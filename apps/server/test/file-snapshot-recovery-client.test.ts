import {afterEach,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalSourceManager} from '../../desktop/src/source-manager.js';
import {defaultConfig} from '../../desktop/src/config.js';
import {DEFAULT_SOURCE_OPTIONS,type SourceOptions} from '../../desktop/src/source-types.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

// Real Desktop manual discovery/outbox/upload and Central routes/pipeline.
// All bytes and credentials are generated fixtures; no live model or ASR.
let root:string,selected:string,node:Awaited<ReturnType<typeof buildApp>>,managers:LocalSourceManager[];
let paths:string[],loseCommitAck:boolean;
const token='generated-cross-end-recovery-owner',headers={authorization:'Bearer '+token};
const originalFetch=globalThis.fetch;
beforeEach(async()=>{
 root=await realpath(await mkdtemp(join(tmpdir(),'mote-cross-end-recovery-')));selected=join(root,'authorized');await mkdir(selected);await writeFile(join(selected,'generated.txt'),'Generated current snapshot');managers=[];paths=[];loseCommitAck=false;
 const config:Config={dataDir:join(root,'central'),token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,dataKey:undefined,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model is authorized for generated recovery fixtures');},close:async()=>{}}});await node.app.ready();
 globalThis.fetch=async(url:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(url)).pathname+new URL(String(url)).search;paths.push(path);
  init?.signal?.throwIfAborted();const h=Object.fromEntries(new Headers(init?.headers).entries());
  const body=init?.body===undefined?undefined:Buffer.from(await new Response(init.body).arrayBuffer());
  const payload=body===undefined?undefined:h['content-type']?.startsWith('application/octet-stream')?body:JSON.parse(body.toString());
  const response=await node.app.inject({method:(init?.method??'GET') as any,url:path,headers:h,...(payload===undefined?{}:{payload})});
  if(loseCommitAck&&path.endsWith('/commit')&&response.statusCode===200){loseCommitAck=false;throw Error('Generated lost ACK after durable commit');}
  return new Response(response.rawPayload,{status:response.statusCode,headers:{'content-type':String(response.headers['content-type']??'application/json')}});
 };
});
afterEach(async()=>{for(const manager of managers)await manager.close();await node?.app.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});});
async function manager(){const value=new LocalSourceManager(join(root,'desktop'),{...defaultConfig(),deviceId:'bf07fd16-109f-47f9-b4f0-daf02649060d',serverUrl:'http://127.0.0.1:47832',token,syncMode:'manual'},'/never-real-calendar',true);managers.push(value);await value.initialize();return value;}
async function firstUpload(options:SourceOptions=DEFAULT_SOURCE_OPTIONS){const value=await manager();await value.addFiles(selected,options);await value.sync(true);assert.equal(paths.length,0,'manual local discovery cannot request recovery or transmit');assert.equal(value.pendingStats().pendingRecords,1);await value.flushPending(new AbortController().signal);assert.equal(value.pendingStats().pendingRecords,0);const sourceId=value.status()[0].source.id;const rows=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions').all();assert.equal(rows.length,1);const id=String(rows[0].capture_id),manifest=String(rows[0].manifest);return {value,sourceId,id,manifest,input:JSON.parse(manifest)};}
function expire(id:string){node.store.db.prepare('UPDATE file_snapshot_inputs SET expires=0 WHERE capture_id=?').run(id);node.files.sweepSnapshotInputs();}
function identity(id:string,manifest:string){assert.deepEqual(node.store.db.prepare('SELECT capture_id,manifest FROM file_versions').all().map(row=>({...row})),[{capture_id:id,manifest}]);assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM captures').get()!.n,1);}
async function recover(value:LocalSourceManager){const before=paths.length;await value.sync(true);assert.equal(paths.length,before,'manual local scan must stay offline');await value.flushPending(new AbortController().signal);assert.equal(value.pendingStats().pendingRecords,0);}

test('Desktop manual sync restores expired bytes under the same capture/revision/time and never replays completed processing',async()=>{
 const first=await firstUpload();expire(first.id);await node.processing.tick();assert.equal(node.files.detail(first.id).job!.state,'blocked');assert.equal(node.files.detail(first.id).job!.error,'snapshot_input_expired');
 await first.value.close();const restarted=await manager();await recover(restarted);identity(first.id,first.manifest);
 assert.ok(paths.includes('/api/file-sync/v1/recovery?sourceId='+first.sourceId));assert.ok(paths.includes('/api/file-sync/v1/recovery/'+first.id+'/uploads'));
 assert.equal(Buffer.concat([...node.files.processingBytes(first.id)]).toString(),'Generated current snapshot');await node.processing.tick();assert.equal(node.files.detail(first.id).job!.state,'succeeded');assert.equal(node.files.chunks(first.id)[0].ocrText,'Generated current snapshot');
 const completed=node.store.db.prepare('SELECT id,state,attempts FROM execution_steps WHERE operation_id=? ORDER BY id').all('file:'+first.id),recoveryCalls=paths.filter(path=>path.includes('/recovery/')&&path.endsWith('/uploads')).length;
 await restarted.sync(true);await restarted.flushPending(new AbortController().signal);await node.processing.tick();identity(first.id,first.manifest);assert.equal(restarted.pendingStats().pendingRecords,0);
 assert.equal(paths.filter(path=>path.includes('/recovery/')&&path.endsWith('/uploads')).length,recoveryCalls);assert.deepEqual(node.store.db.prepare('SELECT id,state,attempts FROM execution_steps WHERE operation_id=? ORDER BY id').all('file:'+first.id),completed);assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);
});

test('Desktop lost ACK plus expired input reuses the immutable pending version without a second capture',async()=>{
 const value=await manager();await value.addFiles(selected,DEFAULT_SOURCE_OPTIONS);await value.sync(true);loseCommitAck=true;await assert.rejects(value.flushPending(new AbortController().signal),/lost ACK/);assert.equal(value.pendingStats().pendingRecords,1);
 const first=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions').get()!;const id=String(first.capture_id),manifest=String(first.manifest);expire(id);await node.processing.tick();await value.close();
 const restarted=await manager();await restarted.sync(true);assert.equal(restarted.pendingStats().pendingRecords,1);await restarted.flushPending(new AbortController().signal);identity(id,manifest);assert.equal(restarted.pendingStats().pendingRecords,0);await node.processing.tick();assert.equal(node.files.detail(id).job!.state,'succeeded');
});

test('Desktop manual sync cannot restart cancellation; only explicit owner retry permits same-capture resupply',async()=>{
 const first=await firstUpload();const cancelled=await node.app.inject({method:'POST',url:'/api/files/'+first.id+'/cancel',headers,payload:{}});assert.equal(cancelled.statusCode,200);assert.equal(node.files.detail(first.id).job!.state,'cancelled');
 const before=paths.length;await first.value.sync(true);await first.value.flushPending(new AbortController().signal);await node.processing.tick();identity(first.id,first.manifest);assert.equal(first.value.pendingStats().pendingRecords,0);assert.equal(node.files.detail(first.id).job!.state,'cancelled');assert.equal(paths.slice(before).some(path=>path.includes('/recovery/')&&path.endsWith('/uploads')),false);
 const retry=await node.app.inject({method:'POST',url:'/api/files/'+first.id+'/retry',headers,payload:{}});assert.equal(retry.statusCode,200);await recover(first.value);identity(first.id,first.manifest);await node.processing.tick();assert.equal(node.files.detail(first.id).job!.state,'succeeded');
});

test('a revoked source cannot restore expired input through Desktop manual sync',async()=>{
 const first=await firstUpload();expire(first.id);await node.processing.tick();node.sources.update(first.sourceId,{enabled:false});const before=paths.length;
 await first.value.sync(true);await first.value.flushPending(new AbortController().signal);await node.processing.tick();identity(first.id,first.manifest);assert.equal(first.value.pendingStats().pendingRecords,0);assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(node.files.chunks(first.id).length,0);assert.equal(paths.slice(before).some(path=>path.includes('/recovery/')&&path.endsWith('/uploads')),false);
});

test('narrowing read permission creates a current restricted revision and ignores retired lightweight limits',async()=>{
 const first=await firstUpload({...DEFAULT_SOURCE_OPTIONS,allowRead:true,indexMode:'full'});expire(first.id);await node.processing.tick();assert.equal(first.input.item.document.fileIndex.allowRead,true);
 const before=paths.length,selectedSource=first.value.status()[0].source;
 await first.value.update(first.sourceId,{...selectedSource,allowRead:false,indexMode:'lightweight'});await first.value.sync(true);assert.equal(first.value.pendingStats().pendingRecords,1);await first.value.flushPending(new AbortController().signal);
 const rows=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions ORDER BY rowid').all();assert.equal(rows.length,2);const current=rows[1],manifest=JSON.parse(String(current.manifest));assert.notEqual(current.capture_id,first.id);assert.notEqual(manifest.item.revision,first.input.item.revision);assert.equal(manifest.previousRevision,first.input.item.revision);assert.equal(manifest.sha256,first.input.sha256);
 assert.equal(manifest.item.document.fileIndex.allowRead,false);assert.equal(manifest.item.document.fileIndex.maxIndexCharacters,100000);assert.equal(node.sources.getItem(first.sourceId,manifest.item.externalId)!.captureId,current.capture_id);assert.equal(paths.slice(before).some(path=>path.includes('/recovery/')&&path.endsWith('/uploads')),false);
 await node.processing.tick();assert.equal(node.files.detail(String(current.capture_id)).job!.state,'succeeded');assert.equal(node.store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.equal(node.files.chunks(first.id).length,0);
});

test('same inode metadata rename creates a successor snapshot instead of settling an expired version',async()=>{
 const {rename,stat}=await import('node:fs/promises');
 // The direct sync path scans before asking for recovery, then stages the scan.
 // It must preserve a metadata change even when the remote request matches bytes.
 for(const managedUploads of [false,true]){
  const selectedPath=managedUploads?join(root,'authorized-managed'):selected;if(managedUploads){await mkdir(selectedPath);await writeFile(join(selectedPath,'generated.txt'),'Generated current snapshot');}
  const value=new LocalSourceManager(join(root,managedUploads?'desktop-managed':'desktop'),{...defaultConfig(),deviceId:'bf07fd16-109f-47f9-b4f0-daf02649060d',serverUrl:'http://127.0.0.1:47832',token,syncMode:'manual'},'/never-real-calendar',managedUploads);managers.push(value);await value.initialize();await value.addFiles(selectedPath,DEFAULT_SOURCE_OPTIONS);const firstStart=paths.length;await value.sync(true);
  if(managedUploads){assert.equal(paths.length,firstStart,'UI local discovery has no transport before explicit flush');assert.equal(value.pendingStats().pendingRecords,1);await value.flushPending(new AbortController().signal);}
  assert.equal(value.pendingStats().pendingRecords,0);const sourceId=value.status()[0].source.id,first=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions WHERE source_id=?').get(sourceId)!,firstId=String(first.capture_id),firstManifest=String(first.manifest),input=JSON.parse(firstManifest);expire(firstId);await node.processing.tick();
  const originalPath=join(selectedPath,'generated.txt'),renamedPath=join(selectedPath,'renamed-generated.txt'),before=await stat(originalPath);await rename(originalPath,renamedPath);const after=await stat(renamedPath);assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
  const start=paths.length;await value.sync(true);if(managedUploads){assert.equal(paths.length,start,'UI rename discovery remains local');assert.equal(value.pendingStats().pendingRecords,1);await value.flushPending(new AbortController().signal);}assert.equal(value.pendingStats().pendingRecords,0);
  const rows=node.store.db.prepare('SELECT capture_id,manifest FROM file_versions WHERE source_id=? ORDER BY rowid').all(sourceId);assert.equal(rows.length,2,'unchanged bytes must not swallow changed file metadata');
  assert.equal(rows[0].manifest,firstManifest);const current=rows[1],next=JSON.parse(String(current.manifest));assert.notEqual(current.capture_id,firstId);assert.notEqual(next.item.revision,input.item.revision);assert.equal(next.previousRevision,input.item.revision);assert.equal(next.sha256,input.sha256);assert.equal(next.item.externalId,input.item.externalId);assert.equal(next.item.title,'renamed-generated.txt');assert.ok(next.item.uri.endsWith('/renamed-generated.txt'));
  assert.equal(paths.slice(start).some(path=>path.includes('/recovery/')&&path.endsWith('/uploads')),false,'changed metadata uses an ordinary successor manifest');
  await node.processing.tick();assert.equal(node.files.detail(String(current.capture_id)).job!.state,'succeeded');assert.equal(node.sources.getItem(next.sourceId,next.item.externalId)!.captureId,current.capture_id);
 }
});
