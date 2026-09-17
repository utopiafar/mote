import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extendState,captureSchema} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileEvidenceRequests} from '../src/file-evidence.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-issue3-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
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
test('indexed files require no original and on-demand reads are source-, version-, and range-bound',async t=>{
 const store=setup(t),sources=new SourceStore(store),files=new FileStore(store,sources),reads=new FileEvidenceRequests(sources);
 const source=sources.register({id:'generated-source',deviceId:'generated-device',name:'Generated files',kind:'local-files',platform:'macos',retention:'snapshot'});
 const item={externalId:'stable-file-id',revision:'version-one',observedAt:'2026-09-17T00:00:00.000Z',kind:'file',title:'Generated.txt',layer:'snapshot',text:'preview',document:{fileIndex:{version:1,fileId:'stable-file-id',contentVersion:'a'.repeat(64),mode:'index',coverage:'lightweight',parser:'utf8',status:'ready',totalCharacters:50,offset:0,length:7,allowRead:true}}};
 const ack=await files.revision({sourceId:source.id,item,sizeBytes:50},()=>{});assert.equal(files.detail(ack.id).hasOriginal,false);
 const pending=reads.read(ack.id,10,12);const request=reads.pending(source.id).items[0];assert.ok(request);assert.equal(reads.pending('generated-source').items.length,1);
 await assert.rejects(reads.complete('another-source',request.id,{status:'ready',text:'secret',contentVersion:'a'.repeat(64)}),{statusCode:404});
 await assert.rejects(reads.complete(source.id,request.id,{status:'ready',text:'wrong version',contentVersion:'b'.repeat(64)}),{statusCode:409});
 await reads.complete(source.id,request.id,{status:'ready',text:'exact text',contentVersion:'a'.repeat(64)});const result=await pending;assert.equal(result.status,'ready');assert.equal(result.record.ocrText,'exact text');assert.equal(result.record.provenance.document.fileIndex.offset,10);
 const excerpt=result.record.id;assert.ok(store.isCurrentEvidence(excerpt));
 await files.revision({sourceId:source.id,previousRevision:'version-one',item:{...item,revision:'version-two',observedAt:'2026-09-17T00:00:01.000Z'},sizeBytes:50},()=>{});
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
