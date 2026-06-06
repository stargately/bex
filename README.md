# bex — deploy-from-git on an elastic, multi-machine substrate

bex is the **deploy-from-git half** of bex.co (strategy 211.09): a Git repo (or a
prebuilt image) becomes a running service, scheduled across machines that are
**added/removed elastically** — and the whole thing runs **locally as a mock** that
swaps to **Hetzner** by changing one provider overlay.

The control plane is a **Go Kubernetes operator**. Everything else is assembled open
source. Full design in [`docs/architecture.md`](docs/architecture.md).

## Panorama

```
  dev   $ kubectl apply -f App.yaml
    │
    ▼
  ╔══ MANAGEMENT CLUSTER ════════════════════════════════ bex-infra · infra/ ══╗
  ║ machine ×1   —   kind node   bex-mgmt-control-plane                        ║
  ║                                                                            ║
  ║ pods ▸ Cluster API   capi · capd · kubeadm-bootstrap · kubeadm-cp          ║
  ║      ▸ BEX OPERATOR  · bex ·  reconcile App → Deployment                   ║
  ║        (prod = a pod here   ·   local dev = host  go run  :8081)           ║
  ╚════════════════════════════════════════════════════════════════════════════╝
        │
        │  bex operator → Deployment into the workload cluster (its KUBECONFIG)
        │  Cluster API  → provisions machines  (add ⇄ remove)
        │                 CAPD → Docker container   ·   CAPH → Hetzner server
        ▼
  ╔══ WORKLOAD CLUSTER ══════════════════════ substrate · your Apps run here ══╗
  ║ control-plane node       worker machines (CAPI provisions these)           ║
  ║                                                                            ║
  ║ ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     ║
  ║ │ bex-kn4d9          │  │ bex-md-0…2fn7c     │  │ bex-md-0…jw4sv     │     ║
  ║ │ apiserver · etcd   │  │                    │  │                    │     ║
  ║ │ scheduler · CM     │  │ [ whoami  pod ]    │  │ [ whoami  pod ]    │     ║
  ║ │ (tainted: no apps) │  │                    │  │                    │     ║
  ║ └────────────────────┘  └────────────────────┘  └────────────────────┘     ║
  ║                                                                            ║
  ║ add a machine ⇒ new node joins · pods bin-pack onto it                     ║
  ╚════════════════════════════════════════════════════════════════════════════╝
                                    ▲  image pull
                    bex-zot   ·   registry container  (:5050)

  ── alternate runtime ─ BEX_RUNTIME=opensandbox ─ single host · NOT the k8s path ──
     host OpenSandbox (:8077) → sandbox container  [ hello-go ]    real pause/resume
     k8s variant: opensandbox-controller in the legacy  orbstack  vcluster (acme)

  levels   machine = a server (Hetzner) / Docker container (local mock)
           cluster = k8s built FROM machines      pod = a process inside a cluster
  layers   · bex        operator/   build → deploy → serve Apps      (the product)
           · bex-infra  infra/      Cluster API — makes clusters & machines
           · substrate  the workload cluster (bex-infra builds it · bex runs Apps)
  count    machines now = 1 (mgmt) + 1 control-plane + 2 workers.   operator, CAPI
           and zot are pods/containers — NOT extra machines.   Hetzner: CAPD→CAPH.
```

> **Two "control planes" — don't conflate.** The **BEX OPERATOR** (`· bex`) is the
> *platform* control plane: it decides what to deploy. The **control-plane node**
> inside a cluster (apiserver/etcd/scheduler) is that *cluster's* own master. The
> operator is a **client** of those apiservers — a pod, not a node, not a machine.

- **Two clusters, not four boxes.** Only `MANAGEMENT CLUSTER` and `WORKLOAD CLUSTER`
  are Kubernetes clusters; `BEX OPERATOR`, Cluster API and `bex-zot` are **pods /
  containers inside** them — they cost **no extra machines**. On Hetzner the machines
  are the cluster **nodes**; swap `CAPD`→`CAPH` and the picture is identical. (A 3rd
  legacy `orbstack` cluster still hosts the OpenSandbox `hello-go` demo.)
- **machines = nodes** of the workload cluster — Docker containers under CAPD locally,
  Hetzner servers under CAPH. **Add/remove a machine** = scale the worker pool; the
  operator only watches the cluster in its `KUBECONFIG` and bin-packs pods onto nodes.

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

## The `App` resource

```yaml
apiVersion: app.bex.co/v1alpha1
kind: App
metadata: { name: whoami }
spec:
  image: traefik/whoami     # prebuilt image; OR build from git with `repo:` + `branch:`
  port: 80
  replicas: 2               # pods bin-pack across machines
```

`kubectl get apps.app.bex.co` shows phase / revision / url.

## Quickstart: local CAPD mock (machines = Docker containers)

Prereqs: Docker (OrbStack), Go ≥ 1.22, `kubectl`, `kind`, `clusterctl`.

```bash
# 1. stand up the mock Hetzner substrate: kind mgmt cluster + Cluster API + CAPD
#    + a workload cluster whose nodes are Docker containers (+ Calico CNI).
bash scripts/mock-cluster.sh            # writes infra/local/bex.kubeconfig

# 2. run bex against the workload cluster (kubernetes runtime)
export KUBECONFIG=$PWD/infra/local/bex.kubeconfig
( cd operator && make install )
( cd operator && BEX_RUNTIME=kubernetes make run ) &

# 3. deploy an App — pods land on the CAPD machines
kubectl apply -f examples/whoami-app.yaml
kubectl get pods -l app.bex.co/app=whoami -o wide   # see them on bex-md-0-* nodes

# 4. ★ add a machine, then scale the App onto it
bash scripts/mock-cluster.sh scale 2    # worker pool 1 -> 2 (a new container node joins)
kubectl patch apps.app.bex.co whoami --type merge -p '{"spec":{"replicas":6}}'
kubectl get pods -l app.bex.co/app=whoami -o wide   # pods now spread across both machines
```

## Deploy to Hetzner (same bex, different provider)

Only the infrastructure overlay changes — `infra/clusterapi/overlays/local-capd` →
`…/hetzner-caph` (a real CAPH manifest is committed there). The bex control plane and
the `App`/Deployment are byte-for-byte identical. See
[`infra/README.md`](infra/README.md) and the overlay README.

## Layout

```
operator/   Go operator (kubebuilder)
  api/v1alpha1/   App CRD          internal/build/    build plane (CNB/Dockerfile → Zot)
  cmd/            manager entrypoint   internal/runtime/   OpenSandbox client
  config/         CRD/RBAC kustomize   internal/controller/ reconcile: kubernetes + opensandbox runtimes
infra/           bex-infra: terraform/ · clusterapi/{base,overlays/{local-capd,hetzner-caph}} · local/
deploy/          gitops/{bootstrap,base,overlays/{local,staging,prod},charts} · opensandbox/ server configs
examples/        whoami-app.yaml (prebuilt), hello-go/ (build-from-git sample)
docs/            architecture.md · go-and-gitops.md
scripts/         mock-cluster.sh · up.sh · deploy-sample.sh · start-opensandbox*.sh
```

## Status

Working & verified: the **Go control plane** (App CRD + reconcile, finalizer
teardown); the **kubernetes runtime** (App → Deployment → pods on machines); the
**local CAPD mock** with **add/remove machine** and pods bin-packing onto added
machines; the **opensandbox runtime** (build CNB/Dockerfile → Zot → sandbox, real
pause/resume); the **Hetzner CAPH overlay** (manifest committed, not applied — no account).

Tracked next: the **edge proxy + stable URL + wake activator** and **HMAC webhook**
(not yet ported); **Cluster Autoscaler** wiring so add/remove-machine is reactive (not
manual); in-cluster builds (BuildKit/kpack Job) so build-from-git images are pullable
by cluster nodes. See [`docs/architecture.md`](docs/architecture.md).
