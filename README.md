# bex — deploy-from-git on an elastic, multi-machine substrate

bex is the **deploy-from-git half** of bex.co (strategy 211.09): a Git repo (or a
prebuilt image) becomes a running service, scheduled across machines that are
**added/removed elastically** — and the whole thing runs **locally as a mock** that
swaps to **Hetzner** by changing one provider overlay.

The control plane is a **Go Kubernetes operator**. Everything else is assembled open
source. Full design in [`docs/architecture.md`](docs/architecture.md).

## Panorama

```
                              ┌──────────┐  kubectl apply Service CR
                              │   dev    │ ─────────────────────────────────┐
                              └──────────┘                                   │
                                                                            ▼
              ┌──────────────────────────────────────────────────────────────────┐
              │  BEX CONTROL PLANE — Go operator   (control-plane/)                │
              │  reconcile a Service:  build (CNB/Dockerfile → Zot) · place · status│
              │  BEX_RUNTIME =     kubernetes      ──or──      opensandbox          │
              └────────────────┬────────────────────────────────┬────────────────┘
                               │ kubernetes runtime              │ opensandbox runtime
                               ▼                                 ▼
  ╔══════════════════ WORKLOAD CLUSTER ══════════════════╗    ┌────────────────────────┐
  ║                                                      ║    │  host OpenSandbox       │
  ║  control-plane node        worker nodes (machines)   ║    │  sandbox (pause/resume  │
  ║  ┌──────────────────┐   ┌──────────────┐┌──────────┐ ║    │  snapshots)             │
  ║  │ apiserver · etcd │   │ Deployment "whoami"       │ ║    │    → hello-go           │
  ║  │ scheduler · CM   │   │ [pod][pod][pod]│[pod][pod] │ ║    └────────────────────────┘
  ║  └──────────────────┘   └──────────────┘└──────────┘ ║
  ║      bex-kn4d9            worker md-0-A    md-0-B     ║       (a Service = one of these,
  ╚═══════════════════════════════▲══════════════════════╝        in whichever cluster+runtime
                                  │ provisions / scales machines    it was created)
                                  │            (add ⇄ remove)
              ┌───────────────────┴────────────────────────────────────────┐
              │  MANAGEMENT CLUSTER — kind  (bex-mgmt)                       │
              │  Cluster API  +  infrastructure provider:                   │
              │     • CAPD  → machine = Docker container     (local mock)    │
              │     • CAPH  → machine = Hetzner server       (prod — swap)   │
              │  Cluster Autoscaler → reactive add/remove from pending pods  │
              └─────────────────────────────────────────────────────────────┘

  Zot registry ──(image pull)──▶ pods    ·    bex = everything above the line;  bex-infra = the management cluster
```

- **3 clusters**: *management* (kind, runs Cluster API → makes machines) · *workload*
  (where your pods run; nodes = the machines) · plus the legacy `orbstack` cluster from
  the OpenSandbox phase (where `hello-go` still lives).
- **2 runtimes** (`BEX_RUNTIME`): `kubernetes` → a Deployment (pods on worker machines)
  · `opensandbox` → a host sandbox (real pause/resume).
- **machines** = worker nodes of the workload cluster — Docker containers under CAPD
  locally, Hetzner servers under CAPH. **Add/remove a machine** = scale the worker pool;
  the operator only watches the cluster in its `KUBECONFIG`.

## Two layers

- **`bex`** (control plane, Go): build → deploy → serve, placement, the auto-allocator.
  Node-aware, **provision-unaware** — it only reads `Node`/`Pod` and creates Deployments.
- **`bex-infra`** (`infra/`): how clusters and machines *exist* — Cluster API + a
  provider (CAPD locally, CAPH on Hetzner), Cluster Autoscaler, Terraform.

`infra/` makes the cluster (day-0, from outside); `deploy/` is what Argo reconciles
*into* it (day-1+). bex never references `infra/`.

## Runtimes (`BEX_RUNTIME`)

| | runs a revision as | use |
| --- | --- | --- |
| `kubernetes` | a **Deployment** (pods on cluster machines) | the elastic, multi-machine path (CAPD/Hetzner) |
| `opensandbox` | an OpenSandbox sandbox (host Docker) | real `pause`/`resume` snapshots; single host |

## The `Service` resource

```yaml
apiVersion: app.bex.co/v1alpha1
kind: Service
metadata: { name: whoami }
spec:
  image: traefik/whoami     # prebuilt image; OR build from git with `repo:` + `branch:`
  port: 80
  replicas: 2               # pods bin-pack across machines
```

`kubectl get services.app.bex.co` shows phase / revision / url.

## Quickstart: local CAPD mock (machines = Docker containers)

Prereqs: Docker (OrbStack), Go ≥ 1.22, `kubectl`, `kind`, `clusterctl`.

```bash
# 1. stand up the mock Hetzner substrate: kind mgmt cluster + Cluster API + CAPD
#    + a workload cluster whose nodes are Docker containers (+ Calico CNI).
bash scripts/mock-cluster.sh            # writes infra/local/bex.kubeconfig

# 2. run bex against the workload cluster (kubernetes runtime)
export KUBECONFIG=$PWD/infra/local/bex.kubeconfig
( cd control-plane && make install )
( cd control-plane && BEX_RUNTIME=kubernetes make run ) &

# 3. deploy a Service — pods land on the CAPD machines
kubectl apply -f examples/whoami-service.yaml
kubectl get pods -l app.bex.co/service=whoami -o wide   # see them on bex-md-0-* nodes

# 4. ★ add a machine, then scale the Service onto it
bash scripts/mock-cluster.sh scale 2    # worker pool 1 -> 2 (a new container node joins)
kubectl patch service.app.bex.co whoami --type merge -p '{"spec":{"replicas":6}}'
kubectl get pods -l app.bex.co/service=whoami -o wide   # pods now spread across both machines
```

## Deploy to Hetzner (same bex, different provider)

Only the infrastructure overlay changes — `infra/clusterapi/overlays/local-capd` →
`…/hetzner-caph` (a real CAPH manifest is committed there). The bex control plane and
the `Service`/Deployment are byte-for-byte identical. See
[`infra/README.md`](infra/README.md) and the overlay README.

## Layout

```
control-plane/   Go operator (kubebuilder)
  api/v1alpha1/   Service CRD          internal/build/    build plane (CNB/Dockerfile → Zot)
  cmd/            manager entrypoint   internal/runtime/   OpenSandbox client
  config/         CRD/RBAC kustomize   internal/controller/ reconcile: kubernetes + opensandbox runtimes
infra/           bex-infra: terraform/ · clusterapi/{base,overlays/{local-capd,hetzner-caph}} · local/
deploy/          gitops/{bootstrap,base,overlays/{local,staging,prod},charts} · opensandbox/ server configs
examples/        whoami-service.yaml (prebuilt), hello-go/ (build-from-git sample)
docs/            architecture.md · go-and-gitops.md
scripts/         mock-cluster.sh · up.sh · deploy-sample.sh · start-opensandbox*.sh
```

## Status

Working & verified: the **Go control plane** (Service CRD + reconcile, finalizer
teardown); the **kubernetes runtime** (Service → Deployment → pods on machines); the
**local CAPD mock** with **add/remove machine** and pods bin-packing onto added
machines; the **opensandbox runtime** (build CNB/Dockerfile → Zot → sandbox, real
pause/resume); the **Hetzner CAPH overlay** (manifest committed, not applied — no account).

Tracked next: the **edge proxy + stable URL + wake activator** and **HMAC webhook**
(not yet ported); **Cluster Autoscaler** wiring so add/remove-machine is reactive (not
manual); in-cluster builds (BuildKit/kpack Job) so build-from-git images are pullable
by cluster nodes. See [`docs/architecture.md`](docs/architecture.md).
