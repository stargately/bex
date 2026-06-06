# bex architecture

bex is the **deploy-from-git half** of bex.co (strategy 211.09): a Git repo becomes
a running, addressable service, bin-packed across machines, with idle services
hibernated ("sleep = free") and woken on request. This doc is the map.

## Two layers: `bex` and `bex-infra`

The single most important boundary:

| | **bex** (control plane) | **bex-infra** (provisioning) |
| --- | --- | --- |
| owns | placement, lifecycle, build→deploy→serve, the **auto-allocator** | clusters + machines |
| node awareness | **reads** `Node`/`Pod` (capacity, utilization); decides placement/eviction | **creates/joins/deletes** nodes |
| provisioning | ❌ never SSHes / runs cloud APIs | ✅ Terraform, Cluster API, autoscaler |
| code | Go (`control-plane/`) | declarative (`infra/`) |
| how it scales machines | **indirectly**: bin-pack + idle-evict → pending pods / empty nodes | Cluster Autoscaler / CAPI react |

bex is **node-aware but provision-unaware**: it never adds a machine itself; it
packs pods tightly and evicts idle ones, and the autoscaler/CAPI translate that
into machines added/removed.

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
you/CI ─(terraform / clusterctl)─▶ infra/ ─▶ k8s cluster + nodes
                                              │ (Argo installed)
                                              ▼
                       Argo ─(reconcile)─▶ deploy/gitops ─▶ platform (incl. bex)
                                                                  │ (product runtime)
                                              user git push ─▶ bex ─▶ sandbox on a node
```

## Local CAPD mock → Hetzner CAPH (the portability bet)

bex is identical locally and in prod; only the **infrastructure provider overlay**
changes. So you develop the whole add/remove-machine + bin-pack + scale-down loop
locally, in Docker, then swap the provider for Hetzner.

| | local (mock) | Hetzner (prod) |
| --- | --- | --- |
| provider | **CAPD** (Docker) | **CAPH** (Hetzner cloud + bare-metal) |
| "machine" | Docker-container node | Hetzner server |
| mgmt cluster | `kind` (`infra/local`) | `infra/terraform` |
| node-pool overlay | `infra/clusterapi/overlays/local-capd` | `…/hetzner-caph` |
| microVMs (Kata/FC) | not available | bare-metal (Robot) |

## Build → deploy → serve (the product)

1. **build** — clone repo @ ref → Dockerfile (BuildKit) or Cloud Native Buildpacks
   (`pack`) → OCI image → push to **Zot** (`control-plane/internal/build`).
2. **deploy** — run the image as a revision on **OpenSandbox** (Docker runtime, or
   k8s runtime → a pod) (`control-plane/internal/runtime`); health-gate; record
   `Service` status (`internal/controller`).
3. **serve** — reach the revision via the runtime endpoint (future: a stable
   `*-<id>.bex.co` URL via the gateway).
4. **sleep = free** — idle → OpenSandbox `pause`; request → `resume` (the gateway
   activator). At the machine level, idle-evict frees nodes → autoscaler scales down.

## Repo map

```
control-plane/   Go operator (+ future gateway): api/ internal/{build,runtime,controller,allocator,gateway} cmd/
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
