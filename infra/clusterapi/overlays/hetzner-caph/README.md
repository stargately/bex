# hetzner-caph overlay — Hetzner via Cluster API Provider Hetzner (CAPH) [seam]

The production swap. Same `Cluster` / `MachineDeployment` shape as `local-capd`,
with provider-specific resources:
- `HetznerCluster`, `HCloudMachineTemplate` (cloud) and/or `HetznerBareMetalMachineTemplate`
  (Robot — needed for Kata/Firecracker microVMs).
- a secret with the Hetzner API token (via SOPS/sealed-secrets, never committed plaintext).

Generate with:
```
clusterctl init --infrastructure hetzner
clusterctl generate cluster bex --infrastructure hetzner ... > cluster.yaml
```
`bex` itself is unchanged — only this overlay differs from `local-capd`.
Not applied here (no Hetzner credentials); structurally identical to the local mock.
