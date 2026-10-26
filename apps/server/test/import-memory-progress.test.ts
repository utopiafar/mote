import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {fixtureMemoryWorkResult} from './fixtures/memory-planning.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import type {Config} from '../src/config.js';
import {buildApp} from '../src/app.js';
import {importMemoryProgress} from '../src/import-memory-progress.js';
import {materialId} from '../src/materials.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

const config=(dataDir:string):Config=>({dataDir,token:'generated-progress-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});

for(const mode of ['failed','waiting','planner-failed'] as const)test(`import receipt progress preserves committed configured batches when another member is ${mode}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-progress-'));let badId='',contextId='',planningCalls=0;
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    if((input.taskContext?.memoryWork as {feedback?:unknown})?.feedback){
      if(mode==='planner-failed'){planningCalls++;input.onTrace?.({type:'run.started',runId:'generated-feedback-'+planningCalls});throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});}
      await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'generated-stop',capabilityId:'memory.feedback-stop',title:'Generated missing context',goal:'Wait for authorized context',input:{reason:'Generated missing context is outside the grant'}}]});
      return {runId:'generated-stop',trace:[],citations:[],answer:'Generated context stop submitted'};
    }
    const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}).members;
    if(members[0].inputKey!==badId)contextId=members[0].id;
    if(members.length===1&&members[0].inputKey===badId&&mode==='failed')throw Error('Generated terminal model failure');
    return {runId:'generated-'+(input.taskContext?.untrustedMemoryDraft?'review':'draft'),trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:members.length===1&&member.inputKey===badId&&mode!=='failed'?'needs_context':'no_candidates',candidateIndexes:[],...(members.length===1&&member.inputKey===badId&&mode!=='failed'?{reason:'Generated missing context',...(mode==='planner-failed'?{contextRefs:[contextId]}:{})}:{})}))})};
  }}});
  await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.lifecycle.save({revision:node.configService.revision,settings:{...node.lifecycle.settings(),batchCharacters:256}});
  node.sources.register({id:'generated',name:'Generated originals',kind:'custom',deviceId:'generated',platform:'import'});
  const ids:string[]=[];
  for(let index=0;index<2;index++)ids.push((await node.sources.upsert('generated',{externalId:String(index),revision:'1',text:('Generated original '+index).padEnd(200,'.'),observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'})).id);
  badId=ids[1];await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
  const jobId=String(node.store.db.prepare('SELECT job_id FROM memory_input_authorizations WHERE capture_id=?').get(ids[0])!.job_id),job=await node.memoryPipeline.run(jobId);
  assert.equal(job.status,mode==='waiting'?'waiting_for_input':'failed');
  if(mode==='planner-failed'){assert.ok(planningCalls>0&&planningCalls<=3);assert.equal(node.featureServices.delegation.list().find(work=>work.profileId==='memory.feedback')?.failureReceipt?.attempt,3);assert.equal(job.errorCode,'memory_feedback_planning_failed');assert.equal(node.featureServices.ownerQuestions.page({operationId:'memory:'+jobId}).items.length,0);assert.equal(node.featureServices.activity.detail('memory:'+jobId).state,'failed');}
  assert.ok(job.batches.some(batch=>batch.status==='completed'));assert.ok(job.batches.every(batch=>!batch.supersededBy));
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
  assert.equal(importMemoryProgress(node.store,[ids[0]])!.completed,1);
  assert.equal(importMemoryProgress(node.store,[ids[1]])![mode==='waiting'?'pending':'failed'],1,JSON.stringify({progress:importMemoryProgress(node.store,[ids[1]]),batches:job.batches.map(batch=>({status:batch.status,error:batch.errorCode,coverage:batch.coverage}))}));
  const progress=importMemoryProgress(node.store,ids)!;assert.equal(progress.completed,1);assert.equal(progress.total,2);assert.equal(progress.receipts,2);assert.deepEqual(progress.jobIds,[jobId]);
  // Completed work remains a fact after cancellation or receipt revocation;
  // neither event can turn its unfinished sibling into completed coverage.
  node.memoryPipeline.cancel(jobId);await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10);
  assert.match(String(node.store.db.prepare('SELECT error FROM material_memory_requests WHERE input_key=?').get(badId)!.error),/cancelled/);
  assert.equal(importMemoryProgress(node.store,[badId])!.cancelled,1,'the queue cancellation marker is not a model failure');
  node.store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=1 WHERE job_id=?').run(jobId);
  assert.equal(importMemoryProgress(node.store,[ids[0]])!.completed,1);assert.equal(importMemoryProgress(node.store,[badId])!.disabled,1);
  await node.sources.upsert('generated',{externalId:'0',revision:'2',text:'Generated revised original',observedAt:'2026-09-02T00:00:00Z',kind:'file',layer:'original'});
  assert.equal(importMemoryProgress(node.store,[ids[0]])!.unavailable,1);
});

test('one committed subrange never completes an original whose remaining range failed',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-ranges-'));let failSecondHalf=true;
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}).members;
    if(members[0].offset>0&&failSecondHalf)throw Error('Generated failed second half');
    return {runId:'generated-range',trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))})};
  }}});
  await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.lifecycle.save({revision:node.configService.revision,settings:{...node.lifecycle.settings(),batchCharacters:1024}});
  node.sources.register({id:'generated',name:'Generated long original',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await node.sources.upsert('generated',{externalId:'long',revision:'1',text:'Generated bounded source. '.repeat(80),observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
  const jobId=String(node.store.db.prepare('SELECT job_id FROM memory_input_authorizations WHERE capture_id=?').get(id)!.job_id),job=await node.memoryPipeline.run(jobId);
  assert.equal(job.status,'failed');assert.ok(job.batches.every(batch=>!batch.supersededBy));assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
  const progress=importMemoryProgress(node.store,[id])!;assert.equal(progress.completed,0);assert.equal(progress.failed,1);
  failSecondHalf=false;assert.equal((await node.memoryPipeline.retry(jobId)).status,'completed');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,job.totalBatches);
  assert.equal(importMemoryProgress(node.store,[id])!.completed,1,'all originally configured intervals cover the complete original after retry');
});

test('legacy jobs keep whole-job import progress without package coverage metadata',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-legacy-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>fixtureMemoryWorkResult(input,{runId:'generated-empty',trace:[],citations:[],answer:'{"memories":[]}'})}});
  await node.app.ready();await authorizeFixtureModels(node);t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated',name:'Generated original',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await node.sources.upsert('generated',{externalId:'legacy',revision:'1',text:'Generated legacy original',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  const material=node.materials.list().items[0];assert.ok(material);
  const job=node.memoryPipeline.create({evidenceIds:node.materials.evidenceIds(material.ref)});
  const scope=String(node.store.db.prepare('SELECT scope FROM memory_input_authorizations WHERE capture_id=?').get(id)!.scope);
  node.store.db.exec('BEGIN IMMEDIATE');assert.ok(node.materialMemoryWork.inputs.claim('generated',id,job.id,scope));node.store.db.exec('COMMIT');
  assert.equal((await node.memoryPipeline.run(job.id)).status,'completed');
  // A persisted pre-coverage job uses its full committed receipt, not a new model call.
  node.store.db.prepare("UPDATE memory_batches SET json=json_remove(json,'$.coverage') WHERE job_id=?").run(job.id);
  assert.equal(importMemoryProgress(node.store,[id])!.completed,1);
  assert.equal(importMemoryProgress(node.store,[id,id])!.total,1);assert.equal(importMemoryProgress(node.store,[id,id])!.receipts,1);
});


test('equal receipt keys and scopes never project another source queue failure',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-source-boundary-'));let queries=0;
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{queries++;throw Error('This read-only progress fixture cannot execute a model');}}});
  await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  for(const sourceId of ['generated-left','generated-right'])node.sources.register({id:sourceId,name:'Generated independent source',kind:'custom',deviceId:'generated',platform:'import'});
  const original={externalId:'same-external-id',revision:'1',text:'Generated original with source-scoped receipt identity',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'};
  const left=await node.sources.upsert('generated-left',original);await node.sources.upsert('generated-right',original);await node.materialOrganizer.tick();
  const leftMaterial=materialId('generated-left',original.externalId),rightMaterial=materialId('generated-right',original.externalId);
  const receipt=node.store.db.prepare('SELECT input_key,scope FROM material_memory_requests WHERE material_id=?').get(leftMaterial)!;assert.ok(receipt);
  // Receipt keys are scoped to a source. A different source may retain the same
  // key and recipe scope, but its queue error cannot become this original's state.
  node.store.db.prepare("UPDATE material_memory_requests SET input_key=?,scope=?,error='generated_other_source_failure' WHERE material_id=?").run(receipt.input_key,receipt.scope,rightMaterial);
  const pending=importMemoryProgress(node.store,[left.id,left.id])!;assert.equal(pending.total,1);assert.equal(pending.receipts,1);assert.equal(pending.pending,1);assert.equal(pending.failed,0);
  node.store.db.prepare("UPDATE material_memory_requests SET error='generated_same_source_failure' WHERE material_id=?").run(leftMaterial);
  const failed=importMemoryProgress(node.store,[left.id])!;assert.equal(failed.failed,1);assert.equal(failed.pending,0,'a matching source failure remains visible');
  node.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=?').run(leftMaterial);
  const absent=importMemoryProgress(node.store,[left.id])!;assert.equal(absent.pending,1);assert.equal(absent.failed,0,'an absent matching queue preserves the left-joined receipt');
  assert.equal(queries,0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n,0,'progress never creates work');
});
