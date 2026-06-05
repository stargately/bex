// Thin wrapper over the Docker CLI (OrbStack daemon). Docker containers are the
// MVP's stand-in for the doc's Kata/Firecracker microVMs: `docker run` = schedule
// a microVM, `docker stop`/`start` = hibernate/wake, the container's writable
// layer = the per-sandbox CoW overlay on NVMe.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logger } from './log.js';

const log = logger('docker');

// Run a command, capturing combined output. If `logFile` is set, output is also
// appended there (used to stream build logs to disk for GET /v1/builds/:id/logs).
export function run(cmd, args, { cwd, env, logFile } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let out = '';
    let err = '';
    const sink = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    child.stdout.on('data', (d) => {
      out += d;
      if (sink) sink.write(d);
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (sink) sink.write(d);
    });
    child.on('error', (e) => {
      if (sink) sink.end();
      resolve({ code: -1, out, err: err + String(e) });
    });
    child.on('close', (code) => {
      if (sink) sink.end();
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

export async function docker(args, opts) {
  return run('docker', args, opts);
}

// Is a container with this exact name running / present?
export async function containerState(nameOrId) {
  const r = await docker(['inspect', '--format', '{{.State.Status}}', nameOrId]);
  if (r.code !== 0) return 'absent';
  return r.out; // running | exited | created | paused ...
}

// Read the host port Docker assigned to a published container port.
export async function publishedPort(nameOrId, containerPort) {
  const r = await docker([
    'inspect',
    '--format',
    `{{(index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort}}`,
    nameOrId,
  ]);
  if (r.code !== 0) return null;
  const p = Number(r.out);
  return Number.isFinite(p) && p > 0 ? p : null;
}

// First published host port of a container, regardless of the container port
// (our containers publish exactly one). Used after run/start where the mapping
// is auto-assigned and may change across stop/start.
export async function firstHostPort(nameOrId) {
  const r = await docker(['inspect', '--format', '{{json .NetworkSettings.Ports}}', nameOrId]);
  if (r.code !== 0) return null;
  let ports;
  try {
    ports = JSON.parse(r.out || '{}');
  } catch {
    return null;
  }
  for (const k of Object.keys(ports)) {
    const arr = ports[k];
    if (Array.isArray(arr) && arr[0]?.HostPort) return Number(arr[0].HostPort);
  }
  return null;
}

// Entrypoint to run an image as a process: the image's ENTRYPOINT plus CMD.
// OpenSandbox requires an explicit entrypoint; for a CNB image this is
// ["/cnb/process/web"], for a Dockerfile image it's whatever the image declares.
export async function imageEntrypoint(image) {
  const r = await docker(['inspect', '--format', '{{json .Config.Entrypoint}}|{{json .Config.Cmd}}', image]);
  if (r.code !== 0) throw new Error('could not inspect image entrypoint: ' + r.err);
  const [epRaw, cmdRaw] = r.out.split('|');
  const ep = JSON.parse(epRaw || 'null') || [];
  const cmd = JSON.parse(cmdRaw || 'null') || [];
  const entry = [...ep, ...cmd];
  if (entry.length === 0) throw new Error('image declares no entrypoint/cmd');
  return entry;
}

export async function startContainer(nameOrId) {
  return docker(['start', nameOrId]);
}

export async function stopContainer(nameOrId) {
  return docker(['stop', '-t', '3', nameOrId]);
}

export async function removeContainer(nameOrId) {
  return docker(['rm', '-f', nameOrId]);
}

// Ensure the local OCI registry (Zot) is up. This is the "Build plane -> registry"
// hop: builds push here, deploys reference it. Zot listens on :5000 inside the
// container with a no-auth default config.
export async function ensureRegistry(name, hostPort, image) {
  const state = await containerState(name);
  if (state === 'running') return true;
  if (state !== 'absent') await removeContainer(name);
  log.info('starting local registry (zot)', { name, hostPort, image });
  const r = await docker([
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '-p', `${hostPort}:5000`,
    image,
  ]);
  if (r.code !== 0) {
    log.warn('registry start failed (continuing without registry)', { err: r.err });
    return false;
  }
  return true;
}
