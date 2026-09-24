import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, copyFile, symlink, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkRelease, downloadReleaseAsset, verifyReleaseEnvelope } from '../packages/shared/dist/release.js';
import { extractSourceArchive } from './update-archive.mjs';
import { checkProfileUpdate, prepareProfileUpdate, profileVersion } from './update-release.mjs';
import { preserveConnectorState, restoreConnectorState } from './update-private.mjs';
import { sourceTar } from './update-fixtures.mjs';
import { execute, repository } from './profile-lib.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
function signedManifest(bytes, version = '0.5.0') {
  const manifest = { schemaVersion: 1, version, channel: 'stable', repository: 'utopiafar/mote', tag: `v${version}`, notesUrl: `https://github.com/utopiafar/mote/releases/tag/v${version}`, publishedAt: new Date().toISOString(), assets: [{ component: 'server', platform: 'source', arch: 'all', format: 'tar.gz', name: `mote-server-${version}.tar.gz`, url: `https://github.com/utopiafar/mote/releases/download/v${version}/mote-server-${version}.tar.gz`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], images: [{ component: 'server', image: 'ghcr.io/utopiafar/mote@sha256:' + 'a'.repeat(64) }] };
  const payload = Buffer.from(JSON.stringify(manifest)), envelope = JSON.stringify({ schemaVersion: 1, keyId: 'synthetic-release-key', payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64') });
  return { manifest: verifyReleaseEnvelope(envelope, { publicKey, keyId: 'synthetic-release-key' }), envelope };
}
async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-update-fixture-'));
  try { await operation(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const build = async path => { await mkdir(join(path, 'apps/server/dist'), { recursive: true }); await mkdir(join(path, 'apps/web/dist'), { recursive: true }); await writeFile(join(path, 'apps/server/dist/index.js'), '// synthetic build artifact'); await writeFile(join(path, 'apps/web/dist/index.html'), '<!doctype html>synthetic'); };
test('ordinary Docker profile commands work in a clean checkout without compiled shared code or node_modules', async () => fixture(async directory => {
  await mkdir(join(directory, 'scripts'));
  for (const name of ['mote.mjs', 'profile-lib.mjs', 'media-workers.mjs', 'tunnel-lib.mjs', 'update-deploy.mjs', 'update-private.mjs']) await copyFile(join(repository, 'scripts', name), join(directory, 'scripts', name));
  await copyFile(join(repository, 'package.json'), join(directory, 'package.json'));
  await copyFile(join(repository, '.env.example'), join(directory, '.env.example'));
  const entry = join(directory, 'scripts/mote.mjs'), args = ['--profile', 'synthetic-clean-checkout', '--home', join(directory, 'profiles')];
  const initialized = JSON.parse(await execute(process.execPath, [entry, 'init', ...args, '--runtime', 'docker'], { capture: true }));
  assert.equal(initialized.runtime, 'docker');
  const configured = JSON.parse(await execute(process.execPath, [entry, 'config', ...args], { capture: true }));
  assert.equal(configured.runtime, 'docker');
  assert.equal(configured.profile, 'synthetic-clean-checkout');
}));
test('signed release and verified asset prepare a separate source checkout without changing profile data', async () => fixture(async directory => {
  const bytes = sourceTar(), signed = signedManifest(bytes), active = join(directory, 'active'); await mkdir(active); await writeFile(join(active, 'package.json'), JSON.stringify({ version: '0.4.0' }));
  const p = { directory, meta: { runtime: 'native', release: active }, env: { MOTE_TOKEN: 'synthetic-private-credential' } };
  const checked = await checkProfileUpdate(p, { checkRelease: options => checkRelease({ ...options, publicKey, keyId: 'synthetic-release-key', fetch: async url => new Response(String(url).includes('api.github.com') ? JSON.stringify({ tag_name: 'v0.5.0', draft: false, prerelease: false }) : signed.envelope) }) });
  assert.equal(checked.available, true);
  const result = await prepareProfileUpdate(p, checked, { downloadReleaseAsset: (asset, path) => downloadReleaseAsset(asset, path, { fetch: async () => new Response(bytes) }), build });
  assert.notEqual(result.release, active); assert.equal(result.releaseVersion, '0.5.0'); assert.equal(p.meta.release, active);
  assert.equal((await lstat(join(result.release, '.mote-release.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(result.release, '.mote-release.json'), 'utf8')).includes(p.env.MOTE_TOKEN));
  assert.deepEqual(await prepareProfileUpdate(p, checked), result);
}));
test('asset corruption and a mismatched package cannot invoke a build or modify the current release', async () => fixture(async directory => {
  const bytes = sourceTar(), { manifest } = signedManifest(bytes), p = { directory, meta: { runtime: 'native', release: '/synthetic-active' }, env: {} }; let built = false;
  await assert.rejects(prepareProfileUpdate(p, { manifest, currentVersion: '0.4.0' }, { downloadReleaseAsset: (asset, path) => downloadReleaseAsset(asset, path, { fetch: async () => new Response(Buffer.alloc(bytes.length)) }), build: async () => { built = true; } }), /asset_checksum_mismatch/);
  assert.equal(built, false); assert.equal(p.meta.release, '/synthetic-active');
  const wrong = sourceTar('0.5.0', [], '0.4.0'), signedWrong = signedManifest(wrong);
  await assert.rejects(prepareProfileUpdate(p, { manifest: signedWrong.manifest, currentVersion: '0.4.0' }, { downloadReleaseAsset: (asset, path) => downloadReleaseAsset(asset, path, { fetch: async () => new Response(wrong) }), build: async () => { built = true; } }), /package identity/);
  assert.equal(built, false);
  await assert.rejects(prepareProfileUpdate(p, { manifest, currentVersion: '0.5.0' }), /newer release/);
}));
test('unsafe tar paths, links, duplicates and missing roots are rejected before extraction', async () => fixture(async directory => {
  for (const [index, entry] of [{ name: 'mote-0.5.0/../escape', body: 'bad' }, { name: 'mote-0.5.0/link', type: '2' }, { name: 'mote-0.5.0/package.json' }, { name: 'mote-0.5.0/.env', body: 'synthetic' }, { name: '/absolute' }].entries()) {
    const path = join(directory, `${index}.gz`), target = join(directory, `target-${index}`); await writeFile(path, sourceTar('0.5.0', [entry]));
    await assert.rejects(extractSourceArchive(path, target, 'mote-0.5.0/')); await assert.rejects(lstat(target), { code: 'ENOENT' });
  }
}));
test('container preparation pulls the signed immutable digest and rejects an inspect mismatch', async () => {
  const { manifest } = signedManifest(sourceTar()), calls = [], p = { meta: { runtime: 'docker' } };
  const result = await prepareProfileUpdate(p, { manifest, currentVersion: '0.4.0' }, { execute: async (command, args) => { calls.push([command, ...args]); return args[0] === 'pull' ? '' : JSON.stringify([manifest.images[0].image]); } });
  assert.equal(result.image, manifest.images[0].image); assert.equal(calls[0][2], manifest.images[0].image);
  await assert.rejects(prepareProfileUpdate(p, { manifest, currentVersion: '0.4.0' }, { execute: async (_command, args) => args[0] === 'pull' ? '' : '[]' }), /digest/);
});
test('installed container version comes from its old image even when CLI metadata is newer', async () => {
  const calls = [], image = 'sha256:' + 'b'.repeat(64), p = { meta: { runtime: 'docker', releaseVersion: '0.5.0' } };
  const version = await profileVersion(p, { dockerContainer: async () => 'synthetic-container', execute: async (_command, args) => { calls.push(args); if (args[0] === 'inspect') return image; if (args[0] === 'image') return 'null'; return '0.4.0'; } });
  assert.equal(version, '0.4.0'); const probe = calls.find(args => args[0] === 'run'); assert.ok(probe.includes(image)); assert.deepEqual(probe.slice(probe.indexOf('--network'), probe.indexOf('--network') + 2), ['--network', 'none']); assert.ok(probe.includes('--read-only'));
});
test('running native version wins over a newer checkout and rejects an inconsistent recorded release', async () => {
  const p = { processFile: '/synthetic/process.json', url: 'http://127.0.0.1:1', meta: { runtime: 'native', release: '/not-read-newer-checkout' }, env: { MOTE_TOKEN: 'synthetic-token' } };
  const dependencies = { nativeIdentity: async () => ({ running: true, managed: true }), fetch: async url => new Response(JSON.stringify(String(url).endsWith('/health') ? { version: '0.4.0' } : {})) };
  assert.equal(await profileVersion(p, dependencies), '0.4.0');
  await assert.rejects(profileVersion({ ...p, meta: { ...p.meta, releaseVersion: '0.5.0' } }, dependencies), /inconsistent/);
});
test('captured build output is bounded and cannot evade termination by ignoring SIGTERM', { timeout: 15000 }, async () => {
  await assert.rejects(execute(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)"], { capture: true, timeoutMs: 10000 }), /exceeded output limit/);
});
test('rollback privately retains connector credentials and selection, clears forward checkpoints and retains current connection metadata', async () => fixture(async directory => {
  const oldData = join(directory, 'old-data'), restored = join(directory, 'restored-data'); await mkdir(join(directory, 'backups')); await mkdir(join(oldData, 'connectors'), { recursive: true }); await mkdir(restored);
  const source = { id: 'synthetic-calendar', name: 'synthetic chosen calendar', kind: 'google-calendar', enabled: true };
  const db = new DatabaseSync(join(oldData, 'mote.sqlite')); db.exec('CREATE TABLE source_connections(id TEXT PRIMARY KEY,json TEXT NOT NULL)'); db.prepare('INSERT INTO source_connections VALUES(?,?)').run(source.id, JSON.stringify(source)); db.close();
  const restoredDb = new DatabaseSync(join(restored, 'mote.sqlite')); restoredDb.close();
  const credential = { version: 1, tokens: { refresh_token: 'synthetic-private-refresh-token' }, calendars: [{ id: source.id }], checkpoints: { synthetic: { syncToken: 'synthetic-forward-checkpoint' } } };
  await writeFile(join(oldData, 'connectors/google-calendar.json'), JSON.stringify(credential), { mode: 0o600 });
  const contentKey = 'ab'.repeat(32) + '\n';
  await writeFile(join(oldData, 'content-key'), contentKey, { mode: 0o600 });
  const p = { directory, dataDir: oldData, meta: { runtime: 'native' } }, handoff = await preserveConnectorState(p);
  await restoreConnectorState({ ...p, dataDir: restored }, handoff);
  const file = join(restored, 'connectors/google-calendar.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.tokens, credential.tokens); assert.deepEqual(saved.calendars, credential.calendars); assert.deepEqual(saved.checkpoints, {}); assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const restoredRead = new DatabaseSync(join(restored, 'mote.sqlite')); assert.deepEqual(JSON.parse(restoredRead.prepare('SELECT json FROM source_connections').get().json), source); restoredRead.close();
  assert.deepEqual(JSON.parse(await readFile(join(oldData, 'connectors/google-calendar.json'), 'utf8')), credential);
  assert.equal(await readFile(join(restored, 'content-key'), 'utf8'), contentKey);
  assert.equal((await lstat(join(restored, 'content-key'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(oldData, 'content-key'), 'utf8'), contentKey);
}));

test('private content-key rollback rejects links, malformed keys and overwriting an existing destination', async () => fixture(async directory => {
  const dataDir = join(directory, 'data'); await mkdir(dataDir); await mkdir(join(directory, 'backups'));
  const db = new DatabaseSync(join(dataDir, 'mote.sqlite')); db.close();
  const p = { directory, dataDir, meta: { runtime: 'native' } }, key = join(dataDir, 'content-key'), outside = join(directory, 'key');
  await writeFile(outside, 'cd'.repeat(32) + '\n');
  for (const kind of ['symlink', 'hardlink', 'directory', 'invalid']) {
    if (kind === 'symlink') await symlink(outside, key);
    else if (kind === 'hardlink') await link(outside, key);
    else if (kind === 'directory') await mkdir(key);
    else await writeFile(key, 'not a generated key');
    await assert.rejects(preserveConnectorState(p), /[Cc]ontent key/);
    assert.deepEqual(await readdir(join(directory, 'backups')), [], 'Failed private handoffs are removed');
    await rm(key, { recursive: true, force: true });
  }
  await copyFile(outside, key);
  const handoff = await preserveConnectorState(p), restored = join(directory, 'restored'); await mkdir(restored);
  await writeFile(join(restored, 'content-key'), 'Existing destination must remain untouched');
  await assert.rejects(restoreConnectorState({ ...p, dataDir: restored }, handoff), { code: 'EEXIST' });
  assert.equal(await readFile(join(restored, 'content-key'), 'utf8'), 'Existing destination must remain untouched');
}));
