import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSourceManager } from '../src/source-manager';
import { DEFAULT_SOURCE_OPTIONS, type SourceItem } from '../src/source-types';
import { sourceAck } from './fixtures';
import {builtInSourceAdapters, SourceAdapterRegistry, type SourceScanContext} from '../src/source-adapters';
import {SourceSync} from '../src/source-sync';
import {defaultConfig} from '../src/config';
let directory: string;
let managers: LocalSourceManager[] = [];
let servers: Server[] = [];
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-source-manager-'))); });
afterEach(async () => { for (const manager of managers) await manager.close(); for (const server of servers) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); managers = []; servers = []; await rm(directory, { recursive: true, force: true }); });
type AckGate = { allowed: boolean; sent: number; dropped: number };
async function endpoint(dropFirstAck = false, ackGate?: AckGate) {
  const items: SourceItem[] = []; const registered: unknown[] = []; let id = ''; let dropNext = dropFirstAck;
  let acknowledgements = 0;
  const sessions=new Map<string,any>();let recoveries:unknown[]=[];let recoveryUploads=0;
  const server = createServer(async (req, res) => {
    expect(req.headers['x-mote-ingress-version']).toBe('2');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    if(req.method==='GET'){res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/api/file-sync/v1/recovery')){res.end(JSON.stringify({items:recoveries}));recoveries=[];}else res.end(JSON.stringify({revision:null}));return;}
    res.setHeader('Content-Type','application/json');
    if(req.url?.includes('/uploads/')&&req.url.includes('/parts/')){const bytes=Buffer.concat(chunks),part=Number(req.url.split('/').at(-1));res.end(JSON.stringify({part,hash:(await import('../src/source-sync')).sourceHash(bytes),bytes:bytes.length}));return;}
    const manifest = JSON.parse(Buffer.concat(chunks).toString()); const body = manifest.item ?? manifest;
    if(req.url?.startsWith('/api/file-sync/v1/recovery/')&&req.url.endsWith('/uploads')){recoveryUploads++;const m=[...sessions.values()].at(-1),uploadId='recovery-'+m.item.revision;sessions.set(uploadId,m);res.end(JSON.stringify({uploadId,partBytes:4194304,parts:[]}));return;}
    if(req.url==='/api/file-sync/v1/uploads'){const uploadId=body.revision;sessions.set(uploadId,manifest);res.end(JSON.stringify({uploadId,partBytes:4194304,parts:[]}));return;}
    const replyAck=(ack:unknown)=>{if(dropNext||ackGate?.allowed===false){dropNext=false;if(ackGate)ackGate.dropped++;res.destroy();return;}acknowledgements++;if(ackGate)ackGate.sent++;res.end(JSON.stringify(ack));};
    if(req.url?.endsWith('/commit')){const m=sessions.get(req.url.split('/').at(-2)!);items.push(m.item);replyAck({...sourceAck(id,m.item,'file-revision',items.length>1),sha256:m.sha256,sizeBytes:m.sizeBytes});return;}
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/items/batch')) { res.statusCode = 404; res.end('{}'); }
    else if (req.method === 'POST') { id = body.id; registered.push(body); res.end(JSON.stringify(body)); }
    else if (req.method === 'PATCH') res.end(JSON.stringify({ ...body, id }));
    else { items.push(body); replyAck(sourceAck(id,body,body.kind==='file'?'file-revision':'source-item',items.length>1)); }
  });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, items, registered, acknowledgements:()=>acknowledgements, loseNextAck: () => { dropNext = true; },recoverLast:()=>{const m=[...sessions.values()].at(-1);expect(m).toBeDefined();recoveries=[{captureId:'b67c1b84-f2cd-4e59-bf67-215545a882dc',externalId:m.item.externalId,revision:m.item.revision,sha256:m.sha256,sizeBytes:m.sizeBytes,observedAt:m.item.observedAt}];},recoveryUploads:()=>recoveryUploads };
}
async function manager(url: string, token = 'synthetic-source-token', adapters?:SourceAdapterRegistry, controlledWatcher = false) {
  const value = new LocalSourceManager(join(directory, 'private-state'), { serverUrl: url, token, deviceId: 'synthetic-device' }, '/must-not-be-invoked-calendar-helper',false,undefined,adapters);
  // Fault/restart cases control reconciliation explicitly. Delayed native setup
  // events must not turn the single deliberately lost ACK into a successful retry.
  if (controlledWatcher) vi.spyOn((value as any).watcher, 'setTargets').mockResolvedValue(undefined);
  managers.push(value); await value.initialize(); return value;
}
it('disabling one source stops only its watcher and scans while the other source continues', async () => {
  const config = { ...defaultConfig(), serverUrl: '', token: undefined, syncMode: 'manual' as const };
  const scans: string[] = [];
  const adapters = new SourceAdapterRegistry().register({
    kind: 'fixture.watched', version: 1, watchesPath: true, tracksDeletions: false, allowsArchive: false,
    validateConfiguration(source) { if (typeof source.path !== 'string') throw new Error('Invalid watched source'); },
    async scan({ source }) {
      scans.push(source.id);
      return {version: 1, scan: {items: [], seen: [], complete: true, skipped: 0}};
    },
  });
  const app = new LocalSourceManager(join(directory, 'toggle-state'), config, '/must-not-be-invoked-calendar-helper', true, undefined, adapters);
  managers.push(app); await app.initialize();
  const setTargets = vi.spyOn((app as any).watcher, 'setTargets');
  const firstPath = join(directory, 'generated-first'), secondPath = join(directory, 'generated-second');
  await mkdir(firstPath); await mkdir(secondPath);
  const first = await app.addAdapterSource({kind: 'fixture.watched', name: 'Generated first', path: firstPath}, DEFAULT_SOURCE_OPTIONS);
  const second = await app.addAdapterSource({kind: 'fixture.watched', name: 'Generated second', path: secondPath}, DEFAULT_SOURCE_OPTIONS);
  await app.sync(true); scans.length = 0;
  const targets = () => ((setTargets.mock.lastCall?.[0] as {sourceId: string}[] | undefined) ?? []).map(target => target.sourceId);
  const firstSource = app.status().find(row => row.source.id === first)!.source;

  await app.update(first, {...firstSource, enabled: false});
  expect(targets()).toEqual([second]);
  await app.sync(true);
  expect(scans).toEqual([second]);

  scans.length = 0;
  await app.update(first, {...firstSource, enabled: true});
  expect(targets()).toEqual([first, second]);
  await app.sync(true);
  expect(scans).toEqual([first, second]);

  // An idempotent re-enable reconciles the same watcher set instead of adding another one.
  await app.update(first, {...firstSource, enabled: true});
  expect(targets()).toEqual([first, second]);
});

it('shows a degraded file root without claiming the scan completed', async () => {
  const config = { ...defaultConfig(), serverUrl: '', token: undefined, syncMode: 'manual' as const };
  const adapters = new SourceAdapterRegistry().register({
    kind: 'fixture.degraded-root', version: 1, watchesPath: true, tracksDeletions: true, allowsArchive: true,
    validateConfiguration(source) { if (typeof source.path !== 'string') throw new Error('Invalid degraded source'); },
    async scan() { return {version: 1, scan: {items: [], seen: [], complete: false, skipped: 0, degraded: 'root_unavailable' as const}}; },
  });
  const app = new LocalSourceManager(join(directory, 'degraded-state'), config, '/must-not-be-invoked-calendar-helper', true, undefined, adapters);
  managers.push(app); await app.initialize();
  const path = join(directory, 'generated-degraded-root'); await mkdir(path);
  const id = await app.addAdapterSource({kind: 'fixture.degraded-root', name: 'Generated degraded root', path}, DEFAULT_SOURCE_OPTIONS);
  await app.sync(true);
  const row = app.status().find(value => value.source.id === id)!;
  expect(row.scanComplete).toBe(false); expect(row.degraded).toBe('root_unavailable'); expect(row.state).toBe('error');
  expect(row.message).toContain('来源根不可用或已变化'); expect(row.message).toContain('未判断删除');
});

it('connects the discovered Kimi Code home and queues its main conversation',async()=>{
  const home=join(directory,'generated-kimi'),root=join(home,'sessions');
  const main=join(root,'wd_fixture','session_fixture','agents','main');await mkdir(main,{recursive:true});
  const events=[
    {type:'turn.prompt',origin:{kind:'user'},input:[{type:'text',text:'Generated coding question'}]},
    {type:'context.append_loop_event',event:{type:'step.begin'}},
    {type:'context.append_loop_event',event:{type:'content.part',part:{type:'text',text:'Generated coding answer'}}},
    {type:'turn.ended',reason:'completed'},
  ];
  await writeFile(join(main,'wire.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  vi.stubEnv('KIMI_CODE_HOME',home);
  try{
    const app=await manager('');const id=await app.addCodingAgent('kimi',DEFAULT_SOURCE_OPTIONS);await app.sync();
    expect(app.status().find(row=>row.source.id===id)?.source.path).toBe(root);
    expect(app.pendingContent().map(row=>row.item.text)).toEqual(expect.arrayContaining(['Generated coding question','Generated coding answer']));
  }finally{vi.unstubAllEnvs();}
});
describe('native source lifecycle with local HTTP fixtures', () => {
  it('persists an ACK-lost file, restores after restart, and never invokes calendar permission at startup', async () => {
    const gate:AckGate={allowed:false,sent:0,dropped:0},server = await endpoint(true,gate); const file = join(directory, '合成.md'); await writeFile(file, '合成内容 🧑🏽‍💻');
    const calendarPermission=vi.spyOn(await import('../src/source-calendar'),'calendarHelper');
    // This restart case owns the retry boundary. Filesystem delivery and the
    // periodic scheduler are covered separately, not allowed to acknowledge it.
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});
    let app:LocalSourceManager|undefined;
    try {
      app = await manager(server.url,undefined,undefined,true); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync();
      expect(gate).toEqual({allowed:false,sent:0,dropped:1});expect(server.items).toHaveLength(1);
      expect(app.status()[0].pending).toBe(1);const sourceId=app.status()[0].source.id; await app.close();
      gate.allowed=true;app = await manager(server.url,undefined,undefined,true); await app.sync();
      expect(app.status()[0].pending).toBe(0); expect(server.items).toHaveLength(2); expect(server.items[0]).toEqual(server.items[1]);
      expect(app.status()[0].source.id).toBe(sourceId);expect(gate.sent).toBe(1);expect(calendarPermission).not.toHaveBeenCalled();
      const status = app.status(); expect(JSON.stringify(status)).not.toContain('synthetic-source-token');
    } finally { await app?.close();vi.useRealTimers();calendarPermission.mockRestore(); }
  });
  it('a controlled watcher retry legitimately acknowledges the same lost-ACK revision before restart',async()=>{
    const server=await endpoint(true),file=join(directory,'watcher-ack.md');await writeFile(file,'Generated ACK retry body');
    vi.useFakeTimers({toFake:['setInterval','clearInterval']});let app:LocalSourceManager|undefined;
    try{
      app=await manager(server.url,undefined,undefined,true);await app.addFiles(file,DEFAULT_SOURCE_OPTIONS);await app.sync();
      expect(app.status()[0].pending).toBe(1);expect(server.acknowledgements()).toBe(0);const sourceId=app.status()[0].source.id;
      (app as any).onFileWatchEvent({sourceId,root:file,path:file,backend:'fsevents',kind:'change'});await app.sync(false);
      expect(app.status()[0].pending).toBe(0);expect(server.acknowledgements()).toBe(1);expect(server.items).toHaveLength(2);expect(server.items[1]).toEqual(server.items[0]);
    }finally{await app?.close();vi.useRealTimers();}
  });
  it('keeps old queued data bound to its original node and respects local pause', async () => {
    const first = await endpoint(true); const second = await endpoint(); const file = join(directory, 'synthetic.md'); await writeFile(file, '旧节点私有合成内容');
    const app = await manager(first.url); await app.addFiles(file, DEFAULT_SOURCE_OPTIONS); await app.sync();
    const source = app.status()[0].source; await app.update(source.id, { ...source, enabled: false });
    await writeFile(file, '新节点合成内容'); await app.changeConnection({ serverUrl: second.url, token: 'other-synthetic-token', deviceId: 'synthetic-device' }); await app.sync();
    expect(second.items).toHaveLength(0);
    await app.update(source.id, { ...source, enabled: true }); await app.sync();
    expect(second.items).toHaveLength(1); expect(second.items[0].text).toBe('');  await app.flushPending(new AbortController().signal); expect(second.items.at(-1)?.text).toBe(''); expect(second.items[0].revision).not.toBe(first.items[0].revision);
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
  let value = await manager(endpointValue.url, undefined, undefined, true); await value.addFiles(file, DEFAULT_SOURCE_OPTIONS); await value.sync();
  const source = value.status()[0].source; await value.update(source.id, { ...source, enabled: false }); await value.sync(); await value.close();
  value = await manager(endpointValue.url, undefined, undefined, true); await value.sync(); expect(value.connectionActivity().pending).toBe(1);
  const release = await value.holdConnection(); await value.sync(true); expect(value.connectionActivity()).toEqual({ pending: 1, inFlight: false }); release();
});

it('checkpoints pending source bodies before credential persistence and recovers identical revisions after restart', async () => {
  const server = await endpoint(true), file = join(directory, 'pending-reauth.md'); await writeFile(file, 'unchanged synthetic pending original');
  let value = await manager(server.url, undefined, undefined, true); await value.addFiles(file, DEFAULT_SOURCE_OPTIONS); await value.sync();
  expect(value.connectionActivity().pending).toBe(1); const oldBody = structuredClone(server.items[0]);
  const replacement = { serverUrl: server.url, token: 'synthetic-replacement-token', deviceId: 'synthetic-device' };
  await expect(value.prepareReauthorization(replacement)).rejects.toThrow('同一节点');
  const release = await value.holdConnection();
  await expect(value.prepareReauthorization({ ...replacement, serverUrl: 'https://other.example' })).rejects.toThrow();
  await expect(value.prepareReauthorization({ ...replacement, deviceId: 'another-device' })).rejects.toThrow();
  await value.prepareReauthorization(replacement); expect(value.connectionActivity().pending).toBe(1);
  // Simulate exit after new config was saved but before changeConnection updated in-memory state.
  release(); await value.close(); value = await manager(server.url, replacement.token, undefined, true); await value.sync();
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

it('flushes durable pending source versions while watcher scans are still running', async () => {
  const server = await endpoint(true), file = join(directory, 'watcher-rerun.md');
  await writeFile(file, 'Generated pending source body');
  const app = await manager(server.url, undefined, undefined, true);
  await app.addFiles(file, DEFAULT_SOURCE_OPTIONS);
  await app.sync(true);
  expect(app.pendingStats().pendingRecords).toBe(1);
  const sourceId = app.status()[0]!.source.id;

  // This case injects the wakeup while controlling both scans. Native watchers
  // can also deliver a delayed event for setup writes and add an unrelated scan.
  // Real filesystem delivery is exercised separately in file-watcher.test.ts.
  (app as any).watcher.close();

  let releaseFirst!: () => void, releaseSecond!: () => void;
  let firstStarted!: () => void, secondStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const firstScan = new Promise<void>(resolve => { firstStarted = resolve; });
  const secondScan = new Promise<void>(resolve => { secondStarted = resolve; });
  let scans = 0;
  vi.spyOn(app as any, 'run').mockImplementation(async () => {
    if (++scans === 1) { firstStarted(); await firstGate; }
    else { secondStarted(); await secondGate; }
  });

  const initial = app.sync(false); await firstScan;
  (app as any).onFileWatchEvent({ sourceId, root: directory, path: file });
  let flushed = false;
  const flush = app.flushPending(new AbortController().signal).then(() => { flushed = true; });
  releaseFirst(); await secondScan;
  await vi.waitFor(() => expect(flushed).toBe(true), {timeout:5000,interval:25});
  const flushedDuringScan = flushed;
  const pendingDuringScan = app.pendingStats().pendingRecords;
  releaseSecond(); await Promise.all([initial, flush]);
  expect(flushedDuringScan).toBe(true);
  expect(pendingDuringScan).toBe(0);
  expect(scans).toBe(2);
  expect(app.pendingStats().pendingRecords).toBe(0);
  expect(server.items).toHaveLength(2);
});


it('an existing snapshot source with no central upload consent stays held across restart and ordinary sync',async()=>{
 const server=await endpoint(true),path=join(directory,'generated-consent.txt');await writeFile(path,'Generated private input');
 let app=await manager(server.url, undefined, undefined, true);await app.addFiles(path,DEFAULT_SOURCE_OPTIONS);await app.sync();await app.close();
 const configPath=join(directory,'private-state','sources.json'),config=JSON.parse(await readFile(configPath,'utf8'));
 delete config.sources[0].centralProcessingConsent;await writeFile(configPath,JSON.stringify(config));
 const before=server.items.length;app=await manager(server.url, undefined, undefined, true);await app.sync();await app.flushPending(new AbortController().signal);
 expect(server.items).toHaveLength(before);expect(app.status()[0]).toMatchObject({state:'paused',source:{centralProcessingConsent:false}});
 await app.update(app.status()[0].source.id,{...app.status()[0].source,centralProcessingConsent:true});await app.sync();
 expect(server.items.length).toBeGreaterThan(before);expect(app.status()[0].source.centralProcessingConsent).toBe(true);
});

for (const retention of ['snapshot','archive','reference'] as const) it(`freezes a one-time ${retention} import through changed or deleted path, lost ACK and restart`, async()=>{
  const server=await endpoint(true),file=join(directory,`once-${retention}.md`);
  await writeFile(file,'Immutable generated one-time content');
  const config={serverUrl:server.url,token:'synthetic-source-token',deviceId:'synthetic-device',syncMode:'manual' as const};
  let value=new LocalSourceManager(join(directory,'once-state'),config,'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();
  await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,retention,syncContinuously:false});await value.sync(true);
  const original=value.pendingContent()[0];expect(original).toBeDefined();expect(value.status()[0].source.importCompletedAt).toBeDefined();
  await writeFile(file,'Changed generated content that must not be imported');await value.sync(true);
  expect(value.pendingContent()[0].item.revision).toBe(original.item.revision);
  await rm(file);await value.close();
  value=new LocalSourceManager(join(directory,'once-state'),config,'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();await value.sync(true);
  expect(value.pendingContent()[0].item).toEqual(original.item);
  await expect(value.flushPending(new AbortController().signal)).rejects.toThrow();
  await value.sync(true);await value.flushPending(new AbortController().signal);
  expect(value.status()[0].pending).toBe(0);expect(server.items.length).toBeGreaterThanOrEqual(2);
  expect(server.items[0]).toEqual(server.items.at(-1));
  await value.sync(true);expect(value.status()[0].pending).toBe(0);
});

it('a completed one-time snapshot import reacquires only the acknowledged version Central asks for',async()=>{
 const server=await endpoint(),file=join(directory,'once-recovery.md');await writeFile(file,'Generated immutable one-time recovery content');
 const value=await manager(server.url);await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await value.sync(true);
 expect(value.status()[0].source.importCompletedAt).toBeDefined();expect(server.items).toHaveLength(1);
 // A forced check without a Central resupply request must not rescan or resend.
 await value.sync(true);expect(server.items).toHaveLength(1);
 server.recoverLast();await value.flushPending(new AbortController().signal);
 expect(value.pendingStats().pendingRecords).toBe(0);expect(server.items).toHaveLength(2);
 expect(server.items[1]).toEqual(server.items[0]);expect(server.recoveryUploads()).toBe(1);
 expect(value.status()[0].source.importCompletedAt).toBeDefined();
});

it('a completed one-time import keeps later local changes out of snapshot recovery',async()=>{
 const server=await endpoint(),file=join(directory,'once-recovery-changed.md');await writeFile(file,'Generated selected one-time version');
 const value=await manager(server.url);await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await value.sync(true);
 expect(server.items).toHaveLength(1);
 server.recoverLast();await writeFile(file,'Changed generated content that must not be imported');
 await value.flushPending(new AbortController().signal);
 expect(server.items).toHaveLength(1);expect(server.recoveryUploads()).toBe(0);expect(value.pendingStats().pendingRecords).toBe(0);
 server.recoverLast();await value.sync(true);await value.flushPending(new AbortController().signal);
 expect(server.items).toHaveLength(1);expect(server.recoveryUploads()).toBe(0);
 expect(value.status()[0].source.importCompletedAt).toBeDefined();
});

it('explicit continuation opt-in resumes change discovery after a one-time import',async()=>{
  const server=await endpoint(),file=join(directory,'opt-in.md');await writeFile(file,'Generated first body');
  const value=new LocalSourceManager(join(directory,'opt-in-state'),{serverUrl:server.url,token:'synthetic-source-token',deviceId:'synthetic-device'},'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();
  await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await value.sync(true);const original=value.pendingContent()[0].item;
  await writeFile(file,'Generated subsequent body');const source=value.status()[0].source;
  await value.update(source.id,{...source,syncContinuously:true,enabled:true});await value.sync(true);
  expect(value.status()[0].source.importCompletedAt).toBeUndefined();expect(value.pendingContent().some(row=>row.item.revision!==original.revision)).toBe(true);
});

it('pauses every source send while local scans stage changes, then resumes the same policy',async()=>{
  const server=await endpoint(),file=join(directory,'paused-send.md');await writeFile(file,'Generated first body');
  const value=new LocalSourceManager(join(directory,'paused-state'),{serverUrl:server.url,token:'synthetic-source-token',deviceId:'synthetic-device',syncMode:'batch',syncIntervalMinutes:5,syncBatchSize:20,syncPaused:true},'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();
  await value.addFiles(file,DEFAULT_SOURCE_OPTIONS);await value.sync(true);expect(value.status()[0].pending).toBe(1);
  await value.flushPending(new AbortController().signal);expect(server.items).toHaveLength(0);expect(server.registered).toHaveLength(0);
  await writeFile(file,'Generated second body');await value.sync(true);expect(value.status()[0].pending).toBeGreaterThanOrEqual(2);
  await value.setSyncPaused(false);await value.flushPending(new AbortController().signal);expect(server.items.length).toBeGreaterThanOrEqual(2);expect(value.status()[0].pending).toBe(0);
});

it('recovers one-time completion atomically from the outbox when source configuration persistence was interrupted',async()=>{
 const server=await endpoint(),file=join(directory,'atomic-once.md');await writeFile(file,'Generated selected version');
 const state=join(directory,'atomic-once'),config={serverUrl:server.url,token:'synthetic-source-token',deviceId:'synthetic-device'};
 let value=new LocalSourceManager(state,config,'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await value.sync(true);const staged=value.pendingContent()[0];await value.close();
 // Simulate exit after the outbox transaction, before the separate UI/config projection was saved.
 const sourcePath=join(state,'sources.json'),saved=JSON.parse(await readFile(sourcePath,'utf8'));delete saved.sources[0].importCompletedAt;await writeFile(sourcePath,JSON.stringify(saved));
 await writeFile(file,'Generated later change that must not be imported');value=new LocalSourceManager(state,config,'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();await value.sync(true);
 expect(value.status()[0].source.importCompletedAt).toBeDefined();expect(value.pendingContent()).toHaveLength(1);expect(value.pendingContent()[0].item).toEqual(staged.item);
 await rm(file);await value.sync(true);expect(value.pendingContent()[0].item).toEqual(staged.item);await value.flushPending(new AbortController().signal);expect(server.items).toHaveLength(1);expect(server.items[0].revision).toBe(staged.item.revision);
});

// 41 durable filesystem imports, loopback ACKs and restart/no-replay checks can
// exceed the generic fixture deadline; this bound is not a product latency SLA.
it('more than forty completed one-time imports can be added and restored without replaying their bodies',async()=>{
 const server=await endpoint();let app=await manager(server.url);
 for(let index=0;index<41;index++){
  const file=join(directory,`generated-import-${index}.txt`);await writeFile(file,`Generated import ${index}`);
  await app.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await app.sync(true);
 }
 expect(app.status()).toHaveLength(41);expect(app.status().every(row=>row.pending===0&&Boolean(row.source.importCompletedAt))).toBe(true);
 const received=server.items.length;expect(received).toBe(41);await app.close();
 app=await manager(server.url);await app.sync(true);
 expect(app.status()).toHaveLength(41);expect(server.items).toHaveLength(received);
 expect(app.status().every(row=>row.pending===0&&Boolean(row.source.importCompletedAt))).toBe(true);
},45_000);

for(const mode of ['full','lightweight'])it(`rejects retired ${mode} index configuration before opening its pending queue and preserves originals`,async()=>{
 const state=join(directory,'strict-state'),file=join(directory,'generated-private.txt'),config={serverUrl:'http://127.0.0.1:1',token:'generated-token',deviceId:'generated-device'};
 await writeFile(file,'Generated durable original fixture');
 const value=new LocalSourceManager(state,config,'/must-not-be-invoked-helper',true);managers.push(value);await value.initialize();
 await value.addFiles(file,{...DEFAULT_SOURCE_OPTIONS,syncContinuously:false});await value.sync(true);
 const pending=value.pendingContent();expect(pending).toHaveLength(1);await value.close();
 const source=pending[0].source,configPath=join(state,'sources.json'),saved=JSON.parse(await readFile(configPath,'utf8'));
 saved.sources[0].indexMode=mode;await writeFile(configPath,JSON.stringify(saved));
 const spool=pending[0].item.localOriginal!;expect(spool).toBeDefined();
 const paths=[configPath,join(state,'storage-format.json')];
 const nodes=join(state,'nodes');for(const binding of await readdir(nodes))for(const name of await readdir(join(nodes,binding)))paths.push(join(nodes,binding,name));
 for(const name of await readdir(spool.directory))paths.push(join(spool.directory,name));
 const before=await Promise.all(paths.map(path=>readFile(path)));
 const reopened=new LocalSourceManager(state,config,'/must-not-be-invoked-helper',true);managers.push(reopened);
 await expect(reopened.initialize()).rejects.toThrow('Existing files were preserved');
 expect(await Promise.all(paths.map(path=>readFile(path)))).toEqual(before);
 expect(reopened.status()).toEqual([]);expect(source.centralProcessingConsent).toBe(true);
});


it.each(['file','default'] as const)('E preserves %s checkpoint mode through normal scan and actual snapshot recovery work',async mode=>{
  const server=await endpoint(),file=join(directory,'generated-checkpoint.txt');await writeFile(file,'Generated checkpoint input');
  const builtIn=builtInSourceAdapters().get('local-files'),contexts:SourceScanContext[]=[];
  const registry=new SourceAdapterRegistry().register({...builtIn,checkpointMode:mode==='file'?'file':undefined,scan:async context=>{
    contexts.push(context);
    if(context.checkpoint&&'catalog' in context.checkpoint){
      expect(context.checkpoint.catalog).not.toBe(context.fileCheckpoint!.catalog);
      const entries=Object.values(context.fileCheckpoint!.catalog);
      if(entries.length){const key=entries[0].relativePath,before=context.fileCheckpoint!.catalog[key].size;
        (context.checkpoint.catalog as any)[key].size=-1;expect(context.fileCheckpoint!.catalog[key].size).toBe(before);}
    }
    return builtIn.scan(context);
  }});
  const app=await manager(server.url,'synthetic-source-token',registry);await app.addFiles(file,DEFAULT_SOURCE_OPTIONS);await app.sync();
  (app as any).watcher.close();expect(app.pendingStats().pendingRecords).toBe(0);expect(server.items).toHaveLength(1);
  contexts.length=0;server.recoverLast();const full=vi.spyOn(SourceSync.prototype,'checkpoint');
  try{
    await app.sync();
    expect(contexts).toHaveLength(2); // Normal scan plus recovery scan after a matched revision invalidates the cursor.
    expect(full).toHaveBeenCalledTimes(mode==='file'?0:2);
    expect(contexts[0].fileCheckpoint?.catalog).toBeDefined();
    // F2 keeps the frozen identities while invalidating the scan cursor for
    // recovery. Live rows settle to synced after the scan, so compare identity.
    const recoveryCheckpoint=contexts[1].fileCheckpoint!,priorCatalog=contexts[0].fileCheckpoint!.catalog;
    expect(recoveryCheckpoint.inProgress).toBe(false);
    expect(recoveryCheckpoint.pendingDirectories).toEqual([]);
    expect(Object.keys(recoveryCheckpoint.catalog)).toEqual(Object.keys(priorCatalog));
    expect(Object.values(recoveryCheckpoint.catalog).map(entry=>entry.entryId)).toEqual(Object.values(priorCatalog).map(entry=>entry.entryId));
    expect(server.items).toHaveLength(2);expect(app.pendingStats().pendingRecords).toBe(0);
    if(mode==='file')expect(contexts.every(context=>context.checkpoint===undefined)).toBe(true);
    else expect(contexts[0].checkpoint).toBeDefined();
  }finally{full.mockRestore();}
});

it('E leaves the complete independent coding adapter checkpoint available by default',async()=>{
  const received:unknown[]=[];
  const registry=new SourceAdapterRegistry().register({kind:'coding-agent',version:1,watchesPath:false,tracksDeletions:false,allowsArchive:false,validateConfiguration(){},async scan(context){
    received.push(context.checkpoint);if(context.checkpoint)(context.checkpoint as any).nested.offset=999;
    return {version:1,scan:{items:[],seen:[],complete:true,skipped:0,checkpoint:{version:1,nested:{offset:17,tail:'Generated checkpoint'}}}};
  }});
  const app=new LocalSourceManager(join(directory,'coding-state'),{serverUrl:'',token:'',deviceId:'synthetic-device'},'/never-native',true,undefined,registry);
  managers.push(app);await app.initialize();await app.addAdapterSource({kind:'coding-agent',name:'Generated coding source'},DEFAULT_SOURCE_OPTIONS);await app.sync();
  await app.sync();expect(received.at(-1)).toEqual({version:1,nested:{offset:999,tail:'Generated checkpoint'}});
  const engine=[...(app as any).engines.values()][0] as SourceSync;
  expect(engine.checkpoint()).toEqual({version:1,nested:{offset:17,tail:'Generated checkpoint'}});
});
