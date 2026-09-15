import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {Indexer} from '../src/indexer.js';

const at=(second:number)=>new Date(Date.UTC(2026,8,12,1,0,second)).toISOString();
const metadata={version:1,observedAt:at(1),collector:{version:'fixture-1',method:'screen_capture'},device:{osVersion:'synthetic-os',model:'synthetic-device',timeZone:'Asia/Shanghai'},state:{batteryPercent:42,charging:false,screenLocked:false,networkType:'wifi'},capture:{intervalMs:15000}};
const event=(source='screen',overrides:Record<string,unknown>={})=>({id:randomUUID(),deviceId:'synthetic-device',deviceName:'Synthetic',platform:'macos',capturedAt:at(15),durationMs:15000,appId:'synthetic.app',appName:'Same visible name',windowTitle:source==='activity'?'':'Synthetic title',ocrText:source==='activity'?'':'Synthetic original evidence',source,privacy:{excluded:false,redacted:false,mode:'none',collection:source==='activity'?'activity':'content'},...overrides});
function fixture(t:{after(fn:()=>void):void},embeddingEnabled=false){const directory=mkdtempSync(join(tmpdir(),'mote-metadata-')),store=new Store(directory,{embeddingEnabled});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}

test('bounded observed device metadata remains distinct from capture/arrival time and round-trips unchanged',async t=>{
  const store=fixture(t),restored=fixture(t),capture=event('activity',{metadata});
  await store.ingest(capture);const saved=store.evidence([capture.id])[0];
  assert.deepEqual(saved.metadata,metadata);assert.equal(saved.capturedAt,at(15));assert.notEqual(saved.receivedAt,saved.metadata!.observedAt);
  assert.equal(saved.ocrText,'');assert.equal(saved.windowTitle,'');assert.equal(saved.blobHash,null);assert.equal(saved.indexingStatus,'text_ready');
  assert.deepEqual(store.devices()[0].metadata,metadata);
  await assert.rejects(store.ingest({...capture,metadata:{...metadata,state:{batteryPercent:43}}}),{statusCode:409});
  await store.ingest(event('screen'));assert.equal(store.list().items.find(r=>r.source==='screen')!.metadata,undefined);
  await restored.importArchive(store.exportArchive(1_000_000));assert.deepEqual(restored.evidence([capture.id])[0].metadata,metadata);
  assert.equal(restored.evidence([capture.id])[0].receivedAt,saved.receivedAt);assert.equal(restored.stats().activityEvents,1);assert.equal(restored.stats().imageCaptures,0);
  const beat={deviceId:'synthetic-device',deviceName:'Synthetic',platform:'macos' as const,status:'capturing' as const,queueDepth:0,metadata:{version:1 as const,observedAt:at(18),state:{batteryPercent:41}}};
  store.heartbeat(beat);assert.deepEqual(store.devices()[0].metadata,beat.metadata);assert.notEqual(store.devices()[0].lastSeenAt,beat.metadata.observedAt);
});

test('activity ingestion rejects any hidden content before persistence',async t=>{
  const store=fixture(t);
  for(const patch of [{ocrText:'forbidden'},{windowTitle:'forbidden'},{mood:'forbidden'},{appId:''},{privacy:{collection:'content'}},{metadata:{...metadata,state:{batteryPercent:101}}},{metadata:{...metadata,secret:'not-an-allowed-field'}},{metadata:{...metadata,capture:{width:1200,height:900}}}])await assert.rejects(store.ingest(event('activity',patch)));
  assert.equal(store.stats().captures,0);assert.equal(store.indexCounts().pending,0);
});

test('activity has no embedding work while content indexes normally; query filters remain exact and paginated',async t=>{
  const store=fixture(t,true),indexer=new Indexer(store,{embeddingBaseUrl:'https://synthetic.invalid/v1',embeddingApiKey:'',embeddingModel:'synthetic'});t.after(()=>indexer.close());
  const ids:string[]=[];for(let i=0;i<3;i++){const value=event('activity',{capturedAt:at(15+i),metadata});ids.push(value.id);await store.ingest(value);}
  const content=event('screen',{appId:'synthetic.other',capturedAt:at(20)}),legacy=event('screen',{privacy:{excluded:false,redacted:false,mode:'none'}});await store.ingest(content);await store.ingest(legacy);
  const calls:string[]=[];indexer.embed=async text=>{calls.push(text);return [1,0];};
  await indexer.tick();assert.equal(calls.length,2);assert.equal(store.pending().length,0);assert.equal(store.indexCounts().failed,0);
  assert.equal((await indexer.search({query:'Same visible name',collection:'activity',appId:'synthetic.app'})).length,3);assert.equal(calls.length,2,'Activity search must not request a model embedding');
  assert.equal(store.search({query:'original',collection:'content',appId:'synthetic.other'}).length,1);
  assert.equal(store.vectorSearch([1,0],'synthetic',{appId:'synthetic.other',collection:'content'}).length,1);
  assert.equal(store.vectorSearch([1,0],'synthetic',{collection:'activity'}).length,0);
  assert.equal(store.list({collection:'content'}).totalCount,2,'Legacy records without explicit collection remain content');
  const first=store.list({appId:'synthetic.app',source:'activity',collection:'activity',limit:2}),second=store.list({appId:'synthetic.app',source:'activity',collection:'activity',limit:2,cursor:first.nextCursor!});
  assert.equal(first.totalCount,3);assert.equal(second.totalCount,3);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,3);assert.equal(second.nextCursor,null);
  assert.equal(store.list({source:'screen',collection:'activity'}).totalCount,0);
  assert.equal(store.retryIndex().queued,2);assert.ok(store.pending().every(r=>r.source==='screen'));
  await indexer.tick();assert.equal(calls.length,4);
});

test('content and activity intervals share device deduplication before filters and retain separate app identities/counts',async t=>{
  const store=fixture(t);
  await store.ingest(event('screen',{capturedAt:at(15),appId:'app.a'}));
  await store.ingest(event('activity',{capturedAt:at(20),appId:'app.b'}));
  await store.ingest(event('activity',{capturedAt:at(20),appId:'app.b',deviceId:'second-device'}));
  await store.ingest(event('note',{capturedAt:at(18),durationMs:0}));
  const range={after:at(10),before:at(18)},all=store.activity(range),content=store.activity({...range,collection:'content'}),activity=store.activity({...range,collection:'activity'});
  assert.equal(all.totalDurationMs,16000);assert.equal(content.totalDurationMs,5000);assert.equal(activity.totalDurationMs,11000);
  assert.equal(content.totalDurationMs+activity.totalDurationMs,all.totalDurationMs);assert.equal(all.captures,3);assert.equal(all.contentCaptures,1);assert.equal(all.activityEvents,2);
  assert.equal(all.apps.length,2,'Same display names do not merge different application identities');
  assert.equal(store.activity({...range,appId:'app.b',deviceId:'synthetic-device'}).totalDurationMs,3000,'Filtering must not reassign the first app interval');
  assert.equal(store.activity({...range,source:'note'}).totalDurationMs,0);
  assert.equal(store.activity({...range,source:'screen'}).totalDurationMs,5000);
  assert.deepEqual(all.devices.map(d=>[d.contentCaptures,d.activityEvents]),[[1,1],[0,1]]);
});

test('source metadata-only revisions, deletion observation and immutable history survive archive checksum validation',async t=>{
  const store=fixture(t),sources=new SourceStore(store),restored=fixture(t),tampered=fixture(t);
  sources.register({id:'files',name:'Synthetic files',kind:'local-files',deviceId:'synthetic-files',platform:'macos'});
  const fileMetadata={version:1,file:{sizeBytes:30,createdAt:at(0),accessedAt:at(1),metadataChangedAt:at(2)}},base={externalId:'synthetic.txt',revision:'r1',observedAt:at(10),modifiedAt:at(3),title:'Synthetic file',text:'Unchanged original text',kind:'file',layer:'snapshot',metadata:fileMetadata};
  const first=await sources.upsert('files',base),secondMeta={...fileMetadata,file:{...fileMetadata.file,accessedAt:at(4)}};
  await assert.rejects(sources.upsert('files',{...base,metadata:secondMeta}),{statusCode:409});
  const second=await sources.upsert('files',{...base,revision:'r2',observedAt:at(11),metadata:secondMeta});
  assert.equal(sources.history('files',base.externalId).length,2);assert.deepEqual(store.evidence([first.id])[0].provenance!.metadata,fileMetadata);assert.deepEqual(store.evidence([second.id])[0].provenance!.metadata,secondMeta);
  const deletionMetadata={...secondMeta,file:{...secondMeta.file,deletionObservedAt:at(12)}};
  await sources.upsert('files',{...base,revision:'r3',observedAt:at(12),text:'',deleted:true,metadata:deletionMetadata});
  assert.deepEqual(sources.listItems({includeDeleted:true}).items[0].metadata,deletionMetadata);
  const archive=store.exportArchive(1_000_000);await restored.importArchive(archive);const mirror=new SourceStore(restored);
  assert.equal(mirror.history('files',base.externalId).length,3);assert.deepEqual(mirror.getItem('files',base.externalId)!.metadata,deletionMetadata);assert.equal(mirror.getItem('files',base.externalId)!.modifiedAt,at(3));
  const corrupted=structuredClone(archive);corrupted.captures[0].provenance.metadata.file.sizeBytes=999;
  await assert.rejects(tampered.importArchive(corrupted),/checksum/);assert.equal(tampered.stats().captures,0);
});

test('zero-duration observations count as samples but never consume another measured interval',async t=>{
  const store=fixture(t);await store.ingest(event('screen',{capturedAt:at(10),durationMs:0,appId:'point-only'}));
  await store.ingest(event('activity',{capturedAt:at(20),durationMs:15000,appId:'measured'}));
  assert.equal(store.activity().totalDurationMs,15000);assert.equal(store.activity({appId:'measured'}).totalDurationMs,15000);assert.equal(store.activity().captures,2);
});

 test('duplicate screenshots persist only metadata and round-trip through archives', async t=>{
  const store=fixture(t), restored=fixture(t);
  const capture=event('screen',{ocrText:'',windowTitle:'',ocr:{status:'disabled'},metadata:{...metadata,capture:{deduplication:{mode:'balanced',duplicate:true},ocrEnabled:false}}});
  await store.ingest(capture);
  const saved=store.evidence([capture.id])[0];
  assert.equal(saved.blobHash,null);assert.equal(saved.ocrText,'');assert.deepEqual(saved.metadata,capture.metadata);
  await restored.importArchive(store.exportArchive(1_000_000));
  assert.deepEqual(restored.evidence([capture.id])[0].metadata,capture.metadata);
  await assert.rejects(store.ingest({...capture,id:randomUUID(),ocrText:'content'}));
  await assert.rejects(store.ingest({...capture,id:randomUUID(),ocr:{status:'pending'}}));
 });
