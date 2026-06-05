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

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
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

// ServiceReconciler reconciles a Service object: build the repo into an image and
// run it as a revision on the runtime (OpenSandbox), recording status. This is the
// Go port of the MVP's deployer + builder + runtime glue.
type ServiceReconciler struct {
	client.Client
	Scheme     *runtime.Scheme
	Registry   string                  // e.g. 127.0.0.1:5050
	CNBBuilder string                  // e.g. paketobuildpacks/builder-jammy-base
	Runtime    *bexruntime.OpenSandbox // OpenSandbox client
}

// +kubebuilder:rbac:groups=app.bex.co,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=app.bex.co,resources=services/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=app.bex.co,resources=services/finalizers,verbs=update

func (r *ServiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var svc appv1alpha1.Service
	if err := r.Get(ctx, req.NamespacedName, &svc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Deletion: tear down the runtime sandbox, then drop the finalizer.
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
		// Requeue explicitly: the finalizer update doesn't bump generation, so the
		// GenerationChangedPredicate would otherwise filter it and stall.
		return ctrl.Result{Requeue: true}, nil
	}

	// Already reconciled this spec generation and serving — nothing to do.
	if svc.Status.ObservedGeneration == svc.Generation && svc.Status.SandboxID != "" {
		return ctrl.Result{}, nil
	}

	branch := svc.Spec.Branch
	if branch == "" {
		branch = "main"
	}
	port := int(svc.Spec.Port)
	if port == 0 {
		port = 3000
	}

	// --- build ---
	r.setPhase(ctx, &svc, appv1alpha1.PhaseBuilding, "Building", "Building image from "+svc.Spec.Repo)
	res, err := build.Build(ctx, build.Options{
		Repo:       svc.Spec.Repo,
		Ref:        branch,
		Name:       svc.Name,
		Registry:   r.Registry,
		CNBBuilder: r.CNBBuilder,
	})
	if err != nil {
		return r.fail(ctx, &svc, "BuildFailed", err)
	}

	// --- deploy a new revision on the runtime ---
	r.setPhase(ctx, &svc, appv1alpha1.PhaseDeploying, "Deploying", "Starting revision for "+res.Image)
	old := svc.Status.SandboxID
	id, err := r.Runtime.Create(ctx, res.Image, port, nil, string(svc.UID))
	if err != nil {
		if id != "" {
			_ = r.Runtime.Delete(ctx, id) // don't leak a failed sandbox on retry
		}
		return r.fail(ctx, &svc, "DeployFailed", err)
	}
	target, err := r.Runtime.Endpoint(ctx, id, port)
	if err != nil {
		_ = r.Runtime.Delete(ctx, id)
		return r.fail(ctx, &svc, "EndpointFailed", err)
	}

	// --- shift traffic: record the new revision, retire the old ---
	svc.Status.Phase = appv1alpha1.PhaseRunning
	svc.Status.Image = res.Image
	svc.Status.SandboxID = id
	svc.Status.Endpoint = fmt.Sprintf("%s:%d%s", target.Host, target.Port, target.Prefix)
	svc.Status.URL = target.URL()
	svc.Status.ActiveRevision = fmt.Sprintf("rev-%d", svc.Generation)
	svc.Status.ObservedGeneration = svc.Generation
	meta.SetStatusCondition(&svc.Status.Conditions, metav1.Condition{
		Type: "Ready", Status: metav1.ConditionTrue, Reason: "Deployed",
		Message: "revision running", ObservedGeneration: svc.Generation,
	})
	if err := r.Status().Update(ctx, &svc); err != nil {
		return ctrl.Result{}, err
	}
	if old != "" && old != id {
		_ = r.Runtime.Delete(ctx, old)
	}
	log.Info("service running", "name", svc.Name, "image", res.Image, "url", svc.Status.URL)
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
		WithEventFilter(predicate.GenerationChangedPredicate{}).
		Named("service").
		Complete(r)
}
