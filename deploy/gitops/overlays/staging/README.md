# staging overlay — seam (not yet materialized)

When a staging cluster exists, add a `kustomization.yaml` here that references `../../base` and patches staging-specific values (image tags, replicas, domains, TLS, CAPH node pool), plus a `bootstrap/staging.yaml` app-of-apps entrypoint.

Keep differences from prod minimal — both reference the same `../../base`.
