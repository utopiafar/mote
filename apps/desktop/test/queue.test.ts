import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableQueue, imageHash, QueueFullError, retryDelay } from '../src/queue';
import { event, image } from './fixtures';

let directory: string;
let queue: DurableQueue;
const limits = { maxQueueBytes: 1024 * 1024, maxQueueEvents: 10 };
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-desktop-queue-test-')); queue = new DurableQueue(directory, limits); await queue.initialize(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('durable capture queue', () => {
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
  const reopened = new DurableQueue(directory, limits); await reopened.initialize(); expect((await reopened.next(3000))?.record.event).toEqual(activity); expect(await readdir(join(directory, 'blobs'))).toEqual([]);
  for (const key of ['ocrText', 'imageMime', 'imageBase64', 'mood', 'title', 'windowTitle', 'provenance']) await expect(queue.enqueue({ ...activity, [key]: 'forbidden fixture' } as never)).rejects.toThrow();
  for (const key of ['width', 'height', 'displayScale', 'maskCount', 'ocrEnabled']) await expect(queue.enqueue({ ...activity, metadata: { ...activity.metadata, capture: { [key]: key === 'ocrEnabled' ? true : 1 } } } as never)).rejects.toThrow();
  await expect(queue.enqueue({ ...activity, metadata: { ...activity.metadata, state: { serialNumber: 'not allowed' } } } as never)).rejects.toThrow();
  await expect(queue.enqueue(activity, image)).rejects.toThrow('不得包含');
});
