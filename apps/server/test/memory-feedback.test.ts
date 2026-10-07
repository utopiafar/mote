import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContextToolError,type QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {MaterialMemoryWork,type MemoryWorkCandidate} from '../src/material-memory-work.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime} from '../src/delegation-runtime.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {registerMemoryDelegation} from '../src/memory-delegation.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import type {MemoryFeedbackRequest} from '../src/memory-feedback.js';

type ModelWork={members:MemoryWorkMember[];contextMembers?:MemoryWorkMember[]};
const modelWork=(input:Pick<QueryInput,'taskContext'>)=>input.taskContext!.memoryWork as ModelWork;
type FixtureMode='resolved'|'unresolved'|'outside'|'context-candidate';
const observedAt='2026-09-01T00:00:00Z';

/** Generated models use the production authority channel, planner and product
 * executor. Only the responses are fixtures; no private archive is opened. */
async function fixture(t:TestContext,mode:FixtureMode='resolved',targets=1){
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-feedback-'));
 const extraction:MemoryPipelineQuery[]=[],reviews:QueryInput[]=[],feedback:MemoryFeedbackRequest[]=[];
 let planning=0,activeModels=0,maxActiveModels=0,backgroundId='',outsideId='',failNextApply=false;
 let store!:Store,sources!:SourceStore,materials!:MaterialStore,memories!:MemoryStore,engine!:ExecutionEngine,work!:MaterialMemoryWork,runtime!:DelegationRuntime,sourcePipelines!:SourcePipelineRuntime,pipeline!:MemoryPipeline,adapter!:ReturnType<typeof registerMemoryDelegation>;
 const runModel=async<T>(action:()=>Promise<T>|T)=>{activeModels++;maxActiveModels=Math.max(maxActiveModels,activeModels);try{return await action();}finally{activeModels--;}};
 const output=(input:Pick<QueryInput,'taskContext'>,runId:string):QueryResult=>{
  const current=modelWork(input),hasContext=Boolean(current.contextMembers?.length),needs=current.members.some(member=>member.id!==backgroundId)&&(mode==='unresolved'||mode==='outside'||!hasContext);
  const coverage=current.members.map(member=>({key:member.key,state:needs?'needs_context':'no_candidates',candidateIndexes:[],...(needs?{reason:'Generated target requires the separately authorized background.',contextRefs:[mode==='outside'?'capture:'+outsideId:backgroundId]}:{})}));
  const memories=mode==='context-candidate'&&hasContext?[{title:'Generated background preference',statement:`The owner prefers a blue bowl [${backgroundId}]`,uncertainty:'Synthetic fixture only',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Fixture only',attribution:'user'},evidenceIds:[backgroundId],evidence:[{id:backgroundId,quote:'I prefer a blue bowl.'}]}]:[];
  return {runId,trace:[],citations:memories.length?[{id:backgroundId,capturedAt:observedAt,appName:'Generated',excerpt:'I prefer a blue bowl.'}]:[],answer:JSON.stringify({memories,coverage,capacity:{saturated:false}})};
 };
 const attach=async()=>{
  store=new Store(directory);sources=new SourceStore(store);materials=new MaterialStore(store);
  memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
  engine=new ExecutionEngine(store);work=new MaterialMemoryWork(store,materials);
  runtime=new DelegationRuntime(store,engine,{autoPump:false,concurrency:()=>1});sourcePipelines=new SourcePipelineRuntime(store,materials,[],undefined,engine,work);await sourcePipelines.ready;
  pipeline=new MemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=> 'generated',concurrency:()=>1,batchCharacters:256,requireAdmission:true,automaticAllowed:job=>work.authorized(job),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:()=>['material'],materialAllowedForMemory:()=>true,query:input=>runModel(()=>{extraction.push(input);return output(input,'generated-extraction-'+extraction.length);}),review:(input,draft)=>reviewMemory(input,draft,next=>runModel(()=>{reviews.push(next);return output(next,'generated-review-'+reviews.length);}))});
  const enqueue=engine.enqueue.bind(engine);
  engine.enqueue=(operationId,kind,input,options)=>{
   if(failNextApply&&kind==='memory.batch'&&Number(store.db.prepare("SELECT json_extract(json,'$.replanRound') round FROM memory_batches WHERE id=?").get(String(input.batchId))?.round)>0){failNextApply=false;throw new Error('Generated interruption before feedback children are committed');}
   return enqueue(operationId,kind,input,options);
  };
  adapter=registerMemoryDelegation({runtime,pipeline,work,sourcePipelines,query:input=>runModel(async()=>{
   assert.ok(input.hostControlChannel,'the model receives the production host authority channel');
   assert.equal(input.hostRetrieval,'none','planning cannot silently read the archive');
   const capabilities=await input.hostControlChannel.execute('delegation_capabilities',{});
   if(input.traceContext?.phase==='feedback-planning'){
    const request=(input.taskContext!.memoryWork as {feedback:MemoryFeedbackRequest}).feedback;
    feedback.push(structuredClone(request));assert.match(JSON.stringify(capabilities.data),/memory\.feedback-group/);assert.match(JSON.stringify(capabilities.data),/memory\.feedback-stop/);
    const background=request.authorized.find(member=>member.id===backgroundId);assert.ok(background);
    assert.ok(request.authorized.every(member=>member.id!==outsideId));
    if(mode==='outside'){
     await assert.rejects(input.hostControlChannel.execute('delegation_submit',{units:[{id:'outside',capabilityId:'memory.feedback-group',title:'Invalid outside context',goal:'Try an unauthorized original',input:{memberKeys:request.targets.map(member=>member.key),contextKeys:[sha256('generated-outside-range')],instruction:'Read the ungranted original'}}]}),error=>error instanceof ContextToolError&&error.code==='invalid_delegation_arguments'&&error.message==='Unit input contract rejected');
     await input.hostControlChannel.execute('delegation_submit',{units:[{id:'stop',capabilityId:'memory.feedback-stop',title:'Context needs owner input',goal:'Keep missing background explicit',input:{reason:'The requested generated original is outside this job authorization.'}}]});
    }else{
     await input.hostControlChannel.execute('delegation_submit',{units:request.targets.map((member,index)=>({id:'target-'+index,capabilityId:'memory.feedback-group',title:'Inspect generated target '+index,goal:'Resolve only this unfinished target',input:{memberKeys:[member.key],contextKeys:[background.key],instruction:'Use the authorized background to inspect the target, retaining its independent provenance.'}}))});
    }
   }else{
    planning++;assert.match(JSON.stringify(capabilities.data),/memory\.package/);
    const catalog=(input.taskContext!.memoryWork as {catalog:MemoryWorkCandidate[]}).catalog;
    const ordered=[...catalog].sort((a,b)=>a.title.localeCompare(b.title));
    await input.hostControlChannel.execute('delegation_submit',{units:[{id:'package',capabilityId:'memory.package',title:'Generated complete package',goal:'Inspect every generated original',input:{members:ordered.map(member=>member.key),instruction:'Preserve all independently authorized sources.'}}]});
   }
   return {runId:'generated-planner-'+(planning+feedback.length),answer:'The bounded plan was submitted.',citations:[],trace:[]};
  })});
 };
 const detach=async()=>{await engine.close();await adapter.close();await runtime.close();await pipeline.close();await sourcePipelines.close();store.close();};
 await attach();
 sources.register({id:'generated',name:'Generated fixture originals',kind:'custom',deviceId:'generated',platform:'import'});
 for(let index=0;index<=targets+1;index++){
  const outside=index===targets+1,text=index===0?'Wholly synthetic. I prefer a blue bowl. '.padEnd(240,'x'):('Wholly synthetic target '+index+'. Refers to a separately authorized earlier plan.').padEnd(100,'x');
  const original=await sources.upsert('generated',{externalId:String(index),revision:'1',text,observedAt,kind:'file',layer:'original'});
  const material=materials.publish({id:materialId('generated',String(index)),kind:'mote.file',schemaVersion:1,title:'Generated original '+index,origin:{sourceId:'generated',externalId:String(index)},blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[original.id]}],members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  const ids=materials.input(material.ref,['material'])!.evidenceIds;
  if(index===0)backgroundId=ids[0];if(outside){outsideId=ids[0];continue;}
  store.db.exec('BEGIN IMMEDIATE');work.inputs.receive({sourceId:'generated',inputKey:'raw-'+index});store.db.exec('COMMIT');work.observe(material.id,['material'],{inputKey:'raw-'+index,change:'source'});
 }
 t.after(async()=>{await detach();rmSync(directory,{recursive:true,force:true});});
 return {get store(){return store;},get pipeline(){return pipeline;},get runtime(){return runtime;},get memories(){return memories;},extraction,reviews,feedback,get backgroundId(){return backgroundId;},get outsideId(){return outsideId;},counts:()=>({planning,feedback:feedback.length,extraction:extraction.length,reviews:reviews.length,maxActiveModels}),
  async start(){assert.equal(await sourcePipelines.drainMemory(pipeline,true),1);const job=pipeline.list()[0];assert.ok(job);return pipeline.run(job.id);},
  interruptNextApply(){failNextApply=true;},
  async restart(){await detach();await attach();},
  checkpoints(){return store.db.prepare('SELECT key,evidence_id FROM memory_checkpoints ORDER BY key').all();},
  async settle(){for(let count=0;count<40;count++){await runtime.tick();if(runtime.list().every(owner=>['succeeded','failed','blocked','stale','cancelled'].includes(owner.status)))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Generated delegated feedback did not settle');},
 };
}

test('production feedback adapter regroups unfinished targets and reads authorized completed background without repeating coverage',{timeout:20000},async t=>{
 const f=await fixture(t,'resolved',2),done=await f.start();await f.settle();
 assert.equal(done.status,'completed');assert.deepEqual(f.counts(),{planning:1,feedback:1,extraction:4,reviews:4,maxActiveModels:1});
 assert.equal(f.feedback[0].targets.length,2);assert.equal(f.feedback[0].round,1);assert.equal(f.feedback[0].authorized.length,3);
 const background=done.batches.find(batch=>!batch.supersededBy&&batch.coverage?.some(member=>member.id===f.backgroundId));assert.equal(background?.attempts,1);
 const parent=done.batches.find(batch=>batch.supersededBy);assert.equal(parent?.supersededBy?.length,2);
 const children=done.batches.filter(batch=>batch.replanRound===1);assert.equal(children.length,2);
 for(const batch of children){assert.equal(batch.coverage?.length,1);assert.ok(batch.coverage!.every(member=>member.id!==f.backgroundId));assert.equal(batch.contextRanges?.length,1);assert.equal(batch.contextRanges![0].id,f.backgroundId);assert.ok(batch.reviewReceipt?.reviewRunId);}
 const withBackground=f.extraction.filter(input=>Boolean(modelWork(input).contextMembers?.length));assert.equal(withBackground.length,2);
 for(const input of withBackground){assert.equal(input.evidenceRanges.length,2);assert.equal(modelWork(input).members.length,1);assert.equal(modelWork(input).contextMembers?.length,1);const reviewed=f.reviews.find(review=>review.traceContext?.batchId===input.traceContext?.batchId);assert.deepEqual(reviewed?.evidenceRanges,input.evidenceRanges);}
 assert.equal(f.checkpoints().length,3);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id=?').get(done.id)!.n,3);
 const checkpointSnapshot=f.checkpoints(),counts=f.counts();await f.pipeline.run(done.id);assert.deepEqual(f.counts(),counts);assert.deepEqual(f.checkpoints(),checkpointSnapshot);
 assert.ok(f.runtime.list().find(owner=>owner.profileId==='memory.feedback')?.units.every(unit=>Boolean(unit.artifactId)));
});

test('two unresolved feedback rounds wait for input and cannot repeat completed siblings or reset the bound',{timeout:20000},async t=>{
 const f=await fixture(t,'unresolved'),done=await f.start();await f.settle();
 assert.equal(done.status,'waiting_for_input');assert.equal(done.errorCode,'memory_context_required');assert.deepEqual(f.feedback.map(request=>request.round),[1,2]);
 const target=done.batches.find(batch=>!batch.supersededBy&&batch.replanRound===2);assert.equal(target?.coverage?.[0].state,'needs_context');assert.equal(target?.errorCode,'memory_context_required');
 assert.equal(f.checkpoints().length,1);assert.equal(f.checkpoints()[0].evidence_id,f.backgroundId);assert.equal(f.extraction.filter(input=>modelWork(input).members.some(member=>member.id===f.backgroundId)).length,1);
 const counts=f.counts(),checkpoints=f.checkpoints();await f.pipeline.run(done.id);await f.pipeline.retry(done.id);assert.deepEqual(f.counts(),counts);assert.deepEqual(f.checkpoints(),checkpoints);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_feedback_plans WHERE job_id=?').get(done.id)!.n,2);
});

test('the real control channel rejects outside background and a stop proposal preserves the missing input',{timeout:20000},async t=>{
 const f=await fixture(t,'outside'),done=await f.start();await f.settle();
 assert.equal(done.status,'waiting_for_input');assert.equal(done.errorCode,'memory_context_required');assert.equal(f.feedback.length,1);assert.equal(done.batches.filter(batch=>batch.replanRound).length,0);
 const owner=f.runtime.list().find(owner=>owner.profileId==='memory.feedback');assert.deepEqual(owner?.units.map(unit=>unit.capabilityId),['memory.feedback-stop']);
 const unresolved=done.batches.find(batch=>batch.coverage?.some(member=>member.state==='needs_context'));assert.deepEqual(unresolved?.coverage?.[0].contextRefs,['capture:'+f.outsideId]);
 assert.ok([...f.extraction,...f.reviews].every(input=>!input.evidenceIds?.includes(f.outsideId)));assert.equal(f.checkpoints().length,1);assert.equal(f.memories.list().length,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations').get()!.n,2,'feedback cannot mint an authorization for the third original');
});

test('background-only candidates cannot be committed as new target memories',{timeout:20000},async t=>{
 const f=await fixture(t,'context-candidate'),done=await f.start();
 assert.equal(done.status,'failed');assert.ok(f.extraction.some(input=>Boolean(modelWork(input).contextMembers?.length)));assert.equal(f.memories.list().length,0);assert.equal(f.checkpoints().length,1);assert.equal(f.checkpoints()[0].evidence_id,f.backgroundId);
});

for(const legacyWait of [false,true])test(`a restart reuses the durable feedback proposal after ${legacyWait?'a legacy impossible wait and ':''}an atomic product handoff interruption`,{timeout:20000},async t=>{
 const f=await fixture(t);f.interruptNextApply();const interrupted=await f.start();
 assert.equal(interrupted.status,'failed');assert.equal(f.feedback.length,1);assert.equal(f.checkpoints().length,1);assert.equal(interrupted.batches.filter(batch=>batch.replanRound).length,0,'partial child inserts must roll back');
 assert.deepEqual(f.counts(),{planning:1,feedback:1,extraction:2,reviews:2,maxActiveModels:1});
 const owner=f.runtime.list().find(owner=>owner.profileId==='memory.feedback');assert.ok(owner?.planningComplete);const unitId=owner.units[0].id;
 const checkpoints=f.checkpoints();if(legacyWait)f.store.db.prepare("UPDATE delegation_works SET json=json_set(json_remove(json,'$.planningComplete','$.plannedUnitIds'),'$.wait',json(?)) WHERE id=?").run(JSON.stringify({unitIds:[unitId],mode:'any'}),owner.id);await f.restart();if(legacyWait)await f.runtime.tick();const done=await f.pipeline.retry(interrupted.id);await f.settle();
 assert.equal(done.status,'completed');assert.equal(f.feedback.length,1,'the saved feedback plan is reused without another planning model');assert.equal(f.counts().planning,1);
 assert.equal(f.checkpoints().length,2);assert.deepEqual(f.checkpoints().filter(row=>row.evidence_id===f.backgroundId),checkpoints);assert.equal(f.runtime.get(owner.id).units[0].id,unitId);
 assert.equal(done.batches.filter(batch=>batch.replanRound===1).length,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_feedback_plans WHERE job_id=?').get(done.id)!.n,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id=?').get(done.id)!.n,2);
 assert.deepEqual(f.counts(),{planning:1,feedback:1,extraction:3,reviews:4,maxActiveModels:1},'the private draft is reused but its retry receives a fresh independent review');
});
