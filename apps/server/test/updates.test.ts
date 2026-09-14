import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ReleaseError, type ReleaseManifest } from '@mote/shared/release';
import { createUpdateService, registerUpdateRoutes } from '../src/updates.js';

const manifest: ReleaseManifest = { schemaVersion: 1, version: '0.5.0', tag: 'v0.5.0', channel: 'stable', publishedAt: new Date().toISOString(), repository: 'utopiafar/mote', notesUrl: 'https://github.com/utopiafar/mote/releases/tag/v0.5.0', assets: [], images: [] };
test('release status does no startup network I/O, coalesces checks and gives isolated commands', async () => {
  let calls = 0, resolve!: (value: { manifest: ReleaseManifest; available: boolean }) => void;
  const service = createUpdateService({ currentVersion: '0.4.0', runtime: 'native', profile: 'staging', profileHome: "/private/synthetic 'profile'" }, { checkRelease: async options => { calls++; assert.equal(options.repository, 'utopiafar/mote'); return new Promise(done => { resolve = done; }); } });
  assert.equal(calls, 0); assert.equal(service.status().state, 'idle');
  const first = service.check(), second = service.check(); assert.equal(calls, 1);
  resolve({ manifest, available: true }); const result = await first; assert.deepEqual(result, await second);
  assert.equal(result.verified, true); assert.equal(result.available, true); assert.ok(result.commands?.update.includes('--profile staging'));
  assert.ok(result.commands?.update.includes("'\"'\"'")); await service.check(); assert.equal(calls, 1);
  await service.close();
});
test('legacy has no executable update command, and upstream error text is never returned', async () => {
  const service = createUpdateService({ currentVersion: '0.4.0', profile: 'legacy', runtime: 'unknown' }, { checkRelease: async () => { throw Error('synthetic-private-token and upstream response'); } });
  const result = await service.check(); assert.equal(result.commands, null); assert.equal(result.error, 'release_check_failed'); assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  const missing = createUpdateService({ currentVersion: '0.4.0' }, { checkRelease: async () => { throw new ReleaseError('release_not_found'); } });
  assert.equal((await missing.check()).error, 'release_not_found'); await Promise.all([service.close(), missing.close()]);
});
test('HTTP check cannot supply a path, command, key or alternate repository', async () => {
  let called = false; const app = Fastify();
  const service = createUpdateService({ currentVersion: '0.4.0' }, { checkRelease: async () => { called = true; return { manifest, available: true }; } });
  registerUpdateRoutes(app, service);
  try {
    for (const body of [{ repository: 'other/repo' }, { command: 'echo ignored' }, { path: '/tmp/synthetic' }, { publicKey: 'untrusted' }, []]) assert.equal((await app.inject({ method: 'POST', url: '/api/software-update/check', payload: body })).statusCode, 400);
    assert.equal(called, false); assert.equal((await app.inject('/api/software-update')).json().state, 'idle');
    assert.equal((await app.inject({ method: 'POST', url: '/api/software-update/check', payload: {} })).json().verified, true);
  } finally { await service.close(); await app.close(); }
});
test('closing aborts and settles in-flight checks before returning', async () => {
  let aborted = false;
  const service = createUpdateService({ currentVersion: '0.4.0' }, { checkRelease: async options => new Promise((_resolve, reject) => { options!.signal!.addEventListener('abort', () => { aborted = true; reject(new ReleaseError('update_request_cancelled')); }, { once: true }); }) });
  const request = service.check(); await service.close(); assert.equal(aborted, true); assert.equal((await request).error, 'update_request_cancelled');
  assert.equal((await service.check()).state, 'error');
});
