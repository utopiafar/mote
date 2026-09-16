import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { sourceTar } from './update-fixtures.mjs';
import { prepareProfileUpdate, profileVersion } from './update-release.mjs';
import { changeProfileDeployment } from './update-deploy.mjs';
import { downloadReleaseAsset } from '../packages/shared/dist/release.js';
import { repository, atomicJson, withProfileLock, nativeIdentity, stopNative } from './profile-lib.mjs';
import { initializeFixture, cli, request, note, capture, image } from './profile-fixtures.mjs';

test('real isolated central update and rollback preserve credentials, generated content-key, data, connectors and tunnel selection', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-update-process-')); let p;
  try {
    p = await initializeFixture(join(directory, 'profiles'), 'test', { dataKey: '' });
    const originalVersion = await profileVersion(p), parts = originalVersion.split('.').map(Number), version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    p.meta.tunnel = { enabled: false, provider: 'cloudflare', protocol: 'http2', image: 'cloudflare/cloudflared:2026.9.1' }; await atomicJson(p.metaFile, p.meta);
    await mkdir(join(p.directory, 'secrets'), { mode: 0o700 }); const tunnelSecret = join(p.directory, 'secrets/cloudflared-token'); await writeFile(tunnelSecret, 'synthetic-offline-tunnel-token'.repeat(2), { mode: 0o600 });
    const envBefore = await readFile(p.envFile), tunnelBefore = await readFile(tunnelSecret), tunnel = structuredClone(p.meta.tunnel);
    await mkdir(join(p.dataDir, 'connectors'), { recursive: true, mode: 0o700 });
    const credentials = { version: 1, tokens: { refresh_token: 'synthetic-inert-refresh-token' }, calendars: [], checkpoints: { fixture: { syncToken: 'synthetic-checkpoint' } } };
    await writeFile(join(p.dataDir, 'connectors/google-calendar.json'), JSON.stringify(credentials), { mode: 0o600 });
    await cli(p.home, p.profile, 'start');
    const contentKey = await readFile(join(p.dataDir, 'content-key'));
    assert.match(contentKey.toString().trim(), /^[a-f0-9]{64}$/);
    const saved = note(), screen = capture(); await request(p, '/api/notes', { method: 'POST', body: saved, status: 201 }); await request(p, '/api/captures', { method: 'POST', body: screen, status: 201 });
    const invitation=await request(p,'/api/connections/invitations',{method:'POST',body:{serverUrl:p.url,label:'Generated update-preservation device'}});
    const paired=await request(p,'/api/connections/redeem',{method:'POST',token:'',body:{code:invitation.invitation.code,deviceId:'synthetic-paired-update',deviceName:'Synthetic paired device',platform:'android'}});
    const bytes = sourceTar(version), asset = { component: 'server', platform: 'source', arch: 'all', format: 'tar.gz', name: `mote-server-${version}.tar.gz`, url: `https://github.com/utopiafar/mote/releases/download/v${version}/mote-server-${version}.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    const manifest = { version, tag: `v${version}`, assets: [asset], images: [] };
    // The production downloader verifies the generated artifact; build adapter copies current compiled
    // central code into the distinct fixture release. This is an actual process test, not an npm/network build.
    const prepared = await prepareProfileUpdate(p, { manifest, currentVersion: originalVersion }, { downloadReleaseAsset: (selected, path) => downloadReleaseAsset(selected, path, { fetch: async () => new Response(bytes) }), build: async path => {
      await cp(join(repository, 'apps/server/dist'), join(path, 'apps/server/dist'), { recursive: true });
      await writeFile(join(path, 'apps/server/package.json'), JSON.stringify({ name: '@mote/server', type: 'module', version }));
      await symlink(join(repository, 'node_modules'), join(path, 'node_modules'), 'dir');
      await mkdir(join(path, 'apps/web/dist'), { recursive: true }); await writeFile(join(path, 'apps/web/dist/index.html'), '<!doctype html>synthetic update fixture');
    } });
    await withProfileLock(p, () => changeProfileDeployment(p, { prepared }));
    assert.equal(await profileVersion(p), version); assert.equal((await request(p, `/api/notes/${saved.id}`)).ocrText, saved.text); assert.deepEqual(await request(p, `/api/captures/${screen.id}/image`, { binary: true }), image);
    assert.deepEqual(await readFile(p.envFile), envBefore); assert.deepEqual(await readFile(tunnelSecret), tunnelBefore); assert.deepEqual(p.meta.tunnel, tunnel);
    assert.deepEqual(JSON.parse(await readFile(join(p.dataDir, 'connectors/google-calendar.json'), 'utf8')), credentials);
    assert.deepEqual(await readFile(join(p.dataDir, 'content-key')), contentKey);
    assert.equal((await request(p,'/api/connections/self',{token:paired.token})).credential.id,paired.credentialId,'Client credentials survive upgrade unchanged');
    await request(p,`/api/connections/${paired.credentialId}`,{method:'DELETE'});
    const later = note(); await request(p, '/api/notes', { method: 'POST', body: later, status: 201 });
    const source = { id: 'synthetic-after-upgrade', name: 'Synthetic selected source', kind: 'google-calendar', deviceId: 'synthetic-device', platform: 'import', retention: 'reference', enabled: false };
    await request(p, '/api/sources', { method: 'POST', body: source });
    const metadataBeforeFailedRollback = await readFile(p.metaFile);
    const forbiddenConnector = join(p.dataDir, 'connectors/forbidden-link');
    await symlink(join(p.dataDir, 'connectors/google-calendar.json'), forbiddenConnector);
    await assert.rejects(withProfileLock(p, () => changeProfileDeployment(p, { rollback: true, restoreData: true })), /Connector credential links/);
    assert.equal(await profileVersion(p), version, 'Preparation failure must restart the unchanged upgraded program');
    assert.equal((await request(p, `/api/notes/${later.id}`)).ocrText, later.text, 'No snapshot restore may have begun');
    assert.deepEqual(await readFile(p.metaFile), metadataBeforeFailedRollback);
    await rm(forbiddenConnector);
    const rollback = await withProfileLock(p, () => changeProfileDeployment(p, { rollback: true, restoreData: true }));
    assert.equal(await profileVersion(p), originalVersion); assert.equal((await request(p, `/api/notes/${saved.id}`)).ocrText, saved.text); await request(p, `/api/notes/${later.id}`, { status: 404 });
    assert.deepEqual(await request(p, `/api/captures/${screen.id}/image`, { binary: true }), image);
    assert.deepEqual(await readFile(join(p.dataDir, 'content-key')), contentKey);
    assert.equal((await lstat(join(p.dataDir, 'content-key'))).mode & 0o777, 0o600);
    assert.ok((await request(p, '/api/sources')).items.some(item => item.id === source.id));
    assert.deepEqual(await readFile(p.envFile), envBefore); assert.deepEqual(await readFile(tunnelSecret), tunnelBefore); assert.deepEqual(p.meta.tunnel, tunnel);
    const retained = JSON.parse(await readFile(join(p.dataDir, 'connectors/google-calendar.json'), 'utf8')); assert.deepEqual(retained.tokens, credentials.tokens); assert.deepEqual(retained.checkpoints, {});
    assert.equal((await lstat(join(p.dataDir, 'connectors/google-calendar.json'))).mode & 0o777, 0o600); assert.ok(rollback.preservedData);
    await request(p,'/api/connections/self',{token:paired.token,status:401});
    assert.ok((await request(p,'/api/connections')).items.find(c=>c.id===paired.credentialId)?.revokedAt,'Rollback must not resurrect a revoked device');
    assert.equal((await lstat(join(p.dataDir,'connectors/client-connections.json'))).mode&0o777,0o600);
    const backupManifest = JSON.parse(await readFile(join(rollback.snapshot, 'backup-manifest.json'), 'utf8')); assert.ok(Object.keys(backupManifest.checksums).every(key => !key.includes('connectors')));
    assert.equal(Object.hasOwn(backupManifest.checksums, 'content-key'), false);
  } finally {
    if (p) { const state = await nativeIdentity(p).catch(() => null); if (state?.running && state.managed) await stopNative(p); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup failure before selection restores a running profile but leaves an intentionally stopped profile stopped', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-update-backup-failure-')); let p;
  try {
    p = await initializeFixture(join(directory, 'profiles'), 'test');
    await cli(p.home, p.profile, 'start');
    const saved = note(); await request(p, '/api/notes', { method: 'POST', body: saved, status: 201 });
    const version = await profileVersion(p), before = await readFile(p.metaFile);
    // A regular file at the backup directory forces a real filesystem error after stop succeeds.
    await rm(join(p.directory, 'backups'), { recursive: true });
    await writeFile(join(p.directory, 'backups'), 'synthetic obstruction', { flag: 'wx', mode: 0o600 });
    const attempt = () => withProfileLock(p, () => changeProfileDeployment(p, { prepared: { release: p.meta.release, releaseVersion: version } }));
    await assert.rejects(attempt());
    assert.equal((await nativeIdentity(p)).running, true);
    assert.equal(await profileVersion(p), version);
    assert.equal((await request(p, `/api/notes/${saved.id}`)).ocrText, saved.text);
    assert.deepEqual(await readFile(p.metaFile), before);
    await stopNative(p);
    await assert.rejects(attempt());
    assert.equal((await nativeIdentity(p)).running, false);
    assert.deepEqual(await readFile(p.metaFile), before);
  } finally {
    if (p) { const state = await nativeIdentity(p).catch(() => null); if (state?.running && state.managed) await stopNative(p); }
    await rm(directory, { recursive: true, force: true });
  }
});
