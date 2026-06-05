// Control-plane HTTP API — the bex.co gateway surface for the Render-like
// deploy-from-git half. Mirrors the doc's "Minimal End-to-End: API Walkthrough":
//
//   POST   /v1/services              create git-backed service; register webhook; auto-deploy
//   GET    /v1/services/:id          service state (provisioning|running|hibernated|...)
//   DELETE /v1/services/:id          teardown
//   POST   /v1/services/:id/deploys  manually build + deploy a ref
//   POST   /v1/webhooks/git/:id      receive git push -> verify HMAC -> enqueue deploy
//   GET    /v1/builds/:id            build status + image ref
//   GET    /v1/builds/:id/logs       streamed build log (plain text)
//   GET    /v1/deploys/:id           deploy/revision status (building -> live)
import fs from 'node:fs';
import { config } from './config.js';
import { services, deploys, builds } from './store.js';
import { newServiceId, newWebhookSecret } from './ids.js';
import { enqueueDeploy, serviceUrl } from './deployer.js';
import { destroy } from './lifecycle.js';
import { verifySignature, parsePush } from './webhook.js';
import { logger } from './log.js';

const log = logger('api');

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function apiBase(req) {
  const host = req.headers.host || `localhost:${config.apiPort}`;
  return process.env.BEX_API_PUBLIC_BASE || `http://${host}`;
}

function authed(req) {
  const key = process.env.BEX_API_KEY;
  if (!key) return true; // dev mode: no key configured
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${key}`;
}

// Public view of a service (hide nothing sensitive beyond what the doc shows).
function serviceView(svc) {
  return {
    id: svc.id,
    name: svc.name,
    state: svc.state,
    url: serviceUrl(svc),
    repo: svc.repo,
    branch: svc.branch,
    revision: svc.activeRevision,
    image: svc.image,
    webhook: svc.webhook,
    currentDeploy: svc.currentDeploy,
    createdAt: svc.createdAt,
  };
}

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/') {
    return json(res, 200, {
      service: 'bex gateway',
      docs: 'POST /v1/services to begin (see README)',
      services: services.all().length,
    });
  }

  // Everything under /v1 except the webhook requires the API key (if configured).
  const isWebhook = parts[0] === 'v1' && parts[1] === 'webhooks';
  if (parts[0] === 'v1' && !isWebhook && !authed(req)) {
    return json(res, 401, { error: 'unauthorized', hint: 'Authorization: Bearer $BEX_API_KEY' });
  }

  // POST /v1/services
  if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'services' && parts.length === 2) {
    const body = await readBody(req);
    let spec;
    try {
      spec = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    if (!spec.name || !spec.repo) {
      return json(res, 400, { error: 'name and repo are required' });
    }
    const id = newServiceId();
    const svc = {
      id,
      name: spec.name,
      host: `${spec.name}-${id}`,
      repo: spec.repo,
      branch: spec.branch || 'main',
      build: { builder: spec.build?.builder || 'auto' },
      run: {
        port: spec.run?.port || 3000,
        healthCheckPath: spec.run?.healthCheckPath || '/',
      },
      envs: spec.envs || {},
      autoDeploy: spec.autoDeploy !== false,
      webhook: {
        url: `${apiBase(req)}/v1/webhooks/git/${id}`,
        secret: newWebhookSecret(),
      },
      state: 'provisioning',
      revisionCounter: 0,
      activeRevision: null,
      handle: null,
      target: null,
      runtime: null,
      image: null,
      lastRequestAt: Date.now(),
      currentDeploy: null,
      createdAt: new Date().toISOString(),
    };
    services.put(svc);
    let deploy = null;
    if (svc.autoDeploy) deploy = enqueueDeploy(svc, svc.branch);
    log.info('service created', { id, name: svc.name, repo: svc.repo });
    return json(res, 201, {
      id: svc.id,
      state: svc.state,
      url: serviceUrl(svc),
      webhook: svc.webhook,
      deploy: deploy ? { id: deploy.id, status: deploy.status } : null,
    });
  }

  // /v1/services/:id  and  /v1/services/:id/deploys
  if (parts[0] === 'v1' && parts[1] === 'services' && parts[2]) {
    const svc = services.get(parts[2]);
    if (!svc) return json(res, 404, { error: 'service not found' });

    if (method === 'GET' && parts.length === 3) return json(res, 200, serviceView(svc));

    if (method === 'DELETE' && parts.length === 3) {
      await destroy(svc);
      services.remove(svc.id);
      log.info('service deleted', { id: svc.id });
      return json(res, 200, { id: svc.id, deleted: true });
    }

    if (method === 'POST' && parts[3] === 'deploys') {
      const body = await readBody(req);
      let ref = svc.branch;
      try {
        const o = JSON.parse(body || '{}');
        if (o.ref) ref = o.ref;
      } catch {}
      const dep = enqueueDeploy(svc, ref);
      return json(res, 202, { id: dep.id, status: dep.status, buildId: dep.buildId });
    }
  }

  // POST /v1/webhooks/git/:id  (HMAC-verified, no bearer key)
  if (method === 'POST' && isWebhook && parts[2] === 'git' && parts[3]) {
    const svc = services.get(parts[3]);
    if (!svc) return json(res, 404, { error: 'service not found' });
    const body = await readBody(req);
    const sig = req.headers['x-hub-signature-256'];
    if (!verifySignature(svc.webhook.secret, body, sig)) {
      log.warn('webhook signature rejected', { service: svc.id });
      return json(res, 401, { error: 'invalid signature' });
    }
    const { branch, after } = parsePush(body, svc);
    const dep = enqueueDeploy(svc, after || branch);
    log.info('webhook accepted -> deploy', { service: svc.id, branch, deploy: dep.id });
    return json(res, 202, { deploy: { id: dep.id, status: dep.status } });
  }

  // GET /v1/builds/:id  and  /v1/builds/:id/logs
  if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'builds' && parts[2]) {
    const b = builds.get(parts[2]);
    if (!b) return json(res, 404, { error: 'build not found' });
    if (parts[3] === 'logs') {
      let text = '';
      try {
        text = fs.readFileSync(b.logFile, 'utf8');
      } catch {}
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(text);
    }
    return json(res, 200, {
      id: b.id,
      status: b.status,
      image: b.image,
      commit: b.commit,
      logs: `${apiBase(req)}/v1/builds/${b.id}/logs`,
      error: b.error,
    });
  }

  // GET /v1/deploys/:id
  if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'deploys' && parts[2]) {
    const d = deploys.get(parts[2]);
    if (!d) return json(res, 404, { error: 'deploy not found' });
    const svc = services.get(d.serviceId);
    return json(res, 200, {
      id: d.id,
      status: d.status,
      revision: d.revision,
      buildId: d.buildId,
      commit: d.commit,
      serviceUrl: svc ? serviceUrl(svc) : d.serviceUrl,
      error: d.error,
    });
  }

  return json(res, 404, { error: 'not found', path: url.pathname });
}
