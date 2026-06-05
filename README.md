# bex — webhook → build → deploy → serve MVP

A runnable, local MVP of the **deploy-from-git half** of [bex.co](../pm/src/knowledge-base/200-Blockeden.xyz/211-Strategy/211.09-webhook-build-deploy-auto-allocation-hetzner.md)
(strategy doc 211.09) — the *"Webhook, Build, Deploy & Serve"* cycle from the doc's
**Minimal End-to-End: API Walkthrough**, plus the **"sleep = free"** hibernate/wake
lifecycle.

It wires the doc's **actual open-source components** wherever they fit: builds use
Cloud Native Buildpacks (`pack` + Paketo), images live in the **Zot** registry, and
the runtime is **pluggable** across three backends (`BEX_RUNTIME`):

| `BEX_RUNTIME` | Revision runs as | Hibernate/wake |
| --- | --- | --- |
| `docker` (default) | a Docker container | `stop`/`start` (~0.75 s) |
| `opensandbox` | an OpenSandbox sandbox (Docker runtime) | **real `pause`/`resume` snapshot** (~80 ms) |
| `opensandbox-k8s` | a **pod in a vcluster** (OpenSandbox k8s runtime → BatchSandbox CR → host k8s) | unavailable on OrbStack (see note) |

The `opensandbox-k8s` path is the doc's full substrate: **OrbStack Kubernetes +
vcluster + OpenSandbox controller**, with the edge reaching pods via `kubectl
port-forward` (OrbStack doesn't route cluster pod IPs to the host). The only layer
still unattainable locally is **Kata/Firecracker** microVMs (OrbStack pods are
ordinary containers). The control-plane glue — the part the doc says is *"genuinely
ours"* (identity/routing, deploy-from-git orchestration, idle → hibernate policy,
the wake-on-request activator) — is implemented here for real.

```
git push ──▶ webhook ──▶ build (OCI image) ──▶ deploy (new revision) ──▶ serve
                                                          │
                                          idle ──▶ hibernate ◀──▶ wake-on-request
```

## Quick start

Requires Docker (OrbStack) running, Node ≥ 20, `git`, `openssl`, `python3`, and
the **Cloud Native Buildpacks** CLI `pack` (`brew install buildpacks/tap/pack`).
No `npm install` — the gateway itself is pure Node built-ins.

```bash
# One command: starts a gateway, runs the whole cycle, tears it down.
bash scripts/demo.sh

# Same demo, but run each revision on OpenSandbox (real pause/resume snapshots).
# Auto-starts a host OpenSandbox server on :8077 if one isn't already up.
BEX_RUNTIME=opensandbox bash scripts/demo.sh
```

The demo creates a service from `examples/hello-node`, deploys it, serves it, then
sends a **signed git-push webhook** that changes the response and redeploys it,
then lets it go idle (hibernate) and wakes it on the next request.

To run the gateway yourself:

```bash
bash scripts/dev.sh           # control plane :8080, edge :8081, idle loop
# (defaults; override with BEX_API_PORT / BEX_EDGE_PORT / BEX_IDLE_TTL_MS / ...)
```

### Full substrate: k8s + vcluster + OpenSandbox-on-k8s

One-time setup to run revisions as pods in a per-tenant vcluster:

```bash
orb config set k8s.enable true && orb start k8s          # OrbStack Kubernetes (context: orbstack)
vcluster create acme -n vcluster-acme --connect=false    # per-tenant virtual cluster
vcluster connect acme -n vcluster-acme --print > deploy/opensandbox/vcluster-acme.kubeconfig
# install the OpenSandbox controller (CRDs: BatchSandbox/Pool/SandboxSnapshot) INTO the vcluster:
helm install opensandbox-controller \
  https://github.com/alibaba/OpenSandbox/releases/download/helm/opensandbox-controller/0.2.0/opensandbox-controller-0.2.0.tgz \
  --kubeconfig deploy/opensandbox/vcluster-acme.kubeconfig \
  -n opensandbox-system --create-namespace --set controller.image.tag=v0.2.0
bash scripts/start-opensandbox-k8s.sh                    # OpenSandbox in k8s runtime on :8078

# then run the gateway against it:
BEX_RUNTIME=opensandbox-k8s bash scripts/dev.sh
```

A deploy now lands as a BatchSandbox CR → pod in the vcluster (synced to host k8s),
served through the edge via `kubectl port-forward`.

> **k8s-mode hibernate/wake is unavailable on OrbStack.** OpenSandbox's snapshot
> (SandboxSnapshot) commits a sandbox's rootfs via an `image-committer` that needs a
> standalone **containerd** CRI socket. OrbStack's Kubernetes runs on **cri-dockerd
> (Docker)**, where that socket isn't exposed the way the committer expects, so the
> commit job fails. The `opensandbox-k8s` runtime therefore declares
> `supportsPause=false`. For real pause/resume use `BEX_RUNTIME=opensandbox`
> (Docker runtime, ~80 ms wake); k8s-mode snapshots would need a containerd-CRI
> cluster (kind/k3s) or a patched controller.

## API (the bex.co `/v1` surface)

| Method · path                   | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `POST /v1/services`             | create git-backed service; register webhook; auto-deploy  |
| `GET  /v1/services/:id`         | service state (`provisioning`/`running`/`hibernated`/…)   |
| `DELETE /v1/services/:id`       | teardown (stop + remove containers)                       |
| `POST /v1/services/:id/deploys` | manually build + deploy a ref                             |
| `POST /v1/webhooks/git/:id`     | receive git push → verify HMAC → enqueue deploy           |
| `GET  /v1/builds/:id` · `/logs` | build status + image ref · streamed build log             |
| `GET  /v1/deploys/:id`          | deploy/revision status (`building` → `live`)              |
| `GET  http://<name>-<id>.<domain>:<edge>/` | **serve**; wakes on request if hibernated      |

Example (against `bash scripts/dev.sh` on the defaults):

```bash
# create + auto-deploy a service from a local git repo
curl -sX POST http://127.0.0.1:8080/v1/services -H 'content-type: application/json' -d '{
  "name":"hello-node","repo":"/abs/path/to/repo","branch":"main",
  "run":{"port":3000,"healthCheckPath":"/"},"autoDeploy":true
}'
# serve through the edge (route by Host header)
curl -H 'Host: hello-node-svc_xxxxx.localhost' http://127.0.0.1:8081/
```

Auth is off by default; set `BEX_API_KEY` to require `Authorization: Bearer …` on
`/v1/*` (the webhook endpoint always authenticates via HMAC instead).

## How it maps to the strategy doc

The doc's layer stack, and what each becomes in this MVP:

| Doc layer (211.09)                               | MVP implementation                                   | Fidelity |
| ------------------------------------------------ | ---------------------------------------------------- | -------- |
| ① Edge / ingress (wildcard TLS, route subdomains, activator) | `src/router.js` — Host-based reverse proxy + wake-on-request | TLS/cert-manager skipped; routing + activator real |
| ② Control plane — bex.co gateway                 | `src/api.js`, `src/server.js`, `src/store.js`        | E2B/ACP side out of scope; deploy-from-git side real |
| ③ Build plane (Buildpacks/Dockerfile via BuildKit) | `src/builder.js` — clone + **CNB `pack build` (Paketo)**; Dockerfile fast-path via BuildKit | **real OSS**; runs on host (not a Kata build sandbox); on arm64 it builds amd64 images (correct for Hetzner) that run under emulation |
| OCI registry                                     | **Zot** container (`localhost:5050`)                 | **real OSS** — one of the two registries the doc names (build pushes, deploy references) |
| ④ Orchestration (OpenSandbox/vcluster/host k8s)  | **OpenSandbox + vcluster + OrbStack k8s** (`BEX_RUNTIME=opensandbox-k8s`); or OpenSandbox-on-Docker; or plain Docker | **real** — sandboxes become BatchSandbox CRs in a per-tenant vcluster, reconciled to pods on host k8s |
| ⑤ Node plane (Kata + Firecracker microVM)        | a pod (k8s) / sandbox / container per revision        | **substituted** — Kata/Firecracker not available on OrbStack; a pod/container stands in for the microVM |
| ⑥ State (NVMe hot / S3 cold snapshots)           | sandbox/container writable layer (hot) + `data/state.json` | S3 cold tier + CoW snapshot tiering not implemented |
| Lifecycle: idle → hibernate → wake               | `src/idle.js` + `src/lifecycle.js` + `src/runtimes/*` | **opensandbox: real pause/resume snapshot** (~80 ms wake); docker: stop/start (~0.75 s) |

What's faithfully demonstrated end-to-end:

- **Webhook** — GitHub-style `X-Hub-Signature-256` HMAC verification, repo→service
  resolution, deploy enqueue (`src/webhook.js`).
- **Build** — real **Cloud Native Buildpacks** (`pack` + Paketo builder) turn the
  repo into an OCI image (Dockerfile fast-path via BuildKit when one is present),
  pushed to the **Zot** registry.
- **Deploy** — new revision, health-check before traffic shift, **zero-downtime**
  switch, **auto-rollback** if the new revision fails its health check.
- **Serve** — edge routes `<name>-<id>.<domain>` to the live revision (a Docker
  container, or an OpenSandbox sandbox reached via its per-sandbox endpoint).
- **"Sleep = free"** — idle detector hibernates the revision; the next request
  transparently wakes it. On `BEX_RUNTIME=opensandbox` this is a **real OpenSandbox
  pause/resume snapshot** (~80 ms warm wake); on Docker it's `stop`/`start` (~0.75 s).

## What's deliberately *not* here (vs. the full doc)

- The **E2B-compatible SDK** + **ACP** surfaces (`/sandboxes`, `runCode`, etc.) —
  this MVP is the Render-like `/services` half only.
- **k8s / vcluster / Kata / Firecracker** multi-tenancy and bin-packing — a single
  Docker host stands in (OpenSandbox here runs on Docker, not as a Kata k8s runtime).
- **S3 cold-tier snapshots, CoW overlay diffing, lazy page-in** — the OpenSandbox
  runtime does real local pause/resume snapshots, but there is no S3 tiering.
- Wildcard **TLS / cert-manager**, per-sandbox **egress firewall**, custom domains.

These are the items the doc itself scopes as "assembled, not authored" or defers;
the MVP focuses on the orchestration glue that is genuinely bex's to build.

## Layout

```
src/
  server.js     entrypoint: control plane (:8080) + edge (:8081) + idle loop
  api.js        /v1 route handlers
  router.js     edge reverse proxy + wake-on-request activator
  webhook.js    HMAC-SHA256 signature verify + push payload parse
  builder.js    clone → CNB `pack build` (Paketo) | Dockerfile → push to Zot
  deployer.js   build → start revision → health-check → traffic shift → rollback
  lifecycle.js  health-check + hibernate / wake / destroy (runtime-agnostic)
  runtimes/
    index.js        select runtime by BEX_RUNTIME
    docker.js       run/stop/start containers; route via published host port
    opensandbox.js  OpenSandbox Lifecycle API; pause/resume snapshots; per-sandbox endpoint
  idle.js       idle detector ("sleep = free" trigger)
  docker.js     Docker CLI wrapper + Zot registry bootstrap
  store.js      JSON-file state (the control-plane "Postgres")
  config.js · ids.js · log.js
examples/hello-node/        the trivial "agent": 200 OK on every GET
deploy/opensandbox/         OpenSandbox server config (Docker runtime)
scripts/dev.sh              run the gateway
scripts/start-opensandbox.sh  run a host OpenSandbox server on :8077
scripts/demo.sh             full end-to-end demo (self-contained)
```

Runtime state, build logs, and cloned repos live under `data/` (gitignored).
