import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {Config} from '../src/config.js';
import {buildApp} from '../src/app.js';
import {importMemoryProgress} from '../src/import-memory-progress.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

const config=(dataDir:string):Config=>({dataDir,token:'generated-progress-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});

for(const mode of ['failed','waiting'] as const)test(`import receipt progress preserves committed split siblings when another member is ${mode}`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-progress-'));let badId='';
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{
    if((input.taskContext?.memoryWork as {feedback?:unknown})?.feedback){
      await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'generated-stop',capabilityId:'memory.feedback-stop',title:'Generated missing context',goal:'Wait for authorized context',input:{reason:'Generated missing context is outside the grant'}}]});
      return {runId:'generated-stop',trace:[],citations:[],answer:'Generated context stop submitted'};
    }
    const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}).members;
    if(members.length===1&&members[0].inputKey===badId&&mode==='failed')throw Error('Generated terminal model failure');
    return {runId:'generated-'+(input.taskContext?.untrustedMemoryDraft?'review':'draft'),trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:members.length===1&&member.inputKey===badId&&mode==='waiting'?'needs_context':'no_candidates',candidateIndexes:[],...(members.length===1&&member.inputKey===badId&&mode==='waiting'?{reason:'Generated missing context'}:{})})),capacity:{saturated:members.length>1}})};
  }}});
  await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated',name:'Generated originals',kind:'custom',deviceId:'generated',platform:'import'});
  const ids:string[]=[];
  for(let index=0;index<2;index++)ids.push((await node.sources.upsert('generated',{externalId:String(index),revision:'1',text:'Generated original '+index,observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'})).id);
  badId=ids[1];await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
  const jobId=String(node.store.db.prepare('SELECT job_id FROM memory_input_authorizations WHERE capture_id=?').get(ids[0])!.job_id),job=await node.memoryPipeline.run(jobId);
  assert.equal(job.status,mode==='failed'?'failed':'waiting_for_input');
  assert.ok(job.batches.some(batch=>batch.supersededBy?.length&&batch.status==='completed'));
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
  assert.equal(importMemoryProgress(node.store,[ids[0]])!.completed,1);
  assert.equal(importMemoryProgress(node.store,[ids[1]])![mode==='failed'?'failed':'pending'],1,JSON.stringify({progress:importMemoryProgress(node.store,[ids[1]]),batches:job.batches.map(batch=>({status:batch.status,error:batch.errorCode,coverage:batch.coverage}))}));
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
    return {runId:'generated-range',trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),capacity:{saturated:members[0].length>1500}})};
  }}});
  await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated',name:'Generated long original',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await node.sources.upsert('generated',{externalId:'long',revision:'1',text:'Generated bounded source. '.repeat(80),observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true,10),1);
  const jobId=String(node.store.db.prepare('SELECT job_id FROM memory_input_authorizations WHERE capture_id=?').get(id)!.job_id),job=await node.memoryPipeline.run(jobId);
  assert.equal(job.status,'failed');assert.ok(job.batches.some(batch=>batch.supersededBy?.length));assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
  const progress=importMemoryProgress(node.store,[id])!;assert.equal(progress.completed,0);assert.equal(progress.failed,1);
  failSecondHalf=false;assert.equal((await node.memoryPipeline.retry(jobId)).status,'completed');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
  assert.equal(importMemoryProgress(node.store,[id])!.completed,1,'all committed leaf intervals cover the complete original after retry');
});

test('legacy jobs keep whole-job import progress without package coverage metadata',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-import-memory-legacy-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>({runId:'generated-empty',trace:[],citations:[],answer:'{"memories":[]}'})}});
  await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated',name:'Generated original',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await node.sources.upsert('generated',{externalId:'legacy',revision:'1',text:'Generated legacy original',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  await node.materialOrganizer.tick();await node.sourcePipelines.tick();
  const material=node.materials.list().items[0];assert.ok(material);
  const job=node.memoryPipeline.create({evidenceIds:node.materials.evidenceIds(material.ref)});
  const scope=String(node.store.db.prepare('SELECT scope FROM memory_input_authorizations WHERE capture_id=?').get(id)!.scope);
  node.store.db.exec('BEGIN IMMEDIATE');assert.ok(node.materialMemoryWork.inputs.claim('generated',id,job.id,scope));node.store.db.exec('COMMIT');
  assert.equal((await node.memoryPipeline.run(job.id)).status,'completed');assert.equal(importMemoryProgress(node.store,[id])!.completed,1);
  assert.equal(importMemoryProgress(node.store,[id,id])!.total,1);assert.equal(importMemoryProgress(node.store,[id,id])!.receipts,1);
});
