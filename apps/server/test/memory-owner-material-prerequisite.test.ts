import {fixtureMemoryCapacity} from './fixtures/memory-planning.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryPublication} from '../src/memory-publication.js';
import {MemoryPhaseOutputs} from '../src/memory-phase-outputs.js';
import {decodeMemoryBatch} from '../src/memory-private-storage.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import type {MemoryProvider} from '../src/memory-provider-contract.js';
import {MaterialStore} from '../src/materials.js';
import {OwnerQuestions} from '../src/owner-questions.js';
import {installMemoryOwnerQuestions} from '../src/memory-owner-questions.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

// Real durable pipeline/reviewer/question host and restart ordering. Discovery,
// native preparation and model transport are generated fixtures, not a native
// Hindsight, live-model, or device validation claim.
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-owner-material-prerequisite-'));
  const namespace={ownerId:'generated-owner',instanceId:'generated-engine',bindingRevision:1},binding={planId:'instance:generated-engine',generation:1,namespace};
  let nativeCalls=0,reviewCalls=0,modelCalls=0,writeCalls=0,originalId='';
  let store:Store,memories:MemoryStore,pipeline:MemoryPipeline,publication:MemoryPublication,questions:OwnerQuestions,disposeQuestions:()=>void;
  const provider={async put(){writeCalls++;throw Error('The blocked prerequisite must precede any canonical write');},async read(){return null;}} as unknown as MemoryProvider;
  const bindings={binding:()=>structuredClone(binding),provider:()=>provider,plugins:{references:()=>[]},assertNewManualWork:()=>{}} as unknown as MemoryBindings;
  function open(){
    store=new Store(join(directory,'vault'));memories=new MemoryStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_plan_binding(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS memory_provider_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO memory_plan_binding VALUES(1,?)').run(JSON.stringify(binding));
    publication=new MemoryPublication(store,memories,bindings);
    pipeline=new MemoryPipeline({store,memories,publication,requireAdmission:true,
      nativeStages:{prepare:async(_input,context)=>{nativeCalls++;context.provider={instanceId:namespace.instanceId,configurationIdentity:'generated-fixed-configuration',namespace};return {runId:context.opId,answer:'{"memories":[]}',citations:[],trace:[]};},
      settle:async()=>{}},models:{model:()=> 'generated-model',configured:()=>true},phases:{
      query:async()=>{modelCalls++;throw Error('Built-in extraction must not run beside the native fixture');},
      review:async(input,draft,_strategy,origin)=>reviewMemory(input,draft,async reviewInput=>{
        reviewCalls++;assert.equal(reviewInput.traceContext?.phase,'review');
        const members=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members,record=memories.readEvidence([originalId])[0];
        return {runId:randomUUID(),answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'needs_owner_input',candidateIndexes:[],question:{prompt:'Are you the speaker describing the generated telescope?',choices:[],reason:'The generated original does not establish owner correspondence.',evidence:[{id:member.id,quote:record.ocrText}]}})),...fixtureMemoryCapacity(input)}),citations:[{id:originalId,capturedAt:record.capturedAt,appName:record.appName,excerpt:record.ocrText}],trace:[]};
      },{draftOrigin:origin})}});
    questions=new OwnerQuestions(store);
    disposeQuestions=installMemoryOwnerQuestions({questions,continuations:pipeline.ownerContinuations,materials:new MaterialStore(store),store,query:async()=>{throw Error('No owner question or reply can be created without its published Material');}});
  }
  async function close(){disposeQuestions();await pipeline.close();await publication.close();store.close();}
  open();originalId=randomUUID();
  await store.ingest({id:originalId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated speaker: I use a silver telescope.',privacy:{excluded:false,redacted:false,mode:'none'}});
  t.after(async()=>{await close();await rm(directory,{recursive:true,force:true});});
  const phaseCheckpoints=(batchId:string)=>{const outputs=new MemoryPhaseOutputs(store,pipeline.engine);return store.db.prepare('SELECT step_id,phase,input_hash,output_hash FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(batchId).map(row=>({...row,state:pipeline.engine.get(String(row.step_id))!.state,output:outputs.read<any>(String(row.step_id),String(row.input_hash))}));};
  return {phaseCheckpoints,get store(){return store;},get memories(){return memories;},get pipeline(){return pipeline;},get publication(){return publication;},calls:()=>({nativeCalls,reviewCalls,modelCalls,writeCalls}),create:()=>pipeline.create({evidenceIds:[originalId]}),restart:async()=>{await close();open();}};
}

for(const legacyVerified of [false,true])test(`raw-original reviewed owner question remains blocked and durable across restart${legacyVerified?' with an earlier verified publication':''}`,async t=>{
  const f=await fixture(t),job=f.create(),blocked=await f.pipeline.run(job.id),batchId=job.batches[0].id;
  assert.equal(blocked.status,'waiting_for_input');assert.equal(blocked.errorCode,'memory_owner_material_required');
  assert.equal(f.pipeline.engine.get(batchId)!.state,'blocked');assert.equal(f.pipeline.engine.get(batchId)!.error,'memory_owner_material_required');
  const checkpoints=f.phaseCheckpoints(batchId);assert.deepEqual(checkpoints.map(row=>[row.phase,row.state]),[['extract','succeeded'],['review','succeeded']]);
  assert.equal(checkpoints[0].output.draftOrigin,'native-engine');assert.equal(checkpoints[0].output.nativeDraft.context.provider.configurationIdentity,'generated-fixed-configuration');
  const output=checkpoints[1].output,coverage=JSON.parse(output.result.answer).coverage;
  assert.equal(output.reviewReceipt.decision,'independent');assert.equal(output.reviewReceipt.reviewRunId,output.result.runId);assert.equal(coverage[0].state,'needs_owner_input');assert.ok(coverage[0].question);
  assert.deepEqual(f.calls(),{nativeCalls:1,reviewCalls:1,modelCalls:0,writeCalls:0});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM owner_questions').get()!.n,0);
  assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT 1 FROM memory_publications WHERE id=?').get(batchId),undefined,'new work blocks before provider staging');
  if(legacyVerified){
    // Recreate the observed pre-fix durable state through the real staging API.
    // The reviewed zero-candidate envelope was valid; only its Material-bound
    // continuation was missing, so no canonical external body is written.
    const batch=decodeMemoryBatch<any>(f.store,String(f.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(batchId)!.json)),workContract=batch.evaluation.workContract;
    await f.publication.stageExtract(batchId,output.result,'generated-model',{workContract,profile:'personal',requireAdmission:true,reviewReceipt:output.reviewReceipt,evidenceRanges:batch.evidenceRanges,expectedFingerprints:Object.fromEntries(batch.chunks.map((chunk:{id:string;fingerprint:string})=>[chunk.id,chunk.fingerprint]))},()=>{});
    assert.equal(f.store.db.prepare('SELECT state FROM memory_publications WHERE id=?').get(batchId)!.state,'verified');
  }
  await f.restart();assert.deepEqual(f.phaseCheckpoints(batchId),checkpoints,'restart preserves the complete private native proposal and independent review');
  const retried=await f.pipeline.retry(job.id);
  assert.equal(retried.status,'waiting_for_input');assert.equal(retried.errorCode,'memory_owner_material_required');
  assert.deepEqual(f.phaseCheckpoints(batchId),checkpoints,'retry preserves checkpoint hashes, independent verdict and exact unanswered question');
  assert.deepEqual(f.calls(),{nativeCalls:1,reviewCalls:1,modelCalls:0,writeCalls:0},'retry reuses approved output without repeating native/model work');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM owner_questions').get()!.n,0);
  assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT state FROM memory_publications WHERE id=?').get(batchId)?.state,legacyVerified?'verified':undefined,'an earlier verified envelope is never falsely committed');
});
