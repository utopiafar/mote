import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp, type QueryAgent } from '../src/app.js';
import type { Config } from '../src/config.js';

const inactive: QueryAgent = { configured: false, query: async () => { throw new Error('No model calls in synthetic heartbeat fixtures'); }, close: async () => {} };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-sync-heartbeat-'));
  const config: Config = { dataDir: directory, token: 'synthetic-owner-sync-heartbeat-token', tokenPath: 'fixture-only', host: '127.0.0.1', port: 0, profile: 'test', maxStorageBytes: 10_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '' };
  let value = await buildApp(config, { agent: inactive });
  t.after(async () => { await value.app.close(); await rm(directory, { recursive: true, force: true }); });
  return { headers: { authorization: `Bearer ${config.token}` }, get app() { return value.app; }, restart: async () => { await value.app.close(); value = await buildApp(config, { agent: inactive }); } };
}
const beat = { deviceId: 'synthetic-sync-device', deviceName: 'Synthetic Mac', platform: 'macos', status: 'capturing', queueDepth: 3, lastCaptureAt: '2026-09-14T12:00:00.000Z' };
const snapshot = { mode: 'interval', state: 'waiting', intervalMinutes: 15, batchSize: 20, pendingRecords: 7, lastUploadAt: '2026-09-14T11:50:00.000Z', nextUploadAt: '2026-09-14T12:05:00.000Z' };

test('authenticated heartbeat sync state persists independently from capture state and survives server restart', async t => {
  const client = await fixture(t);
  for (const [mode, state] of [['realtime', 'uploading'], ['interval', 'waiting'], ['batch', 'waiting'], ['manual', 'manual']]) {
    const sync = { ...snapshot, mode, state };
    const posted = await client.app.inject({ method: 'POST', url: '/api/devices/heartbeat', headers: client.headers, payload: { ...beat, sync } });
    assert.equal(posted.statusCode, 200); assert.deepEqual(posted.json(), { ok: true });
    const listed = await client.app.inject({ url: '/api/devices', headers: client.headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().items[0].sync, sync);
    assert.equal(listed.json().items[0].status, 'capturing');
    assert.equal(listed.json().items[0].queueDepth, 3);
  }
  await client.restart();
  const restored = (await client.app.inject({ url: '/api/devices', headers: client.headers })).json().items[0];
  assert.deepEqual(restored.sync, { ...snapshot, mode: 'manual', state: 'manual' });
  assert.equal(restored.lastCaptureAt, beat.lastCaptureAt);
  // An older client can still update the same device; absence means unreported, not a fabricated policy.
  assert.equal((await client.app.inject({ method: 'POST', url: '/api/devices/heartbeat', headers: client.headers, payload: beat })).statusCode, 200);
  const legacy = (await client.app.inject({ url: '/api/devices', headers: client.headers })).json().items[0];
  assert.equal(Object.hasOwn(legacy, 'sync'), false); assert.equal(legacy.status, beat.status);
});

test('invalid or unauthenticated sync snapshots are rejected before overwriting the last valid device state', async t => {
  const client = await fixture(t), payload = { ...beat, sync: snapshot };
  assert.equal((await client.app.inject({ method: 'POST', url: '/api/devices/heartbeat', payload })).statusCode, 401);
  assert.equal((await client.app.inject({ method: 'POST', url: '/api/devices/heartbeat', headers: client.headers, payload })).statusCode, 200);
  for (const invalid of [{ mode: 'immediate' }, { state: 'syncing' }, { intervalMinutes: 14 }, { intervalMinutes: 1441 }, { batchSize: 0 }, { batchSize: 501 }, { batchSize: 1.5 }, { pendingRecords: -1 }, { pendingRecords: 1_000_001 }, { pendingRecords: 0.5 }, { nextUploadAt: 'tomorrow' }, { text: 'synthetic text must not enter a synchronization heartbeat' }]) {
    const response = await client.app.inject({ method: 'POST', url: '/api/devices/heartbeat', headers: client.headers, payload: { ...beat, sync: { ...snapshot, ...invalid } } });
    assert.equal(response.statusCode, 400, JSON.stringify(invalid));
  }
  const saved = (await client.app.inject({ url: '/api/devices', headers: client.headers })).json().items[0];
  assert.deepEqual(saved.sync, snapshot); assert.equal(saved.status, beat.status);
});
