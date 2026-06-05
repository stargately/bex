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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

// ServiceSpec is the desired state of a deploy-from-git Service — the Render-like
// unit from strategy 211.09. Mirrors the Node MVP's service spec (src/api.js).
type ServiceSpec struct {
	// Repo is the git repository URL (or local path) to deploy from.
	// +required
	Repo string `json:"repo"`

	// Branch to track. Defaults to "main".
	// +optional
	// +kubebuilder:default=main
	Branch string `json:"branch,omitempty"`

	// Builder selects how the image is built:
	// "auto" (Dockerfile if present, else Cloud Native Buildpacks), "buildpack", or "dockerfile".
	// +optional
	// +kubebuilder:validation:Enum=auto;buildpack;dockerfile
	// +kubebuilder:default=auto
	Builder string `json:"builder,omitempty"`

	// Port the application listens on (PORT is injected).
	// +optional
	// +kubebuilder:default=3000
	Port int32 `json:"port,omitempty"`

	// HealthCheckPath polled for 2xx before traffic is shifted to a new revision.
	// +optional
	// +kubebuilder:default=/
	HealthCheckPath string `json:"healthCheckPath,omitempty"`

	// AutoDeploy triggers a deploy on each push to Branch.
	// +optional
	AutoDeploy bool `json:"autoDeploy,omitempty"`

	// IdleTTLSeconds before the service hibernates ("sleep = free"). 0 = controller default.
	// +optional
	IdleTTLSeconds int32 `json:"idleTTLSeconds,omitempty"`
}

// ServicePhase mirrors the lifecycle state machine (211.09 §Agent Lifecycle).
// +kubebuilder:validation:Enum=Pending;Building;Deploying;Running;Hibernated;Failed
type ServicePhase string

const (
	PhasePending    ServicePhase = "Pending"
	PhaseBuilding   ServicePhase = "Building"
	PhaseDeploying  ServicePhase = "Deploying"
	PhaseRunning    ServicePhase = "Running"
	PhaseHibernated ServicePhase = "Hibernated"
	PhaseFailed     ServicePhase = "Failed"
)

// ServiceStatus is the observed state of a Service.
type ServiceStatus struct {
	// Phase is the high-level lifecycle state.
	// +optional
	Phase ServicePhase `json:"phase,omitempty"`

	// URL is the stable serving URL (*-<id>.bex.co).
	// +optional
	URL string `json:"url,omitempty"`

	// ActiveRevision currently serving traffic (e.g. "rev_5").
	// +optional
	ActiveRevision string `json:"activeRevision,omitempty"`

	// Image is the OCI image of the active revision.
	// +optional
	Image string `json:"image,omitempty"`

	// ObservedGeneration is the .metadata.generation the controller last reconciled.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions represent the current state (Ready / Progressing / Degraded).
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Revision",type=string,JSONPath=`.status.activeRevision`
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.status.url`
// +kubebuilder:printcolumn:name="Repo",type=string,JSONPath=`.spec.repo`,priority=1

// Service is the Schema for the services API
type Service struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Service
	// +required
	Spec ServiceSpec `json:"spec"`

	// status defines the observed state of Service
	// +optional
	Status ServiceStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ServiceList contains a list of Service
type ServiceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Service `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Service{}, &ServiceList{})
}
