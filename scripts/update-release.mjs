import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkRelease, selectReleaseAsset, downloadReleaseAsset, compareVersions } from '../packages/shared/dist/release.js';
import { execute, nativeIdentity, dockerContainer } from './profile-lib.mjs';
import { extractSourceArchive } from './update-archive.mjs';

export async function profileVersion(p, dependencies = {}) {
  const valid = value => { compareVersions(value, value); return value; };
  try {
    if (p.meta.runtime === 'docker') {
      const run = dependencies.execute ?? execute;
      const container = await (dependencies.dockerContainer ?? dockerContainer)(p);
      const image = await run('docker', ['inspect', '--format', '{{.Image}}', container], { capture: true });
      if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error();
      const label = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json (index .Config.Labels "org.opencontainers.image.version")}}', image], { capture: true }));
      // Older images have no OCI version label. A no-network, read-only package probe uses the
      // exact installed image ID, never the current CLI checkout or a mutable tag.
      const version = label || await run('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', image, '-p', "require('/app/apps/server/package.json').version"], { capture: true });
      return valid(version);
    }
    const identity = p.processFile ? await (dependencies.nativeIdentity ?? nativeIdentity)(p) : { running: false };
    if (identity.running) {
      if (!identity.managed) throw Error();
      const request = dependencies.fetch ?? fetch, options = { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${p.env.MOTE_TOKEN}` } };
      const owner = await request(p.url + '/api/status', options); if (!owner.ok) throw Error(); await owner.body?.cancel();
      const response = await request(p.url + '/api/health', options); if (!response.ok) throw Error();
      const version = valid((await response.json()).version);
      if (p.meta.releaseVersion && p.meta.releaseVersion !== version) throw Error();
      return version;
    }
    const value = valid(JSON.parse(await readFile(join(p.meta.release, 'package.json'), 'utf8')).version);
    if (p.meta.releaseVersion && p.meta.releaseVersion !== value) throw Error();
    return value;
  } catch { throw Error('The installed release version is unavailable or inconsistent; inspect the selected profile before updating'); }
}
export async function checkProfileUpdate(p, options = {}) {
  const currentVersion = await profileVersion(p);
  const checked = await (options.checkRelease ?? checkRelease)({ repository: p.env.MOTE_UPDATE_REPOSITORY || 'utopiafar/mote', channel: p.env.MOTE_UPDATE_CHANNEL || 'stable', currentVersion, ...(options.version ? { version: options.version } : {}), signal: options.signal });
  return { ...checked, currentVersion };
}
function buildEnvironment() {
  // Never give package lifecycle/build scripts the selected profile, token, model keys, or inherited NODE_OPTIONS.
  const names = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'LC_ALL'];
  return { ...Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), ELECTRON_SKIP_BINARY_DOWNLOAD: '1', NODE_ENV: 'development' };
}
async function buildSource(directory) {
  const options = { cwd: directory, env: buildEnvironment(), capture: true, timeoutMs: 20 * 60 * 1000 };
  await execute('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], options);
  await execute('npm', ['run', 'build:libs'], options);
  await execute('npm', ['run', 'build', '-w', '@mote/server', '-w', '@mote/web'], options);
}
/** Prepare trusted release code without stopping a node or touching its configuration/data. */
export async function prepareProfileUpdate(p, checked, options = {}) {
  const { manifest, currentVersion } = checked;
  if (compareVersions(manifest.version, currentVersion) <= 0) throw Error('Update requires a newer release; use explicit snapshot rollback for downgrades');
  if (p.meta.runtime === 'docker') {
    const target = manifest.images.find(image => image.component === 'server');
    if (!target) throw Error('This signed release does not include a server container image');
    // The signed digest, never a mutable tag, is the update authority. Inspect must resolve exactly that digest.
    const run = options.execute ?? execute;
    options.onStage?.('pulling-image');
    await run('docker', ['pull', target.image], { capture: true, timeoutMs: 20 * 60 * 1000 });
    const digests = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', target.image], { capture: true }));
    if (!Array.isArray(digests) || !digests.includes(target.image)) throw Error('Downloaded server image digest does not match the signed release');
    options.onStage?.('prepared');
    return { image: target.image, releaseVersion: manifest.version, releaseTag: manifest.tag };
  }
  const asset = selectReleaseAsset(manifest, { component: 'server', platform: 'source', arch: 'all', format: 'tar.gz' });
  if (!asset || asset.size > 128 * 1024 * 1024) throw Error('This signed release has no supported bounded server source archive');
  const releases = join(p.directory, 'releases'); await mkdir(releases, { recursive: true, mode: 0o700 });
  if ((await lstat(releases)).isSymbolicLink()) throw Error('Release storage cannot be a symlink');
  const destination = join(releases, `${manifest.version}-${asset.sha256.slice(0, 16)}`);
  let present = false;
  try { await lstat(destination); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (present) {
    const installed = JSON.parse(await readFile(join(destination, '.mote-release.json'), 'utf8'));
    if (installed.version !== manifest.version || installed.sha256 !== asset.sha256 || (await lstat(destination)).isSymbolicLink()) throw Error('Existing release directory is not the verified prepared release');
    await lstat(join(destination, 'apps/server/dist/index.js')); await lstat(join(destination, 'apps/web/dist/index.html'));
    return { release: destination, releaseVersion: manifest.version, releaseTag: manifest.tag };
  }
  const nonce = randomUUID(), archive = join(releases, `.source-${nonce}.tar.gz`), stage = join(releases, `.build-${nonce}`);
  try {
    options.onStage?.('downloading-source');
    await (options.downloadReleaseAsset ?? downloadReleaseAsset)(asset, archive, { signal: options.signal });
    options.signal?.throwIfAborted();
    await extractSourceArchive(archive, stage, `mote-${manifest.version}/`);
    const sourcePackage = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
    if (sourcePackage.name !== 'mote' || sourcePackage.version !== manifest.version) throw Error('Source package identity does not match the signed release');
    options.onStage?.('building-source');
    await (options.build ?? buildSource)(stage);
    options.signal?.throwIfAborted();
    for (const path of ['apps/server/dist/index.js', 'apps/web/dist/index.html']) if (!(await lstat(join(stage, path))).isFile()) throw Error('The prepared release build is incomplete');
    await writeFile(join(stage, '.mote-release.json'), JSON.stringify({ schemaVersion: 1, version: manifest.version, tag: manifest.tag, sha256: asset.sha256, preparedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(stage, destination);
    options.onStage?.('prepared');
    return { release: destination, releaseVersion: manifest.version, releaseTag: manifest.tag };
  } finally { await rm(archive, { force: true }); await rm(stage, { recursive: true, force: true }); }
}
