// OpenSandbox runtime — service revisions as OpenSandbox sandboxes via the
// Lifecycle API (POST /sandboxes, pause, resume, snapshots). This is the doc's
// centerpiece: hibernate/wake become *real* pause/resume snapshots, not just
// container stop/start.
//
// Routing: each sandbox exposes a per-sandbox host endpoint
// (GET /sandboxes/:id/endpoints/:port -> "127.0.0.1:<hostport>/proxy/<port>"),
// which the edge forwards to. The host port can change across pause/resume, so
// we re-fetch the endpoint on resume.
import { config } from '../config.js';
import { imageEntrypoint } from '../docker.js';
import { logger } from '../log.js';

const log = logger('rt:opensandbox');
const BASE = config.opensandboxUrl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = 'opensandbox';

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
    await sleep(500);
  }
  throw new Error(`timed out waiting for sandbox ${id} -> ${want[0]}`);
}

// GET the per-sandbox host endpoint and parse it into {host,port,prefix}.
async function endpointTarget(id, port) {
  const r = await req('GET', `/sandboxes/${id}/endpoints/${port}`);
  const ep = r.json?.endpoint; // e.g. "127.0.0.1:48775/proxy/3000"
  if (!ep) throw new Error(`no endpoint for sandbox ${id}:${port}: ${JSON.stringify(r.json)}`);
  const slash = ep.indexOf('/');
  const hostport = slash === -1 ? ep : ep.slice(0, slash);
  const prefix = slash === -1 ? '' : ep.slice(slash); // "/proxy/3000"
  const [host, p] = hostport.split(':');
  return { host, port: Number(p), prefix };
}

export async function start({ image, port, env, serviceId }) {
  // OpenSandbox requires an explicit entrypoint; derive it from the built image.
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
  if (r.status >= 300 || !id) throw new Error('opensandbox create failed: ' + JSON.stringify(r.json));
  log.info('sandbox created', { id, image });
  await waitForState(id, RUNNING, 120_000); // includes image pull
  const target = await endpointTarget(id, port);
  return { handle: id, target };
}

export async function pause(handle) {
  const r = await req('POST', `/sandboxes/${handle}/pause`);
  if (r.status >= 300) throw new Error('pause failed: ' + JSON.stringify(r.json));
  await waitForState(handle, PAUSED, config.healthTimeoutMs);
}

export async function resume(handle, port) {
  const r = await req('POST', `/sandboxes/${handle}/resume`);
  if (r.status >= 300) throw new Error('resume failed: ' + JSON.stringify(r.json));
  await waitForState(handle, RUNNING, config.healthTimeoutMs);
  const target = await endpointTarget(handle, port);
  return { target };
}

export async function remove(handle) {
  await req('DELETE', `/sandboxes/${handle}`);
}

// Best-effort: delete every sandbox tagged with this service.
export async function removeAllForService(serviceId) {
  const r = await req('GET', '/sandboxes?pageSize=100');
  for (const s of r.json?.items || []) {
    if (s.metadata?.['bex.service'] === serviceId) await req('DELETE', `/sandboxes/${s.id}`);
  }
}
