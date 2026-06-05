// Central configuration for the bex gateway. All knobs are env-overridable so
// the demo can run with aggressive idle TTLs without code changes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function num(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

export const config = {
  root: ROOT,
  // API / control-plane port (the "gateway"): /v1/* + /healthz
  apiPort: num('BEX_API_PORT', 8080),
  // Edge / serve port (the "ingress"): routes <name>-<id>.<domain> -> container
  edgePort: num('BEX_EDGE_PORT', 8081),
  // Subdomain suffix the edge routes on. Requests arrive as Host: <host>.<serveDomain>
  serveDomain: process.env.BEX_SERVE_DOMAIN || 'localhost',
  // Runtime substrate for service revisions: 'docker' (plain containers) or
  // 'opensandbox' (OpenSandbox lifecycle API — real pause/resume snapshots).
  runtime: process.env.BEX_RUNTIME || 'docker',
  // Host OpenSandbox server (Docker runtime). See scripts/start-opensandbox.sh.
  opensandboxUrl: process.env.BEX_OPENSANDBOX_URL || 'http://127.0.0.1:8077',
  // OpenSandbox server in KUBERNETES runtime mode (schedules into the vcluster).
  // See scripts/start-opensandbox-k8s.sh. The edge reaches pods via kubectl
  // port-forward (OrbStack doesn't route cluster pod IPs to the host).
  opensandboxK8sUrl: process.env.BEX_OPENSANDBOX_K8S_URL || 'http://127.0.0.1:8078',
  opensandboxK8sNamespace: process.env.BEX_OPENSANDBOX_NS || 'opensandbox',
  vclusterKubeconfig:
    process.env.BEX_VCLUSTER_KUBECONFIG || `${ROOT}/deploy/opensandbox/vcluster-acme.kubeconfig`,
  sandboxCpu: process.env.BEX_SANDBOX_CPU || '1',
  sandboxMemory: process.env.BEX_SANDBOX_MEMORY || '512Mi',
  sandboxTimeoutSec: num('BEX_SANDBOX_TIMEOUT_SEC', 86_400),

  // Local OCI registry — Zot (one of the two registries the doc names). Use the
  // IPv4 literal: OpenSandbox's Docker pull resolves "localhost" to IPv6 [::1]
  // (where the published port isn't bound) and fails. Docker treats 127.0.0.1
  // registries as insecure (HTTP), so no daemon config is needed.
  registry: process.env.BEX_REGISTRY || '127.0.0.1:5050',
  registryContainer: 'bex-zot',
  // arm64 image for this Mac; override (e.g. zot-linux-amd64) on Hetzner.
  registryImage: process.env.BEX_REGISTRY_IMAGE || 'ghcr.io/project-zot/zot-linux-arm64:latest',
  // Cloud Native Buildpacks builder used by `pack build`. Paketo's jammy-base is
  // amd64-only -> on Apple Silicon it builds amd64 images (correct for Hetzner)
  // that run under OrbStack emulation locally.
  cnbBuilder: process.env.BEX_CNB_BUILDER || 'paketobuildpacks/builder-jammy-base',
  // Where runtime state, logs and cloned repos live (gitignored).
  dataDir: process.env.BEX_DATA_DIR || path.join(ROOT, 'data'),
  // Lifecycle / "sleep = free" knobs.
  idleTtlMs: num('BEX_IDLE_TTL_MS', 60_000), // hibernate after this much inactivity
  idleCheckMs: num('BEX_IDLE_CHECK_MS', 10_000), // how often the idle detector runs
  healthTimeoutMs: num('BEX_HEALTH_TIMEOUT_MS', 45_000), // health-check / wake budget
  healthIntervalMs: num('BEX_HEALTH_INTERVAL_MS', 500),
  // Label namespace stamped on every container we manage.
  label: 'bex.service',
};

export const paths = {
  state: () => path.join(config.dataDir, 'state.json'),
  builds: () => path.join(config.dataDir, 'builds'),
  deploys: () => path.join(config.dataDir, 'deploys'),
  work: () => path.join(config.dataDir, 'work'),
  repos: () => path.join(config.dataDir, 'repos'),
};
