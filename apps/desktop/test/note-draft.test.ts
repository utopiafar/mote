import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NoteDraftStore } from '../src/note-draft';
import { DurableQueue } from '../src/queue';
import { defaultConfig } from '../src/config';
let directory: string;
const config = defaultConfig();
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-note-draft-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('restores the exact draft and ignores reordered older autosave revisions', async () => {
  const store = new NoteDraftStore(directory); await store.initialize();
  const initial = store.get(), latest = { ...initial, text: ' 原文\n新行 ', mood: '平静', revision: 2 };
  await store.update(latest); await store.update({ ...initial, text: 'older', revision: 1 });
  const restarted = new NoteDraftStore(directory); await restarted.initialize();
  expect(restarted.get()).toMatchObject(latest);
});
it('keeps the prepared event ID and timestamp across a crash after enqueue, then replayed IPC does not enqueue again', async () => {
  const store = new NoteDraftStore(join(directory, 'notes')); await store.initialize();
  const queue = new DurableQueue(join(directory, 'queue'), config); await queue.initialize();
  const input = { ...store.get(), text: 'generated note', mood: 'calm', revision: 1 };
  await expect(store.submit(input, config, 'macos', { enqueue: async event => { await queue.enqueue(event); throw new Error('simulated crash after queue fsync'); } })).rejects.toThrow('simulated');
  const first = (await queue.next())!.record.event;
  const restarted = new NoteDraftStore(join(directory, 'notes')); await restarted.initialize();
  expect(restarted.get().prepared).toBe(true);
  const saved = await restarted.submit(input, config, 'macos', queue);
  expect(saved.id).toBe(first.id); expect((await queue.next())!.record.event).toEqual(first); expect(queue.stats().depth).toBe(1);
  const afterCompleted = new NoteDraftStore(join(directory, 'notes')); await afterCompleted.initialize();
  expect(await afterCompleted.submit(input, config, 'macos', { enqueue: async () => { throw new Error('must not enqueue a completed submission'); } })).toEqual(saved);
  expect(afterCompleted.get().text).toBe('');
  // Explicitly submitting a new draft with the same text is a new observation, not semantic deduplication.
  const next = { ...saved.draft, text: input.text, mood: input.mood, revision: 1 };
  const second = await afterCompleted.submit(next, config, 'macos', queue);
  expect(second.id).not.toBe(saved.id); expect(queue.stats().depth).toBe(2);
});
it('refuses to mutate or retarget a prepared submission after a failed queue write', async () => {
  const store = new NoteDraftStore(directory); await store.initialize(); const input = { ...store.get(), text: 'generated', mood: '', revision: 1 };
  await expect(store.submit(input, config, 'macos', { enqueue: async () => { throw new Error('full'); } })).rejects.toThrow('full');
  await expect(store.update({ ...input, text: 'changed', revision: 2 })).rejects.toThrow('不能改写');
  await expect(store.submit(input, { ...config, serverUrl: 'https://other.example' }, 'macos', { enqueue: async () => true })).rejects.toThrow('原中央节点');
});

it('captures optional note metadata once before preparation, preserves it on retry, and honors the disabled setting', async () => {
  const store = new NoteDraftStore(directory); await store.initialize();
  const queue = new DurableQueue(join(directory, 'queue'), config); await queue.initialize();
  const input = { ...store.get(), text: 'synthetic metadata note', mood: '', revision: 1 }; let observations = 0;
  const provider = async () => { observations++; return { version: 1 as const, observedAt: '2026-09-14T00:00:00Z', collector: { method: 'manual' as const }, state: { batteryPercent: 42 } }; };
  await expect(store.submit(input, config, 'macos', { enqueue: async event => { await queue.enqueue(event); throw new Error('crash'); } }, provider)).rejects.toThrow('crash');
  const restarted = new NoteDraftStore(directory); await restarted.initialize(); await restarted.submit(input, config, 'macos', queue, provider);
  expect(observations).toBe(1); expect((await queue.next())?.record.event.metadata?.state?.batteryPercent).toBe(42);
  await restarted.submit({ ...restarted.get(), text: 'metadata disabled', revision: 1 }, { ...config, metadataEnabled: false }, 'macos', queue, provider);
  expect(observations).toBe(1); expect((await queue.exportArchive()).records[1].event).not.toHaveProperty('metadata');
});
