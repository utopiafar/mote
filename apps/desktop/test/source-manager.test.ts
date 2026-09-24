import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSourceManager } from '../src/source-manager';
import { DEFAULT_SOURCE_OPTIONS, type SourceItem } from '../src/source-types';
import { sourceAck } from './fixtures';
let directory: string;
let managers: LocalSourceManager[] = [];
let servers: Server[] = [];
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-manager-'))); });
afterEach(async () => { for (const manager of managers) await manager.close(); for (const server of servers) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); managers = []; servers = []; await rm(directory, { recursive: true, force: true }); });
async function endpoint(dropFirstAck = false) {
  const items: SourceItem[] = []; const registered: unknown[] = []; let id = ''; let dropNext = dropFirstAck;
  const server = createServer(async (req, res) => {
    expect(req.headers['x-mote-ingress-version']).toBe('2');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revision:null}));return;}
    const manifest = JSON.parse(Buffer.concat(chunks).toString()); const body = manifest.item ?? manifest;
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/items/batch')) { res.statusCode = 404; res.end('{}'); }
    else if (req.method === 'POST') { id = body.id; registered.push(body); res.end(JSON.stringify(body)); }
    else if (req.method === 'PATCH') res.end(JSON.stringify({ ...body, id }));
    else { items.push(body); if (dropNext) { dropNext = false; res.destroy(); return; } res.end(JSON.stringify(sourceAck(id,body,body.kind==='file'?'file-revision':'source-item',items.length>1))); }
  });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, items, registered, loseNextAck: () => { dropNext = true; } };
}
async function manager(url: string, token = 'synthetic-source-token') {
  const value = new LocalSourceManager(join(directory, 'private-state'), { serverUrl: url, token, deviceId: 'synthetic-device' }, '/must-not-be-invoked-calendar-helper');
  managers.push(value); await value.initialize(); return value;
}
describe('native source lifecycle with local HTTP fixtures', () => {
  it('persists an ACK-lost file, restores after restart, and never invokes calendar permission at startup', async () => {
    const server = await endpoint(true); const file = join(directory, '合成.md'); await writeFile(file, '合成内容 🧑🏽‍💻');
    let app = await manager(server.url); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync();
    expect(app.status()[0].pending).toBe(1); await app.close();
    app = await manager(server.url); await app.sync();
    expect(app.status()[0].pending).toBe(0); expect(server.items).toHaveLength(2); expect(server.items[0]).toEqual(server.items[1]);
    const status = app.status(); expect(JSON.stringify(status)).not.toContain('synthetic-source-token');
  });
  it('keeps old queued data bound to its original node and respects local pause', async () => {
    const first = await endpoint(true); const second = await endpoint(); const file = join(directory, 'synthetic.md'); await writeFile(file, '旧节点私有合成内容');
    const app = await manager(first.url); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync();
    const source = app.status()[0].source; await app.update(source.id, { ...source, enabled: false });
    await writeFile(file, '新节点合成内容'); await app.changeConnection({ serverUrl: second.url, token: 'other-synthetic-token', deviceId: 'synthetic-device' }); await app.sync();
    expect(second.items).toHaveLength(0);
    await app.update(source.id, { ...source, enabled: true }); await app.sync();
    expect(second.items).toHaveLength(1); expect(second.items[0].text).toBe('新节点合成内容'); expect(second.items[0].revision).not.toBe(first.items[0].revision);
  });
  it('turning off deletion tracking drops a previously queued tombstone instead of replaying it', async () => {
    const server = await endpoint(); const folder = join(directory, 'selected'); await mkdir(folder); const file = join(folder, 'a.md'); await writeFile(file, 'synthetic');
    const app = await manager(server.url); await app.addFiles(folder, { ...DEFAULT_SOURCE_OPTIONS, trackDeletions: true }); await app.sync();
    // This case controls scans explicitly; a live file watcher can otherwise
    // immediately retry the deliberately lost ACK before the policy edit.
    (app as any).watcher.close();
    server.loseNextAck(); await rm(file); await app.sync(); expect(app.status()[0].pending).toBe(1);
    const received = server.items.length; const source = app.status()[0].source;
    await app.update(source.id, { ...source, trackDeletions: false, enabled: true }); await app.sync();
    expect(app.status()[0].pending).toBe(0); expect(server.items.length).toBe(received);
  });
  it('changing to reference before retry cannot leak queued snapshot text or an explicitly masked source name', async () => {
    const server = await endpoint(true); const file = join(directory, 'private-synthetic.md'); await writeFile(file, 'private-synthetic');
    const app = await manager(server.url); await app.addFiles(file, { ...DEFAULT_SOURCE_OPTIONS, redactLiterals: ['private-synthetic'] }); await app.sync();
    const source = app.status()[0].source; await app.update(source.id, { ...source, retention: 'reference', enabled: true }); await app.sync();
    expect(server.items.at(-1)?.text).toBe(''); expect(JSON.stringify(server.registered)).not.toContain('private-synthetic');
    expect(server.items.at(-1)?.uri).toBeUndefined();
  });
});

it('loads paused durable pending bodies before permitting a connection change and holds background sync', async () => {
  const endpointValue = await endpoint(true), file = join(directory, 'pending.md'); await writeFile(file, 'synthetic queued body');
  let value = await manager(endpointValue.url); await value.addFiles(file, DEFAULT_SOURCE_OPTIONS); await value.sync();
  const source = value.status()[0].source; await value.update(source.id, { ...source, enabled: false }); await value.sync(); await value.close();
  value = await manager(endpointValue.url); await value.sync(); expect(value.connectionActivity().pending).toBe(1);
  const release = await value.holdConnection(); await value.sync(true); expect(value.connectionActivity()).toEqual({ pending: 1, inFlight: false }); release();
});

it('checkpoints pending source bodies before credential persistence and recovers identical revisions after restart', async () => {
  const server = await endpoint(true), file = join(directory, 'pending-reauth.md'); await writeFile(file, 'unchanged synthetic pending original');
  let value = await manager(server.url); await value.addFiles(file, DEFAULT_SOURCE_OPTIONS); await value.sync();
  expect(value.connectionActivity().pending).toBe(1); const oldBody = structuredClone(server.items[0]);
  const replacement = { serverUrl: server.url, token: 'synthetic-replacement-token', deviceId: 'synthetic-device' };
  await expect(value.prepareReauthorization(replacement)).rejects.toThrow('同一节点');
  const release = await value.holdConnection();
  await expect(value.prepareReauthorization({ ...replacement, serverUrl: 'https://other.example' })).rejects.toThrow();
  await expect(value.prepareReauthorization({ ...replacement, deviceId: 'another-device' })).rejects.toThrow();
  await value.prepareReauthorization(replacement); expect(value.connectionActivity().pending).toBe(1);
  // Simulate exit after new config was saved but before changeConnection updated in-memory state.
  release(); await value.close(); value = await manager(server.url, replacement.token); await value.sync();
  expect(value.connectionActivity().pending).toBe(0); expect(server.items).toHaveLength(2); expect(server.items[1]).toEqual(oldBody);
});


it('a manual sync overlapping an automatic scan waits for one coalesced forced flush', async () => {
  const app = await manager('http://127.0.0.1:1'); await app.sync();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const begin = new Promise<void>(resolve => { started = resolve; });
  const modes: boolean[] = [];
  vi.spyOn(app as any, 'run').mockImplementation(async (force: unknown) => { modes.push(Boolean(force)); if (!force) { started(); await gate; } });
  const background = app.sync(false); await begin;
  const first = app.sync(true), second = app.sync(true);
  release(); await Promise.all([background, first, second]);
  expect(modes).toEqual([false, true]);
});

it('waits for a watcher scan rerun before flushing a durable pending source item', async () => {
  const server = await endpoint(true), file = join(directory, 'watcher-rerun.md');
  await writeFile(file, 'Generated pending source body');
  const app = await manager(server.url);
  await app.addFiles(file, DEFAULT_SOURCE_OPTIONS);
  await app.sync(true);
  expect(app.pendingStats().pendingRecords).toBe(1);
  const sourceId = app.status()[0]!.source.id;

  let releaseFirst!: () => void, releaseSecond!: () => void;
  let firstStarted!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const firstScan = new Promise<void>(resolve => { firstStarted = resolve; });
  const secondScan = new Promise<void>(resolve => { secondStarted = resolve; });
  let scans = 0;
  vi.spyOn(app as any, 'run').mockImplementation(async () => {
    if (++scans === 1) { firstStarted(); await firstGate; }
    else { (app as any).readable.delete(sourceId); secondStarted(); await secondGate; (app as any).readable.add(sourceId); }
  });

  const initial = app.sync(false); await firstScan;
  (app as any).onFileWatchEvent({ sourceId, root: directory, path: file });
  let flushed = false;
  const flush = app.flushPending(new AbortController().signal).then(() => { flushed = true; });
  releaseFirst(); await secondScan;
  await new Promise(resolve => setTimeout(resolve, 30));
  const flushedDuringScan = flushed;
  const pendingDuringScan = app.pendingStats().pendingRecords;
  releaseSecond(); await Promise.all([initial, flush]);
  expect(flushedDuringScan).toBe(false);
  expect(pendingDuringScan).toBe(1);
  expect(scans).toBe(2);
  expect(app.pendingStats().pendingRecords).toBe(0);
  expect(server.items).toHaveLength(2);
});
