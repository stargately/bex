// bex gateway entrypoint. Brings up two listeners and the background lifecycle:
//   :apiPort  — control plane (/v1/*, /healthz)         [api.js]
//   :edgePort — edge / serve plane (wake-on-request)    [router.js]
//   idle loop — hibernates idle services ("sleep = free") [idle.js]
import http from 'node:http';
import { config } from './config.js';
import { load, saveNow } from './store.js';
import { ensureRegistry } from './docker.js';
import { handleApi } from './api.js';
import { createEdgeServer } from './router.js';
import { startIdleDetector } from './idle.js';
import { runtime } from './runtimes/index.js';
import { logger } from './log.js';

const log = logger('server');

async function main() {
  load();
  runtime(); // validate BEX_RUNTIME early

  // Bring up the local OCI registry (build -> registry -> deploy hop).
  const [, regPort] = config.registry.split(':');
  await ensureRegistry(config.registryContainer, regPort || '5000', config.registryImage);

  const api = http.createServer((req, res) => {
    handleApi(req, res).catch((e) => {
      log.error('api handler error', { err: e.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', detail: e.message }));
      }
    });
  });
  api.listen(config.apiPort, () => log.info(`control plane on :${config.apiPort}`));

  const edge = createEdgeServer();
  edge.listen(config.edgePort, () => log.info(`edge / serve on :${config.edgePort}`));

  startIdleDetector();

  // Flush state on shutdown — the debounced save would otherwise drop the last
  // mutation (e.g. a DELETE) when the process is killed right after.
  const shutdown = (sig) => {
    log.info('shutting down, flushing state', { sig });
    try {
      saveNow();
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info('bex gateway ready', {
    api: `http://localhost:${config.apiPort}`,
    edge: `http://localhost:${config.edgePort} (Host: <name>-<id>.${config.serveDomain})`,
    runtime: config.runtime,
    registry: config.registry,
    idleTtlMs: config.idleTtlMs,
  });
}

main().catch((e) => {
  log.error('failed to start', { err: e.stack || e.message });
  process.exit(1);
});
