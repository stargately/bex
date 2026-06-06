# prod overlay — seam (not yet materialized)

When the Hetzner prod cluster exists, add a `kustomization.yaml` referencing
`../../base` with prod values (TLS, multi-replica, CAPH node pools, real domains,
secrets via SOPS/sealed-secrets), plus `bootstrap/prod.yaml`.
