import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extendState,captureSchema} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileEvidence} from '../src/file-evidence.js';
import {FileProcessing} from '../src/file-processing.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-issue3-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
async function snapshot(files:FileStore,text:string,previousRevision:string|null=null){
 const bytes=Buffer.from(text),hash=sha256(bytes),manifest={sourceId:files.sources.listSources()[0].id,previousRevision,sizeBytes:bytes.length,sha256:hash,relativePath:'generated.txt',item:{externalId:'generated-file',revision:hash,observedAt:'2026-09-17T00:00:00Z',kind:'file',title:'Generated.txt',layer:'snapshot',text:'',mimeType:'text/plain',document:{fileIndex:{version:1,fileId:'generated-file',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:true}}}};
 const session=files.begin(manifest,()=>{});files.part(session.uploadId,0,bytes,()=>{});return files.commit(session.uploadId,()=>{});
}
const event=(at:string,durationMs=5000)=>captureSchema.parse({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated',platform:'macos',source:'activity',appId:'fixture.app',appName:'Fixture',capturedAt:at,durationMs,privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
test('same state has one row, precise disjoint durations, monotonic retry and conflict protection',async t=>{
 const store=setup(t);const first=extendState(undefined,event('2026-09-17T00:00:00.000Z',0));const next=extendState(first,event('2026-09-17T00:00:05.000Z'));const third=extendState(next,event('2026-09-17T00:00:20.000Z'));
 await store.ingest(first);await store.ingest(third);await store.ingest(next);
 assert.equal(store.list({after:'2026-09-17T00:00:03.000Z',before:'2026-09-17T00:00:18.000Z'}).items.length,1);
 assert.equal(store.stats().captures,1);assert.equal(store.evidence([first.id])[0].stateSeries?.samples.length,3);
 assert.equal(store.activity().totalDurationMs,10000);
 assert.equal(store.activity({after:'2026-09-17T00:00:03.000Z',before:'2026-09-17T00:00:18.000Z'}).totalDurationMs,5000);
 await assert.rejects(store.ingest({...third,appName:'forged'}),{statusCode:409});
 await assert.rejects(store.ingest({...third,stateSeries:{version:1,samples:[...third.stateSeries!.samples].reverse()}}));
 store.delete(first.id);await assert.rejects(store.ingest(third),{statusCode:410});
});
test('central text ranges require no original and remain source-, version-, and range-bound',async t=>{
 const store=setup(t),sources=new SourceStore(store),files=new FileStore(store,sources),reads=new FileEvidence(sources),processing=new FileProcessing(files);t.after(()=>processing.close());
 sources.register({id:'generated-source',deviceId:'generated-device',name:'Generated files',kind:'local-files',platform:'macos',retention:'snapshot'});
 const text='Generated exact text and range evidence',ack=await snapshot(files,text);await processing.tick();assert.equal(files.detail(ack.id).hasOriginal,false);
 const result=await reads.read(ack.id,10,10);assert.equal(result.status,'ready');assert.equal(result.record!.ocrText,text.slice(10,20));assert.equal(result.record!.provenance!.document!.fileIndex!.offset,10);
 assert.equal((await reads.read(ack.id,10,10)).record!.id,result.record!.id,'repeated ranges reuse the immutable excerpt');
 await assert.rejects(reads.read(ack.id,0,16001));await assert.rejects(reads.read(ack.id,-1,5));
 const excerpt=result.record!.id;assert.ok(store.isCurrentEvidence(excerpt));assert.deepEqual(store.db.prepare('SELECT parent_id,capture_id FROM file_evidence_links').all().map(row=>({...row})),[{parent_id:ack.id,capture_id:excerpt}]);
 sources.update('generated-source',{retention:'reference'});await assert.rejects(reads.read(ack.id,0,5),{statusCode:409});sources.update('generated-source',{retention:'snapshot'});
 await snapshot(files,'Generated successor text',sha256(Buffer.from(text)));
 assert.equal(store.isCurrentEvidence(excerpt),false);await assert.rejects(reads.read(ack.id,0,5),{statusCode:409});
});
test('time-range diagnostic export reads all disk events beyond the memory display cap',async t=>{
 const store=setup(t),log=new ServerDiagnostics({directory:join(store.directory,'logs'),maxEntries:10,maxBytes:1048576});await log.init();t.after(()=>log.close());
 for(let i=0;i<610;i++){log.record('request.completed',{count:i});if(i%5===0)await log.flush();}await log.flush();
 assert.equal(log.recent(500).length,10);const report=await log.exportRange('2020-01-01T00:00:00.000Z','2100-01-01T00:00:00.000Z');assert.equal(report.events.length,610);assert.equal(report.events[609].count,609);assert.equal(report.retentionLimited,true);
});

test('state compaction retains changing telemetry and normalizes all sample times',async t=>{
 const store=setup(t);const a=event('2026-09-17T00:00:00Z',0),b=event('2026-09-17T00:00:05Z');
 a.metadata={version:1,observedAt:a.capturedAt,state:{idleSeconds:0,availableStorageBytes:900}};b.metadata={version:1,observedAt:b.capturedAt,state:{idleSeconds:5,availableStorageBytes:800}};
 const merged=extendState(extendState(undefined,a),b);assert.equal(merged.stateSeries?.samples.length,2);assert.equal(merged.stateSeries?.samples[1].availableStorageBytes,800);
 await store.ingest(merged);const stored=store.evidence([a.id])[0];const {receivedAt,blobHash,imageMime,indexingStatus,...raw}=stored;captureSchema.parse(raw);
});

test('central retained text and immutable excerpts survive restart and reject permission changes',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-read-restart-'));let store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),reads=new FileEvidence(sources);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'restart-source',deviceId:'synthetic',name:'Generated',kind:'local-files',platform:'macos',retention:'snapshot'});
 const text='Generated restart text range',ack=await snapshot(files,text),processing=new FileProcessing(files);try{await processing.tick();}finally{await processing.close();}
 const first=await reads.read(ack.id,10,12);assert.equal(first.record!.ocrText,text.slice(10,22));
 store.close();store=new Store(directory);sources=new SourceStore(store);files=new FileStore(store,sources);reads=new FileEvidence(sources);
 const restored=await reads.read(ack.id,10,12);assert.equal(restored.record!.id,first.record!.id);assert.equal(restored.record!.ocrText,text.slice(10,22));
 assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_read_requests'").get(),undefined);
 sources.update('restart-source',{enabled:false});await assert.rejects(reads.read(ack.id,10,12),{statusCode:409});
});


test('revocation or deletion during an asynchronous range write cannot publish late evidence',async t=>{
 for(const revoke of ['pause','delete'] as const)await t.test(revoke,async t=>{
  const store=setup(t),sources=new SourceStore(store),files=new FileStore(store,sources),reads=new FileEvidence(sources),processing=new FileProcessing(files);t.after(()=>processing.close());
  sources.register({id:'range-race',deviceId:'generated',name:'Generated',kind:'local-files',platform:'macos',retention:'snapshot'});
  const ack=await snapshot(files,'Generated asynchronous range evidence');await processing.tick();
  const pending=reads.read(ack.id,0,9);
  if(revoke==='pause')sources.update('range-race',{enabled:false});else store.delete(ack.id);
  await assert.rejects(pending,{statusCode:revoke==='pause'?409:404});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_evidence_links').get()!.n,0);
  assert.equal(sources.listItems({sourceId:'range-race'}).items.filter(item=>item.externalId.includes(':excerpt:')).length,0);
 });
});
