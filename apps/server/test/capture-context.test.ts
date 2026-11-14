import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureSchema,uiPageText,type UiPageV3} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {captureContextMembers,captureContextSourceId,readCaptureContext,updateCaptureContext} from '../src/capture-context.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {structuredObject} from './fixtures/structured-page.js';

const at='2026-10-01T00:00:00.000Z';
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-capture-context-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,sources,materials};
}
function capture(source:'screen'|'ui_page'|'activity'|'notification',deviceId='generated-phone'){
  const base={id:randomUUID(),deviceId,deviceName:'Generated device',platform:'android',source,capturedAt:at,durationMs:0,appId:'generated.same-app',appName:'Generated app'};
  if(source==='screen')return captureSchema.parse({...base,ocrText:'Generated screen text'});
  if(source==='activity')return captureSchema.parse({...base,durationMs:1000,privacy:{collection:'activity'},metadata:{version:1,observedAt:at}});
  if(source==='notification')return captureSchema.parse({...base,metadata:{version:1,observedAt:at,collector:{method:'notification_listener'},observation:{sessionId:randomUUID(),elapsedRealtimeMs:1000},notification:{action:'posted',notificationKey:'42'.repeat(32),postedAt:at,ongoing:false,groupSummary:false,text:'Generated notification'}}});
  const page:UiPageV3={version:3,scope:'visible_window',adapterId:'generated.fields',adapterVersion:'1',appVersion:'1',activity:'fixture.Page',status:'ok',truncated:false,observations:{firstAt:at,lastAt:at,count:1},objects:[structuredObject({kind:'article',title:'Generated article',body:[{text:'Generated page text'}]})]};
  return captureSchema.parse({...base,ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page}});
}
function draft(ids:string[]):MaterialDraft{
  const sourceId='generated-mixed-channel',externalId='generated-members';return {id:materialId(sourceId,externalId),origin:{sourceId,externalId},title:'Generated mixed channels',kind:'mote.note',schemaVersion:1,
    members:ids.map(id=>({id,kind:'capture',ref:'capture:'+id})),blocks:ids.map((id,index)=>({id:'body-'+index,kind:'text',format:'plain',text:'Generated independent member',memberIds:[id],evidenceContext:{observedAt:at,document:{}}})),artifacts:[],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
const reseal=(archive:{materials?:unknown})=>{const section=archive.materials as Record<string,unknown>,{checksum:_,...body}=section;const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;section.checksum=sha256(JSON.stringify(canonical(body)));};

test('channel attribution follows only exact linked originals without scanning the capture archive',async t=>{
  const f=fixture(t),screen=capture('screen'),activity=capture('activity'),other=capture('screen','generated-other-device');
  for(const input of [screen,activity,other])await f.store.ingest(input);
  for(let index=0;index<256;index++)await f.store.ingest(capture('screen','generated-unrelated-'+index));
  const screenContext=updateCaptureContext(f.store,f.sources,screen.deviceId,'screen',{expectedVersion:0,description:'Generated screen scope'});
  const activityContext=updateCaptureContext(f.store,f.sources,activity.deviceId,'activity',{expectedVersion:0,description:'Generated activity scope'});
  updateCaptureContext(f.store,f.sources,other.deviceId,'screen',{expectedVersion:0,description:'Generated unrelated scope'});
  const middle=randomUUID(),leaf=randomUUID(),link=f.store.db.prepare('INSERT INTO file_evidence_links VALUES(?,?)');
  link.run(screen.id,middle);link.run(activity.id,middle);link.run(middle,leaf);link.run(leaf,middle);
  const prepare=f.store.db.prepare.bind(f.store.db);let sql='';
  const spy=t.mock.method(f.store.db,'prepare',(statement:string)=>{if(statement.includes('WITH RECURSIVE originals')&&statement.includes('JOIN captures'))sql=statement;return prepare(statement);});
  const selected=[leaf,leaf,randomUUID()],groups=captureContextMembers(f.store,selected);spy.mock.restore();
  assert.deepEqual([...groups],[ [screenContext.sourceId,[screen.id]], [activityContext.sourceId,[activity.id]] ].sort((a,b)=>String(a[1]).localeCompare(String(b[1]))));
  assert.ok(sql,'inspect the query actually used by the attribution reader');
  const plan=prepare('EXPLAIN QUERY PLAN '+sql).all(JSON.stringify(selected),JSON.stringify(selected)).map(row=>String(row.detail));
  assert.ok(plan.some(detail=>/SEARCH c USING (?:INDEX|PRIMARY KEY)/.test(detail)),`look up each exact original by identity: ${plan.join('; ')}`);
  assert.ok(!plan.some(detail=>/\bSCAN c\b/.test(detail)),`unrelated captures must not be scanned on every Memory guard: ${plan.join('; ')}`);
  f.store.delete(screen.id);
  assert.deepEqual([...captureContextMembers(f.store,selected)],[],'deleting an original also retires its linked descendants');
  assert.deepEqual([...captureContextMembers(f.store,[activity.id])],[[activityContext.sourceId,[activity.id]]],'the independent original remains available');
});

test('four explicit channel descriptions cover existing and future originals without crossing device or channel',async t=>{
  const f=fixture(t),types={screen:'screen',structured:'ui_page',activity:'activity',notifications:'notification'} as const;
  const old=new Map<string,string>();
  for(const [channel,source] of Object.entries(types)){const input=capture(source);await f.store.ingest(input);old.set(channel,input.id);}
  const untouchedDevice=capture('screen','generated-other-device');await f.store.ingest(untouchedDevice);
  const devices=f.store.devices(),before=f.store.db.prepare('SELECT json FROM captures ORDER BY id').all();
  for(const channel of Object.keys(types) as Array<keyof typeof types>){
    const prior=readCaptureContext(f.store,f.sources,'generated-phone',channel);assert.equal(prior.version,0);
    const description=`Generated ${channel} owner scope`,saved=updateCaptureContext(f.store,f.sources,'generated-phone',channel,{expectedVersion:0,description});
    assert.equal(saved.sourceId,captureContextSourceId(types[channel],'generated-phone'));
    for(const id of [old.get(channel)!,(await f.store.ingest(capture(types[channel]))).id]){
      const context=f.materials.contextForEvidence(f.store.evidence([id])[0]);assert.deepEqual(context.sourceContextStatements,[{sourceId:saved.sourceId,version:1,description,captureIds:[id]}]);assert.equal(context.ownerRelation,'unknown');
    }
  }
  assert.deepEqual(f.store.db.prepare('SELECT json FROM captures WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').all(JSON.stringify([...old.values(),untouchedDevice.id])),before);
  assert.deepEqual(f.store.devices(),devices,'editing context does not change device capture, connection or send state');
  assert.equal(f.materials.contextForEvidence(f.store.evidence([untouchedDevice.id])[0]).sourceContextStatements,undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
});

test('source-only descriptions narrow mixed material blocks and invalidate only affected current context on clear',async t=>{
  const f=fixture(t),screen=capture('screen'),activity=capture('activity');await f.store.ingest(screen);await f.store.ingest(activity);
  const material=f.materials.publish(draft([screen.id,activity.id]));
  const first=updateCaptureContext(f.store,f.sources,screen.deviceId,'screen',{expectedVersion:0,description:'Generated screen scope'});
  const second=updateCaptureContext(f.store,f.sources,screen.deviceId,'activity',{expectedVersion:0,description:'Generated activity scope'});
  let current=f.materials.get(material.id)!;assert.equal(current.attributionContext?.sourceContextStatements?.length,2);
  const spans=f.materials.read(current.ref).spans;assert.deepEqual(spans[0].attributionContext.sourceContextDeclarations?.map(pin=>pin.sourceId),[first.sourceId]);assert.deepEqual(spans[1].attributionContext.sourceContextDeclarations?.map(pin=>pin.sourceId),[second.sourceId]);
  const originalRevision=current.revision;
  updateCaptureContext(f.store,f.sources,screen.deviceId,'screen',{expectedVersion:1,description:''});
  current=f.materials.get(material.id)!;assert.notEqual(current.revision,originalRevision);assert.equal(f.materials.get(material.ref),undefined);
  assert.deepEqual(f.materials.contextForEvidence(f.store.evidence([screen.id])[0]).sourceContextStatements,[{sourceId:first.sourceId,version:2,description:'',captureIds:[screen.id]}]);
  assert.deepEqual(f.materials.contextForEvidence(f.store.evidence([activity.id])[0]).sourceContextDeclarations?.map(pin=>[pin.sourceId,pin.version]),[[second.sourceId,1]]);
  assert.equal(f.sources.contexts.getAtVersion(first.sourceId,1,first.fingerprint)?.description,'Generated screen scope','historical owner prose is retained separately from current model context');
});

test('a running interpretation cannot publish after its channel context changes or acquire unrelated device scope',async t=>{
  const f=fixture(t),input=capture('activity');await f.store.ingest(input);updateCaptureContext(f.store,f.sources,input.deviceId,'activity',{expectedVersion:0,description:'Generated first scope'});
  const runtime=new ProcessingRuntime(f.store,[],{},Date.now,undefined,f.materials);t.after(()=>runtime.close());let calls=0;
  runtime.registry.register({id:'fixture.channel-context',version:'1',lane:'semantic',async process(value){calls++;assert.deepEqual(value.observations[0].attributionContext?.sourceContextStatements?.[0].captureIds,[input.id]);updateCaptureContext(f.store,f.sources,input.deviceId,'activity',{expectedVersion:1,description:'Generated second scope'});return [{kind:'generated',text:'Generated stale interpretation',metadata:{}}];}});
  const id=runtime.enqueue([{name:'channel',processor:'fixture.channel-context',inputs:[input.id]}]).channel;await runtime.tick();
  const job=runtime.view().jobs.find(job=>job.id===id)!;assert.equal(calls,1);assert.equal(job.state,'stale');assert.deepEqual(job.outputs,[]);
  assert.equal(captureSchema.safeParse({...capture('screen'),metadata:{version:1,observedAt:at,sourceContext:{sourceId:'generated-other-device',description:'Forged'}}}).success,false);
});

test('a caller-chosen source ID cannot bind another device context to a capture',async t=>{
  const f=fixture(t),input=capture('screen');await f.store.ingest(input);
  const id=captureContextSourceId('screen',input.deviceId)!;
  f.sources.register({id,kind:'custom',deviceId:'generated-unrelated-device',platform:'android',name:'Generated wrong source identity'});
  f.sources.updateContext(id,{expectedVersion:0,description:'Unrelated device declaration'});
  assert.equal(f.materials.contextForEvidence(f.store.evidence([input.id])[0]).sourceContextStatements,undefined);
  assert.throws(()=>readCaptureContext(f.store,f.sources,input.deviceId,'screen'),{statusCode:409});
  assert.throws(()=>updateCaptureContext(f.store,f.sources,input.deviceId,'screen',{expectedVersion:0,description:'Cannot overwrite device identity'}),{statusCode:409});
});

test('portable mixed-channel materials keep original scope and reject a resealed cross-device statement',async t=>{
  const f=fixture(t),a=capture('screen'),b=capture('screen','generated-second-phone');await f.store.ingest(a);await f.store.ingest(b);
  updateCaptureContext(f.store,f.sources,a.deviceId,'screen',{expectedVersion:0,description:'Generated first phone'});const other=updateCaptureContext(f.store,f.sources,b.deviceId,'screen',{expectedVersion:0,description:'Generated second phone'});
  const material=f.materials.publish(draft([a.id])),archive=f.store.exportArchive(2_000_000),target=fixture(t);await target.store.importArchive(archive);
  assert.deepEqual(target.materials.get(material.id)?.attributionContext,material.attributionContext);
  const forged=structuredClone(archive),row=forged.materials!.revisions.find(row=>row.material_id===material.id)!,manifest=JSON.parse(String(row.manifest));manifest.attributionContext.sourceContextDeclarations=[{sourceId:other.sourceId,version:other.version,fingerprint:other.fingerprint}];row.manifest=JSON.stringify(manifest);reseal(forged);
  const empty=fixture(t);await assert.rejects(empty.store.importArchive(forged),/unrelated or missing source scope/);assert.equal(empty.store.stats().captures,0);
});

test('owner HTTP channel context is versioned and denies unregistered, forged, collector and revoked requests',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-capture-context-http-')),token='generated-capture-context-owner-token',headers={authorization:`Bearer ${token}`};
  const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const url='/api/devices/generated-phone/capture-context/screen';assert.equal((await node.app.inject({url,headers})).statusCode,404);
  const input=capture('screen');await node.store.ingest(input);assert.equal((await node.app.inject({url,headers})).json().version,0);
  const before=node.store.devices(),payload={expectedVersion:0,description:'Generated HTTP owner scope'};
  const saved=await node.app.inject({method:'PATCH',url,headers,payload});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().version,1);
  assert.deepEqual((await node.app.inject({method:'PATCH',url,headers,payload})).json(),saved.json(),'lost response retries are idempotent');
  assert.equal((await node.app.inject({method:'PATCH',url,headers,payload:{...payload,description:'Conflicting draft'}})).statusCode,409);
  assert.equal((await node.app.inject({method:'PATCH',url,headers,payload:{...payload,deviceId:'another-phone'}})).statusCode,400);
  assert.equal((await node.app.inject({url:url.replace('screen','unknown'),headers})).statusCode,400);
  assert.deepEqual(node.store.devices(),before);
  const invitation=node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector'),paired=await node.connections.redeem({code:invitation.invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}),collector={authorization:`Bearer ${paired.token}`};
  for(const method of ['GET','PATCH'] as const)assert.equal((await node.app.inject({method,url,headers:collector,...(method==='PATCH'?{payload}:{})})).statusCode,403);
  const owned=node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated owner'}),owner=await node.connections.redeem({code:owned.invitation.code,deviceId:'generated-owner-device',deviceName:'Generated owner',platform:'android'});
  await node.connections.revoke(owner.credentialId);assert.equal((await node.app.inject({method:'PATCH',url,headers:{authorization:`Bearer ${owner.token}`},payload:{expectedVersion:1,description:'Rejected revoked edit'}})).statusCode,401);
  assert.equal((await node.app.inject({url,headers})).json().description,payload.description);
});
