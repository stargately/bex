// Build plane — the "Render core": clone repo @ commit, turn it into an OCI
// image, and push it to the local registry (Zot).
//
// Image build uses real Cloud Native Buildpacks (`pack build`, Paketo builder) —
// the doc's "Buildpacks ... via BuildKit" path — with a Dockerfile fast-path when
// the repo ships one (the doc supports "Buildpacks / Nixpacks / Dockerfile").
//
// In the doc the build runs inside a throwaway Kata build sandbox; this MVP builds
// on the host Docker daemon (single-node, no untrusted multi-tenancy yet).
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { docker, run } from './docker.js';
import { builds, buildLogPath } from './store.js';
import { newBuildId } from './ids.js';
import { logger } from './log.js';

const log = logger('builder');

function annotate(logFile, line) {
  fs.appendFileSync(logFile, `\n=== ${line} ===\n`);
}

// Decide how to build, honoring the service's build.builder:
//   'dockerfile'      -> require + use the repo Dockerfile (docker build)
//   'buildpack'       -> always Cloud Native Buildpacks (ignore any Dockerfile)
//   <image with '/'>  -> use that string as the CNB builder image
//   'auto' (default)  -> Dockerfile if present, else CNB
function chooseBuilder(dir, requested, logFile) {
  const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
  if (requested === 'dockerfile') {
    if (!hasDockerfile) throw new Error('build.builder=dockerfile but repo has no Dockerfile');
    annotate(logFile, 'builder: Dockerfile (docker build / BuildKit)');
    return { kind: 'dockerfile', name: 'dockerfile' };
  }
  if (requested === 'buildpack') {
    annotate(logFile, `builder: CNB ${config.cnbBuilder} (forced)`);
    return { kind: 'cnb', builderImage: config.cnbBuilder, name: 'cnb' };
  }
  if (requested && requested.includes('/')) {
    annotate(logFile, `builder: CNB ${requested} (custom)`);
    return { kind: 'cnb', builderImage: requested, name: 'cnb' };
  }
  // auto
  if (hasDockerfile) {
    annotate(logFile, 'builder: auto -> Dockerfile present (docker build / BuildKit)');
    return { kind: 'dockerfile', name: 'dockerfile' };
  }
  annotate(logFile, `builder: auto -> Cloud Native Buildpacks (${config.cnbBuilder})`);
  return { kind: 'cnb', builderImage: config.cnbBuilder, name: 'cnb' };
}

// Produce the OCI image `image` from the source in `dir`.
async function buildImage(choice, image, dir, logFile) {
  if (choice.kind === 'dockerfile') {
    annotate(logFile, `docker build -> ${image}`);
    const r = await docker(['build', '--progress', 'plain', '-t', image, '.'], {
      cwd: dir,
      env: { DOCKER_BUILDKIT: '1' },
      logFile,
    });
    if (r.code !== 0) throw new Error('docker build failed (see build log)');
    return;
  }
  // Cloud Native Buildpacks
  annotate(logFile, `pack build ${image} --builder ${choice.builderImage}`);
  const r = await run(
    'pack',
    ['build', image, '--path', dir, '--builder', choice.builderImage, '--pull-policy', 'if-not-present'],
    { logFile },
  );
  if (r.code !== 0) throw new Error('pack build (CNB) failed (see build log)');
}

async function gitClone(repo, ref, dest, logFile) {
  annotate(logFile, `git clone ${repo} (ref ${ref})`);
  let r = await run('git', ['clone', '--quiet', repo, dest], { logFile });
  if (r.code !== 0) throw new Error('git clone failed: ' + r.err);
  if (ref) {
    r = await run('git', ['-C', dest, 'checkout', '--quiet', ref], { logFile });
    if (r.code !== 0) {
      // ref may be a remote branch name not checked out locally; try origin/<ref>
      r = await run('git', ['-C', dest, 'checkout', '--quiet', `origin/${ref}`], { logFile });
      if (r.code !== 0) throw new Error(`git checkout ${ref} failed: ` + r.err);
    }
  }
  const head = await run('git', ['-C', dest, 'rev-parse', '--short', 'HEAD']);
  return head.out || 'unknown';
}

// Build for a given deploy. Returns the build record (status succeeded|failed).
export async function build({ service, ref }) {
  const id = newBuildId();
  const logFile = buildLogPath(id);
  fs.writeFileSync(logFile, `bex build ${id} for service ${service.id} (${service.name})\n`);
  const rec = builds.put({
    id,
    serviceId: service.id,
    status: 'building',
    ref,
    image: null,
    logFile,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  });

  const workDir = path.join(paths.work(), id);
  try {
    const commit = await gitClone(service.repo, ref || service.branch, workDir, logFile);
    rec.commit = commit;
    builds.put(rec);

    const choice = chooseBuilder(workDir, service.build?.builder || 'auto', logFile);
    rec.builder = choice.name;

    const image = `${config.registry}/${service.name}:${commit}`;
    await buildImage(choice, image, workDir, logFile);

    // Push to the local registry (best-effort: the deploy uses the locally cached
    // image either way, but this exercises the real build -> registry hop).
    annotate(logFile, `docker push ${image}`);
    const pushRes = await docker(['push', image], { logFile });
    if (pushRes.code !== 0) {
      annotate(logFile, 'registry push failed — continuing with locally-built image');
      log.warn('registry push failed', { image, err: pushRes.err });
    }

    rec.status = 'succeeded';
    rec.image = image;
    rec.finishedAt = new Date().toISOString();
    builds.put(rec);
    annotate(logFile, 'BUILD SUCCEEDED');
    log.info('build succeeded', { id, image, builder: rec.builder });
  } catch (e) {
    rec.status = 'failed';
    rec.error = e.message;
    rec.finishedAt = new Date().toISOString();
    builds.put(rec);
    annotate(logFile, 'BUILD FAILED: ' + e.message);
    log.error('build failed', { id, err: e.message });
  } finally {
    // tidy the clone; keep the log
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
  return rec;
}
