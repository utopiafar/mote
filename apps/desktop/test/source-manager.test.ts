import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSourceManager } from '../src/source-manager';
import { DEFAULT_SOURCE_OPTIONS, type SourceItem } from '../src/source-types';
let directory: string;
let managers: LocalSourceManager[] = [];
let servers: Server[] = [];
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-manager-'))); });
afterEach(async () => { for (const manager of managers) await manager.close(); for (const server of servers) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); managers = []; servers = []; await rm(directory, { recursive: true, force: true }); });
async function endpoint(dropFirstAck = false) {
  const items: SourceItem[] = []; const registered: unknown[] = []; let id = ''; let dropNext = dropFirstAck;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { id = body.id; registered.push(body); res.end(JSON.stringify(body)); }
    else if (req.method === 'PATCH') res.end(JSON.stringify({ ...body, id }));
    else { items.push(body); if (dropNext) { dropNext = false; res.destroy(); return; } res.end(JSON.stringify({ id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: id, externalId: body.externalId, revision: body.revision, duplicate: items.length > 1 })); }
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
