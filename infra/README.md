# infra/ — bex-infra: how clusters and machines come to exist

`infra/` is the **provisioning** layer. It answers *"does the cluster / do the nodes
exist?"* — and it runs from **outside** the cluster (your laptop / CI), day-0.
Contrast `deploy/`, which is what **Argo reconciles into an already-existing
cluster** (day-1+). The bex Go control plane never references anything here — it
only reads k8s `Node`/`Pod` objects (provision-unaware).

```
infra/
├── terraform/     base IaC substrate (mgmt cluster, network, LB) — Hetzner; not needed locally
├── clusterapi/    node lifecycle via Cluster API (NodePool ≡ MachineDeployment)
│   ├── base/          shared: namespace, cluster-autoscaler wiring
│   └── overlays/
│       ├── local-capd/     local mock: CAPD (Docker containers as machines)
│       └── hetzner-caph/   prod: CAPH (Hetzner cloud + bare-metal)   [seam]
└── local/         local bootstrap scripts: kind (mgmt) + CAPD + KWOK
```

## The local → Hetzner swap (the whole point)
`bex` is identical in both; only the **infrastructure provider overlay** changes:

| | local (mock) | Hetzner (prod) |
| --- | --- | --- |
| provider | **CAPD** (Docker) | **CAPH** (Hetzner) |
| "machine" | a Docker container node | a Hetzner server / bare-metal |
| overlay | `clusterapi/overlays/local-capd` | `clusterapi/overlays/hetzner-caph` |
| base substrate | kind mgmt cluster (`infra/local`) | `infra/terraform` |

Add/remove a machine = change `MachineDeployment.replicas` (or let Cluster
Autoscaler do it from pending pods). The mechanism is the same; only the provider
behind it differs.
