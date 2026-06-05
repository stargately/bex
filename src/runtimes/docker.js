// Docker runtime — service revisions as plain Docker containers. `run`/`stop`/
// `start` stand in for schedule/hibernate/wake. Hibernation here frees CPU/RAM
// but keeps the writable layer (no memory snapshot — contrast the opensandbox
// runtime, which uses real pause/resume snapshots).
import { config } from '../config.js';
import {
  docker,
  firstHostPort,
  startContainer,
  stopContainer,
  removeContainer,
  containerState,
} from '../docker.js';
import { logger } from '../log.js';

const log = logger('rt:docker');

export const name = 'docker';

function containerName(serviceId, revision) {
  return `bex_${serviceId}_r${revision}`;
}

// start a fresh container; returns { handle, target:{host,port,prefix} }
export async function start({ image, port, env, revision, serviceId }) {
  const handle = containerName(serviceId, revision);
  await removeContainer(handle);
  const args = [
    'run', '-d',
    '--name', handle,
    '-l', `${config.label}=${serviceId}`,
    '-l', `bex.revision=${revision}`,
    '-e', `PORT=${port}`,
    '-p', `0:${port}`,
  ];
  for (const [k, v] of Object.entries(env || {})) args.push('-e', `${k}=${v}`);
  args.push(image);
  const r = await docker(args);
  if (r.code !== 0) throw new Error('docker run failed: ' + r.err);
  const hostPort = await firstHostPort(handle);
  if (!hostPort) throw new Error('could not determine published host port');
  log.info('container started', { handle, hostPort });
  return { handle, target: { host: '127.0.0.1', port: hostPort, prefix: '' } };
}

export async function pause(handle) {
  await stopContainer(handle);
}

// resume and return the (possibly new) target — the auto-assigned host port can
// change across stop/start.
export async function resume(handle) {
  const st = await containerState(handle);
  if (st === 'absent') throw new Error('container vanished');
  if (st !== 'running') await startContainer(handle);
  const hostPort = await firstHostPort(handle);
  if (!hostPort) throw new Error('no host port after resume');
  return { target: { host: '127.0.0.1', port: hostPort, prefix: '' } };
}

export async function remove(handle) {
  await removeContainer(handle);
}

// Tear down every container belonging to a service (handles + stale revisions).
export async function removeAllForService(serviceId) {
  const r = await docker(['ps', '-aq', '--filter', `label=${config.label}=${serviceId}`]);
  for (const id of r.out.split('\n').filter(Boolean)) await removeContainer(id);
}
