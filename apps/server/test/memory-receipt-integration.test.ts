import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {materialId} from '../src/materials.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import {fixtureMemoryPlan,fixtureMemoryWorkResult} from './fixtures/memory-planning.js';

const config=(dataDir:string):Config=>({dataDir,token:'generated-receipt-grant-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
const original=(id:string,revision='1')=>({externalId:id,revision,observedAt:'2020-01-01T00:00:00Z',text:`Generated original ${id} revision ${revision}`,kind:'message',layer:'original'});
const coding=(id:string)=>({...original(id),document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'fixture',sessionId:'session',eventId:id,role:'user',attribution:'human',part:0,parts:1}}});
const empty=(input:QueryInput,node:Awaited<ReturnType<typeof buildApp>>)=>{
  if(!input.question.includes('FINAL UNIFIED RESPONSE CONTRACT:\nInterpret every supplied part'))return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};
  const range=input.evidenceRanges![0],record=node.memories.readEvidence([range.id])[0],quote=record.ocrText.slice(range.offset,range.offset+Math.min(range.length,120));
  return {answer:JSON.stringify({summary:'Generated bounded conversation interpretation',evidence:[{id:range.id,quote,offset:range.offset}],workRecords:[],events:[],memoryCandidates:[],actionCues:[]}),citations:[{id:range.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()};
};

test('denied receipts survive restart and duplicate ACK while new ordinary and Coding inputs continue',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-receipt-')),cfg=config(directory);
  let calls=0;
  const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{const plan=await fixtureMemoryPlan(input);if(plan)return plan;calls++;return fixtureMemoryWorkResult(input,empty(input,node));}}};
  let node=await buildApp(cfg,dependencies);await node.app.ready();
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  assert.equal(node.lifecycle.settings().extraction.enabled,true);
  node.sources.register({id:'ordinary',name:'Generated diary',kind:'custom',deviceId:'fixture',platform:'import'});
  node.sources.register({id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture',platform:'import'});
  node.sourcePipelines.configure('coding',{settleSeconds:0});
  const diary=original('diary'),event=coding('one');
  await node.sources.upsert('ordinary',diary);await node.sources.upsert('coding',event);
  node.store.db.prepare('UPDATE memory_input_authorizations SET authorized=0').run();
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE authorized=0').get()!.n,2);
  await node.app.close();

  node=await buildApp(cfg,dependencies);
  // Shutdown can interrupt an admitted organizer and leave its persisted
  // retry delay. Drive the real recovery until both materials are published.
  for(let attempt=0;attempt<100;attempt++){
    await node.materialOrganizer.tick();await node.sourcePipelines.tick();
    if(node.materials.list().items.length===2)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),0);assert.equal(calls,0);
  const oldMaterials=node.materials.list().items;
  assert.equal(oldMaterials.length,2,JSON.stringify({steps:node.store.db.prepare('SELECT kind,state,error,attempts,available_at FROM execution_steps').all()}));
  for(const material of oldMaterials)assert.equal(node.materialMemoryWork.readyForMemory(material.ref),true);
  assert.equal((await node.sources.upsert('ordinary',diary)).duplicate,true);
  assert.equal((await node.sources.upsert('coding',event)).duplicate,true);
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),0);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE authorized=1').get()!.n,0);
  for(const material of oldMaterials){
    const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+cfg.token},payload:{evidenceIds:node.materials.evidenceIds(material.ref)}});
    assert.equal(response.statusCode,202,response.body);
    const completed=await node.memoryPipeline.run(response.json().id);assert.equal(completed.status,'completed',JSON.stringify(completed.batches.map(batch=>({status:batch.status,error:batch.errorCode}))));
  }
  assert.equal(calls,4,'each explicit owner range receives extraction and independent coverage review when the legacy interpretation lacks complete candidate coverage');
  // New receipts after enabling may authorize work even when their authored
  // date is old. Source dates do not decide the authorization time.
  await node.sources.upsert('ordinary',original('diary','2'));
  await node.sources.upsert('coding',coding('two'));
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
  for(const row of node.store.db.prepare('SELECT job_id FROM material_memory_requests WHERE auto_authorized=1').all()){const done=await node.memoryPipeline.run(String(row.job_id));assert.equal(done.status,'completed',JSON.stringify(done.batches.map(batch=>({phase:batch.phase,status:batch.status,error:batch.errorCode,validation:batch.validationFailures}))));}
  assert.equal(calls,8,'automatic zero outputs receive independent review; Coding interpretation is navigation for its full-source worker');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE authorized=1 AND job_id IS NOT NULL').get()!.n,2);
});

test('removed source Memory controls are rejected while current Coding intake is authorized',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-source-receipt-')),cfg=config(directory);
  let calls=0;
  const node=await buildApp(cfg,{agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{calls++;return empty(input,node);}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture',platform:'import'});
  node.sourcePipelines.configure('coding',{settleSeconds:0});
  await node.sources.upsert('coding',coding('one'));
  node.sourcePipelines.configure('coding',{settleSeconds:0});
  await node.sourcePipelines.tick();
  assert.throws(()=>node.sourcePipelines.configure('coding',{memory:false}));
  assert.equal(node.store.db.prepare('SELECT authorized FROM memory_input_authorizations WHERE source_id=?').get('coding')!.authorized,1);assert.equal(calls,0);
  assert.equal(node.materials.list().items.length,1);
  // Erasure removes authorization as well as derived material state.
  node.sourcePipelines.forget('coding');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE source_id=?').get('coding')!.n,0);
  assert.equal(node.materials.get(materialId('coding',JSON.stringify(['codex','fixture','session']))),undefined);
});

test('fresh connector startup installs continuous processing before intake',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-startup-receipt-')),cfg=config(directory),modulePath=join(directory,'generated-connector.mjs');
  let calls=0;
  const dependencies={agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{calls++;return empty(input,node);}}};
  let node=await buildApp(cfg,dependencies);await node.app.ready();
  const settings=node.lifecycle.settings();
  await node.app.close();
  writeFileSync(modulePath,`export default {apiVersion:1,id:'generated-startup',sourceKinds:['custom'],create:ctx=>({init:async()=>{
    ctx.sources.register({id:'startup',name:'Generated startup',kind:'custom',deviceId:'fixture',platform:'import'});
    await ctx.sources.upsert('startup',{externalId:'original',revision:'1',observedAt:'2020-01-01T00:00:00Z',text:'Generated startup original',kind:'message',layer:'original'});
  }})};`);
  node=await buildApp({...cfg,connectors:{modules:[modulePath]}},dependencies);
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const grant=node.store.db.prepare('SELECT authorized FROM memory_input_authorizations WHERE source_id=?').get('startup');
  assert.equal(grant?.authorized,1);
  node.lifecycle.configure(settings);await node.materialOrganizer.tick();
  assert.equal(calls,0,'intake and deterministic publication do not invoke a model');
  assert.equal(node.materials.list({query:'startup original'}).items.length,1);
  assert.equal(node.materialMemoryWork.catalog().length,1);
});

for(const backgroundWorker of [false,undefined])test(`Memory timer ${backgroundWorker===false?'is isolated by the explicit test dependency':'runs continuously with production defaults'}`,{timeout:20000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-timer-')),cfg=config(directory);let calls=0;
 const node=await buildApp(cfg,{backgroundWorker,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{const plan=await fixtureMemoryPlan(input);if(plan)return plan;calls++;return fixtureMemoryWorkResult(input,empty(input,node));}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});await node.app.ready();
 node.sources.register({id:'timer-source',name:'Generated timer source',kind:'custom',deviceId:'fixture',platform:'import'});
 await node.sources.upsert('timer-source',original('automatic-timer'));await node.materialOrganizer.tick();
 assert.equal(node.store.db.prepare("SELECT authorized FROM memory_input_authorizations WHERE source_id='timer-source'").get()!.authorized,1,'test scheduling never changes intake authority');
 if(backgroundWorker===false){await new Promise(resolve=>setTimeout(resolve,5500));assert.equal(calls,0);assert.equal(node.memoryPipeline.list().length,0);}
 else{
  const deadline=Date.now()+15000;while(Date.now()<deadline&&!node.memoryPipeline.list().some(job=>job.status==='completed'))await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(node.memoryPipeline.list().some(job=>job.status==='completed'));assert.equal(calls,2,'the real feature timer admits extraction and independent empty review');
 }
});
