import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncHistory, captureHistoryItem, historyRange, sourceHistoryItem } from '../src/sync-history';
import { SourceSync } from '../src/source-sync';
import type { ScannedItem, SourceDefinition, SourceItem } from '../src/source-types';
import { event, sourceAck } from './fixtures';

let directory: string, history: SyncHistory;
let now = new Date(2026, 9, 7, 12).getTime();
const config = { serverUrl: 'http://127.0.0.1:7331', deviceId: 'generated-device' };
const day = '2026-10-07';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mote-sync-history-'));
  now = new Date(2026, 9, 7, 12).getTime();
  history = new SyncHistory(join(directory, 'history.sqlite'), () => now);
  await history.initialize();
});
afterEach(async () => { history.close(); await rm(directory, { recursive: true, force: true }); });
const record = () => captureHistoryItem(event(randomUUID()));

it('persists partial receipts, request bytes and first-confirmation deduplication across retries', () => {
  const first = record(), second = record(), run = history.begin(config, 'manual');
  history.attempt(run, [first, second]); history.addBytes(run, 123);
  history.settle(run, first.key, true, first.captureId, 201);
  history.settle(run, second.key, false, undefined, 503); history.finish(run);
  expect(history.run(config, run)).toMatchObject({ outcome: 'partial', bytes: 123, total: 2, received: 1, unconfirmed: 1 });
  const retry = history.begin(config, 'automatic'); history.attempt(retry, [first, second]); history.addBytes(retry, 456);
  history.settle(retry, first.key, true, first.captureId, 200);
  history.settle(retry, second.key, true, second.captureId, 201); history.finish(retry);
  expect(history.page(config, { day })).toMatchObject({ total: 2, received: 2, bytes: 579 });
  expect(history.item(config, retry, first.key).firstReceipt).toBe(false);
  expect(history.item(config, retry, second.key).firstReceipt).toBe(true);
  expect(history.contents(config, { runId: run }).items).toHaveLength(2);
});

it('does not revoke a validated ACK when local cleanup or a later split request fails', () => {
  const item = record(), run = history.begin(config, 'manual'); history.attempt(run, [item]);
  history.settle(run, item.key, true, item.captureId, 201);
  history.settle(run, item.key, false, undefined, 500);
  history.attempt(run, [item]); history.finish(run);
  expect(history.item(config, run, item.key)).toMatchObject({ outcome: 'received', firstReceipt: true });
  expect(history.run(config, run).outcome).toBe('received');
});

it('isolates node and device receipts before content lookup and recovers unfinished runs', async () => {
  const item = record(), run = history.begin(config, 'automatic'); history.attempt(run, [item]);
  history.close(); history = new SyncHistory(join(directory, 'history.sqlite'), () => now); await history.initialize();
  expect(history.run(config, run)).toMatchObject({ outcome: 'interrupted', received: 0, unconfirmed: 1 });
  expect(history.item(config, run, item.key).outcome).toBe('interrupted');
  for (const foreign of [{ ...config, deviceId: 'another' }, { ...config, serverUrl: 'http://127.0.0.1:7441' }]) {
    expect(history.page(foreign, { day }).total).toBe(0);
    expect(() => history.item(foreign, run, item.key)).toThrow();
    expect(history.receivedCapture(foreign, item.key)).toBeUndefined();
  }
});

it('keeps only metadata, restricts database permissions and prunes after 30 days', async () => {
  const fixture = event(), item = captureHistoryItem({ ...fixture, ocrText: 'GENERATED SECRET BODY' });
  const run = history.begin(config, 'manual'); history.attempt(run, [item]); history.settle(run, item.key, true, fixture.id); history.finish(run);
  expect((await stat(join(directory, 'history.sqlite'))).mode & 0o777).toBe(0o600);
  history.close();
  expect((await readFile(join(directory, 'history.sqlite'))).includes(Buffer.from('GENERATED SECRET BODY'))).toBe(false);
  now += 31 * 86400000; history = new SyncHistory(join(directory, 'history.sqlite'), () => now); await history.initialize();
  expect(() => history.run(config, run)).toThrow();
  expect(history.page(config, { day }).received).toBe(0);
});

it('bounds pagination and validates filters and calendar dates', () => {
  for (let i = 0; i < 23; i++) { const run = history.begin(config, 'manual'), item = record(); history.attempt(run, [item]); history.settle(run, item.key, true, item.captureId); history.finish(run); }
  const page = history.page(config, { day }); expect(page.items).toHaveLength(20); expect(page.nextOffset).toBe(20);
  expect(history.page(config, { day, offset: 20 }).items).toHaveLength(3);
  for (const invalid of ['2026-02-30', '2026-13-01', 'not-a-date']) expect(() => historyRange(invalid)).toThrow();
  expect(historyRange(day, 7).days).toHaveLength(7);
  expect(() => history.page(config, { day, offset: -1 })).toThrow();
  expect(() => history.page(config, { day, source: 'unknown' as any })).toThrow();
  expect(() => history.page(config, { day, outcome: 'sending' as any })).toThrow();
});

const source: SourceDefinition = { id: 'generated-source', name: 'Fixture', deviceId: config.deviceId, enabled: true, kind: 'local-files', retention: 'reference', platform: 'macos' };
const indexed = (i: number): ScannedItem => ({ externalId: `fixture-${i}`, title: `Generated file ${i}`, text: '', kind: 'file', layer: 'reference', document: { fileIndex: { version: 1, fileId: `file-${i}`, contentVersion: 'generated', mode: 'catalog', coverage: 'none', parser: 'none', status: 'ready', totalCharacters: 0, offset: 0, length: 0, allowRead: false } } });

it('journals partial manifest receipts and quarantined failures without changing queue acknowledgement', async () => {
  const engine = new SourceSync(join(directory, 'source.json')); await engine.initialize();
  await engine.stage({ items: [indexed(0), indexed(1)], seen: [], complete: false, skipped: 0 }, false);
  const run = history.begin(config, 'manual');
  await engine.flush(source, async (path, body) => {
    if (path === '/api/sources') return { id: source.id, enabled: true };
    if (path.endsWith('capabilities')) return { manifestBatch: 100 };
    const items = (body as { items: { item: SourceItem }[] }).items;
    return { results: items.map(({ item }, i) => i ? { externalId: item.externalId, revision: item.revision, state: 'rejected', status: 410 } : { externalId: item.externalId, revision: item.revision, state: 'accepted', ack: sourceAck(source.id, item, 'file-revision') }) };
  }, undefined, history.observer(run)); history.finish(run);
  expect(history.run(config, run)).toMatchObject({ outcome: 'partial', received: 1, unconfirmed: 1 });
  expect(engine.status()).toMatchObject({ pending: 0, blocked: 1 });
  expect(history.contents(config, { runId: run, source: 'file', outcome: 'unconfirmed' }).items[0].code).toBe(410);
});

it('preserves an earlier individual file ACK when a later request fails', async () => {
  const engine = new SourceSync(join(directory, 'source.json')); await engine.initialize();
  await engine.stage({ items: [indexed(0), indexed(1)], seen: [], complete: false, skipped: 0 }, false);
  const run = history.begin(config, 'manual'); let calls = 0;
  await expect(engine.flush(source, async (path, body) => {
    if (path === '/api/sources') return { id: source.id, enabled: true };
    if (path.endsWith('capabilities')) return {};
    if (path.startsWith('/api/file-sync/v1/head')) return { revision: null };
    if (++calls > 1) throw Error('generated network failure');
    return sourceAck(source.id, (body as { item: SourceItem }).item, 'file-revision');
  }, undefined, history.observer(run))).rejects.toThrow('generated network failure');
  history.finish(run);
  expect(history.run(config, run)).toMatchObject({ outcome: 'partial', received: 1, unconfirmed: 1 });
  expect(engine.status().pending).toBe(2);
});
