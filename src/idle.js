// Idle detector — the "sleep = free" trigger. Periodically scans running
// services and hibernates any with no traffic for longer than the idle TTL.
// (The doc's idle controller: no requests / no open session -> pause + evict pod.)
import { config } from './config.js';
import { services } from './store.js';
import { hibernate } from './lifecycle.js';
import { runtime } from './runtimes/index.js';
import { logger } from './log.js';

const log = logger('idle');

export function startIdleDetector() {
  // Some runtimes can't hibernate (e.g. opensandbox-k8s on cri-dockerd has no
  // usable snapshot path) — don't churn trying.
  if (runtime().supportsPause === false) {
    log.info('idle hibernation disabled for runtime (pause unsupported)', { runtime: config.runtime });
    return null;
  }
  log.info('idle detector running', { ttlMs: config.idleTtlMs, everyMs: config.idleCheckMs });
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const svc of services.all()) {
      if (svc.state !== 'running') continue;
      const last = svc.lastRequestAt || 0;
      if (now - last > config.idleTtlMs) {
        log.info('service idle past TTL -> hibernate', {
          service: svc.id,
          idleMs: now - last,
        });
        await hibernate(svc).catch((e) => log.warn('hibernate failed', { err: e.message }));
      }
    }
  }, config.idleCheckMs);
  timer.unref?.();
  return timer;
}
