// Deploy orchestrator — the "deploy (new revision)" path from the doc:
// build -> run new revision -> health-check -> shift traffic (zero-downtime)
// -> retire old revision. A failed health check leaves the previous revision
// serving (auto-rollback).
import { build } from './builder.js';
import { healthCheck } from './lifecycle.js';
import { runtime } from './runtimes/index.js';
import { services, deploys } from './store.js';
import { newDeployId } from './ids.js';
import { logger } from './log.js';
import { config } from './config.js';

const log = logger('deployer');

// Create a queued deploy and process it in the background. Returns immediately
// with the deploy record (the API responds 202 Accepted).
export function enqueueDeploy(service, ref) {
  const dep = deploys.put({
    id: newDeployId(),
    serviceId: service.id,
    status: 'queued',
    ref: ref || service.branch,
    commit: null,
    buildId: null,
    revision: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  });
  service.currentDeploy = dep.id;
  services.put(service);
  // fire-and-forget; errors are captured onto the deploy record
  processDeploy(dep.id).catch((e) => log.error('deploy crashed', { id: dep.id, err: e.message }));
  return dep;
}

async function processDeploy(deployId) {
  const dep = deploys.get(deployId);
  const service = services.get(dep.serviceId);
  if (!service) return;

  // --- build ---
  dep.status = 'building';
  deploys.put(dep);
  const buildRec = await build({ service, ref: dep.ref });
  dep.buildId = buildRec.id;
  dep.commit = buildRec.commit;
  if (buildRec.status !== 'succeeded') {
    dep.status = 'failed';
    dep.error = buildRec.error || 'build failed';
    dep.finishedAt = new Date().toISOString();
    deploys.put(dep);
    // keep the previous revision serving; only fail the service if nothing is live
    if (!service.containerId) {
      service.state = 'failed';
      services.put(service);
    }
    log.error('deploy failed at build', { deploy: dep.id });
    return;
  }

  // --- run new revision on the runtime (docker | opensandbox) ---
  dep.status = 'deploying';
  deploys.put(dep);
  const revision = (service.revisionCounter || 0) + 1;
  const rt = runtime();
  let started;
  try {
    started = await rt.start({
      image: buildRec.image,
      port: service.run?.port || 3000,
      env: service.envs,
      revision,
      serviceId: service.id,
    });
  } catch (e) {
    dep.status = 'failed';
    dep.error = e.message;
    dep.finishedAt = new Date().toISOString();
    deploys.put(dep);
    if (!service.handle) {
      service.state = 'failed';
      services.put(service);
    }
    log.error('deploy failed at run', { deploy: dep.id, err: e.message });
    return;
  }

  // --- health-check the new revision before shifting traffic ---
  const healthy = await healthCheck(started.target, service.run?.healthCheckPath);
  if (!healthy) {
    await rt.remove(started.handle); // discard the bad revision
    dep.status = 'failed';
    dep.error = 'health check failed';
    dep.finishedAt = new Date().toISOString();
    deploys.put(dep);
    if (!service.handle) {
      service.state = 'failed';
      services.put(service);
    }
    log.error('deploy failed health check (auto-rollback)', { deploy: dep.id });
    return;
  }

  // --- shift traffic: point the edge at the new revision, retire the old ---
  const old = service.handle;
  service.handle = started.handle;
  service.target = started.target;
  service.runtime = rt.name;
  service.image = buildRec.image;
  service.revisionCounter = revision;
  service.activeRevision = `rev_${revision}`;
  service.state = 'running';
  service.lastRequestAt = Date.now();
  services.put(service);

  if (old && old !== started.handle) await rt.remove(old);

  dep.status = 'live';
  dep.revision = `rev_${revision}`;
  dep.serviceUrl = serviceUrl(service);
  dep.finishedAt = new Date().toISOString();
  deploys.put(dep);
  log.info('deploy live', { deploy: dep.id, revision: dep.revision, url: dep.serviceUrl });
}

export function serviceUrl(service) {
  const port = config.edgePort === 80 ? '' : `:${config.edgePort}`;
  return `http://${service.host}.${config.serveDomain}${port}/`;
}
