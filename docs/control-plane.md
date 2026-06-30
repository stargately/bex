# bex control plane (source of truth) vs. operator (mechanism)

> **Status: planned direction, not built yet.** Today there is **no control plane and no Postgres** — you `kubectl apply` an `App` CR, the **operator** reconciles it, and the only store is the app cluster's **etcd**. This doc describes where bex is going and why, so the boundary is clear before the code exists.

bex's Go layer splits into **two collaborating components** — keep them distinct:

|  | **bex control plane** (planned) | **bex operator** (exists) |
| --- | --- | --- |
| role | **policy / intent** — business logic + the source of truth | **mechanism** — make reality match intent |
| owns | tenants, apps, domains, plans/billing, quotas, auth | `App` CR → `Deployment` + `Service` + `Ingress` (+TLS) |
| store | **Postgres** (durable, queryable, backed up) | **none** — it's a k8s controller; its "store" is the API/etcd |
| interface | an API / web UI for users | watches `App` CRs; writes their `status` |
| decides | _what should exist & who's allowed_ | _how to run it_ (rollout, health-gate, idle-hibernate) |
| code | a Go service (`operator/` repo, separate binary) | `operator/internal/controller` (kubebuilder) |

**Rule of thumb:** business/product logic lives in the **control plane**; the operator stays a thin, idempotent, **CR-driven** reconciler with **no DB** and no policy.

## Data flow

```
users / API / web UI
      │
bex control plane  (Go service + Postgres)        ← source of truth + business logic
  - auth · tenants · plans/billing · quotas
  - app/domain CRUD + validation + domain verification (BYOD)
  - reconciles rows → creates/updates App CRs (k8s API)
      │  (App CR = the contract between the two)
      ▼
App CRs  (in etcd)  ──watched by──▶  bex operator  ← mechanism, no Postgres
      │ reconcile
      ▼
Deployment · Service · Ingress (+cert-manager TLS)  →  Hetzner / k8s runtime
```

The **`App` CR is the contract**: the control plane writes intent into it; the operator executes it. Either side can be developed/tested against that contract independently.

## Why a Postgres source of truth (the durability + product case)

- **Durability.** Business data (who owns which app/domain) belongs in a real DB, backed up off-node. Today everything lives only in the single app node's **etcd** (`/var/lib/etcd`, local disk, no HA) — a node _reboot_ is fine, but a node _rebuild_ loses it, and the App is **not in git** (Apps are imperative by design). With Postgres as the truth, **etcd becomes a rebuildable projection**: lose the cluster, re-`project` from Postgres.
- **Multi-tenant / BYOD.** Tenants, custom domains, plans, quotas are **relational business data** with queries/joins/an API — not a fit for etcd (size-capped ~8 GB, no queries, no watch-as-a-database). A domain a tenant adds becomes a row → the control plane projects an `App`/Ingress → the operator + cert-manager issue TLS (Traefik routes new hosts with no reload — see [`docs/architecture.md`](architecture.md)).
- **API/UI.** Users interact with rows through a product API, not `kubectl`.

## One Postgres, owned by the control plane

- **One instance**, not two — two Postgres for one product is wasted ops at this scale.
- **Only the control plane connects to it.** The operator does **not** share it (it has no DB). If the operator ever needs its own state, isolate at the logical level — separate **database/schema + role** in the same instance — not a second server.
- **Don't** put business logic in the operator (keep it mechanical) **or** in Postgres itself (triggers/stored procedures) — logic lives in the control plane's Go code; Postgres is storage.
- **Don't** have the operator read Postgres directly instead of CRs — that throws away k8s watch/RBAC/GC and forces you to rebuild change-notification.

## Schema sketch (illustrative)

```sql
tenants (id, name, plan, created_at, …)
apps    (id, tenant_id→tenants, name, repo|image, port, replicas, idle_ttl, …)
domains (id, app_id→apps, host, verified_at, cert_status, …)   -- BYOD custom domains
-- + accounts/auth, usage/billing, audit
```

The control plane reconciles these rows into `App` CRs (e.g. an `apps` row + its primary `domains` row → an `App` with `spec.host`); the operator does the rest.

## What's built vs. planned

- **Built:** the `App` CRD + operator (reconcile → Deployment/Service/Ingress/TLS), GitOps platform (Traefik, cert-manager, Zot, Argo), the local CAPD mock → Hetzner CAPH.
- **Planned (this doc):** the Postgres-backed control plane (service + schema + projection to CRs), tenant/domain/billing logic, the product API/UI. Until then: `kubectl apply` App CRs directly; etcd is the store; snapshot etcd off-node for interim durability.
