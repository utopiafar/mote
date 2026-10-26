import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId} from '../src/materials.js';
import {sha256} from '../src/store.js';
import {validMemoryFeedbackGroup,validMemoryFeedbackPlan,type MemoryFeedbackRequest} from '../src/memory-feedback.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

const at='2026-10-13T00:00:00Z';
const member=(index:number):MemoryWorkMember=>({key:sha256('generated-range-'+index),id:randomUUID(),offset:0,length:30,fingerprint:sha256('generated-original-'+index),state:'pending',memoryIds:[]});
test('feedback keeps large exact target/context sets and partitions without a group-count quota',()=>{
 const targets=Array.from({length:80},(_,index)=>member(index)),context=Array.from({length:80},(_,index)=>member(index+80));
 const request:MemoryFeedbackRequest={jobId:'generated-job',batchId:'generated-batch',round:1,contextTime:at,targets,authorized:[...targets,...context],coverage:targets.map(target=>({key:target.key,state:'needs_context',candidateIndexes:[],contextRefs:[context.at(-1)!.key]})),requireNewContext:true};
 const input={memberKeys:targets.map(target=>target.key),contextKeys:context.map(value=>value.key),instruction:'Inspect these exact generated ranges with the authorized context.'};
 assert.equal(validMemoryFeedbackGroup(request,input),true);
 assert.equal(validMemoryFeedbackPlan(request,[{...input,id:'generated-group',goal:'Resolve the specific missing context'}]),true);
 const groups=targets.map((target,index)=>({...input,memberKeys:[target.key],contextKeys:[context[index].key],id:'generated-group-'+index,goal:'Inspect this exact target'}));
 assert.equal(validMemoryFeedbackPlan(request,groups),true,'normal submission pagination does not limit the whole plan to eight groups');
 assert.equal(validMemoryFeedbackGroup(request,{...input,contextKeys:[sha256('generated-ungranted')]}),false);
 assert.equal(validMemoryFeedbackGroup(request,{...input,memberKeys:[...input.memberKeys,input.memberKeys[0]]}),false);
 assert.equal(validMemoryFeedbackPlan(request,groups.slice(1)),false,'every target is still required exactly once');
 assert.equal(validMemoryFeedbackPlan(request,[...groups,groups[0]]),false);
 assert.equal(validMemoryFeedbackGroup({...request,history:[{batchId:'prior',targets,contextMembers:context}]},input),false,'the full catalog cannot manufacture new context from an already inspected combination');
});

test('a large reviewed needs-context batch recovers through the real coordinator without clipping targets or grants',{timeout:30000},async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mote-large-feedback-'));
 const config:Config={dataDir,token:'generated-feedback-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const calls:QueryInput[]=[],requests:MemoryFeedbackRequest[]=[];let targetIds:string[]=[],contextIds:string[]=[],node!:Awaited<ReturnType<typeof buildApp>>,fixtureMaterial:{id:string;ref:string}|undefined,checkedOrganizer=false;
 const settleOrganizer=async()=>{
  for(let turn=0;turn<20;turn++){await node.materialOrganizer.tick(200);const status=node.materialOrganizer.status();if(status.pendingChanges===0&&status.pendingSteps===0&&status.backfills.every(backfill=>backfill.complete))return status;await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.fail('Generated organizer did not finish its source changes and startup backfills: '+JSON.stringify(node.materialOrganizer.status()));
 };
 const generate=async(input:QueryInput):Promise<QueryResult>=>{
  if(input.traceContext?.phase==='extract'&&!checkedOrganizer){checkedOrganizer=true;await settleOrganizer();assert.equal(node.materials.get(fixtureMaterial!.id)!.ref,fixtureMaterial!.ref,'a real organizer turn cannot replace the fixture head after source intake and startup backfills are drained');}
  calls.push(input);
  if(input.traceContext?.phase==='feedback-planning'){
   const request=(input.taskContext!.memoryWork as {feedback:MemoryFeedbackRequest}).feedback;requests.push(structuredClone(request));
   assert.equal(input.hostRetrieval,'none');assert.equal(request.targets.length,80);assert.equal(request.authorized.length,160);
   assert.deepEqual(new Set(request.targets.map(target=>target.id)),new Set(targetIds));
   assert.ok(request.authorized.some(value=>value.id===contextIds.at(-1)),'the late context remains in the catalog');
   assert.equal(node.memoryPipeline.feedbackAllowed(request),true);
   assert.equal(node.memoryPipeline.feedbackAllowed({...request,authorized:[...request.authorized,member(999)]}),false);
   const catalog=await input.hostControlChannel!.execute('delegation_capabilities',{});
   const definition=(catalog.data as {capabilities:{id:string;inputSchema:any}[]}).capabilities.find(value=>value.id==='memory.feedback-group');
   assert.ok(definition);assert.equal(definition.inputSchema.properties.memberKeys.maxItems,undefined);assert.equal(definition.inputSchema.properties.contextKeys.maxItems,undefined);
   await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'generated-all-targets',capabilityId:'memory.feedback-group',title:'Resolve the generated referents',goal:'Complete only the unfinished targets',input:{memberKeys:request.targets.map(value=>value.key),contextKeys:request.authorized.filter(value=>contextIds.includes(value.id)).map(value=>value.key),instruction:'Interpret each target using these exact authorized background ranges.'}}]});
   return {answer:'Generated exact context plan submitted.',citations:[],trace:[],runId:randomUUID()};
  }
  const work=input.taskContext!.memoryWork as {members:MemoryWorkMember[];contextMembers:MemoryWorkMember[]};
  assert.equal(work.members.length,80);assert.deepEqual(new Set(work.members.map(value=>value.id)),new Set(targetIds));
  const restored=Boolean(work.contextMembers?.length);
  if(restored){assert.equal(work.contextMembers.length,80);assert.deepEqual(new Set(work.contextMembers.map(value=>value.id)),new Set(contextIds));}
  return {answer:JSON.stringify({memories:[],coverage:work.members.map(value=>({key:value.key,state:restored?'no_candidates':'needs_context',candidateIndexes:[],...(restored?{}:{reason:'The generated referent is explained by a separately authorized original.',contextRefs:[contextIds.at(-1)]})}))}),citations:[],trace:[],runId:randomUUID()};
 };
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:true,close:async()=>{},query:generate})});await node.app.ready();
 t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 node.sources.register({id:'generated-feedback-source',name:'Generated originals',kind:'custom',deviceId:'generated',platform:'import'});
 const texts=Array.from({length:160},(_,index)=>'Generated original '+index+' records an exact scoped referent.');
 const original=await node.sources.upsert('generated-feedback-source',{externalId:'original',revision:'1',observedAt:at,kind:'message',layer:'original',text:texts.join('\n')});
 // backgroundWorker:false leaves the real five-second Material producer enabled.
 // Consume original intake and startup backfills before installing the generated
 // 160-block head; otherwise a later producer turn correctly invalidates it.
 const sourceSequence=Number(node.store.db.prepare('SELECT max(seq) seq FROM changes').get()!.seq),organized=await settleOrganizer();
 assert.ok(organized.cursor>=sourceSequence);assert.equal(organized.stepCounts.running,0);assert.equal(organized.stepCounts.waiting,0);
 const material=node.materials.publish({id:materialId('generated-feedback-source','original'),kind:'mote.note',schemaVersion:1,title:'Generated large dialogue',origin:{sourceId:'generated-feedback-source',externalId:'original',deviceId:'generated'},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:texts.map((text,index)=>({id:'paragraph-'+index,kind:'text',format:'plain',text,memberIds:[original.id]})),artifacts:[{key:'source-body',state:'ready',blockIds:texts.map((_,index)=>'paragraph-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}},{expectedRevision:node.materials.get(materialId('generated-feedback-source','original'))!.revision});
 fixtureMaterial={id:material.id,ref:material.ref};
 const ids=node.materials.input(material.ref,['source-body'])!.evidenceIds;targetIds=ids.slice(0,80);contextIds=ids.slice(80);
 const job=node.memoryPipeline.create({evidenceIds:ids,evidenceRanges:targetIds.map((id,index)=>({id,offset:0,length:texts[index].length})),contextEvidenceRanges:contextIds.map((id,index)=>({id,offset:0,length:texts[index+80].length})),recipes:[{id:'mote.personal-memory',version:'5'}]});
 assert.equal(job.totalBatches,1);assert.equal(job.authorizedChunks!.length,160);
 const done=await withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id));
 assert.equal(done.status,'completed',JSON.stringify({jobId:done.id,errorCode:done.errorCode,failureReceipt:done.failureReceipt,batches:done.batches.map(batch=>({id:batch.id,status:batch.status,errorCode:batch.errorCode,failureReceipt:batch.failureReceipt}))}));assert.equal(requests.length,1);
 assert.equal(calls.filter(input=>input.traceContext?.phase==='extract').length,2);assert.equal(calls.filter(input=>input.traceContext?.phase==='review').length,2);
 const restored=done.batches.filter(batch=>batch.replanRound===1);assert.equal(restored.length,1,'the model-selected context handoff does not introduce automatic subdivisions');
 assert.equal(restored[0].coverage!.length,80);assert.equal(restored[0].contextRanges!.length,80);assert.ok(restored[0].reviewReceipt);
 assert.deepEqual(new Set(node.store.db.prepare('SELECT evidence_id FROM memory_checkpoints').all().map(value=>String(value.evidence_id))),new Set(targetIds),'context-only reads never complete additional targets');
 assert.equal(node.memories.list().length,0);
 node.store.delete(original.id);assert.equal(node.memoryPipeline.feedbackAllowed(requests[0]),false,'source deletion still revokes the complete historical grant');
});
