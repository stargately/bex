// OpenSandbox KUBERNETES runtime — the doc's full substrate. Sandboxes are
// created via the OpenSandbox Lifecycle API on a server running in `kubernetes`
// mode (:8078), which writes BatchSandbox CRs into a per-tenant vcluster; the
// opensandbox-controller reconciles them into pods, and vcluster syncs those to
// the host OrbStack cluster.
//
// Edge routing: OrbStack does not route cluster pod IPs to the host, so the edge
// reaches a sandbox via `kubectl port-forward` to its pod (a local-dev stand-in
// for the in-cluster ingress/gateway a real deployment would use). The forward is
// re-established on resume.
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { imageEntrypoint } from '../docker.js';
import { logger } from '../log.js';

const log = logger('rt:opensandbox-k8s');
const BASE = config.opensandboxK8sUrl;
const NS = config.opensandboxK8sNamespace;
const KCFG = config.vclusterKubeconfig;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = 'opensandbox-k8s';

// Hibernate/wake via SandboxSnapshot requires the controller's image-committer to
// reach a standalone containerd CRI socket on the node. OrbStack's Kubernetes runs
// on cri-dockerd (Docker), where that socket path doesn't exist, so snapshot
// pause/resume can't work here. Declared unsupported so the idle detector skips it
// (use BEX_RUNTIME=opensandbox for real pause/resume, or a containerd-CRI cluster).
export const supportsPause = false;

// active port-forwards: sandboxId -> { proc, port }
const forwards = new Map();

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const RUNNING = ['Running', 'running', 'Ready', 'ready'];
const PAUSED = ['Paused', 'paused', 'Stopped', 'stopped', 'Suspended', 'suspended'];
const FAILED = ['Failed', 'failed', 'Error', 'error'];

async function waitForState(id, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const g = await req('GET', `/sandboxes/${id}`);
    const st = g.json?.status?.state;
    if (st && st !== last) {
      log.info('sandbox state', { id, state: st });
      last = st;
    }
    if (want.includes(st)) return st;
    if (FAILED.includes(st)) throw new Error(`sandbox ${id} -> ${st}: ${JSON.stringify(g.json?.status)}`);
    await sleep(700);
  }
  throw new Error(`timed out waiting for sandbox ${id} -> ${want[0]}`);
}

function stopForward(id) {
  const f = forwards.get(id);
  if (f) {
    try {
      f.proc.kill();
    } catch {}
    forwards.delete(id);
  }
}

// kubectl port-forward to the sandbox pod (<id>-0). Resolves with the local port.
function startForward(id, appPort) {
  stopForward(id);
  return new Promise((resolve, reject) => {
    const proc = spawn('kubectl', [
      '--kubeconfig', KCFG,
      'port-forward', '-n', NS, `pod/${id}-0`, `0:${appPort}`,
    ]);
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { proc.kill(); } catch {}
        reject(new Error('port-forward did not establish in time'));
      }
    }, 20_000);
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        forwards.set(id, { proc, port: Number(m[1]) });
        log.info('port-forward up', { id, localPort: Number(m[1]) });
        resolve(Number(m[1]));
      }
    });
    proc.stderr.on('data', (d) => log.warn('port-forward stderr', { id, msg: String(d).trim().slice(0, 120) }));
    proc.on('exit', () => forwards.delete(id));
  });
}

async function target(id, appPort) {
  const port = await startForward(id, appPort);
  return { host: '127.0.0.1', port, prefix: '' };
}

export async function start({ image, port, env, serviceId }) {
  const entrypoint = await imageEntrypoint(image);
  const body = {
    image: { uri: image },
    entrypoint,
    env: { PORT: String(port), ...(env || {}) },
    resourceLimits: { cpu: config.sandboxCpu, memory: config.sandboxMemory },
    metadata: { 'bex.service': serviceId },
    timeout: config.sandboxTimeoutSec,
  };
  const r = await req('POST', '/sandboxes', body);
  const id = r.json?.id;
  if (r.status >= 300 || !id) throw new Error('opensandbox(k8s) create failed: ' + JSON.stringify(r.json));
  log.info('sandbox created (BatchSandbox CR)', { id, image });
  await waitForState(id, RUNNING, 180_000); // CR -> controller -> pod -> image pull
  return { handle: id, target: await target(id, port) };
}

export async function pause() {
  // See supportsPause above — not available on OrbStack's cri-dockerd k8s.
  throw new Error('snapshot pause unsupported on this k8s runtime (cri-dockerd node)');
}

export async function resume(handle, port) {
  const r = await req('POST', `/sandboxes/${handle}/resume`);
  if (r.status >= 300) throw new Error('resume failed: ' + JSON.stringify(r.json));
  await waitForState(handle, RUNNING, config.healthTimeoutMs);
  return { target: await target(handle, port) };
}

export async function remove(handle) {
  stopForward(handle);
  await req('DELETE', `/sandboxes/${handle}`);
}

export async function removeAllForService(serviceId) {
  const r = await req('GET', '/sandboxes?pageSize=100');
  for (const s of r.json?.items || []) {
    if (s.metadata?.['bex.service'] === serviceId) {
      stopForward(s.id);
      await req('DELETE', `/sandboxes/${s.id}`);
    }
  }
}
