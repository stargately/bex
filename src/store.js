// JSON-file-backed state store. Stands in for the control-plane Postgres in the
// architecture doc ("identity map: tenant -> sandbox/service -> URL"). Holds the
// logical objects — services, deploys, builds — and their lifecycle state.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { logger } from './log.js';

const log = logger('store');

const db = {
  services: {}, // id -> service
  deploys: {}, // id -> deploy
  builds: {}, // id -> build
};

function ensureDirs() {
  for (const dir of [config.dataDir, paths.builds(), paths.deploys(), paths.work(), paths.repos()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(paths.state(), 'utf8');
    Object.assign(db, JSON.parse(raw));
    log.info('state loaded', {
      services: Object.keys(db.services).length,
      deploys: Object.keys(db.deploys).length,
    });
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('could not load state, starting fresh', { err: e.message });
  }
}

let saveTimer = null;
export function save() {
  // Debounced atomic write — avoids thrashing the disk on bursty updates.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = paths.state() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, paths.state());
  }, 50);
}

export function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const tmp = paths.state() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, paths.state());
}

// --- services ---
export const services = {
  get: (id) => db.services[id],
  all: () => Object.values(db.services),
  byHost: (host) => Object.values(db.services).find((s) => s.host === host),
  put: (svc) => {
    svc.updatedAt = new Date().toISOString();
    db.services[svc.id] = svc;
    save();
    return svc;
  },
  remove: (id) => {
    delete db.services[id];
    save();
  },
};

// --- deploys ---
export const deploys = {
  get: (id) => db.deploys[id],
  forService: (sid) => Object.values(db.deploys).filter((d) => d.serviceId === sid),
  put: (dep) => {
    db.deploys[dep.id] = dep;
    save();
    return dep;
  },
};

// --- builds ---
export const builds = {
  get: (id) => db.builds[id],
  put: (b) => {
    db.builds[b.id] = b;
    save();
    return b;
  },
};

export function buildLogPath(buildId) {
  return path.join(paths.builds(), `${buildId}.log`);
}
