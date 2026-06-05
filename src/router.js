// Edge / serve plane — the wildcard ingress + activator. Routes
// Host: <name>-<id>.<serveDomain> to the service's running container, and on a
// hit to a hibernated service it parks the request, wakes the container, and
// then forwards (the doc's wake-on-request — "the caller only ever sees the 200").
import http from 'node:http';
import { config } from './config.js';
import { services } from './store.js';
import { wake } from './lifecycle.js';
import { logger } from './log.js';

const log = logger('edge');

// Coalesce concurrent wakes for the same service into one in-flight promise.
const waking = new Map();
function wakeOnce(svc) {
  if (!waking.has(svc.id)) {
    const p = wake(svc).finally(() => waking.delete(svc.id));
    waking.set(svc.id, p);
  }
  return waking.get(svc.id);
}

function hostLabel(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host.split('.')[0]; // <name>-<id>
}

function send(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(msg + '\n');
}

export function createEdgeServer() {
  return http.createServer(async (req, res) => {
    const label = hostLabel(req);
    const svc = services.byHost(label);
    if (!svc) {
      return send(res, 404, `bex edge: no service for host "${label}". Use Host: <name>-<id>.${config.serveDomain}`);
    }

    // Wake-on-request if hibernated/idle/resuming.
    if (svc.state !== 'running') {
      log.info('request to non-running service -> wake', { service: svc.id, state: svc.state });
      const ok = await wakeOnce(svc);
      if (!ok) return send(res, 503, `bex edge: service ${svc.id} failed to wake`);
    }
    svc.lastRequestAt = Date.now();

    const target = svc.target;
    if (!target || !target.port) return send(res, 502, 'bex edge: no upstream target');

    // Forward to the runtime target. `prefix` is empty for docker; for
    // opensandbox it is the per-sandbox proxy path (e.g. /proxy/3000).
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: (target.prefix || '') + req.url,
        headers: req.headers,
        timeout: 30_000,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      log.warn('upstream error', { service: svc.id, err: e.message });
      if (!res.headersSent) send(res, 502, 'bex edge: upstream error');
      else res.end();
    });
    upstream.on('timeout', () => upstream.destroy());
    req.pipe(upstream);
  });
}
