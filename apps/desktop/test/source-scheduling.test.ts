import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSourceManager } from '../src/source-manager';
import { defaultConfig } from '../src/config';
import { DEFAULT_SOURCE_OPTIONS } from '../src/source-types';
let directory: string, managers: LocalSourceManager[] = [];
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-managed-sources-'))); vi.stubGlobal('fetch', vi.fn()); });
afterEach(async () => { for (const app of managers) await app.close(); managers = []; await rm(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });
async function create(config: ReturnType<typeof defaultConfig>) { const app = new LocalSourceManager(join(directory, 'state'), config, '/never-real-calendar', true); managers.push(app); await app.initialize(); return app; }
it('keeps scanning/staging files locally with no connection, restores them, and copies original versions only for confirmed first binding', async () => {
  const local = { ...defaultConfig(), serverUrl: '', token: undefined, syncMode: 'manual' as const };
  const file = join(directory, 'generated.md'); await writeFile(file, 'original generated offline version');
  let app = await create(local); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync(true);
  expect(fetch).not.toHaveBeenCalled(); expect(app.pendingStats().pendingRecords).toBe(1); expect(app.status()[0].state).toBe('idle');
  await app.close(); app = await create(local); await app.sync(true); expect(app.pendingStats().pendingRecords).toBe(1);
  const target = { ...local, serverUrl: 'https://confirmed.example', token: 'synthetic-first-token' };
  await expect(app.prepareInitialConnection(target)).rejects.toThrow();
  const release = await app.holdConnection(); await app.prepareInitialConnection(target); await app.nodeBinding.commit(target, true, true); await app.changeConnection(target); release();
  await app.sync(true); expect(fetch).not.toHaveBeenCalled(); expect(app.pendingStats().pendingRecords).toBe(1);
  const received: any[] = [];
  vi.mocked(fetch).mockImplementation(async (_url, init) => { if(init!.method==='GET')return new Response(JSON.stringify({revision:null}));const manifest = JSON.parse(await new Response(init!.body).text());const body=manifest.item??manifest; received.push(body); return new Response(JSON.stringify(init!.method === 'PUT' ? { id: 'b67c1b84-f2cd-4e59-bf67-215545a882dc', sourceId: app.status()[0].source.id, externalId: body.externalId, revision: body.revision, duplicate: false } : { ...body, id: app.status()[0].source.id }), { status: 200 }); });
  await app.flushPending(new AbortController().signal);
  expect(app.pendingStats().pendingRecords).toBe(0); expect(received.find(body => body.text)?.text).toBe('original generated offline version');
  await expect(app.nodeBinding.commit({ ...target, serverUrl: 'https://other.example' }, true, true)).rejects.toThrow();
});
it('a configured manual source can be added and edited without registration, upload, or heartbeat requests', async () => {
  const config = { ...defaultConfig(), token: 'synthetic-manual-token', syncMode: 'manual' as const };
  const file = join(directory, 'generated.txt'); await writeFile(file, 'first');
  const app = await create(config); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync(true);
  await writeFile(file, 'second'); await app.sync(true);
  expect(fetch).not.toHaveBeenCalled(); expect(app.pendingStats().pendingRecords).toBe(2);
  const source = app.status()[0].source; await app.update(source.id, { ...source, enabled: false }); await app.sync(true);
  await app.flushPending(new AbortController().signal); expect(fetch).not.toHaveBeenCalled();
  expect(app.pendingStats()).toMatchObject({ pendingRecords: 2, eligibleRecords: 0, heldRecords: 2, heldReason: '本地来源已暂停，待传版本保留在本机' });
  await app.update(source.id, { ...source, enabled: true }); await app.sync(true);
  expect(app.pendingStats()).toMatchObject({ pendingRecords: 2, eligibleRecords: 2, heldRecords: 0 });
  expect(fetch).not.toHaveBeenCalled();
});
it('wakes a long-interval source when its native watcher reports a file change', async () => {
  const config = { ...defaultConfig(), serverUrl: '', token: undefined, syncMode: 'manual' as const };
  const file = join(directory, 'watcher-fixture.txt'); await writeFile(file, 'first synthetic version');
  const app = await create(config); await app.addFiles(file, { ...DEFAULT_SOURCE_OPTIONS, intervalSeconds: 3600 }); await app.sync(true);
  expect(app.pendingStats().pendingRecords).toBe(1);
  await writeFile(file, 'second synthetic version');
  await vi.waitFor(() => expect(app.pendingStats().pendingRecords).toBe(2), { timeout: 5000, interval: 25 });
});
it('persists the first unsynchronized source-metadata timestamp across restarts and later edits', async () => {
  const config = { ...defaultConfig(), token: 'synthetic-metadata-token', syncMode: 'interval' as const };
  const file = join(directory, 'empty.txt'); await writeFile(file, '');
  let app = await create(config); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync(true);
  const original = app.pendingStats().oldestUpdateAt; expect(original).toBeDefined();
  await app.close(); app = await create(config); await app.sync(true);
  expect(app.pendingStats().oldestUpdateAt).toBe(original); expect(fetch).not.toHaveBeenCalled();
  const source = app.status()[0].source; await app.update(source.id, { ...source, enabled: true }); await app.sync(true);
  expect(app.pendingStats().oldestUpdateAt).toBe(original);
});
it('continues local discovery during a blocked upload and commits both versions exactly once',async()=>{
 const config={...defaultConfig(),token:'generated-concurrent-token',syncMode:'manual' as const},file=join(directory,'live.txt');await writeFile(file,'first generated version');const app=await create(config);await app.addFiles(file,DEFAULT_SOURCE_OPTIONS);await app.sync(true);
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),ready=new Promise<void>(resolve=>started=resolve);const bodies:any[]=[];
 vi.mocked(fetch).mockImplementation(async(url,init)=>{const path=String(url).replace(config.serverUrl,''),body=init?.body?JSON.parse(await new Response(init.body).text()):undefined;if(init?.method==='GET')return new Response(JSON.stringify({revision:null}));if(path==='/api/sources')return new Response(JSON.stringify(body));if(init?.method==='PATCH')return new Response(JSON.stringify({...body,id:app.status()[0].source.id}));const record=body.item??body;bodies.push(record);if(bodies.length===1){started();await gate;}return new Response(JSON.stringify({id:'b67c1b84-f2cd-4e59-bf67-215545a882dc',sourceId:app.status()[0].source.id,externalId:record.externalId,revision:record.revision,duplicate:false}));});
 const upload=app.flushPending(new AbortController().signal);await ready;
 try{await writeFile(file,'second generated version');void app.sync(true);await vi.waitFor(()=>expect(app.pendingStats().pendingRecords).toBe(2),{timeout:5000,interval:25});expect(app.connectionActivity().inFlight).toBe(true);}finally{release();}
 await upload;expect(bodies.map(body=>body.text)).toEqual(['first generated version','second generated version']);expect(app.pendingStats().pendingRecords).toBe(0);
});
