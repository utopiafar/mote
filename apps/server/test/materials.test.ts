import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {buildApp} from '../src/app.js';
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
});
