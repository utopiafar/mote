import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceSync } from '../src/source-sync';
import type { ScannedItem, SourceDefinition } from '../src/source-types';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mote-source-batch-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const source: SourceDefinition = { id: 'fixture', name: 'fixture', kind: 'coding-agent', deviceId: 'device', platform: 'macos', retention: 'snapshot', enabled: true };
const item = (index: number, syncQueue: 'realtime' | 'history'): ScannedItem => ({ externalId: `event-${index}`, title: `event ${index}`, text: `generated ${index}`, kind: 'message', layer: 'snapshot', syncQueue });
const receipt = (value: ScannedItem & { revision: string }) => ({ id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: source.id, externalId: value.externalId, revision: value.revision, duplicate: false });

it('uploads ordinary source records in batches, gives realtime four turns for one history turn, and checkpoints per batch', async () => {
  const engine = new SourceSync(join(root, 'state.json'));
  await engine.initialize();
  await engine.stage({ items: [...Array.from({ length: 500 }, (_, i) => item(i, 'realtime')), ...Array.from({ length: 100 }, (_, i) => item(i + 500, 'history'))], seen: [], complete: true, skipped: 0 }, false);
  const paths: string[] = [], firstIds: string[] = [];
  const request = async (path: string, body: unknown, method: 'GET' | 'POST' | 'PUT') => {
    paths.push(`${method} ${path}`);
    if (path === '/api/sources') return { id: source.id, enabled: true };
    const records = (body as { items: Array<ScannedItem & { revision: string }> }).items;
    firstIds.push(records[0]!.externalId);
    return { receipts: records.map(receipt) };
  };
  await engine.flush(source, request);
  const batches = paths.filter(path => path.includes('/items/batch'));
  expect(batches).toHaveLength(6);
  expect(firstIds.slice(0, 4).every(id => Number(id.replace('event-', '')) < 500)).toBe(true);
  expect(Number(firstIds[4]!.replace('event-', ''))).toBeGreaterThanOrEqual(500);
  expect(engine.status()).toMatchObject({ pending: 0, realtimePending: 0, historyPending: 0 });
});

it('does not remove a batch when the central acknowledgement has the wrong identity', async () => {
  const engine = new SourceSync(join(root, 'state.json'));
  await engine.stage({ items: [item(1, 'realtime'), item(2, 'realtime')], seen: [], complete: true, skipped: 0 }, false);
  await expect(engine.flush(source, async (path, body) => {
    if (path === '/api/sources') return { id: source.id, enabled: true };
    const records = (body as { items: Array<ScannedItem & { revision: string }> }).items;
    return { receipts: records.map(value => ({ ...receipt(value), externalId: 'not-the-record' })) };
  })).rejects.toThrow('确认');
  expect(engine.status().pending).toBe(2);
});
