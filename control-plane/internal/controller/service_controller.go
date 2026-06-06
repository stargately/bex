/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"strconv"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	appv1alpha1 "github.com/blockeden/bex/control-plane/api/v1alpha1"
	"github.com/blockeden/bex/control-plane/internal/build"
	bexruntime "github.com/blockeden/bex/control-plane/internal/runtime"
)

const finalizer = "app.bex.co/finalizer"

// Runtime modes.
const (
	ModeOpenSandbox = "opensandbox" // run revisions as OpenSandbox sandboxes (host)
	ModeKubernetes  = "kubernetes"  // run revisions as k8s Deployments (pods on cluster nodes)
)

// ServiceReconciler reconciles a Service: resolve an image (prebuilt or built from
// git) and run it as a revision on the selected runtime, recording status.
type ServiceReconciler struct {
	client.Client
	Scheme     *runtime.Scheme
	Mode       string                  // ModeOpenSandbox | ModeKubernetes
	Registry   string                  // e.g. 127.0.0.1:5050
	CNBBuilder string                  // e.g. paketobuildpacks/builder-jammy-base
	Runtime    *bexruntime.OpenSandbox // OpenSandbox client (ModeOpenSandbox)
}

// +kubebuilder:rbac:groups=app.bex.co,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=app.bex.co,resources=services/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=app.bex.co,resources=services/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete

func (r *ServiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var svc appv1alpha1.Service
	if err := r.Get(ctx, req.NamespacedName, &svc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Deletion: tear down external resources (OpenSandbox sandbox); owned k8s
	// Deployment/Service are garbage-collected via owner refs.
	if !svc.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&svc, finalizer) {
			if svc.Status.SandboxID != "" {
				_ = r.Runtime.Delete(ctx, svc.Status.SandboxID)
			}
			controllerutil.RemoveFinalizer(&svc, finalizer)
			if err := r.Update(ctx, &svc); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}
	if controllerutil.AddFinalizer(&svc, finalizer) {
		if err := r.Update(ctx, &svc); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{Requeue: true}, nil // finalizer update doesn't bump generation
	}

	// Already reconciled this spec generation and running — nothing to do.
	if svc.Status.ObservedGeneration == svc.Generation && svc.Status.Phase == appv1alpha1.PhaseRunning {
		return ctrl.Result{}, nil
	}

	port := int(svc.Spec.Port)
	if port == 0 {
		port = 3000
	}

	// --- resolve the image: prebuilt, or build from git ---
	image := svc.Spec.Image
	if image == "" {
		if svc.Spec.Repo == "" {
			return r.fail(ctx, &svc, "BadSpec", fmt.Errorf("one of spec.image or spec.repo is required"))
		}
		branch := svc.Spec.Branch
		if branch == "" {
			branch = "main"
		}
		r.setPhase(ctx, &svc, appv1alpha1.PhaseBuilding, "Building", "Building image from "+svc.Spec.Repo)
		res, err := build.Build(ctx, build.Options{
			Repo: svc.Spec.Repo, Ref: branch, Name: svc.Name,
			Registry: r.Registry, CNBBuilder: r.CNBBuilder,
		})
		if err != nil {
			return r.fail(ctx, &svc, "BuildFailed", err)
		}
		image = res.Image
	}

	if r.Mode == ModeKubernetes {
		return r.reconcileKubernetes(ctx, &svc, image, port)
	}
	return r.reconcileOpenSandbox(ctx, &svc, image, port)
}

// reconcileKubernetes runs the revision as a Deployment (+ ClusterIP Service) owned
// by the Service — pods are scheduled onto the cluster's nodes (machines).
func (r *ServiceReconciler) reconcileKubernetes(ctx context.Context, svc *appv1alpha1.Service, image string, port int) (ctrl.Result, error) {
	r.setPhase(ctx, svc, appv1alpha1.PhaseDeploying, "Deploying", "Reconciling Deployment for "+image)
	replicas := svc.Spec.Replicas
	if replicas == 0 {
		replicas = 1
	}
	labels := map[string]string{"app.bex.co/service": svc.Name}

	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: svc.Name, Namespace: svc.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, dep, func() error {
		dep.Spec.Replicas = &replicas
		dep.Spec.Selector = &metav1.LabelSelector{MatchLabels: labels}
		dep.Spec.Template.ObjectMeta.Labels = labels
		dep.Spec.Template.Spec.Containers = []corev1.Container{{
			Name:  "app",
			Image: image,
			Env:   []corev1.EnvVar{{Name: "PORT", Value: strconv.Itoa(port)}},
			Ports: []corev1.ContainerPort{{ContainerPort: int32(port)}},
		}}
		return controllerutil.SetControllerReference(svc, dep, r.Scheme)
	}); err != nil {
		return r.fail(ctx, svc, "DeployFailed", err)
	}

	clusterSvc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: svc.Name, Namespace: svc.Namespace}}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, clusterSvc, func() error {
		clusterSvc.Spec.Selector = labels
		clusterSvc.Spec.Ports = []corev1.ServicePort{{Port: int32(port), TargetPort: intstr.FromInt(port)}}
		return controllerutil.SetControllerReference(svc, clusterSvc, r.Scheme)
	}); err != nil {
		return r.fail(ctx, svc, "ServiceFailed", err)
	}

	// Readiness: requeue until the Deployment has its replicas ready.
	_ = r.Get(ctx, client.ObjectKeyFromObject(dep), dep)
	if dep.Status.ReadyReplicas < replicas {
		svc.Status.Phase = appv1alpha1.PhaseDeploying
		svc.Status.Image = image
		_ = r.Status().Update(ctx, svc)
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	svc.Status.Phase = appv1alpha1.PhaseRunning
	svc.Status.Image = image
	svc.Status.URL = fmt.Sprintf("http://%s.%s.svc:%d", svc.Name, svc.Namespace, port)
	svc.Status.ActiveRevision = fmt.Sprintf("rev-%d", svc.Generation)
	svc.Status.ObservedGeneration = svc.Generation
	meta.SetStatusCondition(&svc.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: metav1.ConditionTrue, Reason: "Deployed",
		Message:            fmt.Sprintf("%d/%d replicas ready", dep.Status.ReadyReplicas, replicas),
		ObservedGeneration: svc.Generation,
	})
	if err := r.Status().Update(ctx, svc); err != nil {
		return ctrl.Result{}, err
	}
	logf.FromContext(ctx).Info("service running (kubernetes)", "name", svc.Name, "image", image, "replicas", replicas)
	return ctrl.Result{}, nil
}

// reconcileOpenSandbox runs the revision as an OpenSandbox sandbox (host runtime).
func (r *ServiceReconciler) reconcileOpenSandbox(ctx context.Context, svc *appv1alpha1.Service, image string, port int) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	r.setPhase(ctx, svc, appv1alpha1.PhaseDeploying, "Deploying", "Starting revision for "+image)
	old := svc.Status.SandboxID
	id, err := r.Runtime.Create(ctx, image, port, nil, string(svc.UID))
	if err != nil {
		if id != "" {
			_ = r.Runtime.Delete(ctx, id)
		}
		return r.fail(ctx, svc, "DeployFailed", err)
	}
	target, err := r.Runtime.Endpoint(ctx, id, port)
	if err != nil {
		_ = r.Runtime.Delete(ctx, id)
		return r.fail(ctx, svc, "EndpointFailed", err)
	}

	svc.Status.Phase = appv1alpha1.PhaseRunning
	svc.Status.Image = image
	svc.Status.SandboxID = id
	svc.Status.Endpoint = fmt.Sprintf("%s:%d%s", target.Host, target.Port, target.Prefix)
	svc.Status.URL = target.URL()
	svc.Status.ActiveRevision = fmt.Sprintf("rev-%d", svc.Generation)
	svc.Status.ObservedGeneration = svc.Generation
	meta.SetStatusCondition(&svc.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: metav1.ConditionTrue, Reason: "Deployed",
		Message: "revision running", ObservedGeneration: svc.Generation,
	})
	if err := r.Status().Update(ctx, svc); err != nil {
		return ctrl.Result{}, err
	}
	if old != "" && old != id {
		_ = r.Runtime.Delete(ctx, old)
	}
	log.Info("service running (opensandbox)", "name", svc.Name, "image", image, "url", svc.Status.URL)
	return ctrl.Result{}, nil
}

func (r *ServiceReconciler) setPhase(ctx context.Context, svc *appv1alpha1.Service, p appv1alpha1.ServicePhase, reason, msg string) {
	svc.Status.Phase = p
	meta.SetStatusCondition(&svc.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: metav1.ConditionFalse, Reason: reason, Message: msg,
		ObservedGeneration: svc.Generation,
	})
	_ = r.Status().Update(ctx, svc)
}

func (r *ServiceReconciler) fail(ctx context.Context, svc *appv1alpha1.Service, reason string, err error) (ctrl.Result, error) {
	svc.Status.Phase = appv1alpha1.PhaseFailed
	meta.SetStatusCondition(&svc.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: metav1.ConditionFalse, Reason: reason, Message: err.Error(),
		ObservedGeneration: svc.Generation,
	})
	_ = r.Status().Update(ctx, svc)
	return ctrl.Result{}, err
}

// SetupWithManager sets up the controller with the Manager.
func (r *ServiceReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&appv1alpha1.Service{}).
		Owns(&appsv1.Deployment{}).
		WithEventFilter(predicate.GenerationChangedPredicate{}).
		Named("service").
		Complete(r)
}
