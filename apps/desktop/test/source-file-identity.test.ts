import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {link,lstat,mkdir,mkdtemp,readFile,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanSourceFiles} from '../src/source-files';
import {DirectoryCatalog} from '../src/directory-catalog';
import {sourceWork} from '../src/background';
import * as volume from '../src/local-volume';
import {SourceSync} from '../src/source-sync';
import {DEFAULT_SOURCE_OPTIONS,type LocalFileCheckpoint,type SourceDefinition,type SourceRequest} from '../src/source-types';
import {sourceAck} from './fixtures';

let root:string;
const checkpoint=(scan:Awaited<ReturnType<typeof scanSourceFiles>>)=>scan.checkpoint as LocalFileCheckpoint;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'mote-file-identity-')));});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});

it('keeps the logical ID and full content version through a verified local rename and SQLite restart',async()=>{
  // Exercise the real macOS volume probe when available; other environments use a controlled OS boundary.
  const actual=await volume.localVolumeIdentity(root);
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(actual??'apfs:generated-volume');
  const selected=join(root,'selected'),state=join(root,'state.json');await mkdir(selected);
  await writeFile(join(selected,'before.md'),'Generated content');
  let sync=new SourceSync(state);await sync.initialize();
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint(),[],true);
  const item=first.items[0],id=item.externalId;
  await sync.stage(first,false);sync=new SourceSync(state);await sync.initialize();
  const saved=sync.fileCheckpoint()!.catalog['before.md'];
  expect(saved).toMatchObject({entryId:id,relativePath:'before.md',contentVersion:hash('Generated content'),contentHash:hash('Generated content')});
  expect(saved.fileId).not.toBe(id);
  await rename(join(selected,'before.md'),join(selected,'after.md'));
  const moved=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint(),[],true);
  expect(moved.complete).toBe(true);expect(moved.items).toHaveLength(1);
  expect(moved.items[0]).toMatchObject({externalId:id,title:'after.md',document:{fileIndex:{fileId:id,contentVersion:hash('Generated content')}}});
  expect(moved.seen).toEqual([id]);await sync.stage(moved,false);
  sync=new SourceSync(state);await sync.initialize();
  expect(Object.keys(sync.fileCheckpoint()!.catalog)).toEqual(['after.md']);
  expect(sync.fileCheckpoint()!.catalog['after.md']).toMatchObject({entryId:id,contentHash:hash('Generated content')});
});

it('does not equate a same-name replacement or two same-content locations',async()=>{
  await writeFile(join(root,'a.md'),'Generated identical');await writeFile(join(root,'b.md'),'Generated identical');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),ids=first.items.map(item=>item.externalId);
  expect(new Set(ids).size).toBe(2);
  expect(first.items.map(item=>item.document!.fileIndex!.contentVersion)).toEqual([hash('Generated identical'),hash('Generated identical')]);
  await rename(join(root,'a.md'),join(root,'.displaced'));await writeFile(join(root,'a.md'),'Generated identical');
  const next=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(next.complete).toBe(true);expect(next.items).toHaveLength(1);
  expect(next.items[0].externalId).not.toBe(ids[0]);expect(next.items[0].externalId).not.toBe(ids[1]);
  expect(next.items[0].document!.fileIndex!.contentVersion).toBe(first.items[0].document!.fileIndex!.contentVersion);
  expect(next.seen).toContain(ids[1]);expect(next.seen).not.toContain(ids[0]);
});

it('does not preserve an old identity when a replaced file is temporarily excluded by extension',async()=>{
  const path=join(root,'a.md');await writeFile(path,'Generated old');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),old=first.items[0].externalId;
  await rename(path,join(root,'.old'));await writeFile(path,'Generated replacement');
  const excluded=await scanSourceFiles(root,{...DEFAULT_SOURCE_OPTIONS,extensions:['.txt']},undefined,undefined,checkpoint(first));
  expect(excluded.complete).toBe(true);expect(checkpoint(excluded).catalog['a.md'].entryId).toBeUndefined();
  const restored=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(excluded));
  expect(restored.items).toHaveLength(1);expect(restored.items[0].externalId).not.toBe(old);
});

it('keeps both the renamed entry and a replacement created at its old location',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const oldPath=join(root,'a.md'),newPath=join(root,'b.md');await writeFile(oldPath,'Generated original');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),oldId=first.items[0].externalId;
  await rename(oldPath,newPath);await writeFile(oldPath,'Generated replacement');
  const next=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  const moved=next.items.find(item=>item.title==='b.md')!,replacement=next.items.find(item=>item.title==='a.md')!;
  expect(moved.externalId).toBe(oldId);expect(replacement.externalId).not.toBe(oldId);
  expect(new Set(next.seen)).toEqual(new Set([oldId,replacement.externalId]));
  expect(Object.keys(checkpoint(next).catalog).sort()).toEqual(['a.md','b.md']);
  const later=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(next));
  expect(later.items).toEqual([]);expect(new Set(later.seen)).toEqual(new Set(next.seen));
});

it('does not follow a replaced parent symlink when checking the old locator',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected=join(root,'selected'),outside=join(root,'outside');await mkdir(selected);await mkdir(outside);await mkdir(join(selected,'old'));
  await writeFile(join(selected,'old','a.md'),'Generated original');await writeFile(join(outside,'a.md'),'Generated unrelated');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS);
  await rename(join(selected,'old','a.md'),join(selected,'b.md'));await rm(join(selected,'old'),{recursive:true});await symlink(outside,join(selected,'old'));
  const next=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(next.items).toHaveLength(1);expect(next.items[0].externalId).not.toBe(first.items[0].externalId);
});

it('keeps hard-linked locations distinct and does not guess an ambiguous rename',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  await writeFile(join(root,'a.md'),'Generated shared inode');await link(join(root,'a.md'),join(root,'b.md'));
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),ids=first.items.map(item=>item.externalId);
  expect(new Set(ids).size).toBe(2);
  await rename(join(root,'a.md'),join(root,'c.md'));
  const next=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(next.items.find(item=>item.title==='c.md')!.externalId).not.toBe(ids[0]);
  expect(next.seen).toContain(ids[1]);expect(next.seen).not.toContain(ids[0]);
});

it('does not infer a rename on an unverified volume, even for identical content',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  await writeFile(join(root,'a.md'),'Generated network content');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS);
  await rename(join(root,'a.md'),join(root,'b.md'));
  const next=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(next.complete).toBe(true);expect(next.items[0].externalId).not.toBe(first.items[0].externalId);
  expect(next.seen).not.toContain(first.items[0].externalId);
});

it('never rebinds matching hashes when an offline root returns as another mount',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');
  const selected=join(root,'mount'),offline=join(root,'offline');await mkdir(selected);
  await writeFile(join(selected,'a.md'),'Generated same');await writeFile(join(selected,'b.md'),'Generated same');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS),oldIds=first.items.map(item=>item.externalId);
  await rename(selected,offline);
  const missing=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(missing.complete).toBe(false);expect(missing.degraded).toBe('root_unavailable');
  await mkdir(selected);await writeFile(join(selected,'x.md'),'Generated same');await writeFile(join(selected,'y.md'),'Generated same');
  const remount=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(missing));
  expect(remount.complete).toBe(false);expect(remount.degraded).toBe('root_changed');
  expect(remount.items).toHaveLength(2);expect(new Set(remount.items.map(item=>item.externalId)).size).toBe(2);
  for(const item of remount.items){expect(oldIds).not.toContain(item.externalId);expect(item.document!.fileIndex!.contentVersion).toBe(hash('Generated same'));}
  expect(Object.keys(checkpoint(remount).catalog)).toEqual(expect.arrayContaining(['a.md','b.md','x.md','y.md']));
});

it('does not reuse IDs after an unverified volume returns even if its root and inode numbers match',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  const selected=join(root,'mount'),offline=join(root,'offline');await mkdir(selected);
  await writeFile(join(selected,'a.md'),'Generated same');await writeFile(join(selected,'b.md'),'Generated same');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS),oldIds=first.items.map(item=>item.externalId);
  await rename(selected,offline);
  const missing=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  await rename(offline,selected);
  const returned=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(missing));
  expect(returned.complete).toBe(false);expect(returned.degraded).toBe('root_changed');expect(returned.items).toHaveLength(2);
  for(const item of returned.items)expect(oldIds).not.toContain(item.externalId);
  const settled=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(returned));
  expect(settled.complete).toBe(true);expect(settled.items).toEqual([]);
  expect(new Set(settled.seen)).toEqual(new Set(returned.items.map(item=>item.externalId)));
});

it('separates identities when the verified volume changes despite identical filesystem numbers',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValueOnce('apfs:volume-a').mockResolvedValue('apfs:volume-b');
  await writeFile(join(root,'a.md'),'Generated same');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS);
  const changed=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(changed.complete).toBe(false);expect(changed.degraded).toBe('root_changed');
  expect(changed.items).toHaveLength(1);expect(changed.items[0].externalId).not.toBe(first.items[0].externalId);
  const settled=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(changed));
  expect(settled.complete).toBe(true);expect(settled.seen).toEqual([changed.items[0].externalId]);
});

it('preserves unseen catalog entries while an unverified returned root is checked',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  const selected=join(root,'mount'),offline=join(root,'offline');await mkdir(selected);await writeFile(join(selected,'a.md'),'Generated old');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS);await rename(selected,offline);
  const missing=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  await rm(join(offline,'a.md'));await rename(offline,selected);
  const verify=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(missing));
  expect(verify.complete).toBe(false);expect(verify.degraded).toBe('root_changed');expect(checkpoint(verify).catalog['a.md'].entryId).toBe(first.items[0].externalId);
  const settled=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(verify));
  expect(settled.complete).toBe(true);expect(settled.seen).toEqual([]);
});

it('restarts an interrupted page after an unverified root outage without missing files',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  const selected=join(root,'mount'),offline=join(root,'offline');await mkdir(selected);
  await writeFile(join(selected,'a.md'),'Generated A');await writeFile(join(selected,'b.md'),'Generated B');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS),page=new DirectoryCatalog(selected,checkpoint(first));
  expect((await page.next(1,[])).candidates).toHaveLength(1);expect(page.inProgress).toBe(true);
  await rename(selected,offline);
  const missing=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,page.checkpoint());
  expect(checkpoint(missing).inProgress).toBe(true);await rename(offline,selected);
  const returned=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(missing));
  expect(returned.complete).toBe(false);expect(returned.degraded).toBe('root_changed');
  expect(returned.items.map(item=>item.title).sort()).toEqual(['a.md','b.md']);
  for(const item of returned.items)expect(first.seen).not.toContain(item.externalId);
  const settled=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(returned));
  expect(settled.complete).toBe(true);expect(new Set(settled.seen)).toEqual(new Set(returned.items.map(item=>item.externalId)));
});

it('withholds absences until a returned unverified root completes verification across pages',async()=>{
  vi.spyOn(volume,'localVolumeIdentity').mockResolvedValue(undefined);
  const selected=join(root,'mount'),offline=join(root,'offline');await mkdir(selected);
  await writeFile(join(selected,'a.md'),'Generated A');await writeFile(join(selected,'b.md'),'Generated B');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS);await rename(selected,offline);
  const missing=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  await rm(join(offline,'b.md'));await rename(offline,selected);
  const next=DirectoryCatalog.prototype.next;let cut=false;
  const spy=vi.spyOn(DirectoryCatalog.prototype,'next').mockImplementation(async function(limit,excluded){
    const batch=await next.call(this,limit,excluded);
    if(!cut && batch.candidates.length){cut=true;return {...batch,faulted:true};}
    return batch;
  });
  const head=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(missing));spy.mockRestore();
  expect(head.complete).toBe(false);expect(checkpoint(head).identityVerificationPending).toBe(true);
  const state=join(root,'state');let sync=new SourceSync(state);await sync.initialize();await sync.stage(head,false);
  sync=new SourceSync(state);await sync.initialize();expect(sync.fileCheckpoint()!.identityVerificationPending).toBe(true);
  const tail=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint());
  expect(tail.complete).toBe(false);expect(tail.degraded).toBe('root_changed');
  expect(checkpoint(tail).catalog['b.md'].entryId).toBe(first.items.find(item=>item.title==='b.md')!.externalId);
  expect(checkpoint(tail).identityVerificationPending).toBe(false);
  await sync.stage(tail,false);sync=new SourceSync(state);await sync.initialize();expect(sync.fileCheckpoint()!.identityVerificationPending).toBe(false);
  const settled=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint());
  expect(settled.complete).toBe(true);expect(settled.seen).toEqual([head.items[0].externalId]);
});

it('records only a metadata version in reference mode and never calls it a full content hash',async()=>{
  await writeFile(join(root,'a.md'),'Generated reference');
  const scan=await scanSourceFiles(root,{...DEFAULT_SOURCE_OPTIONS,retention:'reference'});
  const entry=checkpoint(scan).catalog['a.md'];
  expect(entry.contentVersion).toBe(scan.items[0].document!.fileIndex!.contentVersion);
  expect(entry.contentVersion).not.toBe(hash('Generated reference'));expect(entry.contentHash).toBeUndefined();
  expect(scan.items[0].localOriginal).toBeUndefined();expect(scan.items[0].localOriginalBase64).toBeUndefined();
});

it.each(['replace','modify'] as const)('rejects a %s between enumeration and the first fstat',async change=>{
  const path=join(root,'a.md');await writeFile(path,'Generated original');
  const next=DirectoryCatalog.prototype.next;
  vi.spyOn(DirectoryCatalog.prototype,'next').mockImplementation(async function(limit,excluded){
    const batch=await next.call(this,limit,excluded);
    if(batch.candidates.length){if(change==='replace')await rename(path,join(root,'.old'));await writeFile(path,'Generated changed body');}
    return batch;
  });
  const scan=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS);
  expect(scan.complete).toBe(false);expect(scan.items).toEqual([]);expect(scan.skipped).toBeGreaterThan(0);
});

it('rejects replacement after spooling and removes the rejected private spool',async()=>{
  const path=join(root,'a.md'),marker=join(root,'.markers');await writeFile(path,'Generated original');
  const run=sourceWork.run.bind(sourceWork);let spoolDirectory:string|undefined;
  vi.spyOn(sourceWork,'run').mockImplementation(async (...args:any[])=>{
    const value=await (run as any)(...args);
    if(args[0].kind==='spool-original'){
      spoolDirectory=value.directory;await rename(path,join(root,'.old'));await writeFile(path,'Generated replacement');
    }
    return value;
  });
  const scan=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,marker);
  expect(scan.complete).toBe(false);expect(scan.items).toEqual([]);expect(spoolDirectory).toBeDefined();
  await expect(lstat(spoolDirectory!)).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(path,'utf8')).toBe('Generated replacement');
});

it('does not attach a failed replacement to the previous ID when the next scan recovers',async()=>{
  const path=join(root,'a.md');await writeFile(path,'Generated first');
  const first=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS),old=first.items[0].externalId;
  await rename(path,join(root,'.old'));await writeFile(path,'Generated replacement');
  const next=DirectoryCatalog.prototype.next;
  const spy=vi.spyOn(DirectoryCatalog.prototype,'next').mockImplementation(async function(limit,excluded){
    const batch=await next.call(this,limit,excluded);
    if(batch.candidates.length){await rename(path,join(root,'.replacement'));await writeFile(path,'Generated final');}
    return batch;
  });
  const failed=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,checkpoint(first));
  expect(failed.complete).toBe(false);expect(failed.items).toEqual([]);expect(failed.seen).not.toContain(old);
  expect(checkpoint(failed).catalog['a.md']).toMatchObject({entryId:old,fileId:checkpoint(first).catalog['a.md'].fileId,syncState:'error'});
  spy.mockRestore();let previous=checkpoint(failed),recovered:Awaited<ReturnType<typeof scanSourceFiles>>|undefined;
  for(let attempt=0;attempt<3;attempt++){recovered=await scanSourceFiles(root,DEFAULT_SOURCE_OPTIONS,undefined,undefined,previous);previous=checkpoint(recovered);if(recovered.items.length)break;}
  expect(recovered!.items).toHaveLength(1);expect(recovered!.items[0].externalId).not.toBe(old);
  expect(Buffer.from(recovered!.items[0].localOriginalBase64!,'base64').toString()).toBe('Generated final');
});

it('keeps registry IDs when a policy forces a rescan across restart',async()=>{
  const selected=join(root,'selected'),state=join(root,'state');await mkdir(selected);await writeFile(join(selected,'a.md'),'Generated policy');
  let sync=new SourceSync(state);await sync.initialize();await sync.ensurePolicy('snapshot');await sync.ensureAdapterVersion(2);
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,sync.fileCheckpoint(),[],true);
  await sync.stage(first,false);const id=first.items[0].externalId;
  await sync.ensurePolicy('reference');sync=new SourceSync(state);await sync.initialize();
  const next=await scanSourceFiles(selected,{...DEFAULT_SOURCE_OPTIONS,retention:'reference'},undefined,undefined,sync.fileCheckpoint(),[],true);
  expect(next.items).toHaveLength(1);expect(next.items[0].externalId).toBe(id);expect(next.items[0].layer).toBe('reference');
  await sync.stage(next,false);sync=new SourceSync(state);await sync.initialize();
  expect(sync.fileCheckpoint()!.catalog['a.md'].entryId).toBe(id);
  expect(sync.fileCheckpoint()!.catalog['a.md'].contentHash).toBeUndefined();
});

it('reopens the same registry identity when Central requests snapshot input recovery',async()=>{
  const selected=join(root,'selected'),state=join(root,'state'),marker=join(root,'markers');await mkdir(selected);
  const bytes='Generated recovery';await writeFile(join(selected,'a.md'),bytes);
  const source:SourceDefinition={id:'generated',name:'Generated',kind:'local-files',deviceId:'generated',platform:'macos',retention:'snapshot',enabled:true};
  let sync=new SourceSync(state);await sync.initialize();await sync.ensurePolicy('snapshot');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,sync.fileCheckpoint(),[],true);
  await sync.stage(first,false);const queued=sync.pendingContent()[0];
  const request:SourceRequest=async(path,body)=>{
    if(path==='/api/sources')return source;
    if(path.includes('/head?'))return {revision:null};
    if(path.endsWith('/uploads'))return {uploadId:'generated',partBytes:4194304,parts:[]};
    if(path.includes('/parts/'))return {part:0,hash:createHash('sha256').update(body as Buffer).digest('hex'),bytes:(body as Buffer).length};
    if(path.endsWith('/commit'))return {...sourceAck(source.id,queued,'file-revision'),sha256:hash(bytes),sizeBytes:Buffer.byteLength(bytes)};
    throw Error(path);
  };
  await sync.flush(source,request);
  expect(await sync.requestSnapshotRecovery([{captureId:'00000000-0000-4000-8000-000000000035',externalId:queued.externalId,revision:queued.revision,sha256:hash(bytes),sizeBytes:Buffer.byteLength(bytes),observedAt:queued.observedAt}])).toBe(1);
  sync=new SourceSync(state);await sync.initialize();
  const retry=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,marker,sync.fileCheckpoint(),[],true);
  expect(retry.items[0].externalId).toBe(queued.externalId);await sync.stage(retry,false);
  expect(sync.pendingContent()).toHaveLength(1);
  expect(sync.pendingContent()[0]).toMatchObject({externalId:queued.externalId,revision:queued.revision,snapshotRecovery:{captureId:'00000000-0000-4000-8000-000000000035',sha256:hash(bytes)}});
  await sync.flush(source,request);
});

it('refuses an older registry without clearing its existing state',async()=>{
  const selected=join(root,'selected'),state=join(root,'state');await mkdir(selected);await writeFile(join(selected,'a.md'),'Generated old state');
  const first=await scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS),old=structuredClone(checkpoint(first));
  delete (old as {identityVersion?:number}).identityVersion;
  const sync=new SourceSync(state);await sync.initialize();await sync.stage({...first,checkpoint:old},false);
  await expect(sync.ensurePolicy('changed')).rejects.toThrow('existing source state was preserved');
  expect(sync.checkpoint()).toEqual(old);expect(sync.pendingContent()).toHaveLength(1);
  await expect(scanSourceFiles(selected,DEFAULT_SOURCE_OPTIONS,undefined,undefined,old)).rejects.toThrow('existing source state was preserved');
});
