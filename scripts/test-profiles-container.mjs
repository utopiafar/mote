#!/usr/bin/env node
// Actual Docker/Compose lifecycle tests. Never publish images or use an existing profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repository, loadProfile, profilePaths } from './profile-lib.mjs';
import { cli, command, initializeFixture, updateEnvironment, request, note, capture, image } from './profile-fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mote-compose-fixture-')), home = join(directory, 'profiles'), restoredHome = join(directory, 'restored');
const imageTag = `mote-compose-fixture:${randomUUID()}`, profiles = [], volumes = new Set(), imageIds = new Set();
async function docker(args, timeoutMs = 120000) {
  const result = await command('docker', args, { timeoutMs });
  assert.equal(result.code, 0, `docker ${args[0]} failed: ${result.stderr.slice(-1600)}`); return result.stdout.trim();
}
const run = (p, action, args = [], options = {}) => cli(p.home, p.profile, action, args, { timeoutMs: 180000, ...options });
let available = false;
try {
  await docker(['version', '--format', '{{.Server.Version}}'], 30000); available = true;
  console.info('[compose-profiles] Building temporary image from this repository');
  await docker(['build', '--tag', imageTag, '--file', 'Dockerfile', '.'], 15 * 60 * 1000);
  let dev = await initializeFixture(home, 'dev', { runtime: 'docker', image: imageTag }), test = await initializeFixture(home, 'test', { runtime: 'docker', image: imageTag });
  profiles.push(dev, test); for (const p of profiles) volumes.add(p.meta.volume);
  // Quote and dollar characters must survive Node dotenv parsing and Compose's raw env_file.
  dev = await updateEnvironment(dev, { MOTE_TOKEN: `synthetic-${randomUUID()}-$literal-"quoted"` });
  // Keep models disabled, while proving non-default capacity and configured key booleans cross Docker.
  dev = await updateEnvironment(dev, { MOTE_MAX_STORAGE_MB: '23', MOTE_MODEL_API_KEY: 'synthetic-container-config-agent-key', MOTE_EMBEDDING_API_KEY: 'synthetic-container-config-embedding-key' });
  const config = JSON.parse((await run(dev, 'compose', ['--', 'config', '--format', 'json'])).stdout);
  // compose config escapes dollar signs for reusable configuration output.
  // Verify credential bytes at the actual container boundary after startup instead.
  assert.equal(config.services.mote.environment.MOTE_LOG_DIR, '/data/logs');
  assert.equal(config.services.mote.environment.MOTE_ENV_FILE, '/app/deploy/empty.env');
  assert.equal(config.services.mote.ports[0].host_ip, '127.0.0.1');
  assert.notEqual(dev.project, test.project); assert.notEqual(dev.meta.volume, test.meta.volume);
  await run(dev, 'start'); await run(test, 'start');
  const literalContainer = (await run(dev,'compose',['--','ps','--quiet','mote'])).stdout.trim();
  const actualEnvironment = JSON.parse(await docker(['inspect','--format','{{json .Config.Env}}',literalContainer]));
  assert.equal(actualEnvironment.find(value=>value.startsWith('MOTE_TOKEN=')),`MOTE_TOKEN=${dev.env.MOTE_TOKEN}`);
  for (const p of [dev, test]) {
    await request(p, '/api/configuration', { token: p === dev ? test.env.MOTE_TOKEN : dev.env.MOTE_TOKEN, status: 401 });
    const configuration = await request(p, '/api/configuration');
    const fields = new Map(configuration.groups.flatMap(group => group.fields).map(field => [field.key, field]));
    assert.equal(configuration.version, 1); assert.equal(configuration.profile, p.profile); assert.equal(configuration.runtime, 'docker');
    assert.equal(configuration.readOnly, true); assert.equal(configuration.restartRequired, true);
    assert.equal(configuration.envFile, p.envFile, 'The owner edit path must identify the host profile file');
    assert.equal(configuration.baseDir, '/app/deploy');
    assert.equal(fields.get('configurationFile').value, p.envFile);
    assert.equal(fields.get('effectiveEnvFile').value, '/app/deploy/empty.env');
    assert.equal(fields.get('effectiveEnvFile').source, 'environment');
    assert.equal(configuration.storage.kind, 'docker-volume'); assert.equal(configuration.storage.source, p.meta.volume);
    assert.equal(configuration.storage.mountPath, '/data'); assert.equal(configuration.storage.dataDir, '/data');
    assert.equal(configuration.storage.sqlitePath, '/data/mote.sqlite'); assert.equal(configuration.storage.blobsDir, '/data/blobs');
    assert.equal(configuration.storage.logDir, '/data/logs'); assert.equal(fields.get('logDirectory').value, '/data/logs');
    assert.equal(fields.get('maxStorageBytes').value, Number(p.env.MOTE_MAX_STORAGE_MB) * 1024 * 1024);
    assert.equal(fields.get('maxStorageBytes').source, 'environment');
    assert.equal(fields.get('dataKeyConfigured').value, true); assert.equal(fields.get('accessTokenConfigured').value, true);
    assert.equal(fields.get('modelApiKeyConfigured').value, Boolean(p.env.MOTE_MODEL_API_KEY));
    assert.equal(fields.get('embeddingApiKeyConfigured').value, Boolean(p.env.MOTE_EMBEDDING_API_KEY));
    const secrets = [p.env.MOTE_TOKEN, p.env.MOTE_DATA_KEY, p.env.MOTE_MODEL_API_KEY, p.env.MOTE_EMBEDDING_API_KEY].filter(Boolean);
    const serialized = JSON.stringify(configuration);
    for (const secret of secrets) assert.ok(!serialized.includes(JSON.stringify(secret).slice(1, -1)), 'Configuration must not contain credential values, including JSON-escaped tokens');
    const support = JSON.stringify(await request(p, '/api/support-bundle'));
    for (const privateValue of [...secrets, p.envFile, p.directory, p.meta.volume, '/app/deploy', '/data']) {
      assert.ok(!support.includes(JSON.stringify(privateValue).slice(1, -1)), 'Reading owner configuration must not place secrets or paths in support bundles');
    }
  }
  console.info('[compose-profiles] Authenticated effective configuration, host/container storage mapping and safe support isolation passed');
  await request(dev, '/api/status', { token: test.env.MOTE_TOKEN, status: 401 });
  const saved = note(), screen = capture();
  await request(dev, '/api/notes', { method: 'POST', body: saved, status: 201 });
  await request(dev, '/api/captures', { method: 'POST', body: screen, status: 201 });
  assert.equal((await request(test, '/api/captures')).items.length, 0);
  assert.deepEqual(await request(dev, `/api/captures/${screen.id}/image`, { binary: true }), image);
  await run(dev, 'backup', ['--out', join(directory, 'running')], { fail: true });
  console.info('[compose-profiles] Real Compose profiles, literal credentials, loopback ports, isolated data and encrypted image checks passed');

  await run(dev, 'compose', ['--', 'down']); await run(dev, 'start');
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  await run(dev, 'stop');
  const snapshot = join(directory, 'snapshot'); await run(dev, 'backup', ['--out', snapshot]);
  assert.deepEqual((await readdir(snapshot)).sort(), ['backup-manifest.json', 'blobs', 'files', 'mote.sqlite']);
  const manifest = JSON.parse(await readFile(join(snapshot, 'backup-manifest.json'), 'utf8'));
  const blob = Object.keys(manifest.checksums).find(name => name.startsWith('files/objects/') && name.endsWith('/0.aes'));
  assert.notDeepEqual(await readFile(join(snapshot, blob)), image);
  const restored = await initializeFixture(restoredHome, 'test', { runtime: 'docker', image: imageTag, dataKey: dev.env.MOTE_DATA_KEY }); profiles.push(restored); volumes.add(restored.meta.volume);
  await run(restored, 'restore', ['--from', snapshot]); await run(restored, 'start');
  assert.equal((await request(restored, `/api/notes/${saved.id}`)).ocrText, saved.text);
  assert.deepEqual(await request(restored, `/api/captures/${screen.id}/image`, { binary: true }), image);
  await run(restored, 'restore', ['--from', snapshot], { fail: true });
  await run(restored, 'stop'); await run(restored, 'restore', ['--from', snapshot], { fail: true });
  console.info('[compose-profiles] Recreated containers, offline volume backup and empty-volume encrypted restore passed');

  await run(dev, 'start');
  const oldImage = await docker(['image','inspect','--format','{{.Id}}',imageTag]); imageIds.add(oldImage);
  // Rebuild the same mutable tag while its original container is still running.
  // Rollback must restore the original image ID, not follow the overwritten tag.
  const derive = join(directory,'image-derive'); await mkdir(derive);
  await writeFile(join(derive,'Dockerfile'), `FROM ${imageTag}\nLABEL dev.mote.fixture.revision=${randomUUID()}\n`);
  await docker(['build','--tag',imageTag,derive]);
  const newImage = await docker(['image','inspect','--format','{{.Id}}',imageTag]); imageIds.add(newImage);
  assert.notEqual(oldImage,newImage);
  await run(dev, 'upgrade', ['--image', imageTag]);
  const upgraded = await loadProfile(profilePaths('dev',home));
  assert.equal(upgraded.meta.image,newImage); assert.equal(upgraded.meta.previous.image,oldImage);
  const upgradedContainer = (await run(dev,'compose',['--','ps','--quiet','mote'])).stdout.trim();
  assert.equal(await docker(['inspect','--format','{{.Image}}',upgradedContainer]),newImage);
  const newer = note(); await request(dev, '/api/notes', { method: 'POST', body: newer, status: 201 });
  const source = { id: 'synthetic-current-google-source', name: 'Synthetic current calendar selection', kind: 'google-calendar', deviceId: 'synthetic-device', platform: 'import', retention: 'reference', enabled: false };
  await request(dev, '/api/sources', { method: 'POST', body: source });
  const credentials = { version: 1, tokens: { refresh_token: 'synthetic-offline-refresh-token' }, calendars: [{ id: 'synthetic-calendar', summary: 'Synthetic calendar', timeZone: 'Asia/Shanghai' }], checkpoints: { 'synthetic-calendar': { syncToken: 'synthetic-old-checkpoint' } } };
  const envBeforeRollback = await readFile(dev.envFile);
  await run(dev, 'stop');
  // Write only inert fixture credentials. Google configuration is absent, so startup cannot contact Google.
  await run(dev, 'compose', ['--', 'run', '--rm', '--no-deps', 'mote', 'node', '-e', `const fs=require('node:fs');fs.mkdirSync('/data/connectors',{recursive:true,mode:0o700});fs.writeFileSync('/data/connectors/google-calendar.json',${JSON.stringify(JSON.stringify(credentials))},{mode:0o600});fs.writeFileSync('/data/connectors/opaque.json',JSON.stringify({credential:'synthetic-opaque-credential'}),{mode:0o600});`]);
  await run(dev, 'start');
  await run(dev, 'rollback', ['--restore-data']);
  const current = await loadProfile(profilePaths('dev', home)); volumes.add(current.meta.volume);
  assert.notEqual(current.meta.volume, dev.meta.volume);
  assert.equal(current.meta.image,oldImage);
  const restoredContainer = (await run(dev,'compose',['--','ps','--quiet','mote'])).stdout.trim();
  assert.equal(await docker(['inspect','--format','{{.Image}}',restoredContainer]),oldImage);
  await docker(['volume', 'inspect', dev.meta.volume]);
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  await request(dev, `/api/notes/${newer.id}`, { status: 404 });
  assert.deepEqual(await request(dev, `/api/captures/${screen.id}/image`, { binary: true }), image);
  assert.ok((await request(dev, '/api/sources')).items.some(item => item.id === source.id), 'Current connector source selection survives the older archive');
  assert.deepEqual(await readFile(dev.envFile), envBeforeRollback);
  // Assert inside the container; never print credential bodies, even synthetic ones.
  const restoredCredentials = { ...credentials, checkpoints: {} };
  await docker(['exec', restoredContainer, 'node', '-e', `const fs=require('node:fs'),assert=require('node:assert/strict');assert.deepEqual(JSON.parse(fs.readFileSync('/data/connectors/google-calendar.json','utf8')),${JSON.stringify(restoredCredentials)});assert.equal(fs.statSync('/data/connectors/google-calendar.json').mode&0o777,0o600);assert.equal(fs.statSync('/data/connectors/google-calendar.json').uid,process.getuid());assert.equal(fs.statSync('/data/connectors').mode&0o777,0o700);assert.equal(JSON.parse(fs.readFileSync('/data/connectors/opaque.json','utf8')).credential,'synthetic-opaque-credential');assert.equal(fs.existsSync('/data/connectors/.mote-rollback-connections.json'),false);`]);
  const backupFolders = await readdir(join(dev.directory, 'backups'));
  assert.equal(backupFolders.some(name => name.startsWith('.connectors-')), false, 'Private handoff must be removed after rollback');
  for (const path of [current.meta.previous.backup, upgraded.meta.previous.backup]) {
    assert.deepEqual((await readdir(path)).sort(), ['backup-manifest.json', 'blobs', 'files', 'mote.sqlite']);
    const snapshotManifest = JSON.parse(await readFile(join(path, 'backup-manifest.json'), 'utf8'));
    assert.ok(Object.keys(snapshotManifest.checksums).every(name => !name.includes('connectors')));
  }
  console.info('[compose-profiles] Image switch, private connector permissions/selection and snapshot rollback passed; upgraded volume remains available');

  // Validate the optional proxy config without publishing TLS ports or requesting certificates.
  test = await updateEnvironment(test, { MOTE_TLS_DOMAIN: 'synthetic-mote.invalid' });
  await run(test, 'tls', ['--enable']);
  const tls = JSON.parse((await run(test, 'compose', ['--', 'config', '--format', 'json'])).stdout);
  assert.equal(tls.services.caddy.image, 'caddy:2.11.4-alpine');
  await docker(['run', '--rm', '--env', 'MOTE_TLS_DOMAIN=synthetic-mote.invalid', '--mount', `type=bind,source=${join(repository, 'deploy/Caddyfile')},target=/etc/caddy/Caddyfile,readonly`, 'caddy:2.11.4-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile']);
  console.info('[compose-profiles] Caddy configuration validation passed; public DNS/TLS deployment was not attempted');
} finally {
  if (available) {
    for (const p of profiles.reverse()) {
      const current = await loadProfile(profilePaths(p.profile, p.home)).catch(() => p); volumes.add(current.meta.volume);
      await run(p, 'compose', ['--', 'down', '--volumes', '--remove-orphans']).catch(() => undefined);
    }
    for (const volume of volumes) await command('docker', ['volume', 'rm', volume]).catch(() => undefined);
    await command('docker', ['image', 'rm', imageTag]).catch(() => undefined);
    for (const id of Array.from(imageIds).reverse()) await command('docker',['image','rm',id]).catch(()=>undefined);
  }
  await rm(directory, { recursive: true, force: true });
}
