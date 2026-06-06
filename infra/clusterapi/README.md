# infra/clusterapi — node lifecycle via Cluster API

Declarative machines. A `Cluster` + `MachineDeployment` describe the desired node
pool; the Cluster API controllers (installed via `clusterctl init`, kept in GitOps
under `deploy/gitops/base/cluster-api.yaml`) reconcile them into real nodes.

- **`base/`** — shared, provider-agnostic bits (namespace, cluster-autoscaler
  annotations, MachineDeployment replica defaults used as patch targets).
- **`overlays/local-capd/`** — the full CAPD workload-cluster manifest (Docker
  containers as machines). Generated with `clusterctl generate cluster ... --infrastructure docker`. Used by `infra/local`.
- **`overlays/hetzner-caph/`** — the CAPH equivalent (Hetzner). Same `Cluster` /
  `MachineDeployment` shape; provider-specific `*MachineTemplate`. [seam]

**Add / remove a machine:**
```
kubectl scale machinedeployment <name> --replicas=N     # or edit replicas
# or: let cluster-autoscaler scale it from pending pods (annotations in base/)
```
This is `bex-infra`; the bex control plane only observes the resulting `Node`s.
