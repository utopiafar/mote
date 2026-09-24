import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue, imageHash, QueueFullError, retryDelay } from '../src/queue';
import {extendState} from '@mote/shared/state-series';
import { event, image } from './fixtures';

let directory: string;
let queue: DurableQueue;
const limits = { maxQueueBytes: 1024 * 1024, maxQueueEvents: 10 };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-desktop-queue-test-')); queue = new DurableQueue(directory, limits); await queue.initialize(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('durable capture queue', () => {
  it('clears only pending pre-v2 captures and keeps acknowledged local originals for browse', async () => {
    const acknowledged={...event('f50650f0-fb31-4215-90cd-c96dc62d5e94'),ocr:{status:'pending' as const}};
    await queue.enqueue(acknowledged,image);
    await queue.acknowledge(acknowledged.id);
    await queue.enqueue(event(), image);
    await queue.syncCheckpoint('2026-09-22T01:00:00Z');
    await writeFile(join(directory, 'capture-input-journal.json'), 'legacy pending input');
    await writeFile(join(directory, 'capture-stage-journal.json'), 'legacy stage output');
    await rm(join(directory, 'capture-ingress-v2.json'));
    const upgraded = new DurableQueue(directory, limits);
    await upgraded.initialize();
    expect(upgraded.stats().depth).toBe(0);
    expect(upgraded.stats().blocked).toBe(0);
    expect(await readdir(join(directory, 'events'))).toEqual([`${acknowledged.id}.json`]);
    expect(await readdir(join(directory, 'blobs'))).toEqual([`${imageHash(image)}.jpg`]);
    expect(upgraded.recordForBrowser(acknowledged.id)?.syncError).toBe('legacy_ingress_archive');
    expect(await upgraded.imageForBrowser(acknowledged.id)).toEqual(image);
    expect(await upgraded.next()).toBeUndefined();
    for (const name of ['capture-input-journal.json', 'capture-stage-journal.json', 'capture-stage-checkpoint.json', 'sync-checkpoint.json']) {
      await expect(stat(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await upgraded.resetRetries();
    expect(await upgraded.next()).toBeUndefined();
    const backup=await upgraded.exportArchive();
    const restored=new DurableQueue(join(directory,'explicit-restore'),limits);
    await restored.initialize();
    await restored.importArchive(backup);
    expect((await restored.next())?.record).toMatchObject({event:{id:acknowledged.id},uploaded:false});
    expect(JSON.parse(await readFile(join(directory, 'capture-ingress-v2.json'), 'utf8'))).toEqual({ version: 2 });
    const fresh = event('f50650f0-fb31-4215-90cd-c96dc62d5e93');
    upgraded.setLimits({...limits,maxQueueEvents:1});
    await upgraded.enqueue(fresh, image);
    const reopened = new DurableQueue(directory, limits);
    await reopened.initialize();
    expect((await reopened.next())?.record.event.id).toBe(fresh.id);
  });
  it('retains the archive ACK origin separately from retry and last-contact timestamps',async()=>{
    queue.stats();
    await queue.syncCheckpoint('2026-09-22T01:00:00Z','2026-09-22T01:01:00Z');
    expect(queue.stats().archiveAcknowledgment).toBeUndefined();
    const ack={at:'2026-09-22T01:02:00Z',origin:'https://fixture.invalid'};
    await queue.syncCheckpoint(ack.at,undefined,ack);expect(queue.stats().archiveAcknowledgment).toEqual(ack);
    const reopened=new DurableQueue(directory,limits);await reopened.initialize();expect(reopened.stats().archiveAcknowledgment).toEqual(ack);
  });
  it('rejects a blank application name before accepting an upload record', async () => {
    for (const appName of ['', '  \t\n']) await expect(queue.enqueue({ ...event(), appName }, image)).rejects.toThrow();
    expect(queue.stats().depth).toBe(0);
    await queue.enqueue({ ...event(), appName: '生成的应用' }, image);
    const restarted = new DurableQueue(directory, limits); await restarted.initialize();
    expect((await restarted.next())?.record.event.appName).toBe('生成的应用');
  });
  it('stores directly readable JSON and original JPEG bytes and reopens them without a content decryption key', async () => {
    const original = { ...event(), ocrText: '合成明文记录\n可直接读取的 OCR' };
    await queue.enqueue(original, image);
    const eventPath = join(directory, 'events', `${original.id}.json`);
    const imagePath = join(directory, 'blobs', `${imageHash(image)}.jpg`);
    expect(JSON.parse(await readFile(eventPath, 'utf8')).event).toEqual(original);
    expect(await readFile(imagePath)).toEqual(image);
    if (process.platform !== 'win32') {
      expect((await stat(eventPath)).mode & 0o777).toBe(0o600);
      expect((await stat(imagePath)).mode & 0o777).toBe(0o600);
    }
    const reopened = new DurableQueue(directory, limits);
    await reopened.initialize();
    expect((await reopened.next())?.record.event).toEqual(original);
    expect(await reopened.imageForBrowser(original.id)).toEqual(image);
  });
  it('pages only matching screenshots and isolates returned records from the durable queue', async () => {
    const first = event(), second = {...event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), capturedAt: '2026-09-14T13:00:00.000Z'};
    await queue.enqueue({...first, capturedAt: '2026-09-14T12:00:00.000Z'}, image);
    await queue.enqueue(second, image);
    const page = await queue.pageForBrowser('2026-09-14T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 0, 1);
    expect(page.total).toBe(2); expect(page.records.map(r => r.event.id)).toEqual([second.id]);
    page.records[0].event.ocrText = 'mutated';
    expect(queue.recordForBrowser(second.id)?.event.ocrText).toBe(second.ocrText);
    expect((await queue.pageForBrowser('2026-09-14T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 1, 1)).records.map(r => r.event.id)).toEqual([first.id]);
    expect((await queue.pageForBrowser('2026-09-15T00:00:00.000Z', '2026-09-16T00:00:00.000Z', 0, 1)).total).toBe(0);
  });
  it('makes progress at the byte limit by consuming pre-reserved OCR space, including worst-case escaping', async () => {
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const } };
    await queue.enqueue(original, image); await queue.acknowledge(original.id);
    const reserved = queue.stats().bytes;
    queue.setLimits({ ...limits, maxQueueBytes: reserved });
    expect(queue.atCapacity()).toBe(true);
    await expect(queue.saveOcr(original.id, '\u0000'.repeat(100000))).resolves.toBeUndefined();
    expect(queue.stats().bytes).toBeLessThanOrEqual(reserved);
    await queue.acknowledge(original.id, true); expect(queue.stats().depth).toBe(0);
  });
  it('retains deferred OCR quota and immutable payload through ACK/restart/export until OCR succeeds', async () => {
    queue.setLimits({ ...limits, maxQueueEvents: 1 });
    const original = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const, reason: 'charging' as const } };
    await queue.enqueue(original, image); await queue.acknowledge(original.id);
    expect(queue.atCapacity()).toBe(true); expect(queue.stats()).toMatchObject({ depth: 1, waitingOcr: 1, eligibleDepth: 0 });
    await expect(queue.enqueue(event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), image)).rejects.toBeInstanceOf(QueueFullError);
    const restored = new DurableQueue(directory, { ...limits, maxQueueEvents: 1 }); await restored.initialize();
    expect((await restored.nextOcr())?.image).toEqual(image); expect(await restored.next()).toBeUndefined();
    await restored.saveOcr(original.id, 'RECOGNIZED FIXTURE');
    const entry = await restored.next(); expect(entry?.record.event).toEqual(original); expect(entry?.record.uploaded).toBe(true); expect(entry?.record.ocrResult).toBe('RECOGNIZED FIXTURE');
    const target = new DurableQueue(join(directory, 'imported'), limits); await target.initialize(); await target.importArchive(await restored.exportArchive());
    expect((await target.next())?.record.uploaded).toBe(false); // Imported node must ACK original again before patch.
    await restored.acknowledge(original.id, true); expect(restored.stats().depth).toBe(0); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  });
  it('deduplicates identical image bytes while preserving every sampled observation and survives restart', async () => {
    await queue.enqueue(event(), image);
    await queue.enqueue(event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), image);
    expect(queue.stats().depth).toBe(2);
    expect(await readdir(join(directory, 'blobs'))).toHaveLength(1);
    const restored = new DurableQueue(directory, limits); await restored.initialize();
    expect(restored.stats().depth).toBe(2);
    expect((await restored.next())?.image).toEqual(image);
    await restored.acknowledge(event().id);
    expect(await readdir(join(directory, 'blobs'))).toHaveLength(1);
    await restored.acknowledge('f50650f0-fb31-4215-90cd-c96dc62d5e93');
    expect(await readdir(join(directory, 'blobs'))).toHaveLength(0);
  });
  it('uses stable event IDs idempotently and rejects conflicting content', async () => {
    expect(await queue.enqueue(event(), image)).toBe(true);
    expect(await queue.enqueue(event(), image)).toBe(false);
    await expect(queue.enqueue({ ...event(), ocrText: 'changed' }, image)).rejects.toThrow('相同事件 ID');
    expect(queue.stats().depth).toBe(1);
  });
  it('serializes concurrent appends and respects a hard count bound without dropping old observations', async () => {
    queue.setLimits({ ...limits, maxQueueEvents: 1 });
    const results = await Promise.allSettled([queue.enqueue(event(), image), queue.enqueue(event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), image)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(queue.stats().depth).toBe(1);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(QueueFullError);
  });
  it('counts metadata against the byte bound and writes no orphan when full', async () => {
    queue.setLimits({ ...limits, maxQueueBytes: 20 });
    await expect(queue.enqueue(event(), image)).rejects.toBeInstanceOf(QueueFullError);
    expect(await readdir(join(directory, 'blobs'))).toHaveLength(0);
  });
  it('persists retry scheduling across a crash and preserves unchanged retry payload', async () => {
    await queue.enqueue(event(), image);
    const original = await queue.next(0);
    await queue.failed(event().id, 1000, () => 0.5);
    const restored = new DurableQueue(directory, limits); await restored.initialize();
    expect(await restored.next(2999)).toBeUndefined();
    const retry = await restored.next(3000);
    expect(retry?.record.event).toEqual(original?.record.event);
    expect(retry?.image).toEqual(original?.image);
    expect(retry?.record.attempts).toBe(1);
    await restored.resetRetries();
    expect(await restored.next(0)).toBeDefined();
    expect(retryDelay(100, () => 0.5)).toBe(15 * 60000);
  });
  it('exports portable sanitized data and imports only after all hashes validate', async () => {
    await queue.enqueue(event(), image);
    const archive = await queue.exportArchive();
    expect(archive.blobs[imageHash(image)]).toBe(image.toString('base64'));
    expect(await queue.importArchive(archive)).toBe(0);
    const target = new DurableQueue(join(directory, 'target'), limits); await target.initialize();
    const invalid = structuredClone(archive); invalid.blobs[imageHash(image)] = Buffer.from('corrupted').toString('base64');
    await expect(target.importArchive(invalid)).rejects.toThrow();
    expect(target.stats().depth).toBe(0);
    expect(await target.importArchive(archive)).toBe(1);
    expect((await target.next())?.image).toEqual(image);
  });
  it('rejects excluded events and filesystem path IDs before writing', async () => {
    await expect(queue.enqueue({ ...event(), privacy: { ...event().privacy, excluded: true } } as never, image)).rejects.toThrow();
    await expect(queue.enqueue({ ...event(), id: '../outside' }, image)).rejects.toThrow();
    expect(queue.stats().depth).toBe(0);
  });
  it('cleans crash leftovers, while failing closed on corrupted durable records', async () => {
    const orphanHash = imageHash(image);
    await writeFile(join(directory, 'blobs', `${orphanHash}.jpg`), image);
    await writeFile(join(directory, 'events', 'interrupted.tmp'), 'partial');
    await queue.initialize();
    expect(await readdir(join(directory, 'events'))).toHaveLength(0);
    expect(await readdir(join(directory, 'blobs'))).toHaveLength(0);
    await queue.enqueue(event(), image);
    await writeFile(join(directory, 'blobs', `${orphanHash}.jpg`), Buffer.from('corrupt'));
    const restored = new DurableQueue(directory, limits);
    await expect(restored.initialize()).rejects.toThrow();
    expect(JSON.parse(await readFile(join(directory, 'events', `${event().id}.json`), 'utf8')).event.id).toBe(event().id);
  });
});

  it('persists and exports notes without synthetic blobs, retaining original text, mood and stable retries', async () => {
    const note = { ...event(), source: 'note' as const, imageMime: undefined, durationMs: 0, ocrText: '  合成随手记\n第二行  ', mood: '平静', privacy: { excluded: false as const, redacted: false, mode: 'none' as const } };
    await queue.enqueue(note); await queue.failed(note.id, 1000, () => .5);
    expect(await readdir(join(directory, 'blobs'))).toEqual([]);
    const restored = new DurableQueue(directory, limits); await restored.initialize();
    expect((await restored.next(3000))?.record.event.ocrText).toBe(note.ocrText);
    expect((await restored.next(3000))?.image).toBeUndefined();
    const archive = await restored.exportArchive(); expect(archive.blobs).toEqual({});
    const target = new DurableQueue(join(directory, 'notes-target'), limits); await target.initialize();
    expect(await target.importArchive(archive)).toBe(1); expect(await target.importArchive(archive)).toBe(0);
    expect((await target.next())?.record.event.mood).toBe('平静');
    await target.acknowledge(note.id); expect(target.stats().depth).toBe(0);
    await expect(queue.enqueue(note, image)).rejects.toThrow('不得包含');
  });

it('keeps activity metadata durable but rejects all content fields and content-only capture parameters before disk', async () => {
  const { imageMime, ocrText, ...base } = event();
  const activity = { ...base, source: 'activity' as const, privacy: { excluded: false as const, redacted: false, mode: 'none' as const, collection: 'activity' as const }, metadata: { version: 1 as const, observedAt: base.capturedAt, capture: { intervalMs: 15000 }, device: { osVersion: 'synthetic' } } };
  await queue.enqueue(activity); await queue.failed(activity.id, 1000, () => .5);
  const reopened = new DurableQueue(directory, limits); await reopened.initialize(); expect((await reopened.next(3000))?.record.event).toEqual(extendState(undefined,activity)); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  for (const key of ['ocrText', 'imageMime', 'imageBase64', 'mood', 'title', 'windowTitle', 'provenance']) await expect(queue.enqueue({ ...activity, [key]: 'forbidden fixture' } as never)).rejects.toThrow();
  for (const key of ['width', 'height', 'displayScale', 'maskCount', 'ocrEnabled']) await expect(queue.enqueue({ ...activity, metadata: { ...activity.metadata, capture: { [key]: key === 'ocrEnabled' ? true : 1 } } } as never)).rejects.toThrow();
  await expect(queue.enqueue({ ...activity, metadata: { ...activity.metadata, state: { serialNumber: 'not allowed' } } } as never)).rejects.toThrow();
  await expect(queue.enqueue(activity, image)).rejects.toThrow('不得包含');
});

it('retains generated Mac notification observations across queue reload and metadata export', async () => {
  const base=event(),at=base.capturedAt;
  const notification={...base,source:'notification' as const,imageMime:undefined,ocr:undefined,ocrText:'',durationMs:0,
    privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'content' as const},
    metadata:{version:1 as const,observedAt:at,collector:{method:'accessibility' as const},observation:{sessionId:base.id,elapsedRealtimeMs:1},notification:{action:'posted' as const,notificationKey:'ab'.repeat(32),postedAt:at,ongoing:false,groupSummary:false,text:'Generated notification'}}};
  await queue.enqueue(notification);
  const restored=new DurableQueue(directory,limits);await restored.initialize();
  expect((await restored.next())?.record.event.metadata?.notification?.text).toBe('Generated notification');
  expect(restored.exportMetadata().records[0].source).toBe('notification');
});

it('persists compacted observations across restart and ignores an acknowledgement for an older prefix',async()=>{
  const base=event(), first={...base,source:'activity' as const,privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'activity' as const}};
  delete first.imageMime;delete first.ocrText;delete first.ocr;
  first.capturedAt='2026-09-17T00:00:00.000Z';first.durationMs=0;
  await queue.enqueue(first);await queue.enqueue({...first,id:crypto.randomUUID(),capturedAt:'2026-09-17T00:00:05.000Z',durationMs:5000});
  const restarted=new DurableQueue(directory,limits);await restarted.initialize();
  expect((await restarted.next())?.record.event.stateSeries?.samples).toHaveLength(2);
  await restarted.acknowledge(first.id,false,1);expect(restarted.stats().depth).toBe(1);
});

it('packs stable snapshots without acknowledging other records when a receipt is partial', async () => {
  const a = event(), b = event('00000000-0000-4000-8000-000000000077');
  await queue.enqueue(a, image); await queue.enqueue(b, image);
  const batch = await queue.nextBatch(25, Date.now(), true);
  expect(batch.map(item => item.record.event.id).sort()).toEqual([a.id, b.id].sort());
  await queue.acknowledge(a.id);
  expect((await queue.nextBatch()).map(item => item.record.event.id)).toEqual([b.id]);
  const reopened = new DurableQueue(directory, limits); await reopened.initialize();
  expect((await reopened.next())?.record.event.id).toBe(b.id);
});
