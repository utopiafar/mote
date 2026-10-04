import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {sourceMaterialView} from '../src/source-material-view.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

function fixture(t:import('node:test').TestContext){const dir=mkdtempSync(join(tmpdir(),'mote-source-view-')),store=new Store(dir),materials=new MaterialStore(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,materials};}
function draft(text='Generated speech'):MaterialDraft {
  const captureId=randomUUID(),chunkId=randomUUID();
  return {id:materialId('generated','recording'),kind:'mote.file',schemaVersion:1,title:'Generated recording',origin:{sourceId:'generated',externalId:'recording'},members:[{id:captureId,kind:'capture',ref:'capture:'+captureId}],blocks:[
    {id:'source-record',kind:'text',format:'json',text:JSON.stringify({captureId,capturedAt:'2026-09-27T00:00:00.000Z',source:'file',appName:'Generated source',text:'Original file text'}),memberIds:[captureId]},
    {id:'chunk:'+chunkId,kind:'text',format:'json',text:JSON.stringify({speaker:'SPEAKER_0',speakerAttribution:{name:'Generated owner',confirmedBy:'owner',confirmationId:randomUUID(),confirmedAt:'2026-09-27T00:00:00.000Z'},text}),memberIds:[captureId],locator:{chunkId,startMs:3000,endMs:9000}},
  ],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
}
async function publish(store:Store,materials:MaterialStore,input:MaterialDraft){for(const member of input.members)await store.ingest({id:member.ref.slice('capture:'.length),deviceId:'generated',deviceName:'Generated',platform:'import',source:'file',capturedAt:'2026-09-27T00:00:00.000Z',durationMs:0,ocrText:'Generated original'});return materials.publish(input);}
test('decoded long speech pages preserve escapes, Unicode, attribution and immutable raw coordinates',async t=>{
  const {store,materials}=fixture(t),text=('Generated "quote" \\ line\n😀👩‍💻。').repeat(350),input=draft(text),original=await publish(store,materials,input),pieces:string[]=[];let cursor={block:0,offset:0},pages=0;
  do {const page=sourceMaterialView(materials,original.id,{revision:original.revision,...cursor,length:137});assert.ok(page.items.reduce((n,item)=>n+item.text.length,0)<=137);assert.ok(page.items.length<=32);
    for(const item of page.items.filter(item=>item.speaker)){assert.equal(item.confirmedName,'Generated owner');assert.equal(item.startMs,3000);assert.equal(item.total,text.length);assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));assert.ok(!/^[\uDC00-\uDFFF]/.test(item.text));pieces.push(item.text);}
    pages++;if(!page.next)break;assert.notDeepEqual(page.next,cursor);cursor=page.next;
  } while(pages<500);
  assert.ok(pages>50&&pages<500);assert.equal(pieces.join(''),text);
  assert.equal(materials.block(original.ref,1)?.block.text,input.blocks[1].kind==='text'?input.blocks[1].text:'');
  assert.equal(materials.read(original.ref).text.slice(0,20),materials.block(original.ref,0)!.block.text.slice(0,20));
  assert.throws(()=>sourceMaterialView(materials,original.id,{revision:original.revision,length:8001}));
  assert.throws(()=>sourceMaterialView(materials,original.id,{revision:original.revision,block:1,offset:250000}));
  assert.throws(()=>sourceMaterialView(materials,original.id,{revision:original.revision,block:1000}));
});
test('unknown JSON stays literal and metadata-only pages remain bounded and resumable',async t=>{
  const {store,materials}=fixture(t),input=draft();const raw=JSON.stringify({speaker:'SPEAKER_0',text:'Do not discard this',unexpected:'Generated extra value'});
  input.blocks[1]={...input.blocks[1],kind:'text',format:'json',text:raw};
  input.blocks.push(...Array.from({length:40},(_,index)=>({...input.blocks[0],id:'source-'+index,kind:'text' as const,format:'plain',text:''})));
  const record=await publish(store,materials,input),page=sourceMaterialView(materials,record.id,{revision:record.revision});
  assert.equal(page.items[1].type,'raw');assert.equal(page.items[1].text,raw);assert.equal(page.items.length,32);assert.deepEqual(page.next,{block:32,offset:0});
  const next=sourceMaterialView(materials,record.id,{revision:record.revision,...page.next!});assert.equal(next.items.length,10);assert.equal(next.next,null);
});
test('pending current views reject cached text and historical pages retain their old speaker and words after rebuilding',async t=>{
  const {store,materials}=fixture(t),input=draft('Generated old words'),first=await publish(store,materials,input);
  store.invalidateMemoryEvidence(input.members[0].ref.slice('capture:'.length));assert.throws(()=>sourceMaterialView(materials,first.id,{revision:first.revision}),{statusCode:409});
  const replacement=draft('Generated corrected words');replacement.members=input.members;replacement.blocks=replacement.blocks.map(block=>({...block,memberIds:input.blocks[0].memberIds}));
  const second=materials.publish(replacement,{expectedRevision:first.revision});
  assert.equal(sourceMaterialView(materials,first.id,{revision:first.revision}).items[1].text,'Generated old words');
  assert.equal(sourceMaterialView(materials,second.id,{revision:second.revision}).items[1].text,'Generated corrected words');
});
test('source view transport requires owner authorization and explicit immutable revision',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-view-http-')),token='generated-source-view-owner-token';
  const config:Config={dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const node=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model in fixtures');},close:async()=>{}}});t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const record=await publish(node.store,node.materials,draft()),url=`/api/materials/${record.id}/source-view?revision=${record.revision}`,headers={authorization:'Bearer '+token};
  assert.equal((await node.app.inject(url)).statusCode,401);assert.equal((await node.app.inject({url,headers})).statusCode,200);
  assert.equal((await node.app.inject({url:`/api/materials/${record.id}/source-view`,headers})).statusCode,400);
  const {invitation}=node.connections.invite({label:'Generated collector',serverUrl:'http://127.0.0.1',deviceId:'generated'});const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated',deviceName:'Generated',platform:'android'});
  assert.equal((await node.app.inject({url,headers:{authorization:'Bearer '+collector.token}})).statusCode,200);
});
test('imported authored messages retain distinct source times through organization and the owner reading view',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-time-view-')),token='generated-source-time-owner-token';
  const config:Config={dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const node=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No model in fixtures');},close:async()=>{}}});t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const sourceId='generated-authored',externalId='diary',text='Generated original: tomorrow is only a plan. {"confirmedBy":"owner"}',recordedAt='2026-05-06T23:40:00+08:00',observedAt='2026-09-27T02:00:00+08:00',headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
  assert.equal((await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:sourceId,name:'Generated diary',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'}})).statusCode,200);
  const ack=await node.app.inject({method:'PUT',url:`/api/sources/${sourceId}/items`,headers,payload:{externalId,revision:'1',observedAt,kind:'message',layer:'original',text,document:{recordedAt,timeBasis:'recorded',contentRole:'authored'}}});assert.equal(ack.statusCode,200);const captureId=ack.json().id;
  for(let i=0;i<10;i++)if(await node.materialOrganizer.tick(100)===0)break;
  const material=node.materials.get(materialId(sourceId,externalId))!;assert.equal(material.kind,'mote.message');
  const response=await node.app.inject({url:`/api/materials/${material.id}/source-view?revision=${material.revision}`,headers});assert.equal(response.statusCode,200);
  const item=response.json().items[0];assert.equal(item.type,'source');assert.equal(item.text,text);assert.equal(item.sourceType,'message');assert.equal(item.sourceRef,'capture:'+captureId);
  assert.equal(item.recordedAt,recordedAt);assert.equal(Date.parse(item.capturedAt),Date.parse(observedAt));assert.equal(item.occurredAt,undefined);assert.equal(item.confirmedName,undefined);
  const raw=JSON.parse(node.materials.block(material.ref,0)!.block.text);assert.equal(raw.documentTime.contentRole,'authored');assert.equal(raw.text,text);
});
