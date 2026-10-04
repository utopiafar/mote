import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';

async function fixture(t:{after(fn:()=>Promise<void>|void):void},organize=true){
  const directory=mkdtempSync(join(tmpdir(),'mote-authored-memory-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const organizers=new MaterialOrganizerRuntime(store,materials);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const originalId=randomUUID(),deviceId='generated-owner';
  await store.ingest({id:originalId,deviceId,deviceName:'Generated owner',platform:'import',
    appId:'dev.mote.web.notes',appName:'Notes',source:'note',capturedAt:'2026-09-20T00:00:00.000Z',
    durationMs:0,ocrText:'Generated note: a meeting moved from Tuesday to Friday.',
    privacy:{excluded:false,redacted:false,mode:'none'}});
  if(organize)await organizers.tick();
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,organizers.sourceItemRecipes);
  const strategy=new MemoryStrategies().resolve({id:'mote.personal-memory',version:'2'}).binding;
  return {store,sources,materials,organizers,reader,originalId,deviceId,strategy};
}

test('current built-in authored Material is admitted once, without a second raw original batch',async t=>{
  const f=await fixture(t),material=f.materials.list({kind:'mote.note'}).items[0]!;
  const owner=f.store.db.prepare('SELECT organizer_id,version,group_json,active FROM material_organizer_groups WHERE material_id=?').get(material.id);
  assert.deepEqual({id:owner.organizer_id,version:owner.version,active:owner.active},
    {id:'mote.authored-record',version:'2',active:1});
  assert.equal(JSON.parse(String(owner.group_json)).captureId,f.originalId);
  assert.equal(f.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(material.origin.sourceId),undefined);
  assert.equal(f.reader.materialPlanAllowed(material.id),true);
  assert.equal(f.reader.materialAllowedForMemory(material.ref,undefined,['material']),true);
  const selected=f.reader.memoryPlanSelection({},[f.strategy]);
  assert.equal(selected.manualPlans.length,1);
  assert.deepEqual(selected.evidenceIds,[]);
  assert.deepEqual(selected.unavailable,[]);
  const anchor=f.materials.input(material.ref,['material'])!.evidenceIds[0];
  const exact=f.reader.memoryPlanSelection({},[f.strategy],undefined,[f.originalId,anchor]);
  assert.equal(exact.manualPlans.length,1);
  assert.deepEqual(exact.evidenceIds,[],'an explicit original plus its current authored anchor is one input');
  const legacy=f.reader.memorySelection();
  assert.equal(legacy.evidenceIds.length,1);
  assert.notEqual(legacy.evidenceIds[0],f.originalId);

  // The fake executor is never run. Creating the durable job verifies that
  // planning and batch admission agree without contacting a model.
  const pipeline=fixtureMemoryPipeline({store:f.store,memories:f.reader.memories,
    materialSourceCurrent:(pin,id)=>f.reader.materialSourceCurrent(pin,id),
    materialPlanAllowed:id=>f.reader.materialPlanAllowed(id),
    materialInput:(ref,required)=>f.materials.input(ref,required),
    materialAllowedForMemory:(ref,_profileId,required)=>f.reader.materialAllowedForMemory(ref,undefined,required),
    model:()=>'',configured:()=>false,query:async()=>{throw Error('Fake model must not run');},
    review:async()=>{throw Error('Fake review must not run');}});
  t.after(()=>pipeline.close());
  const job=pipeline.create({manualPlans:selected.manualPlans,recipes:[{id:'mote.personal-memory',version:'2'}],evidenceIds:[]});
  assert.equal(job.inputPlans?.total,1);
  assert.equal(job.inputPlans?.blocked,0);
  assert.equal(job.totalBatches,1);
  assert.deepEqual(job.batches[0]?.planIds?.length,1);
});

test('an authored-looking prefix cannot authorize an unowned Material',async t=>{
  const f=await fixture(t,false),sourceId='authored:'+createHash('sha256').update(JSON.stringify(f.deviceId)).digest('hex');
  const material=f.materials.publish({id:materialId(sourceId,f.originalId),kind:'mote.note',schemaVersion:1,title:'Forged authored origin',
    origin:{sourceId,externalId:f.originalId,deviceId:f.deviceId},
    blocks:[{id:'record',kind:'text',format:'json',text:'Generated body',memberIds:[f.originalId]}],
    members:[{id:f.originalId,kind:'capture',ref:'capture:'+f.originalId}],coverage:{state:'complete'},
    artifacts:[{key:'authored-record',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  assert.equal(f.reader.materialPlanAllowed(material.id),false);
  assert.equal(f.reader.materialAllowedForMemory(material.ref,undefined,['material']),false);
  const selected=f.reader.memoryPlanSelection({},[f.strategy]);
  assert.deepEqual(selected.unavailable,[material.ref]);
  assert.equal(selected.manualPlans.length,0);
});

test('deletion and superseded Material revisions remain inadmissible',async t=>{
  const f=await fixture(t),material=f.materials.list({kind:'mote.note'}).items[0]!;
  assert.equal(f.reader.materialAllowedForMemory(material.ref,undefined,['material']),true);
  const replacement=f.materials.publish({id:material.id,kind:material.kind,schemaVersion:1,title:'Generated replacement',origin:material.origin,
    blocks:[{id:'record',kind:'text',format:'json',text:'Generated replacement body',memberIds:[f.originalId]}],
    members:[{id:f.originalId,kind:'capture',ref:'capture:'+f.originalId}],coverage:{state:'complete'},
    artifacts:[{key:'authored-record',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},
    {expectedRevision:material.revision});
  assert.notEqual(replacement.ref,material.ref);
  assert.equal(f.reader.materialAllowedForMemory(material.ref,undefined,['material']),false);
  assert.equal(f.reader.materialSourceCurrent({kind:'material-revision',ref:material.ref},material.id),false);
  f.store.delete(f.originalId);
  assert.equal(f.reader.materialPlanAllowed(material.id),false);
  assert.equal(f.reader.materialAllowedForMemory(replacement.ref,undefined,['material']),false);
  assert.deepEqual(f.reader.memoryPlanSelection({},[f.strategy]).evidenceIds,[]);
});

async function historicalDuplicate(t:TestContext){
  const f=await fixture(t),material=f.materials.list({kind:'mote.note'}).items[0]!;
  const selected=f.reader.memoryPlanSelection({},[f.strategy]);
  const control={allowed:false,extracts:0,reviews:0,fingerprint:'a'.repeat(64)};
  const configuration=()=>({owner:'models' as const,fingerprint:control.fingerprint,revision:1,
    profileId:'generated-profile',provider:'generated',model:'generated-model'});
  const pipeline=fixtureMemoryPipeline({store:f.store,memories:f.reader.memories,requireAdmission:true,
    materialSourceCurrent:(pin,id)=>f.reader.materialSourceCurrent(pin,id),
    materialPlanAllowed:id=>control.allowed&&f.reader.materialPlanAllowed(id),
    materialInput:(ref,required)=>f.materials.input(ref,required),
    materialAllowedForMemory:(ref,_profileId,required)=>control.allowed&&f.reader.materialAllowedForMemory(ref,undefined,required),
    model:()=>configuration().model,configured:()=>true,configuration,
    query:async input=>{control.extracts++;const proofId=input.evidenceIds[0],quote=f.reader.memories.readEvidence([proofId])[0].ocrText;return {answer:JSON.stringify({memories:[{
      domain:'personal',title:'Generated rescheduling',statement:`The generated meeting moved [${proofId}]`,
      uncertainty:'Only this generated note supports the change.',
      admission:{layer:'observation',reason:'The changed date may matter later',scope:'This generated meeting',attribution:'user'},
      evidenceIds:[proofId],evidence:[{id:proofId,quote}]}]}),
      citations:[{id:proofId,capturedAt:'2026-09-20T00:00:00.000Z',appName:'Notes',excerpt:quote}],
      trace:[],runId:'generated-extract-'+control.extracts};},
    review:(input,result,strategy)=>reviewMemory(input,result,async()=>({...result,runId:'generated-review-'+ ++control.reviews}),{strategy})});
  t.after(()=>pipeline.close());
  // Separate raw intake and pinned Material inputs require their own model reads.
  const job=pipeline.create({manualPlans:selected.manualPlans,recipes:[{id:'mote.personal-memory',version:'2'}],
    evidenceIds:[f.originalId],modelProfileId:'generated-profile'});
  const first=await pipeline.run(job.id);
  return {f,material,pipeline,job,first,control};
}

test('explicit recheck extracts the pinned Material after completing a separate raw batch',async t=>{
  const {f,material,pipeline,job,first,control}=await historicalDuplicate(t);
  assert.equal(first.status,'failed');
  assert.equal(first.errorCode,'memory_authorization_revoked');
  assert.equal(first.completedBatches,1);
  assert.equal(first.memoryIds.length,1);
  assert.equal(f.reader.memories.get(first.memoryIds[0]).status,'published');
  assert.equal(control.extracts,1);assert.equal(control.reviews,1);
  control.allowed=true;
  const recovered=await pipeline.retry(job.id);
  assert.equal(recovered.status,'completed');
  assert.equal(recovered.inputPlans?.completed,1);
  assert.equal(recovered.batches.length,2);
  assert.ok(recovered.memoryIds.includes(first.memoryIds[0]));
  assert.equal(control.extracts,2);assert.equal(control.reviews,2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get()!.n,2);
  const plan=JSON.parse(String(f.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=?').get(job.id)!.json));
  assert.equal(plan.coveredByBatchId,undefined);assert.ok(plan.resolvedInput,'the new batch pins its own Material revision');
});

test('a deleted reviewed Memory cannot be revived by the authored coverage recheck',async t=>{
  const {f,pipeline,job,first,control}=await historicalDuplicate(t),oldId=first.memoryIds[0];
  assert.equal(first.status,'failed');
  f.reader.memories.delete(oldId);
  control.allowed=true;
  await pipeline.retry(job.id);
  assert.equal(f.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(oldId),undefined);
  assert.ok(control.extracts>1,'the old donor must not suppress normal processing');
  const plan=JSON.parse(String(f.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=?').get(job.id)!.json));
  assert.equal(plan.coveredByBatchId,undefined);
});

test('a changed model configuration cannot reuse the old reviewed batch',async t=>{
  const {f,pipeline,job,first,control}=await historicalDuplicate(t);
  assert.equal(first.status,'failed');
  control.fingerprint='b'.repeat(64);
  control.allowed=true;
  await pipeline.retry(job.id);
  assert.ok(control.extracts>1,'the changed configuration requires a new model attempt');
  const plan=JSON.parse(String(f.store.db.prepare('SELECT json FROM memory_input_plans WHERE job_id=?').get(job.id)!.json));
  assert.equal(plan.coveredByBatchId,undefined);
});
