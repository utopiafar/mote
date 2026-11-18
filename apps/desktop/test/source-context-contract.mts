import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { centralSourceContentPage } from '../src/content-library';
import { SourceContextOutbox } from '../src/source-context-outbox';
import { DEFAULT_SOURCE_OPTIONS, type SourceRequest } from '../src/source-types';
import { defaultConfig } from '../src/config';
import { TransportFailure, httpFailure } from '../src/support';
import { buildFixtureCentral } from './central-fixture.mjs';

const token = 'generated-desktop-source-context-owner';
const headers = { authorization: 'Bearer ' + token };
const id = 'local-ff0dca9c-dc56-4f25-b35a-aac044731313';
const definition = { id, name: 'Generated local folder', kind: 'local-files', deviceId: 'generated-device', platform: 'macos' as const, retention: 'snapshot' as const, enabled: true };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-source-context-contract-'));
  let node: Awaited<ReturnType<typeof buildFixtureCentral>> | undefined;
  t.after(async () => {
    try { await node?.app.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  node = await buildFixtureCentral(join(directory, 'vault'), token);
  return { ...node, directory };
}

async function collectorToken(connections: Awaited<ReturnType<typeof fixture>>['connections'], deviceId: string) {
  const { invitation } = connections.invite({ label: 'Generated collector', serverUrl: 'http://127.0.0.1', deviceId }, 'collector');
  return (await connections.redeem({ code: invitation.code, deviceId, deviceName: 'Generated Mac', platform: 'macos' })).token;
}

test('owner source-context route preserves exact text, retry identity, conflicts and private persistence', async t => {
  const { directory, app, sources, connections } = await fixture(t);
  sources.register(definition);
  const collectorHeaders = { authorization: 'Bearer ' + await collectorToken(connections, definition.deviceId) };
  let denied = false, drop = false;
  const calls: unknown[] = [];
  const request: SourceRequest = async (path, body, method) => {
    calls.push({ path, body, method });
    const response = await app.inject({
      method, url: path, headers: denied ? collectorHeaders : headers,
      ...(body === undefined ? {} : { payload: body as { expectedVersion: number; description: string } }),
    });
    if (response.statusCode >= 400) throw new TransportFailure('Generated route failure', httpFailure(response.statusCode), response.statusCode);
    if (drop && method === 'PATCH') { drop = false; throw Error('Generated lost ACK'); }
    return response.json();
  };
  const signal = new AbortController().signal;
  const path = join(directory, 'binding-one', 'contexts.json');
  let outbox = new SourceContextOutbox(path);
  await outbox.initialize();

  assert.deepEqual((await outbox.read(id, request, signal)).snapshot, { sourceId: id, version: 0, description: '' });
  const description = 'Generated author statement\n<script>literal only</script> 🧑🏽‍💻';
  await outbox.stage(id, { expectedVersion: 0, description });
  drop = true;
  await assert.rejects(outbox.flush(id, request, signal), /Generated lost ACK/);
  assert.equal(sources.contexts.current(id).description, description);
  assert.equal(outbox.get(id).pending?.expectedVersion, 0);

  outbox = new SourceContextOutbox(path);
  await outbox.initialize();
  assert.equal(outbox.get(id).pending?.description, description);
  await outbox.flush(id, request, signal);
  assert.equal(outbox.pending(id), false);
  assert.equal(sources.contexts.current(id).version, 1);

  await outbox.stage(id, { expectedVersion: 1, description: 'Generated local edit' });
  const edit = await app.inject({
    method: 'PATCH', url: '/api/sources/' + id + '/context', headers,
    payload: { expectedVersion: 1, description: 'Generated other owner edit' },
  });
  assert.equal(edit.statusCode, 200, edit.body);
  await assert.rejects(outbox.flush(id, request, signal), { httpStatus: 409 });
  assert.equal(outbox.get(id).conflict, true);
  assert.equal(outbox.get(id).snapshot.description, 'Generated other owner edit');
  assert.equal(outbox.get(id).pending?.description, 'Generated local edit');
  const before = calls.length;
  await assert.rejects(outbox.flush(id, request, signal));
  assert.equal(calls.length, before, 'Conflicts never retry by overwriting the newly observed version');

  await outbox.stage(id, { expectedVersion: 2, description: 'Generated reviewed edit' });
  denied = true;
  await assert.rejects(outbox.flush(id, request, signal), { httpStatus: 403 });
  assert.equal(outbox.get(id).pending?.description, 'Generated reviewed edit');
  assert.equal((await outbox.read(id, request, signal)).error, 'denied');
  denied = false;
  await outbox.flush(id, request, signal);

  const other = new SourceContextOutbox(join(directory, 'binding-two', 'contexts.json'));
  await other.initialize();
  assert.equal(other.pending(id), false);
  assert.equal(other.get(id).snapshot.description, '');
  const reauthorizedPath = join(directory, 'reauthorized', 'contexts.json');
  await outbox.checkpointTo(reauthorizedPath);
  const reauthorized = new SourceContextOutbox(reauthorizedPath);
  await reauthorized.initialize();
  assert.equal(reauthorized.get(id).snapshot.description, 'Generated reviewed edit');
  const metadata = await app.inject({ url: '/api/sources', headers });
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.equal(metadata.body.includes('Generated reviewed edit'), false, 'Private description is absent from public source metadata');
  await outbox.stage(id, { expectedVersion: 3, description: '' });
  await outbox.flush(id, request, signal);
  assert.equal(sources.contexts.current(id).description, '');
});

test('source archive HTTP rows are consumed with exact identities, pagination and source/device boundaries', async t => {
  const { app, sources, connections } = await fixture(t);
  const otherId = id + 'other', otherDeviceId = 'another-device';
  sources.register(definition);
  sources.register({ ...definition, id: otherId, deviceId: otherDeviceId });
  for (let i = 0; i < 31; i++) {
    await sources.upsert(id, { externalId: String(i), revision: 'v1', title: 'Generated ' + i, text: 'Exact text ' + i, observedAt: '2026-10-01T10:00:00.000Z', kind: 'file', layer: 'snapshot' });
  }
  await sources.upsert(otherId, { externalId: 'other', revision: 'v1', title: 'Other device', text: 'Must stay elsewhere', observedAt: '2026-10-01T10:00:00.000Z', kind: 'file', layer: 'snapshot' });

  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = { ...defaultConfig(), serverUrl, token, deviceId: definition.deviceId };
  const source = { ...DEFAULT_SOURCE_OPTIONS, ...definition };
  const page = await centralSourceContentPage(config, source);
  assert.equal(page.items.length, 30);
  assert.ok(page.nextCursor);
  assert.ok(page.items.every(row => row.key.startsWith('capture:') && row.source === 'file' && row.sourceName === definition.name));
  const second = await centralSourceContentPage(config, source, page.nextCursor);
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...page.items, ...second.items].map(item => item.key)).size, 31);
  assert.equal(JSON.stringify(page).includes('Must stay elsewhere'), false);

  const otherToken = await collectorToken(connections, otherDeviceId);
  assert.deepEqual(await centralSourceContentPage({ ...config, token: otherToken }, source), { items: [], authorizationDenied: true });
});

test('processed snapshot metadata rows render in the Mac archive page for both read permissions', async t => {
  const { app, sources } = await fixture(t);
  const source = { ...DEFAULT_SOURCE_OPTIONS, ...definition, name: 'Generated snapshot folder' };
  sources.register({ ...definition, name: source.name });
  const fileIndex = { version: 1 as const, fileId: 'generated-file', contentVersion: 'f'.repeat(64), mode: 'index' as const, coverage: 'full' as const, parser: 'text.utf8', status: 'ready' as const, totalCharacters: 633, offset: 0, length: 633, maxIndexCharacters: 8000, allowRead: false };
  const item = { externalId: 'file:generated-metadata', revision: 'v1', observedAt: '2026-11-03T00:00:00.000Z', title: 'Generated snapshot', text: '', kind: 'file' as const, layer: 'snapshot' as const, mimeType: 'text/plain', document: { fileId: 'generated-file', contentRole: 'other', timeBasis: 'unknown', fileIndex } };
  await sources.upsert(id, item);
  await sources.upsert(id, { ...item, externalId: 'file:generated-metadata-readable', revision: 'v2', document: { ...item.document, fileIndex: { ...fileIndex, allowRead: true } } });

  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const page = await centralSourceContentPage({ ...defaultConfig(), serverUrl, token, deviceId: definition.deviceId }, source);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every(row => row.key.startsWith('capture:') && row.source === 'file' && row.sourceName === source.name));
});

test('desktop capture-channel outbox consumes actual device context routes without changing original bytes', async t => {
  const { LocalSourceManager } = await import('../src/source-manager');
  const { directory, app, store } = await fixture(t);
  const deviceId = 'generated-mac-context';
  const input = {
    id: '6245e812-27d0-4da0-bbf3-5abbbeedc25a', deviceId, deviceName: 'Generated Mac', platform: 'macos' as const,
    source: 'activity' as const, capturedAt: '2026-10-29T08:00:00.000Z', durationMs: 1000, appId: 'dev.mote.generated', appName: 'Generated Notes',
    privacy: { excluded: false as const, redacted: false, mode: 'none' as const, collection: 'activity' as const },
  };
  await store.ingest(input);
  const original = store.db.prepare('SELECT json FROM captures WHERE id=?').get(input.id)!.json;
  const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const manager = new LocalSourceManager(join(directory, 'desktop'), {
    ...defaultConfig(), deviceId, serverUrl, token, syncMode: 'manual', syncPaused: true,
  }, '/never-native-helper', true);
  try {
    await manager.initialize();
    const signal = new AbortController().signal;
    const empty = await manager.captureContext('activity');
    assert.equal(empty.snapshot.version, 0);
    await manager.saveCaptureContext('activity', { expectedVersion: 0, description: 'Generated source-wide declaration' });
    assert.equal(manager.pendingStats().pendingUpdates, 1);
    await manager.flushPending(signal);
    assert.equal((await manager.captureContext('activity')).pending?.description, 'Generated source-wide declaration');
    await manager.setSyncPaused(false);
    await manager.flushPending(signal);
    const accepted = await manager.captureContext('activity');
    assert.equal(accepted.snapshot.description, 'Generated source-wide declaration');
    assert.equal(accepted.snapshot.version, 1);
    assert.equal(accepted.pending, undefined);
    assert.equal((await manager.captureContext('screen')).snapshot.description, '');
    assert.equal(store.db.prepare('SELECT json FROM captures WHERE id=?').get(input.id)!.json, original);
    await manager.saveCaptureContext('activity', { expectedVersion: 1, description: '' });
    await manager.flushPending(signal);
    assert.equal((await manager.captureContext('activity')).snapshot.description, '');
  } finally {
    await manager.close();
  }
});
