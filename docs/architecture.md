# bex architecture

bex is the **deploy-from-git half** of bex.co (strategy 211.09): a Git repo becomes
a running, addressable service, bin-packed across machines, with idle services
hibernated ("sleep = free") and woken on request. This doc is the map.

## Two layers: `bex` and `bex-infra`

The single most important boundary:

| | **bex** (control plane + operator) | **bex-infra** (provisioning) |
| --- | --- | --- |
| owns | placement, lifecycle, build→deploy→serve, the **auto-allocator** | clusters + machines |
| node awareness | **reads** `Node`/`Pod` (capacity, utilization); decides placement/eviction | **creates/joins/deletes** nodes |
| provisioning | ❌ never SSHes / runs cloud APIs | ✅ Terraform, Cluster API, autoscaler |
| code | Go (`operator/`) | declarative (`infra/`) |
| how it scales machines | **indirectly**: bin-pack + idle-evict → pending pods / empty nodes | Cluster Autoscaler / CAPI react |

bex is **node-aware but provision-unaware**: it never adds a machine itself; it
packs pods tightly and evicts idle ones, and the autoscaler/CAPI translate that
into machines added/removed.

**Names map to layers consistently** (layer · directory · runtime entity):

| layer | directory | runtime entity |
| --- | --- | --- |
| **bex** | `operator/` | the **BEX OPERATOR** — a **pod in the app cluster** (deploys Apps) |
| **bex-infra** | `infra/` | the **INFRA CLUSTER** (Cluster API; makes clusters/machines) |
| *(substrate)* | — | the **APP CLUSTER** — runs the bex operator **and** your Apps; bex-infra builds it |

The APP CLUSTER belongs to *neither* layer cleanly — it's the substrate
bex-infra provisions, and it hosts both the bex operator pod and the user Apps.
The operator runs **in-cluster** (a `Deployment` in `bex-system`), never on a laptop;
`make run` from source is only a dev inner-loop.

### Control plane (source of truth) vs. operator (mechanism)

The `bex` layer itself splits in two — keep them distinct (full design:
[`control-plane.md`](control-plane.md)):

- **operator** *(today)* — a k8s controller that reconciles `App` CRs into
  `Deployment`/`Service`/`Ingress` (+TLS). **No database**; idempotent; mechanical.
- **control plane** *(planned)* — a **Postgres-backed** service holding the product's
  **source of truth** (tenants / apps / domains / plans + business logic). It projects
  rows into `App` CRs; the operator executes them.

Business/product logic belongs in the **control plane**; the operator stays a thin,
CR-driven reconciler. The **`App` CR is the contract** between them.

**Data layering.** Postgres (planned) is the **durable truth**; Kubernetes/**etcd is a
rebuildable projection** of it — lose the cluster, re-project from Postgres. This matters
because today business state lives *only* in the single app node's etcd (local disk, no
HA) and Apps are imperative (not in git), so a node *rebuild* loses it. Until the control
plane exists: `App` CRs are applied directly and etcd is the only store (snapshot it
off-node for interim durability).

## `infra/` vs `deploy/` (both hold YAML — different jobs)

- **`infra/`** = day-0, run **from outside** (terraform / clusterctl) to make the
  cluster + nodes *exist*.
- **`deploy/`** = day-1+, **Argo reconciles into** an existing cluster (Zot,
  OpenSandbox controller, bex itself, Cluster API controllers, autoscaler).
- Nuance: the Cluster API/autoscaler **controllers** are deployed (`deploy/`), but
  the **desired node pools** they consume (`Cluster`/`MachineDeployment`) are
  declared in `infra/`. Engine = deploy, desired-infra = infra.
- A third thing is **neither**: bex deploying a *user's* repo into a sandbox — that's
  the **product runtime**, not GitOps and not infra.

```
day-0    you / CI ──(terraform · clusterctl)──▶ infra/ ──▶ clusters & machines exist
 outside                                                    (infra cluster + app-cluster nodes)
                                                               │ Argo CD installed in-cluster
                                                               ▼
day-1    Argo CD ──(reconcile)──▶ deploy/gitops/ ──▶ platform pods
 inside                                               Zot · OpenSandbox-ctrl · CAPI · BEX OPERATOR
                                                               │
                                                               ▼
product  user `git push` ─▶ BEX OPERATOR ─▶ build (CNB/Dockerfile → Zot) ─▶ run a revision:
 runtime  (bex's own loop,                                  · k8s          → Deployment + pods on nodes
          not GitOps)                                       · opensandbox  → a sandbox (pause/resume)
```

## Local CAPD mock → Hetzner CAPH (the portability bet)

bex is identical locally and in prod; only the **infrastructure provider overlay**
changes. So you develop the whole add/remove-machine + bin-pack + scale-down loop
locally, in Docker, then swap the provider for Hetzner.

| | local (mock) | Hetzner (prod) |
| --- | --- | --- |
| provider | **CAPD** (Docker) | **CAPH** (Hetzner cloud + bare-metal) |
| "machine" | Docker-container node | Hetzner server |
| infra cluster | `kind` (`infra/local`) | `infra/terraform` |
| node-pool overlay | `infra/clusterapi/overlays/local-capd` | `…/hetzner-caph` |
| microVMs (Kata/FC) | not available | bare-metal (Robot) |

## Build → deploy → serve (the product)

1. **build** — clone repo @ ref → Dockerfile (BuildKit) or Cloud Native Buildpacks
   (`pack`) → OCI image → push to **Zot** (`operator/internal/build`).
2. **deploy** — run the image as a revision on **OpenSandbox** (Docker runtime, or
   k8s runtime → a pod) (`operator/internal/runtime`); health-gate; record
   `App` status (`internal/controller`).
3. **serve** — reach the revision via the runtime endpoint (future: a stable
   `*-<id>.bex.co` URL via the gateway).
4. **sleep = free** — idle → OpenSandbox `pause`; request → `resume` (the gateway
   activator). At the machine level, idle-evict frees nodes → autoscaler scales down.

## Repo map

```
operator/   Go operator (+ planned control plane & gateway): api/ internal/{build,runtime,controller,allocator,gateway} cmd/  ·  control plane = Postgres source of truth (docs/control-plane.md)
infra/           bex-infra: terraform/ clusterapi/{base,overlays/{local-capd,hetzner-caph}} local/
deploy/          GitOps: gitops/{bootstrap,base,overlays/{local,staging,prod},charts} + opensandbox/ server configs
examples/        sample user apps (hello-go)
docs/            this file + go-and-gitops.md
scripts/         up.sh, mock-cluster.sh, deploy-sample.sh, start-opensandbox*.sh
```

## What's genuinely ours vs assembled
Ours (Go): the **auto-allocator** (bin-pack + idle-evict), the deploy-from-git
orchestration, the gateway (edge + webhook + activator), E2B/ACP translation.
Assembled: Kubernetes, Cluster API/CAPD/CAPH, Cluster Autoscaler, OpenSandbox, Zot,
Cloud Native Buildpacks. bex is the glue + the economics, not the substrate.
