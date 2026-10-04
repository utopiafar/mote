import {fixtureMemoryResult} from './fixtures/memory-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {buildApp} from '../src/app.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import type {Config} from '../src/config.js';

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-formal-material-'));
  const store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,materials:new MaterialStore(store),directory};
}
function draft(sourceId='fixture-source',externalId='fixture-session'):MaterialDraft{
  return {id:materialId(sourceId,externalId),kind:'coding.session',schemaVersion:1,title:'Synthetic coding session',
    origin:{sourceId,externalId,firstAt:'2026-09-24T01:00:00.000Z',lastAt:'2026-09-24T01:05:00.000Z'},
    members:[{id:'source-1',kind:'source-item',ref:'source-item:fixture:1',revision:'v1',locator:{message:1}}],
    blocks:[{id:'message-1',kind:'text',format:'plain',text:'Generated first message',memberIds:['source-1'],locator:{message:1}}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

test('formal material revisions are immutable, independently readable, deduplicated and CAS fenced',t=>{
  const {store,materials}=fixture(t),first=draft();
  const published=materials.publish(first);
  assert.equal(published.changed,true);
  assert.equal(materials.publish(first).changed,false);
  assert.equal(materials.get(first.id)?.revision,published.revision);
  assert.deepEqual(materials.members(published.ref).items,first.members);
  assert.equal(materials.read(published.ref,{offset:10,length:7}).text,'first m');
  assert.equal(materials.list({sourceId:'fixture-source'}).items[0]?.ref,published.ref);
  const second:MaterialDraft={...first,blocks:[first.blocks[0]!,{id:'message-2',kind:'text',format:'plain',text:'Generated second message',memberIds:['source-1']}],
    origin:{...first.origin,lastAt:'2026-09-24T01:06:00.000Z'}};
  assert.throws(()=>materials.publish(second),{statusCode:409});
  const revised=materials.publish(second,{expectedRevision:published.revision});
  assert.notEqual(revised.revision,published.revision);
  assert.equal(materials.read(published.ref).text,'Generated first message\n');
  assert.equal(materials.read(revised.ref).text,'Generated first message\nGenerated second message\n');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_block_payloads').get()!.n,2);
  assert.throws(()=>materials.publish(first,{expectedRevision:revised.revision}),{statusCode:409});
  const retired=materials.retire(first.id,{expectedRevision:revised.revision});
  assert.equal(retired.retired,true);
  assert.equal(materials.get(first.id),undefined);
  assert.equal(materials.get(published.ref),undefined);
  assert.deepEqual(materials.list().items,[]);
  assert.equal(materials.forget(first.id),true);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_block_payloads').get()!.n,0);
});

test('block paging, exact lineage and material-held assets remain bounded and survive restart',t=>{
  const {store,materials,directory}=fixture(t);
  const asset=store.assets.put(Buffer.from('Generated asset bytes'));
  const base=draft('fixture-source','long-session');
  const blocks:MaterialDraft['blocks']=Array.from({length:80},(_,i)=>({id:`message-${i}`,kind:'text',format:'plain',text:'x',memberIds:['source-1'],locator:{message:i}}));
  blocks.push({id:'original',kind:'asset',hash:asset.hash,mimeType:'text/plain',memberIds:['source-1']});
  const record=materials.publish({...base,blocks});asset.release();
  const first=materials.read(record.ref,{length:12000});
  assert.equal(first.spans.length,64);
  assert.equal(first.textRange.nextOffset,128);
  const second=materials.read(record.ref,{offset:first.textRange.nextOffset!,length:12000});
  assert.equal(second.spans.length,17);
  assert.equal(second.spans.at(-1)?.asset?.hash,asset.hash);
  assert.equal(second.textRange.nextOffset,null);
  assert.equal(materials.members(record.ref,{limit:1}).items[0]?.locator?.message,1);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM asset_references WHERE owner LIKE 'material:%'").get()!.n,1);
  const reopened=new Store(directory);t.after(()=>reopened.close());
  const restarted=new MaterialStore(reopened);
  assert.equal(restarted.read(record.ref,{offset:first.textRange.nextOffset!}).spans.at(-1)?.asset?.hash,asset.hash);
  materials.forget(base.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM asset_references WHERE owner LIKE 'material:%'").get()!.n,0);
});

test('deleting source capture purges derived material text and pinned revisions',async t=>{
  const {store,materials}=fixture(t),captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-24T01:00:00.000Z',durationMs:0,ocrText:'Generated capture text'});
  const base=draft('fixture-source','capture-dependent');
  base.members=[{id:'capture-1',kind:'capture',ref:`capture:${captureId}`,locator:{start:0,end:9}}];
  base.blocks=[{id:'body',kind:'text',format:'plain',text:'Generated capture text',memberIds:['capture-1']}];
  const record=materials.publish(base);
  store.delete(captureId);
  assert.equal(materials.get(record.ref),undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_block_payloads').get()!.n,0);
});

test('capture member text has revision-bound synthetic Memory evidence',async t=>{
  const {store,materials}=fixture(t),captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-24T01:00:00.000Z',durationMs:0,ocrText:'Generated capture original'});
  const first=draft('fixture-source','capture-evidence');
  first.members=[{id:'capture',kind:'capture',ref:`capture:${captureId}`}];
  first.blocks=[{id:'body',kind:'text',format:'plain',text:'Generated derived capture text',memberIds:['capture']}];
  const published=materials.publish(first),anchor=materials.evidenceIds(published.ref)[0]!;
  assert.ok(anchor);assert.equal(materials.isCurrentEvidence(anchor),true);
  assert.equal(materials.evidence([anchor])[0]?.ocrText,'Generated derived capture text');
  assert.deepEqual(materials.evidence([anchor])[0]?.provenance?.document,{timeBasis:'unknown',contentRole:'other'});
  assert.equal(materials.evidence([anchor])[0]?.capturedAt,published.createdAt);
  const next=materials.publish({...first,blocks:[{id:'body',kind:'text',format:'plain',text:'Revised derived capture text',memberIds:['capture']}]},
    {expectedRevision:published.revision});
  const nextAnchor=materials.evidenceIds(next.ref)[0]!;
  assert.notEqual(nextAnchor,anchor);assert.equal(materials.isCurrentEvidence(anchor),false);
  assert.equal(materials.isCurrentEvidence(nextAnchor),true);
  assert.equal(materials.read(published.ref).text,'Generated derived capture text\n');
});

test('changing only a block context invalidates its Memory, preserves other evidence and retains immutable history',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-context-')),captureId=randomUUID();
  let store=new Store(directory),materials=new MaterialStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const observedAt='2026-09-24T01:00:00.000Z',recordedAt='2026-05-01T08:00:00+08:00';
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:observedAt,durationMs:0,ocrText:'Generated original'});
  const context={observedAt,document:{recordedAt,timeBasis:'recorded' as const,contentRole:'authored' as const}};
  const value:MaterialDraft={...draft(),members:[{id:'source',kind:'capture',ref:`capture:${captureId}`}],
    blocks:[0,1].map(index=>({id:`body-${index}`,kind:'text',format:'plain',text:`Generated quote ${index}`,memberIds:['source'],evidenceContext:context}))};
  const first=materials.publish(value),old=materials.evidence(materials.evidenceIds(first.ref));
  const fingerprints=old.map(memoryEvidenceFingerprint);
  const memories=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
  const saved=old.map(record=>memories.publish(memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated',statement:`Generated supported statement [${record.id}]`,uncertainty:'Fixture only',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),
    citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()}),'fixture').items[0]!.id));
  const revised:MaterialDraft={...value,blocks:value.blocks.map((block,index)=>index===0?{...block,evidenceContext:{...context,document:{...context.document,recordedAt:'2026-05-02T08:00:00+08:00'}}}:block)};
  const second=materials.publish(revised,{expectedRevision:first.revision});
  const current=materials.evidence(materials.evidenceIds(second.ref));
  assert.equal(materials.read(first.ref).text,materials.read(second.ref).text,'raw text and quote offsets do not change');
  assert.notEqual(current[0]!.id,old[0]!.id);assert.equal(current[1]!.id,old[1]!.id);
  assert.equal(memories.get(saved[0]!.id).status,'stale');assert.equal(memories.get(saved[1]!.id).status,'published');
  assert.equal(memoryEvidenceFingerprint(current[1]!),fingerprints[1]);
  assert.equal(memoryEvidenceFingerprint(materials.evidence([old[0]!.id])[0]!),fingerprints[0]);
  assert.equal(materials.evidence([old[0]!.id])[0]!.provenance?.document?.recordedAt,recordedAt);
  assert.equal(materials.publish(revised,{expectedRevision:second.revision}).changed,false);
  store.logicalBytes();
  const accounted=store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='material_evidence_context'").get();
  assert.ok(Number(accounted?.bytes)>0,'shared storage accounting includes the provenance payload');
  store.close();store=new Store(directory);materials=new MaterialStore(store);
  assert.deepEqual(materials.evidence(current.map(record=>record.id)),current);
  store.delete(captureId);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_evidence_context').get()!.n,0,'deletion propagates to all historical contexts');
  assert.equal(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='material_evidence_context'").get()?.bytes,0);
  assert.equal(materials.evidence([...old,...current].map(record=>record.id)).length,0);
});

test('owner material API requires owner credential and serves only bounded reads',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-api-'));
  const config:Config={dataDir:directory,token:'generated-fixture-token',tokenPath:'fixture-only',host:'127.0.0.1',port:47832,
    dataKey:undefined,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const {app,store}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('unused');},close:async()=>{}}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const materials=new MaterialStore(store),record=materials.publish(draft());
  assert.equal((await app.inject(`/api/materials/${record.id}`)).statusCode,401);
  assert.equal((await app.inject('/api/materials/status')).statusCode,401);
  const headers={authorization:`Bearer ${config.token}`};
  const status=await app.inject({url:'/api/materials/status',headers});
  assert.equal(status.statusCode,200);assert.equal(typeof status.json().pendingChanges,'number');
  const read=await app.inject({url:`/api/materials/${record.id}/read?offset=10&length=7`,headers});
  assert.equal(read.statusCode,200);assert.equal(read.json().text,'first m');
  assert.equal((await app.inject({url:'/api/materials',headers})).json().items[0].ref,record.ref);
  assert.equal((await app.inject({url:`/api/materials/${record.id}/read?length=12001`,headers})).statusCode,400);
  const captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-24T01:00:00.000Z',durationMs:0,ocrText:'Generated original for two blocks'});
  const value:MaterialDraft={...draft('fixture-source','two-block-selection'),
    members:[{id:'original',kind:'capture',ref:`capture:${captureId}`}],
    blocks:[0,1].map(index=>({id:`body-${index}`,kind:'text' as const,format:'plain',text:`Generated block ${index}`,memberIds:['original']}))};
  const current=materials.publish(value),anchors=materials.evidenceIds(current.ref);
  assert.equal(anchors.length,2);
  const owner=await app.inject({url:`/api/materials/${current.id}`,headers});
  assert.deepEqual(owner.json().memorySource,{status:'ready',evidenceIds:anchors},'both current blocks belong to one explicit Material selection');
  assert.equal((await app.inject(`/api/materials/${current.id}`)).statusCode,401);
  const revised=materials.publish({...value,blocks:[value.blocks[0]!,{...value.blocks[1]!,text:'Generated revised second block'}]},
    {expectedRevision:current.revision});
  assert.deepEqual((await app.inject({url:`/api/materials/${revised.id}`,headers})).json().memorySource,
    {status:'ready',evidenceIds:materials.evidenceIds(revised.ref)});
  assert.equal((await app.inject({url:`/api/materials/${current.id}/revisions/${current.revision}`,headers})).json().memorySource,undefined,
    'historical revisions never carry a current extraction selection');
  store.invalidateMemoryEvidence(materials.evidenceIds(revised.ref)[0]!);
  assert.deepEqual((await app.inject({url:`/api/materials/${revised.id}`,headers})).json().memorySource,
    {status:'waiting',evidenceIds:[]},'an invalidated current anchor must not be offered for extraction');
});

test('source invalidation permits an identical rebuild once, preserves other anchors and stays idempotent across store instances',async t=>{
  const {store,materials}=fixture(t),ids=[randomUUID(),randomUUID()];
  for(const id of ids)await store.ingest({id,deviceId:'fixture',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-24T01:00:00Z',durationMs:0,ocrText:'Generated original'});
  const value:MaterialDraft={...draft(),members:ids.map((id,i)=>({id:`m${i}`,kind:'capture',ref:'capture:'+id})),
    blocks:ids.map((_,i)=>({id:`b${i}`,kind:'text',format:'plain',text:`Generated fact ${i}`,memberIds:[`m${i}`]}))};
  const first=materials.publish(value),[changed,stable]=materials.evidenceIds(first.ref);
  store.invalidateMemoryEvidence(ids[0]);
  assert.equal(materials.isCurrentEvidence(changed),false);assert.equal(materials.isCurrentEvidence(stable),true);
  assert.throws(()=>materials.read(first.ref),{statusCode:409});
  const reopened=new MaterialStore(store),second=reopened.publish(value,{expectedRevision:first.revision});
  assert.notEqual(second.ref,first.ref);assert.equal(second.changed,true);
  assert.equal(reopened.evidenceIds(second.ref)[1],stable);assert.notEqual(reopened.evidenceIds(second.ref)[0],changed);
  assert.equal(reopened.publish(value,{expectedRevision:second.revision}).changed,false);
  assert.equal(new MaterialStore(store).publish(value).ref,second.ref);
  assert.equal(reopened.read(first.ref).text,reopened.read(second.ref).text);
  const renamed=reopened.publish({...value,title:'New evidence context'},{expectedRevision:second.revision});
  assert.equal(reopened.isCurrentEvidence(stable),false,'changed contextual metadata cannot silently retain an old fingerprint');
  assert.ok(reopened.evidenceIds(renamed.ref).every(id=>!reopened.evidenceIds(second.ref).includes(id)));
  const illegal={...value,blocks:[{...value.blocks[0],evidenceIds:[ids[1]]}]};
  assert.throws(()=>reopened.publish(illegal,{expectedRevision:renamed.revision}),{statusCode:409});
  assert.equal(reopened.get(value.id)?.ref,renamed.ref,'invalid provenance rolls back publication');
});
