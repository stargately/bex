// Lifecycle orchestration over a pluggable runtime (docker | opensandbox).
// Maps the doc's state machine to runtime ops:
//   start  ~ schedule (Provisioning -> Running)
//   pause  ~ hibernate / "sleep = free" (Running/Idle -> Hibernated)
//   resume ~ wake-on-request (Hibernated -> Resuming -> Running)
//
// A service's edge target is `{host, port, prefix}` — the runtime decides how it
// is reached (docker: a published host port; opensandbox: a per-sandbox endpoint
// like 127.0.0.1:<port>/proxy/<appPort>). Targets can change across a wake, so
// resume always returns a fresh one.
import http from 'node:http';
import { config } from './config.js';
import { runtime } from './runtimes/index.js';
import { services } from './store.js';
import { logger } from './log.js';

const log = logger('lifecycle');

// Poll an edge target until it answers 2xx/3xx, or give up after `timeout`.
export function healthCheck(target, healthPath, timeoutMs = config.healthTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const path = (target.prefix || '') + (healthPath || '/');
  return new Promise((resolve) => {
    const attempt = () => {
      const reqx = http.request(
        { host: target.host, port: target.port, path, method: 'GET', timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode >= 200 && res.statusCode < 400) return resolve(true);
          retry();
        },
      );
      reqx.on('error', retry);
      reqx.on('timeout', () => reqx.destroy());
      reqx.end();
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, config.healthIntervalMs);
    };
    attempt();
  });
}

// Idle -> Hibernated: pause via the runtime (real snapshot on opensandbox; stop
// on docker). Compute is freed; the service keeps its identity + URL.
export async function hibernate(service) {
  if (!service.handle || service.state === 'hibernated') return;
  log.info('hibernating', { service: service.id, runtime: service.runtime });
  await runtime().pause(service.handle);
  service.state = 'hibernated';
  services.put(service);
}

// Hibernated -> Resuming -> Running: resume, refresh the target, re-health-check.
export async function wake(service) {
  if (service.state === 'running') return true;
  if (!service.handle) return false;
  log.info('waking', { service: service.id, runtime: service.runtime });
  service.state = 'resuming';
  services.put(service);
  try {
    const { target } = await runtime().resume(service.handle, service.run?.port || 3000);
    service.target = target;
  } catch (e) {
    log.warn('resume failed', { service: service.id, err: e.message });
    service.state = 'failed';
    services.put(service);
    return false;
  }
  const ok = await healthCheck(service.target, service.run?.healthCheckPath);
  service.state = ok ? 'running' : 'failed';
  service.lastRequestAt = Date.now();
  services.put(service);
  return ok;
}

// Tear down all runtime resources for a service.
export async function destroy(service) {
  try {
    if (service.handle) await runtime().remove(service.handle);
    await runtime().removeAllForService(service.id);
  } catch (e) {
    log.warn('destroy had errors', { service: service.id, err: e.message });
  }
}
