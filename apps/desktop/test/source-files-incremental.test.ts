import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceWork } from '../src/background';
import { DirectoryCatalog } from '../src/directory-catalog';
import * as volume from '../src/local-volume';
import { scanSourceFiles } from '../src/source-files';
import { LocalSourceManager } from '../src/source-manager';
import { SourceSync, sourceHash } from '../src/source-sync';
import { DEFAULT_SOURCE_OPTIONS, type LocalFileCheckpoint, type SourceDefinition, type SourceRequest } from '../src/source-types';
import { sourceAck } from './fixtures';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), lstat: vi.fn(actual.lstat) };
});

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'mote-incremental-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const checkpoint = (scan: Awaited<ReturnType<typeof scanSourceFiles>>) => scan.checkpoint as LocalFileCheckpoint;
const oldTime = new Date('2020-01-01T00:00:00.000Z');
async function writeWithOldMtime(path: string, text: string) { await writeFile(path, text); await utimes(path, oldTime, oldTime); }

// Simulate a filesystem that reports the same metadata for two different bodies.
// Keep the first full content digest while aligning its saved metadata with the
// second observation, including ctime and the inode-derived quick fingerprint.
async function hideMetadataChange(state: LocalFileCheckpoint, path: string, key: string) {
  const info = await lstat(path), entry = state.catalog[key];
  expect(info.size).toBe(entry.size); expect(info.mtimeMs).toBe(entry.mtimeMs);
  entry.ctimeMs = info.ctimeMs;
  entry.quickHash = entry.contentQuickHash = sourceHash(`${entry.fileId}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
}

it.each(['directory', 'file'] as const)('rechecks a signalled %s despite matching size, mtime and metadata', async mode => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected = join(root, 'selected'); await mkdir(selected);
  const file = join(selected, 'a.txt'), marker = join(root, 'markers');
  await writeWithOldMtime(file, 'first');
  const target = mode === 'file' ? file : selected;
  const first = await scanSourceFiles(target, DEFAULT_SOURCE_OPTIONS, undefined, marker);
  const prior = checkpoint(first), id = first.items[0].externalId;
  await writeWithOldMtime(file, 'other'); await hideMetadataChange(prior, file, 'a.txt');
  const work = vi.spyOn(sourceWork, 'run');
  const quiet = await scanSourceFiles(target, DEFAULT_SOURCE_OPTIONS, undefined, marker, prior);
  expect(quiet.items).toEqual([]);
  expect(work.mock.calls.filter(([job]) => job.kind === 'spool-original')).toHaveLength(0);
  const changed = await scanSourceFiles(target, DEFAULT_SOURCE_OPTIONS, undefined, marker, prior, [file]);
  expect(changed.items).toHaveLength(1);
  expect(changed.items[0].externalId).toBe(id);
  expect(changed.items[0].document?.fileIndex?.contentVersion).toBe(sourceHash('other'));
  expect(await readFile(join(changed.items[0].localOriginal!.directory, '0'), 'utf8')).toBe('other');
});

it.each(['unknown volume', 'return after offline'] as const)('fully checks matching metadata on %s', async reason => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue(reason === 'unknown volume' ? undefined : 'apfs:generated-volume');
  const selected = join(root, 'selected'); await mkdir(selected);
  const file = join(selected, 'a.txt'), marker = join(root, 'markers');
  await writeWithOldMtime(file, 'first');
  const first = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, marker), prior = checkpoint(first);
  await writeWithOldMtime(file, 'other'); await hideMetadataChange(prior, file, 'a.txt');
  if (reason === 'return after offline') { prior.degradedReason = 'root_unavailable'; prior.lastScanComplete = false; }
  const changed = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, marker, prior);
  expect(changed.items).toHaveLength(1);
  expect(changed.items[0].externalId).toBe(first.items[0].externalId);
  expect(changed.items[0].document?.fileIndex?.contentVersion).toBe(sourceHash('other'));
  if (reason === 'unknown volume') {
    const work = vi.spyOn(sourceWork, 'run');
    const same = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, marker, checkpoint(changed));
    expect(work.mock.calls.filter(([job]) => job.kind === 'spool-original')).toHaveLength(1);
    expect(same.items).toEqual([]);
  }
});

it('rechecks a nested mounted filesystem even when its selected root is on trusted APFS', async () => {
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected=join(root,'selected'),file=join(selected,'a.txt');await mkdir(selected);await writeWithOldMtime(file,'first');
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation((async(path:any,...args:any[])=>{
    const info=await (actual.lstat as any)(path,...args);
    return path===selected?new Proxy(info,{get(target,key){return key==='dev'?target.dev+1:Reflect.get(target,key,target);}}):info;
  }) as typeof lstat);
  try{
    const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS),prior=checkpoint(first);
    await writeWithOldMtime(file,'other');await hideMetadataChange(prior,file,'a.txt');
    const next=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,prior);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].externalId).toBe(first.items[0].externalId);
    expect(next.items[0].document?.fileIndex?.contentVersion).toBe(sourceHash('other'));
  }finally{vi.mocked(lstat).mockImplementation(actual.lstat);}
});

it('finishes content verification across interrupted pages after an offline root returns', async () => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected = join(root, 'selected'); await mkdir(selected);
  for (const name of ['a.txt','b.txt']) await writeWithOldMtime(join(selected,name), 'first');
  const first = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS), prior = checkpoint(first);
  for (const name of ['a.txt','b.txt']) { await writeWithOldMtime(join(selected,name), 'other'); await hideMetadataChange(prior,join(selected,name),name); }
  prior.degradedReason='root_unavailable'; prior.lastScanComplete=false;
  const next = DirectoryCatalog.prototype.next; let interrupted = false;
  const spy = vi.spyOn(DirectoryCatalog.prototype,'next').mockImplementation(async function(limit,excluded) {
    const page = await next.call(this,Math.min(limit,1),excluded);
    if (!interrupted && page.candidates.length) { interrupted=true; return {...page,faulted:true}; }
    return page;
  });
  const head = await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,prior);
  spy.mockRestore();
  expect(head.complete).toBe(false);expect(checkpoint(head).contentVerificationPending).toBe(true);
  const tail = await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(head));
  expect(tail.complete).toBe(true);expect(checkpoint(tail).contentVerificationPending).toBe(false);
  expect([...head.items,...tail.items].map(item=>item.title).sort()).toEqual(['a.txt','b.txt']);
  expect([...head.items,...tail.items].every(item=>item.document?.fileIndex?.contentVersion===sourceHash('other'))).toBe(true);
});

it('bounds priority rechecks by bytes even when unchanged files produce no upload', async () => {
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  const selected=join(root,'selected'),a=join(selected,'a.txt'),b=join(selected,'b.txt'),marker=join(root,'markers');await mkdir(selected);
  await writeFile(a,Buffer.alloc(16*1024*1024,97));await writeFile(b,'b');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker);
  expect(first.complete).toBe(false);
  const rest=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,checkpoint(first));
  expect(rest.complete).toBe(true);expect(rest.items.map(item=>item.title)).toEqual(['b.txt']);
  const head=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,checkpoint(rest),[a,b]);
  expect(head.items).toEqual([]);expect(head.complete).toBe(false);expect(head.checkedPriorityPaths).toEqual([a]);
  const tail=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,checkpoint(head),[b]);
  expect(tail.checkedPriorityPaths).toEqual([b]);
});

it('keeps a pathless watcher signal through the manager and checks its whole selected directory', async () => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected=join(root,'selected'),file=join(selected,'a.txt');await mkdir(selected);await writeWithOldMtime(file,'first');
  const app=new LocalSourceManager(join(root,'private-profile'),{serverUrl:'',deviceId:'generated-device',syncMode:'manual'},'/unused',true);
  vi.spyOn((app as any).watcher,'setTargets').mockResolvedValue(undefined);
  try {
    await app.initialize();const id=await app.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await app.sync(true);
    expect(app.pendingContent()).toHaveLength(1);
    await writeWithOldMtime(file,'other');
    const engine=(app as any).engines.get(id) as SourceSync;
    await hideMetadataChange(engine.fileCheckpoint()!,file,'a.txt');
    (app as any).onFileWatchEvent({sourceId:id,root:selected,backend:'fsevents',kind:'change'});
    await app.sync(false);
    const pending=app.pendingContent().map(row=>row.item);
    expect(pending).toHaveLength(2);
    expect(pending[1].externalId).toBe(pending[0].externalId);
    expect(pending.map(item=>item.document?.fileIndex?.contentVersion).sort()).toEqual([sourceHash('first'),sourceHash('other')].sort());
  } finally { await app.close(); }
});

it('continues a pathless watcher reconciliation across pages without waiting for the ordinary interval', async () => {
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected=join(root,'selected');await mkdir(selected);
  for(const name of ['a.txt','b.txt'])await writeWithOldMtime(join(selected,name),'first');
  const app=new LocalSourceManager(join(root,'private-profile'),{serverUrl:'',deviceId:'generated-device',syncMode:'manual'},'/unused',true);
  vi.spyOn((app as any).watcher,'setTargets').mockResolvedValue(undefined);
  try{
    await app.initialize();const id=await app.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await app.sync(true);
    const engine=(app as any).engines.get(id) as SourceSync;
    for(const name of ['a.txt','b.txt']){const file=join(selected,name);await writeWithOldMtime(file,'other');await hideMetadataChange(engine.fileCheckpoint()!,file,name);}
    const next=DirectoryCatalog.prototype.next;let cut=false;
    const spy=vi.spyOn(DirectoryCatalog.prototype,'next').mockImplementation(async function(limit,excluded){
      const page=await next.call(this,Math.min(limit,1),excluded);
      if(!cut&&page.candidates.length){cut=true;return {...page,faulted:true};}return page;
    });
    (app as any).onFileWatchEvent({sourceId:id,root:selected,backend:'fsevents',kind:'change'});await app.sync(false);spy.mockRestore();
    expect(app.status()[0].scanComplete).toBe(false);
    (app as any).states.get(id).lastSyncAt=new Date().toISOString();
    await app.sync(false);
    expect(app.status()[0].scanComplete).toBe(true);
    expect(app.pendingContent().filter(row=>row.item.document?.fileIndex?.contentVersion===sourceHash('other'))).toHaveLength(2);
  }finally{await app.close();}
});

it('resolves a relative watcher filename for a selected single file', async () => {
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const file=join(root,'a.txt');await writeWithOldMtime(file,'first');
  const app=new LocalSourceManager(join(root,'private-profile'),{serverUrl:'',deviceId:'generated-device',syncMode:'manual'},'/unused',true);
  vi.spyOn((app as any).watcher,'setTargets').mockResolvedValue(undefined);
  try{
    await app.initialize();const id=await app.addFiles(file,DEFAULT_SOURCE_OPTIONS);await app.sync(true);
    const engine=(app as any).engines.get(id) as SourceSync;
    await writeWithOldMtime(file,'other');await hideMetadataChange(engine.fileCheckpoint()!,file,'a.txt');
    (app as any).onFileWatchEvent({sourceId:id,root:file,path:'a.txt',backend:'inotify',kind:'change'});await app.sync(false);
    const pending=app.pendingContent().map(row=>row.item.document?.fileIndex?.contentVersion);
    expect(pending.sort()).toEqual([sourceHash('first'),sourceHash('other')].sort());
  }finally{await app.close();}
});

it('keeps a content baseline for new-only on an untrusted volume without uploading existing files', async () => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue(undefined);
  const file = join(root, 'a.txt'), options = {...DEFAULT_SOURCE_OPTIONS, initialSync:'new_only' as const};
  await writeWithOldMtime(file, 'first');
  const first = await scanSourceFiles(root, options);
  expect(first.items).toEqual([]);
  expect(checkpoint(first).catalog['a.txt'].contentHash).toBe(sourceHash('first'));
  await writeWithOldMtime(file, 'other'); await hideMetadataChange(checkpoint(first), file, 'a.txt');
  const changed = await scanSourceFiles(root, options, undefined, undefined, checkpoint(first));
  expect(changed.items).toHaveLength(1);
  expect(Buffer.from(changed.items[0].localOriginalBase64!, 'base64').toString()).toBe('other');
});

it('never reads a file body or creates an original spool in reference mode', async () => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue(undefined);
  const file = join(root, 'a.txt'); await writeWithOldMtime(file, 'generated private body');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let bodyReads = 0;
  vi.mocked(open).mockImplementation((async (path: any, flags: any, ...rest: any[]) => {
    const handle = await (actual.open as any)(path, flags, ...rest);
    if (path === file) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args: any[]) => { bodyReads++; return read(...args); });
    }
    return handle;
  }) as typeof open);
  const work = vi.spyOn(sourceWork, 'run');
  const options = {...DEFAULT_SOURCE_OPTIONS, retention:'reference' as const};
  const first = await scanSourceFiles(root, options, undefined, join(root, '.markers'));
  const next = await scanSourceFiles(root, options, undefined, join(root, '.markers'), checkpoint(first), [file]);
  expect(first.items).toHaveLength(1); expect(next.items).toEqual([]);
  expect(first.items[0]).toMatchObject({layer:'reference', text:''});
  expect(first.items[0].localOriginal).toBeUndefined(); expect(first.items[0].localOriginalBase64).toBeUndefined();
  expect(bodyReads).toBe(0);
  expect(work.mock.calls.filter(([job]) => job.kind === 'spool-original' || job.kind === 'spool-bytes')).toHaveLength(0);
});

it('compares privacy-transformed digests only with the same transformed bytes', async () => {
  vi.spyOn(volume, 'localVolumeIdentity').mockResolvedValue(undefined);
  const file = join(root, 'a.txt'), options = {...DEFAULT_SOURCE_OPTIONS, redactLiterals:['AAA', 'BBB']};
  await writeWithOldMtime(file, 'AAA');
  const first = await scanSourceFiles(root, options), prior = checkpoint(first);
  expect(prior.catalog['a.txt'].contentHash).toBe(sourceHash('[已遮盖]'));
  await writeWithOldMtime(file, 'BBB'); await hideMetadataChange(prior, file, 'a.txt');
  const same = await scanSourceFiles(root, options, undefined, undefined, prior);
  expect(same.items).toEqual([]);
  await writeWithOldMtime(file, 'CCC'); await hideMetadataChange(checkpoint(same), file, 'a.txt');
  const changed = await scanSourceFiles(root, options, undefined, undefined, checkpoint(same));
  expect(changed.items).toHaveLength(1);
  expect(changed.items[0].document?.fileIndex?.contentVersion).toBe(sourceHash('CCC'));
});

it.each([
  {label:'snapshot',retention:'snapshot' as const,masked:false},
  {label:'masked snapshot',retention:'snapshot' as const,masked:true},
  {label:'archive',retention:'archive' as const,masked:false},
])('retries a lost $label response from the frozen spool after the original changes', async ({retention,masked}) => {
  const selected = join(root, 'selected'); await mkdir(selected);
  const file = join(selected, 'a.txt'), marker = join(root, 'markers'), state = join(root, 'outbox');
  const firstBytes = masked ? 'generated secret bytes' : 'generated first bytes';
  const sentBytes = masked ? 'generated [已遮盖] bytes' : firstBytes;
  const options = {...DEFAULT_SOURCE_OPTIONS,retention,redactLiterals:masked?['secret']:[]};
  await writeFile(file, firstBytes);
  let sync = new SourceSync(state); await sync.initialize();
  const scan = await scanSourceFiles(selected, options, undefined, marker, sync.fileCheckpoint(), [], true);
  await sync.stage(scan, false); const queued = sync.pendingContent()[0], spool = queued.localOriginal!;
  expect(spool).toBeDefined();expect(queued.localOriginalBase64).toBeUndefined();
  expect(await readFile(join(spool.directory,'0'),'utf8')).toBe(sentBytes);
  const source: SourceDefinition = {id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention,enabled:true};
  const manifests: any[] = [], parts: Buffer[] = []; let loseResponse = true;
  const request: SourceRequest = async (path, body) => {
    if (path === '/api/sources') return source;
    if (path.includes('/head?')) return {revision:null};
    if (path.endsWith('/uploads')) { manifests.push(structuredClone(body)); return {uploadId:'generated', partBytes:4194304, parts:[]}; }
    if (path.includes('/parts/')) { const bytes = Buffer.from(body as Buffer); parts.push(bytes); return {part:0,hash:sourceHash(bytes),bytes:bytes.length}; }
    if (path.endsWith('/commit')) {
      if (loseResponse) { loseResponse = false; throw Error('generated lost response'); }
      return {...sourceAck(source.id, queued, 'file-revision', true),sha256:spool.sha256,sizeBytes:spool.sizeBytes};
    }
    throw Error(path);
  };
  await expect(sync.flush(source, request)).rejects.toThrow('lost response');
  await writeFile(file, 'generated newer bytes');
  sync = new SourceSync(state); await sync.initialize();
  const work = vi.spyOn(sourceWork, 'run');
  await sync.flush(source, request);
  expect(work.mock.calls.filter(([job]) => job.kind === 'spool-original' || job.kind === 'spool-bytes')).toHaveLength(0);
  expect(manifests[1]).toEqual(manifests[0]);
  expect(parts.map(part => part.toString())).toEqual([sentBytes, sentBytes]);
  if(masked)expect(JSON.stringify(manifests)).not.toContain('secret');
  expect(sync.status().pending).toBe(0);
  await expect(lstat(spool.directory)).rejects.toMatchObject({code:'ENOENT'});
  const newer = await scanSourceFiles(selected, options, undefined, marker, sync.fileCheckpoint(), [file], true);
  expect(await readFile(join(newer.items[0].localOriginal!.directory, '0'), 'utf8')).toBe('generated newer bytes');
});

it('sends an older pending history revision before a newer realtime revision of the same file', async () => {
  const selected=join(root,'selected'),file=join(selected,'a.txt'),marker=join(root,'markers');await mkdir(selected);
  const state=join(root,'outbox');let sync=new SourceSync(state);await sync.initialize();
  await writeFile(file,'generated old');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,sync.fileCheckpoint(),[],true);
  await sync.stage(first,false,undefined,'all','history');
  await writeFile(file,'generated newer');
  const second=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,sync.fileCheckpoint(),[file],true);
  await sync.stage(second,false,undefined,'all','realtime');
  sync=new SourceSync(state);await sync.initialize();
  const source:SourceDefinition={id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot',enabled:true};
  const manifests:any[]=[],parts:string[]=[];
  const request:SourceRequest=async(path,body)=>{
    if(path==='/api/sources')return source;
    if(path.includes('/head?'))return {revision:null};
    if(path.endsWith('/uploads')){manifests.push(body);return {uploadId:String(manifests.length),partBytes:4194304,parts:[]};}
    if(path.includes('/parts/')){const bytes=body as Buffer;parts.push(bytes.toString());return {part:0,hash:sourceHash(bytes),bytes:bytes.length};}
    if(path.endsWith('/commit')){const m=manifests[Number(path.split('/').at(-2))-1];return {...sourceAck(source.id,m.item,'file-revision'),sha256:m.sha256,sizeBytes:m.sizeBytes};}
    throw Error(path);
  };
  await sync.flush(source,request);
  expect(parts).toEqual(['generated old','generated newer']);
  expect(manifests[1].previousRevision).toBe(manifests[0].item.revision);
  expect(sync.status().pending).toBe(0);
});
