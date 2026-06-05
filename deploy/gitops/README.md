# bex platform GitOps (scaffold)

This directory is the **platform substrate** as declarative, version-pinned state —
the GitOps answer from [`docs/go-and-gitops.md`](../../docs/go-and-gitops.md):

> **GitOps the platform; never GitOps the per-deploy user workloads** (those are bex's
> product runtime — webhook → build → deploy).

It converts the imperative MVP setup (`helm install …`, `vcluster create …`, `kubectl …`)
into reproducible Git state, pinned to the versions the MVP verified.

## What's in scope here
- Cluster addons: **Zot** registry (later: ingress/cert-manager, Loki/Prometheus).
- **OpenSandbox controller** + CRDs (chart `0.2.0`, image `v0.2.0`) incl. snapshot config.
- **bex control plane** (our Go gateway/controllers) — once containerized (placeholder).
- Per-tenant **vcluster** provisioning — via `ApplicationSet` (future).

## What's NOT here (by design)
- User **service revisions** — driven by the bex gateway at runtime, not GitOps.
- **Cluster/node creation** — infra (Terraform on Hetzner; OrbStack locally).

## Tooling
Argo CD **app-of-apps** (`bootstrap/app-of-apps.yaml` → `platform/*`). Flux is an equally
valid swap (HelmRelease/Kustomization). Secrets via **SOPS** or **sealed-secrets** (none
checked in plaintext). Env differences (local OrbStack insecure-registry vs Hetzner TLS)
go in `envs/{orbstack,hetzner}/` overlays.

## Status
Apply-ready except for one step (a git remote):
- ✅ opensandbox-controller chart **vendored** at `charts/opensandbox-controller` (0.2.0);
  `helm template` renders it with our values (image `v0.2.0` + snapshot flags).
- ✅ **Argo CD installed** into the `orbstack` cluster (`argocd` ns, 7/7 pods).
- ✅ All Application manifests **validate** against the live Argo CRDs (`--dry-run=server`).
- ⬜ **Remaining:** push this repo to a git remote Argo can reach, set `repoURL` in
  `bootstrap/app-of-apps.yaml` + `platform/opensandbox-controller.yaml`, then
  `kubectl apply -f bootstrap/app-of-apps.yaml`.
- ⬜ Containerize the Go gateway (see `../../control-plane/`) and fill in `platform/bex-gateway.yaml`.

The pinned values under `values/` encode exactly what the MVP proved
(controller image `v0.2.0`, snapshot registry/insecure, image-committer `v0.1.0`).
