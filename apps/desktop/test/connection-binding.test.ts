import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableQueue } from '../src/queue';
import { defaultConfig } from '../src/config';
import { connectionBinding } from '../src/connection-binding';
import { event, image } from './fixtures';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-binding-fixture-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('binds a local backlog only after confirmation, preserves the binding after restart and blocks URL-clearing bypasses', async () => {
  const local = { ...defaultConfig(), serverUrl: '', token: undefined };
  let queue = new DurableQueue(directory, local); await queue.initialize(); await queue.enqueue(event(), image);
  const initial = { ...local, serverUrl: 'https://first.example', token: 'synthetic-initial-token' };
  await expect(queue.binding.commit(initial, true)).rejects.toThrow('节点');
  await queue.binding.commit(initial, true, true);
  queue = new DurableQueue(directory, local); await queue.initialize();
  expect(queue.binding.unbound()).toBe(false); expect(queue.binding.matches(local)).toBe(false); expect(queue.binding.matches(initial)).toBe(true);
  await expect(queue.binding.commit({ ...initial, serverUrl: 'https://other.example' }, true, true)).rejects.toThrow('节点');
  await expect(queue.binding.commit({ ...initial, token: 'replacement' }, true, true)).rejects.toThrow('节点');
  await queue.binding.commit({ ...initial, token: 'replacement' }, true, false, true);
  expect(await readFile(join(directory, 'connection-binding.json'), 'utf8')).not.toContain('replacement');
});
it('binds the canonical shared instance scope so the same node survives a different URL spelling', async () => {
  const token = 'generated-scope-owner-token-' + 'a'.repeat(32);
  const first = { ...defaultConfig(), serverUrl: 'https://first.example/', token };
  const same = { ...first, serverUrl: 'https://first.example' }, other = { ...first, serverUrl: 'https://other.example' };
  expect(connectionBinding(first)).toMatchObject({ kind: 'bound', origin: 'https://first.example' });
  expect(connectionBinding(first)).toEqual(connectionBinding(same));
  const queue = new DurableQueue(directory, first); await queue.initialize(); await queue.enqueue(event(), image);
  expect(queue.binding.matches(same)).toBe(true); expect(queue.binding.matches(other)).toBe(false);
  await queue.binding.commit({ ...same, token: 'replacement-owner-token-' + 'b'.repeat(32) }, true, false, true);
  await expect(queue.binding.commit(other, true, true, true)).rejects.toThrow('节点');
  expect(JSON.parse(await readFile(join(directory, 'connection-binding.json'), 'utf8'))).toMatchObject({ kind: 'bound', origin: 'https://first.example' });
});
it('persists interval checkpoints and clears retry deadlines without changing pending contents', async () => {
  const config = defaultConfig(); let queue = new DurableQueue(directory, config); await queue.initialize(); await queue.enqueue(event(), image);
  const lastUploadAt = '2026-09-14T00:00:00.000Z', nextRetryAt = '2026-09-14T00:01:00.000Z';
  await queue.syncCheckpoint(lastUploadAt, nextRetryAt); queue = new DurableQueue(directory, config); await queue.initialize();
  expect(queue.stats()).toMatchObject({ depth: 1, oldestPendingAt: event().capturedAt, lastUploadAt, nextRetryAt });
  await queue.resetRetries(); expect(queue.stats()).toMatchObject({ depth: 1, lastUploadAt, nextRetryAt: undefined });
});

it('rejects a missing binding for an existing current backlog and never adopts its owner',async()=>{
 const config=defaultConfig(),queue=new DurableQueue(directory,config);await queue.initialize();await queue.enqueue(event(),image);await rm(join(directory,'connection-binding.json'));
 const reopened=new DurableQueue(directory,config);await expect(reopened.initialize()).rejects.toThrow('Unsupported desktop storage format');await expect(stat(join(directory,'connection-binding.json'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(directory,'events',event().id+'.json'),'utf8')).toContain(event().id);
});
