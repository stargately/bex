# bex — webhook → build → deploy → serve (Go control plane)

bex is the **deploy-from-git half** of [bex.co](docs/go-and-gitops.md) (strategy 211.09):
a Git repo becomes a running, addressable service. The control plane is a **Go
Kubernetes operator**; the substrate is assembled from open source — Cloud Native
Buildpacks, the Zot registry, OpenSandbox, Kubernetes + vcluster.

```
Service CR ─▶ build (OCI image) ─▶ deploy revision ─▶ serve
            (CNB / Dockerfile)     (OpenSandbox)
```

## Architecture

| Concern | What | Where |
| --- | --- | --- |
| **Control plane** | Go kubebuilder operator: `Service` CRD + reconcile | `control-plane/` |
| ↳ build plane | clone repo @ ref → Dockerfile (BuildKit) or CNB `pack` → push to Zot | `control-plane/internal/build` |
| ↳ runtime | OpenSandbox Lifecycle API client (create / endpoint / pause / resume / delete) | `control-plane/internal/runtime` |
| **Registry** | Zot (OCI) | `127.0.0.1:5050` |
| **Runtime substrate** | OpenSandbox → Docker, or → Kubernetes (BatchSandbox CR → pod in a vcluster) | `deploy/opensandbox/`, `scripts/start-opensandbox*.sh` |
| **GitOps** | Argo CD app-of-apps for the platform substrate | `deploy/gitops/` |

Everything bex *consumes* is Go/k8s-native; the only first-party code is the Go
control plane. See [`docs/go-and-gitops.md`](docs/go-and-gitops.md) for the direction
(why Go, and why GitOps the platform but not user deploys).

## The `Service` resource

```yaml
apiVersion: app.bex.co/v1alpha1
kind: Service
metadata: { name: hello-go }
spec:
  repo: "https://github.com/acme/hello-go"   # or a local path
  branch: main
  builder: auto            # auto | buildpack | dockerfile
  port: 3000
  healthCheckPath: /
  autoDeploy: true
```

The controller builds the repo, runs it as a revision on OpenSandbox, and records
`status.{phase,url,image,sandboxID,activeRevision}`. `kubectl get services.app.bex.co`
shows phase / revision / url.

## Run it (local, OrbStack)

Prereqs: Docker (OrbStack), Go ≥ 1.22, `git`, `pack` (`brew install buildpacks/tap/pack`),
`kubectl`, and OrbStack Kubernetes enabled (`orb start k8s`).

```bash
# 1. bring up the substrate (Zot registry + OpenSandbox server + the Service CRD)
bash scripts/up.sh

# 2. run the control plane (Go operator)
cd control-plane && make run        # uses ~/.kube/config (orbstack)

# 3. deploy a service from the Go sample
bash scripts/deploy-sample.sh       # creates a local repo + applies a Service CR
kubectl get services.app.bex.co -w  # watch Building -> Running
```

`status.url` is the per-sandbox endpoint; `curl` it to get `OK`.

### Full substrate (k8s + vcluster)

OpenSandbox can schedule revisions as **pods in a per-tenant vcluster** instead of
Docker containers — point the controller at the k8s-runtime OpenSandbox server
(`BEX_OPENSANDBOX_URL=http://127.0.0.1:8078`). Setup is in
[`deploy/gitops/README.md`](deploy/gitops/README.md) and `scripts/start-opensandbox-k8s.sh`.

### GitOps (platform substrate)

`deploy/gitops/` is an Argo CD app-of-apps for the assembled OSS (Zot,
opensandbox-controller, …). Argo CD is installed in the `orbstack` cluster; manifests
validate. Push to a remote and `kubectl apply -f deploy/gitops/bootstrap/app-of-apps.yaml`.
The platform is GitOps-managed; **per-deploy user workloads are not** — those are bex's
runtime job.

## Layout

```
control-plane/            Go operator (kubebuilder)
  api/v1alpha1/           Service CRD types
  internal/build/         build plane
  internal/runtime/       OpenSandbox client
  internal/controller/    Service reconcile (build -> deploy -> status)
  cmd/main.go             manager entrypoint
examples/hello-go/        sample user app (Go + Dockerfile)
deploy/opensandbox/       OpenSandbox server configs (docker + k8s runtimes)
deploy/gitops/            Argo CD app-of-apps for the platform
docs/go-and-gitops.md     direction: Go + GitOps decision
scripts/                  up.sh, deploy-sample.sh, start-opensandbox*.sh
```

## Status — ported vs. TODO

Done in Go: build (Dockerfile/CNB→Zot), deploy on OpenSandbox, status/lifecycle phase,
finalizer teardown. Verified end-to-end.

Not yet ported from the original MVP (tracked): the **edge proxy + stable `*-id` URL +
wake-on-request activator**, the **HMAC git webhook** (auto-deploy on push), and
**idle → hibernate** (OpenSandbox `pause`/`resume`; works on the Docker runtime, blocked
on OrbStack's cri-dockerd k8s — see `docs/go-and-gitops.md`). Builds run via host
`pack`/`docker` (an in-cluster BuildKit/kpack Job is the productionization).
