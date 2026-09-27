import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {materialSourcePin,materialSourceCurrent} from '../src/material-source-pin.js';
import type {ManualMemoryInputPlanRequest} from '../src/memory-input-plans.js';
import {reviewMemory} from '../src/memory-review.js';

const recipes=[{id:'fixture.body',version:'1'},{id:'fixture.transcript',version:'1'}];
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-input-plans-')),options:{maxStorageBytes?:number}={};let store:Store,materials:MaterialStore,sources:SourceStore,pipeline:MemoryPipeline;
 const calls:MemoryPipelineQuery[]=[],control:{allowed:boolean;failure?:Error}={allowed:true};
 const start=()=>{store=new Store(directory,options);materials=new MaterialStore(store);sources=new SourceStore(store);const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id)),strategies=new MemoryStrategies();
  for(const [index,ref] of recipes.entries())strategies.registerRecipe({...ref,requires:[index?'transcript':'body'],extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'}});
  const query=async(input:MemoryPipelineQuery)=>{calls.push(input);if(control.failure)throw control.failure;return {answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()};};
  pipeline=new MemoryPipeline({store,memories,strategies,configured:()=>true,model:()=> 'generated',query,review:(input,result)=>reviewMemory(input,result,async request=>query(request as MemoryPipelineQuery)),materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>control.allowed&&Boolean(materials.input(ref,required??['material'])?.ready),materialPlanAllowed:()=>control.allowed,materialSourceCurrent:(pin,id)=>materialSourceCurrent(store,materials,pin,id)});
 };
 start();t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const add=async(name:string)=>{sources.register({id:name,name:'Generated '+name,kind:'custom',deviceId:'fixture',platform:'import'});return (await sources.upsert(name,{externalId:'original',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated original '+name})).id;};
 const publish=(name:string,raw:string,state:'ready'|'pending'|'failed',body='Generated body '+name)=>{const id=materialId(name,'original'),prior=materials.get(id);return materials.publish({id,kind:'mote.message',schemaVersion:1,title:'Generated material',origin:{sourceId:name,externalId:'original',deviceId:'fixture'},members:[{id:'original',kind:'capture',ref:'capture:'+raw}],blocks:[{id:'body',kind:'text',format:'plain',text:body,memberIds:['original']},...(state==='ready'?[{id:'transcript',kind:'text' as const,format:'plain',text:'Generated transcript '+name,memberIds:['original']}]:[])],artifacts:[{key:'body',state:'ready',revision:'body-v1',blockIds:['body']},{key:'transcript',state,revision:state,blockIds:state==='ready'?['transcript']:[]}],coverage:{state:state==='ready'?'complete':'partial'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},{expectedRevision:prior?.revision??null});};
 const plan=(id:string,index:number,allow?:string[]):ManualMemoryInputPlanRequest=>{const material=materials.get(id)!;return {materialId:id,selectedRef:material.ref,sourcePin:materialSourcePin(store,materials,material),strategy:pipeline.strategies.resolve(recipes[index]).binding,required:[index?'transcript':'body'],evidenceAllowList:allow};};
 return {get store(){return store;},get pipeline(){return pipeline;},get materials(){return materials;},get sources(){return sources;},calls,control,options,add,publish,plan,async restart(){await pipeline.close();store.close();start();}};
}

test('ready plans retain same-recipe batching and waiting plans persist without a model attempt',async t=>{
 const f=await fixture(t),a=await f.add('a'),b=await f.add('b'),ma=f.publish('a',a,'pending'),mb=f.publish('b',b,'pending');
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(ma.id,0),f.plan(mb.id,0),f.plan(ma.id,1)]}),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'waiting_for_input');assert.equal(done.completedBatches,1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].evidenceIds.length,2);assert.equal(done.inputPlans?.completed,2);assert.equal(done.inputPlans?.waiting,1);
 assert.equal(f.store.db.prepare("SELECT state FROM operation_progress WHERE id=?").get('memory:'+job.id)!.state,'waiting');assert.equal(f.store.db.prepare("SELECT attempts FROM execution_steps WHERE kind='memory.input' AND state='waiting'").get()!.attempts,0);
 const completed=done.batches[0];await f.restart();f.publish('a',a,'ready');f.pipeline.wakeInputs([ma.id]);const resumed=await f.pipeline.run(job.id);
 assert.equal(resumed.status,'completed');assert.equal(resumed.batches.length,2);assert.equal(f.calls.length,2);assert.deepEqual(resumed.batches.find(batch=>batch.id===completed.id),completed);await f.pipeline.tickInputs();assert.equal(f.calls.length,2);assert.equal(f.store.db.prepare("SELECT state FROM operation_progress WHERE id=?").get('memory:'+job.id)!.state,'succeeded');
});

test('waiting-only jobs pause and cancel without launching late ready inputs',async t=>{
 const f=await fixture(t),raw=await f.add('pause'),material=f.publish('pause',raw,'pending'),job=f.pipeline.create({evidenceIds:[],recipes:[recipes[1]],manualPlans:[f.plan(material.id,1)]});
 assert.equal((await f.pipeline.run(job.id)).status,'waiting_for_input');assert.equal(f.calls.length,0);assert.equal(f.pipeline.pause(job.id).status,'paused');f.publish('pause',raw,'ready');f.pipeline.wakeInputs();await f.pipeline.tickInputs();assert.equal(f.calls.length,0);
 f.pipeline.cancel(job.id);await f.pipeline.tickInputs();assert.equal(f.pipeline.get(job.id).status,'cancelled');assert.equal(f.calls.length,0);assert.equal(f.store.db.prepare("SELECT count(*) n FROM memory_batches WHERE job_id=?").get(job.id)!.n,0);
});

test('material-first selection order still coalesces ready inputs by recipe',async t=>{
 const f=await fixture(t),a=await f.add('group-a'),b=await f.add('group-b'),ma=f.publish('group-a',a,'ready'),mb=f.publish('group-b',b,'ready');
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(ma.id,0),f.plan(ma.id,1),f.plan(mb.id,0),f.plan(mb.id,1)]}),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'completed');assert.equal(done.completedBatches,2);assert.equal(f.calls.length,2);assert.ok(f.calls.every(call=>call.evidenceIds.length===2));
});

test('a transcript becoming unavailable cannot invalidate the body batch in the same manual job',async t=>{
 const f=await fixture(t),raw=await f.add('independent'),material=f.publish('independent',raw,'ready'),body=f.materials.input(material.id,['body'])!;
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(material.id,0),f.plan(material.id,1)]});f.publish('independent',raw,'failed');
 assert.equal(f.materials.input(material.id,['body'])!.fingerprint,body.fingerprint);
 const done=await f.pipeline.run(job.id);assert.equal(done.completedBatches,1);assert.equal(done.failedBatches,1);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].processingMaterialInputs?.map(pin=>pin.required),[['body']]);
});

test('a paused waiting plan resumes only its original ready input and current authorization',async t=>{
 const f=await fixture(t),raw=await f.add('resume'),material=f.publish('resume',raw,'pending'),job=f.pipeline.create({evidenceIds:[],recipes:[recipes[1]],manualPlans:[f.plan(material.id,1)]});await f.pipeline.run(job.id);f.pipeline.pause(job.id);
 f.publish('resume',raw,'ready');f.control.allowed=false;f.pipeline.resume(job.id);const blocked=await f.pipeline.run(job.id);assert.equal(blocked.status,'failed');assert.equal(f.calls.length,0);
 f.control.allowed=true;const restored=await f.pipeline.retry(job.id);assert.equal(restored.status,'completed');assert.equal(f.calls.length,1);
});

test('failed inputs remain local to their recipe and exact IDs never grant a future sibling output',async t=>{
 const f=await fixture(t),raw=await f.add('precise'),material=f.publish('precise',raw,'failed'),ids=f.materials.input(material.id,['body'])!.evidenceIds;
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(material.id,0),f.plan(material.id,1,ids)]});assert.equal((await f.pipeline.run(job.id)).status,'failed');assert.equal(f.calls.length,1);assert.equal(f.pipeline.get(job.id).completedBatches,1);
 f.publish('precise',raw,'ready');const result=await f.pipeline.retry(job.id);assert.equal(result.status,'failed');assert.equal(f.calls.length,1);assert.ok(result.recipeProgress?.flatMap(recipe=>recipe.reasons).some(reason=>reason.code==='memory_input_outside_selection'));
});

test('source replacement stales waiting plans and source deletion clears private plan metadata',async t=>{
 const f=await fixture(t),raw=await f.add('replace'),material=f.publish('replace',raw,'pending'),job=f.pipeline.create({evidenceIds:[],recipes:[recipes[1]],manualPlans:[f.plan(material.id,1)]});await f.pipeline.run(job.id);
 await f.sources.upsert('replace',{externalId:'original',revision:'2',observedAt:'2026-02-01T00:00:00Z',kind:'message',layer:'original',text:'Generated unrelated new input'});await f.pipeline.tickInputs();assert.equal(f.pipeline.get(job.id).inputPlans?.stale,1);assert.equal(f.calls.length,0);
 f.materials.forget(material.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_plans').get()!.n,0);
});

test('quota failure rolls back the job, plans, batches and execution membership together',async t=>{
 const f=await fixture(t),raw=await f.add('quota'),material=f.publish('quota',raw,'pending');f.options.maxStorageBytes=f.store.logicalBytes()+100;
 assert.throws(()=>f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(material.id,0),f.plan(material.id,1)]}),{statusCode:507});
 for(const table of ['memory_jobs','memory_input_plans','memory_batches','execution_steps','operation_progress'])assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
});


test('a repaired failed input retries immediately while a different original still waits',async t=>{
 const f=await fixture(t),a=await f.add('retry-a'),b=await f.add('retry-b'),ma=f.publish('retry-a',a,'failed'),mb=f.publish('retry-b',b,'pending');
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(ma.id,0),f.plan(ma.id,1),f.plan(mb.id,0),f.plan(mb.id,1)]});
 const waiting=await f.pipeline.run(job.id);assert.equal(waiting.status,'waiting_for_input');assert.equal(waiting.inputPlans?.blocked,1);assert.equal(waiting.inputPlans?.waiting,1);assert.equal(f.calls.length,1);
 f.publish('retry-a',a,'ready');const retried=await f.pipeline.retry(job.id);
 assert.equal(retried.status,'waiting_for_input');assert.equal(retried.inputPlans?.blocked,0);assert.equal(retried.inputPlans?.completed,3);assert.equal(retried.inputPlans?.waiting,1);assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls[1].processingMaterialInputs?.map(pin=>({id:pin.materialId,required:pin.required})),[{id:ma.id,required:['transcript']}]);
});

test('a manual input recheck still honors a failed model batch cooldown',async t=>{
 const f=await fixture(t),raw=await f.add('retry-provider'),material=f.publish('retry-provider',raw,'pending');
 f.control.failure=new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:60000});
 const job=f.pipeline.create({evidenceIds:[],recipes,manualPlans:[f.plan(material.id,0),f.plan(material.id,1)]}),waiting=await f.pipeline.run(job.id);
 assert.equal(waiting.status,'waiting_for_input');assert.equal(waiting.failedBatches,1);assert.equal(f.calls.length,1);
 await assert.rejects(f.pipeline.retry(job.id),error=>error instanceof ProviderFailure&&error.details.code==='provider_unavailable'&&(error.details.retryAfterMs??0)>50000);
 assert.equal(f.calls.length,1);
});
