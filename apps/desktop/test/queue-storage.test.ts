import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, defaultConfig } from '../src/config';
import { QueueStorage, StorageCommitUncertainError } from '../src/queue-storage';
import { DurableQueue } from '../src/queue';
import { event, image } from './fixtures';

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mote-storage-fixture-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const profile = join(root, 'profile'), external = join(root, 'external'); await mkdir(profile); await mkdir(external);
  const config = { ...defaultConfig(), deviceId: event().deviceId, serverUrl: '', token: undefined };
  const store = new ConfigStore(profile, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }); await store.save(config);
  const storage = new QueueStorage(profile, 'test', config.deviceId), source = await storage.open('');
  const queue = new DurableQueue(source, config); queue.setStorageGuard(() => storage.assertOwned(queue.directory)); await queue.initialize();
  const pending = { ...event(), ocrText: undefined, ocr: { status: 'pending' as const, reason: 'charging' as const } };
  await queue.enqueue(pending, image); await queue.acknowledge(pending.id); await queue.saveOcr(pending.id, 'GENERATED DEFERRED OCR');
  await queue.failed(pending.id, 1000, () => 0.5); await queue.syncCheckpoint('2026-09-14T00:00:00.000Z', '2026-09-14T00:01:00.000Z');
  await queue.initialize(); // Normalize optional zero-valued legacy fields before byte/state comparisons.
  const target = await storage.candidate(external, source);
  const selected = async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory;
  const commit = () => store.save({ ...config, captureStorageDirectory: target });
  return { profile, external, config, store, storage, source, queue, target, selected, commit };
}
describe('capture storage transactions with generated queue data', () => {
  it('moves complete queue, pending OCR/retries/binding/checkpoint and preserves identity across restart/default restore', async () => {
    const f = await fixture(), before = await f.queue.exportArchive();
    const binding = await readFile(join(f.source, 'connection-binding.json')), checkpoint = await readFile(join(f.source, 'sync-checkpoint.json'));
    await f.queue.relocate(f.target, f.storage, f.commit, f.selected);
    expect(await f.selected()).toBe(f.target); expect(f.queue.directory).toBe(f.target); expect(await f.queue.exportArchive()).toEqual(before);
    expect(await readFile(join(f.target, 'connection-binding.json'))).toEqual(binding); expect(await readFile(join(f.target, 'sync-checkpoint.json'))).toEqual(checkpoint);
    await expect(stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(f.target)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(join(f.target, 'events'))) expect((await stat(join(f.target, 'events', name))).mode & 0o777).toBe(0o600);
    const reopened = new QueueStorage(f.profile, 'test', f.config.deviceId); const queue = new DurableQueue(await reopened.open(f.target), f.config); await queue.initialize(); await reopened.recover(queue.directory);
    expect(await queue.exportArchive()).toEqual(before);
    await queue.relocate(f.source, reopened, () => f.store.save(f.config), f.selected);
    expect(await f.selected()).toBe(f.source); expect(queue.directory).toBe(f.source); expect(await queue.exportArchive()).toEqual(before);
  });
  it('keeps original active and removes only owned new copies when saving config fails before commit', async () => {
    const f = await fixture(), before = await f.queue.exportArchive();
    await expect(f.queue.relocate(f.target, f.storage, async () => { throw new Error('synthetic disk full'); }, f.selected)).rejects.toThrow('synthetic disk full');
    expect(f.queue.directory).toBe(f.source); expect(await f.selected()).toBe(f.source); expect(await f.queue.exportArchive()).toEqual(before);
    await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.external))).toEqual([]);
  });
  it('preserves both copies if activation throws after pointer commit; restart uses target and never reverts to stale original', async () => {
    const f = await fixture(), before = await f.queue.exportArchive();
    await expect(f.queue.relocate(f.target, f.storage, async () => { await f.commit(); throw new Error('synthetic post-rename failure'); }, f.selected)).rejects.toBeInstanceOf(StorageCommitUncertainError);
    expect(await f.selected()).toBe(f.target); expect((await stat(f.source)).isDirectory()).toBe(true); expect((await stat(f.target)).isDirectory()).toBe(true);
    const storage = new QueueStorage(f.profile, 'test', f.config.deviceId); const queue = new DurableQueue(await storage.open(f.target), f.config); await queue.initialize(); await storage.recover(queue.directory);
    expect(await queue.exportArchive()).toEqual(before); await expect(stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not delete original when recovery target has missing directories or corrupted JPEG', async () => {
    const f = await fixture();
    await expect(f.queue.relocate(f.target, f.storage, async () => { await f.commit(); throw new Error('synthetic crash'); }, f.selected)).rejects.toBeInstanceOf(StorageCommitUncertainError);
    const blobDirectory = join(f.target, 'blobs'); await rename(blobDirectory, join(f.target, 'saved-blobs'));
    const storage = new QueueStorage(f.profile, 'test', f.config.deviceId);
    await expect(storage.open(f.target)).rejects.toThrow(); expect((await stat(f.source)).isDirectory()).toBe(true);
    await rename(join(f.target, 'saved-blobs'), blobDirectory);
    const [blob] = await readdir(blobDirectory); await writeFile(join(blobDirectory, blob), 'CORRUPTED GENERATED BYTES');
    const queue = new DurableQueue(await storage.open(f.target), f.config);
    await expect(queue.initialize()).rejects.toThrow(); expect((await stat(f.source)).isDirectory()).toBe(true);
  });
  it('serializes pending reads and writes behind migration and writes only to newly committed location', async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const moving = f.queue.relocate(f.target, f.storage, async () => { entered(); await barrier; await f.commit(); }, f.selected);
    await ready;
    let written = false;
    const another = event('f50650f0-fb31-4215-90cd-c96dc62d5e93');
    const write = f.queue.enqueue(another, image).then(() => { written = true; });
    const read = f.queue.imageForBrowser(event().id); await new Promise(resolve => setTimeout(resolve, 20)); expect(written).toBe(false);
    release(); await moving; await write; expect(await read).toEqual(image);
    expect(JSON.parse(await readFile(join(f.target, 'events', `${another.id}.json`), 'utf8')).event.id).toBe(another.id);
    await expect(stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects occupied paths, nested queues, symlinks and other profile ownership', async () => {
    const f = await fixture(); await mkdir(f.target);
    await expect(f.queue.relocate(f.target, f.storage, f.commit, f.selected)).rejects.toThrow('存在');
    await expect(f.storage.candidate(f.source, f.source)).rejects.toThrow();
    const link = join(root, 'linked'); await symlink(f.external, link);
    await expect(f.storage.candidate(link, f.source)).rejects.toThrow('符号链接');
    const foreign = new QueueStorage(join(root, 'other-profile'), 'other', f.config.deviceId);
    await expect(foreign.open(f.source)).rejects.toThrow('不属于');
    await symlink(join(f.profile, 'config.json'), join(f.source, 'events', 'unsafe.json'));
    await expect(f.queue.relocate(join(f.external, 'another'), f.storage, f.commit, f.selected)).rejects.toThrow('符号链接');
  });
  it('does not recreate unavailable external storage during checkpoint, binding or enqueue, and resumes after reconnect', async () => {
    const f = await fixture(); await f.queue.relocate(f.target, f.storage, f.commit, f.selected);
    const disconnected = join(root, 'disconnected'); await rename(f.target, disconnected);
    await expect(f.queue.syncCheckpoint()).rejects.toThrow();
    await expect(f.queue.binding.commit(f.config, true)).rejects.toThrow();
    await expect(f.queue.enqueue(event('f50650f0-fb31-4215-90cd-c96dc62d5e93'), image)).rejects.toThrow();
    await expect(f.storage.open(f.target)).rejects.toThrow('连接原磁盘');
    await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rename(disconnected, f.target); await f.queue.syncCheckpoint(); expect(await f.queue.imageForBrowser(event().id)).toEqual(image);
  });
});

it('keeps the new pointer authoritative when old-copy cleanup fails, even after ACKs change the new queue', async () => {
  const f = await fixture();
  const internal = f.storage as unknown as { removeOwned(path: string, id?: string): Promise<void> };
  const remove = internal.removeOwned.bind(f.storage);
  internal.removeOwned = async (path, id) => { if (path === f.source) throw new Error('synthetic unavailable old disk'); await remove(path, id); };
  await f.queue.relocate(f.target, f.storage, f.commit, f.selected);
  expect(f.storage.cleanupPending).toBe(true); expect(f.queue.directory).toBe(f.target);
  await f.queue.acknowledge(event().id, true); expect(f.queue.stats().depth).toBe(0);
  const storage = new QueueStorage(f.profile, 'test', f.config.deviceId), queue = new DurableQueue(await storage.open(f.target), f.config);
  await queue.initialize(); await storage.recover(queue.directory);
  expect(queue.stats().depth).toBe(0); await expect(stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects missing custom directories during guarded initialize without recreating their parents', async () => {
  const f = await fixture(); await f.queue.relocate(f.target, f.storage, f.commit, f.selected);
  const disconnected = join(root, 'disconnected'); await rename(f.target, disconnected);
  const queue = new DurableQueue(f.target, f.config);
  queue.setStorageGuard(async () => {}); // Simulate disappearance immediately AFTER a successful ownership check.
  await expect(queue.initialize()).rejects.toThrow(); await expect(stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(disconnected)).isDirectory()).toBe(true);
});
