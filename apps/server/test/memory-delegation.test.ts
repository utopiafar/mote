import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import {AgentYieldError} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {MaterialMemoryWork,type MemoryWorkCandidate} from '../src/material-memory-work.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime} from '../src/delegation-runtime.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {registerMemoryDelegation} from '../src/memory-delegation.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

async function fixture(t:TestContext,count=4){
 const directory=mkdtempSync(join(tmpdir(),'mote-delegated-memory-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id)),engine=new ExecutionEngine(store),work=new MaterialMemoryWork(store,materials),runtime=new DelegationRuntime(store,engine,{autoPump:false}),sourcePipelines=new SourcePipelineRuntime(store,materials,[],undefined,engine,work);await sourcePipelines.ready;
 for(const sourceId of ['generated-one','generated-two'])sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:sourceId,platform:'import'});
 for(let index=0;index<count;index++){
  const sourceId=index%2?'generated-two':'generated-one',externalId=String(index),original=await sources.upsert(sourceId,{externalId,revision:'1',text:'Generated reference with no durable personal fact.',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  const material=materials.publish({id:materialId(sourceId,externalId),kind:'mote.file',schemaVersion:1,title:'Generated original '+index,origin:{sourceId,externalId},blocks:[{id:'body',kind:'text',format:'plain',text:'Generated reference with no durable personal fact.',memberIds:[original.id]}],members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  store.db.exec('BEGIN IMMEDIATE');work.inputs.receive({sourceId,inputKey:'raw-'+index});store.db.exec('COMMIT');work.observe(material.id,['material'],{inputKey:'raw-'+index,change:'source'});
 }
 let planning=0,extraction=0,reviews=0;
 const zero=(input:QueryInput,runId:string):QueryResult=>({runId,trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),capacity:{saturated:false}})});
 const pipeline=new MemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=> 'synthetic',concurrency:()=>2,requireAdmission:true,automaticAllowed:job=>work.authorized(job),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:()=>['material'],materialAllowedForMemory:()=>true,query:async input=>{extraction++;return zero(input,'generated-extraction');},review:(input,draft)=>reviewMemory(input,draft,async next=>{reviews++;return zero(next,'generated-review');})});
 let planningHook:((input:QueryInput,catalog:MemoryWorkCandidate[])=>Promise<void>)|undefined;
 let allow:((candidate:MemoryWorkCandidate)=>boolean)=()=>true;
 const adapter=registerMemoryDelegation({runtime,pipeline,work,sourcePipelines,allowCandidate:candidate=>allow(candidate),query:async input=>{planning++;const catalog=(input.taskContext!.memoryWork as {catalog:MemoryWorkCandidate[]}).catalog;if(planningHook)await planningHook(input,catalog);else await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'joint',capabilityId:'memory.package',title:'Inspect selected originals',goal:'Inspect the complete synthetic set',input:{members:catalog.map(candidate=>candidate.key),instruction:'Preserve separate source identities and verify every input'}}]});return {runId:'generated-plan',answer:'The bounded input catalog was delegated.',citations:[],trace:[]};}});
 t.after(async()=>{await engine.close();await adapter.close();await runtime.close();await pipeline.close();await sourcePipelines.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,runtime,sourcePipelines,work,pipeline,adapter,counts:()=>({planning,extraction,reviews}),setPlanning(hook:NonNullable<typeof planningHook>){planningHook=hook;},setAllowed(hook:typeof allow){allow=hook;},async finish(){for(let tick=0;tick<30;tick++){await runtime.tick();await sourcePipelines.drainMemory(pipeline,true);if(runtime.list().every(owner=>['succeeded','failed','blocked','stale'].includes(owner.status)))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Synthetic Memory work did not settle');}};
}

test('production adapter uses the generic model control channel and existing Memory commits with per-input coverage',async t=>{
 const f=await fixture(t);assert.equal(await f.sourcePipelines.drainMemory(f.pipeline,true),1);await f.finish();
 assert.deepEqual(f.counts(),{planning:1,extraction:1,reviews:1});assert.equal(f.pipeline.list().length,1);
 const job=f.pipeline.get(f.pipeline.list()[0].id);assert.equal(job.automaticGrants?.length,4);assert.equal(new Set(job.automaticGrants?.map(grant=>grant.sourceId)).size,2);assert.equal(job.status,'completed');assert.equal(job.batches[0].coverage?.length,4);assert.ok(job.batches[0].reviewReceipt?.reviewRunId);
 const owner=f.runtime.list()[0];assert.equal(owner.status,'succeeded');assert.equal(owner.units.length,1);assert.equal(owner.units[0].capabilityId,'memory.package');assert.ok(owner.units[0].artifactId);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);assert.equal(await f.sourcePipelines.drainMemory(f.pipeline,true),0);assert.equal(f.counts().planning,1,'another tick cannot rerun the model or consume another receipt');
});

test('planner controls choose package boundaries; omitted catalog members cannot be declared processed',async t=>{
 const f=await fixture(t,2);f.setPlanning(async(input,catalog)=>{await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'incomplete',capabilityId:'memory.package',title:'One original',goal:'Inspect one original',input:{members:[catalog[0].key],instruction:'Only this original'}}]});});
 await assert.rejects(f.sourcePipelines.drainMemory(f.pipeline,true),/planning/i);assert.equal(f.pipeline.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,0);assert.equal(f.runtime.list()[0].status,'failed');
 await assert.rejects(f.sourcePipelines.drainMemory(f.pipeline,true));assert.equal(f.counts().planning,1,'a failed durable planner needs explicit retry instead of another model call each tick');
});

test('recovery links a claimed package after planning without rerunning either model or receipt claims',async t=>{
 const f=await fixture(t,2),pipeline=f.pipeline;
 // Persist precisely the interruption window after atomic queue+claims and
 // before the host attaches the external execution handle.
 const held={create:(input:Parameters<MemoryPipeline['create']>[0])=>pipeline.create(input),get:(id:string)=>pipeline.get(id),cancel:(id:string)=>pipeline.cancel(id),run:async()=>{}};
 assert.equal(await f.work.drainPlanned(held,true,f.adapter.plan,64),1);
 const job=f.pipeline.get(f.pipeline.list()[0].id),unit=f.runtime.list()[0].units[0];
 assert.equal(unit.stepId,unit.id);assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.package-status'").get()!.n,0);
 f.adapter.reconcile();f.adapter.reconcile();
 assert.equal(f.runtime.unit(unit.id).stepId,'memory-package-status:'+job.id);assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.package-status'").get()!.n,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id=?').get(job.id)!.n,2);
 await f.pipeline.run(job.id);await f.finish();assert.deepEqual(f.counts(),{planning:1,extraction:1,reviews:1});assert.equal(f.runtime.list()[0].status,'succeeded');
});

test('cancelling the delegated branch revokes the actual queued product before it can execute',async t=>{
 const f=await fixture(t,2),pipeline=f.pipeline;
 const held={create:(input:Parameters<MemoryPipeline['create']>[0])=>pipeline.create(input),get:(id:string)=>pipeline.get(id),cancel:(id:string)=>pipeline.cancel(id),run:async()=>{}};
 await f.work.drainPlanned(held,true,f.adapter.plan,64,()=>true,f.adapter.onCreated);
 const job=f.pipeline.get(f.pipeline.list()[0].id),unit=f.runtime.list()[0].units[0];f.runtime.cancelUnit(unit.id);
 assert.equal(f.pipeline.get(job.id).status,'cancelled');assert.equal((await f.pipeline.run(job.id)).status,'cancelled');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.deepEqual(f.counts(),{planning:1,extraction:0,reviews:0});
});

test('planner metadata enrolls all original dependencies before dispatch and deletion erases its private plan',async t=>{
 const f=await fixture(t,2);let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.setPlanning(async()=>{enter();await held;});const running=f.sourcePipelines.drainMemory(f.pipeline,true);await entered;
 const owner=f.runtime.list()[0],ids=f.store.db.prepare('SELECT evidence_id FROM delegation_dependencies WHERE work_id=?').all(owner.id).map(row=>String(row.evidence_id)),original=ids.find(id=>f.store.evidence([id]).length)!;
 assert.ok(original,'material ancestor originals are enrolled before the model sees titles');f.store.delete(original);release();
 await assert.rejects(running);assert.equal(f.runtime.get(owner.id).status,'stale');assert.throws(()=>f.runtime.journal.payload(owner.id),/no longer available/);assert.equal(f.pipeline.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM delegation_events WHERE work_id=?').get(owner.id)!.n,0);
});

test('private catalog members are postponed before metadata dispatch without consuming their receipt',async t=>{
 const f=await fixture(t,2);f.setAllowed(candidate=>candidate.sourceId==='generated-one');
 f.setPlanning(async(input,catalog)=>{assert.equal(catalog.length,1);assert.equal(catalog[0].sourceId,'generated-one');await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'allowed',capabilityId:'memory.package',title:'Allowed original',goal:'Inspect authorized metadata',input:{members:[catalog[0].key],instruction:'Preserve attribution'}}]});});
 assert.equal(await f.sourcePipelines.drainMemory(f.pipeline,true),1);await f.finish();
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM memory_input_authorizations WHERE source_id='generated-two' AND authorized=1 AND job_id IS NULL").get()!.n,1);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM material_memory_requests r JOIN material_heads h ON h.id=r.material_id WHERE h.source_id='generated-two' AND r.job_id IS NULL AND r.ready_at>?").get(Date.now())!.n,1);
 assert.equal(f.runtime.list().length,1);assert.equal(f.counts().planning,1);
});

test('partial proposal handoff recovers remaining groups from the journal before planning a new catalog',async t=>{
 const f=await fixture(t,2);f.setPlanning(async(input,catalog)=>{await input.hostControlChannel!.execute('delegation_submit',{units:catalog.map((candidate,index)=>({id:'part-'+index,capabilityId:'memory.package',title:'Separate original',goal:'Inspect independently',input:{members:[candidate.key],instruction:'Preserve separate source identity'}}))});});
 const catalog=f.work.catalog(),proposals=await f.adapter.plan(catalog),pipeline=f.pipeline;
 const held={create:(input:Parameters<MemoryPipeline['create']>[0])=>pipeline.create(input),get:(id:string)=>pipeline.get(id),cancel:(id:string)=>pipeline.cancel(id),run:async()=>{}};
 assert.equal(f.work.acceptPackages(held,catalog,[proposals[0]],()=>true,f.adapter.onCreated),1);assert.equal(f.pipeline.list().length,1);
 f.adapter.reconcile();f.adapter.reconcile();assert.equal(f.pipeline.list().length,2);assert.equal(f.counts().planning,1);
 // A planner fragment returning at the same handoff window reuses the product.
 assert.equal(f.work.acceptPackages(held,catalog,proposals,()=>true,f.adapter.onCreated),0);assert.ok(f.pipeline.list().every(job=>job.status!=='cancelled'));
 for(const job of f.pipeline.list())await f.pipeline.run(job.id);await f.finish();assert.deepEqual(f.counts(),{planning:1,extraction:2,reviews:2});assert.equal(f.runtime.list().length,1);assert.equal(f.runtime.list()[0].status,'succeeded');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,2);
});

test('pre-upgrade Memory proposal wait validates saved packages without another model call and completes independently reviewed coverage',async t=>{
 const f=await fixture(t,4),catalog=f.work.catalog();
 await f.adapter.plan(catalog);const owner=f.runtime.list()[0],unitIds=owner.units.map(unit=>unit.id);
 f.store.db.prepare("UPDATE delegation_works SET json=json_set(json_remove(json,'$.planningComplete','$.plannedUnitIds'),'$.wait',json(?)) WHERE id=?").run(JSON.stringify({unitIds,mode:'any'}),owner.id);
 await f.runtime.tick();await new Promise(resolve=>setTimeout(resolve,100));f.adapter.reconcile();await f.finish();
 assert.equal(f.runtime.get(owner.id).status,'succeeded');assert.deepEqual(f.runtime.get(owner.id).units.map(unit=>unit.id),unitIds);
 assert.deepEqual(f.counts(),{planning:1,extraction:1,reviews:1});assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);
 f.adapter.reconcile();await f.runtime.tick();assert.deepEqual(f.counts(),{planning:1,extraction:1,reviews:1});
});

test('an incomplete legacy plan resumes the model with exact local IDs and cannot hand off until all members are covered',async t=>{
 const f=await fixture(t,2),catalog=f.work.catalog();let fragments=0;
 f.setPlanning(async(input,selected)=>{
  if(++fragments===1){
   await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'original-part',capabilityId:'memory.package',title:'Generated part',goal:'Inspect one original',input:{members:[selected[0].key],instruction:'Preserve original attribution'}}]});
   const owner=f.runtime.list()[0];f.store.db.prepare("UPDATE delegation_works SET json=json_set(json,'$.wait',json(?)) WHERE id=?").run(JSON.stringify({unitIds:owner.units.map(unit=>unit.id),mode:'any'}),owner.id);
   // Reproduce the pre-upgrade yield through the real fragment lifecycle.
   throw new AgentYieldError();
  }
  const units=(input.taskContext!.memoryWork as {units:{id:string;localId:string;capabilityId:string;title:string;goal:string;input:Record<string,unknown>}[]}).units;
  assert.equal(units.length,1);assert.equal(units[0].localId,'original-part');assert.ok(units[0].id.endsWith(':unit:original-part'));
  assert.equal(f.pipeline.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,0);
  const {localId,capabilityId,title,goal,input:priorInput}=units[0];await input.hostControlChannel!.execute('delegation_submit',{units:[{id:localId,capabilityId,title,goal,input:priorInput}]});
  await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'missing-part',capabilityId:'memory.package',title:'Generated remainder',goal:'Inspect the remaining original',input:{members:[selected[1].key],instruction:'Preserve original attribution'}}]});
 });
 const planned=f.adapter.plan(catalog);
 for(let n=0;n<30;n++){await f.runtime.tick();if(f.runtime.list()[0]?.planningComplete)break;await new Promise(resolve=>setTimeout(resolve,10));}
 const proposals=await planned;assert.equal(proposals.length,2);assert.ok(proposals[0].id!.endsWith(':unit:original-part'));assert.equal(f.counts().planning,2);
 f.adapter.reconcile();await f.finish();assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);assert.deepEqual(f.counts(),{planning:2,extraction:2,reviews:2});
});

test('overlapping recovered plans never claim one original twice and remaining originals stay eligible',async t=>{
 const f=await fixture(t,4),catalog=f.work.catalog();
 const a=await f.adapter.plan(catalog.slice(0,3)),b=await f.adapter.plan(catalog.slice(1));assert.equal(a.length,1);assert.equal(b.length,1);
 for(const owner of f.runtime.list())f.store.db.prepare("UPDATE delegation_works SET json=json_set(json_remove(json,'$.planningComplete','$.plannedUnitIds'),'$.wait',json(?)) WHERE id=?").run(JSON.stringify({unitIds:owner.units.map(unit=>unit.id),mode:'any'}),owner.id);
 await f.runtime.tick();await new Promise(resolve=>setTimeout(resolve,100));f.adapter.reconcile();
 assert.equal(f.pipeline.list().length,1,'the overlapping package must not partially claim its remaining original');
 await f.finish();assert.equal(await f.sourcePipelines.drainMemory(f.pipeline,true),0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,4);
 assert.equal(f.pipeline.list().length,2);assert.equal(f.pipeline.list().every(job=>job.status==='completed'),true);
});

// This corpus runs alongside three other server test files in the workspace suite.
// Preserve all 1,000 inputs and 125 reviewed jobs while allowing suite CPU contention.
test('a thousand generated originals drain bounded catalogs with complete independently reviewed coverage',{timeout:120000},async t=>{
 const f=await fixture(t,1000);
 f.setPlanning(async(input,catalog)=>{
  assert.ok(catalog.length<=64,'the coordinator never receives the full archive');
  const units=[];for(let offset=0;offset<catalog.length;offset+=8)units.push({id:'group-'+offset,capabilityId:'memory.package',title:'Generated group',goal:'Inspect these generated originals',input:{members:catalog.slice(offset,offset+8).map(candidate=>candidate.key),instruction:'Inspect every original and keep each source receipt independent'}});
  await input.hostControlChannel!.execute('delegation_submit',{units});
 });
 for(let round=0;round<16;round++)assert.ok(await f.sourcePipelines.drainMemory(f.pipeline,true)>0);
 assert.equal(await f.sourcePipelines.drainMemory(f.pipeline,true),0);
 const jobs=f.store.db.prepare('SELECT id FROM memory_jobs ORDER BY id').all().map(row=>String(row.id));assert.equal(jobs.length,125);
 await Promise.all(jobs.map(id=>f.pipeline.run(id)));await f.finish();
 const grants=f.store.db.prepare('SELECT source_id,input_key,job_id FROM memory_input_authorizations WHERE authorized=1').all();
 assert.equal(grants.length,1000);assert.ok(grants.every(grant=>grant.job_id));assert.equal(new Set(grants.map(grant=>JSON.stringify([grant.source_id,grant.input_key]))).size,1000);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1000);
 const coverage=jobs.flatMap(id=>f.pipeline.get(id).batches.filter(batch=>!batch.supersededBy).flatMap(batch=>{assert.ok(batch.reviewReceipt?.reviewRunId);return batch.coverage??[];}));
 assert.equal(coverage.length,1000);assert.ok(coverage.every(member=>member.state==='no_candidates'));assert.equal(new Set(coverage.map(member=>member.key)).size,1000);
 assert.deepEqual(f.counts(),{planning:16,extraction:125,reviews:125});assert.ok(f.runtime.list().every(owner=>owner.status==='succeeded'));
});
