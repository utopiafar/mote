import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseAnswer,type AgentAnswer,type ContextReader,type QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {fixtureMemoryPlan} from './fixtures/memory-planning.js';

// Generated originals and scripted model decisions exercise the combined host
// lifecycle. They do not establish model selection, narrator or date accuracy.
const at='2026-10-13T00:00:00Z';
const facts=Array.from({length:40},(_,index)=>`Generated choice ${index}: option ${index}.`);
const frame='Generated diary retrospective covers 2024; its recording date is 2025-02-03.';
const continuation='Generated continuation confirms these choices are recollections, not future plans.';
const text=(frame+'\n').padEnd(256,'.')+facts.join('\n')+'\n';
const original=text.padEnd(3200,'.')+continuation+'\n'+'.'.repeat(4096-3201-continuation.length);
assert.equal(original.length,4096);

test('HTTP composed personal policy reads context, reviews over 32 selected candidates, then reports source invalidation across restart',{timeout:30000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-composition-'));
 const config:Config={dataDir:directory,token:'generated-composition-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 type Call={jobId?:string;phase?:string;target:MemoryWorkMember[];contextRead:boolean};
 const calls:Call[]=[],spyFailures:string[]=[];
 let node:Awaited<ReturnType<typeof buildApp>>;
 const generate=async(input:QueryInput,reader:ContextReader):Promise<QueryResult&Pick<AgentAnswer,'evidenceReadRanges'>>=>{
  const plan=await fixtureMemoryPlan(input);if(plan)return plan;
  const work=input.taskContext?.memoryWork as {workContract?:string;members:MemoryWorkMember[]}|undefined;
  assert.equal(work?.workContract,'range-evaluation@1');assert.ok(input.evidenceReadRanges?.length);
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const bridge=await startBridge(reader,input,24);
  try{
   const member=work!.members.find(member=>facts.every(quote=>original.slice(member.offset,member.offset+member.length).includes(quote)));
   const call:Call={jobId:input.traceContext?.jobId,phase:input.traceContext?.phase,target:work!.members,contextRead:false};calls.push(call);
   if(member){
    assert.ok(member.offset+member.length<=3200,'the continuation lies outside this batch target');
    const response=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({id:member.id,offset:3200,length:continuation.length})});
    assert.equal(response.status,200);const page=await response.json();assert.equal(page.data[0].ocrText,continuation);call.contextRead=true;
   }
   const memories=member?facts.map((quote,index)=>({domain:'personal',title:'Generated composed choice '+index,statement:`The generated diary recollects choice ${index}: ${quote} [${member.id}]`,uncertainty:'Only the generated diary supports this recollection',admission:{layer:'observation',reason:'Generated model-selected recollection',scope:'This generated diary retrospective',attribution:'observed'},evidenceIds:[member.id],evidence:[{id:member.id,quote,offset:original.indexOf(quote)},{id:member.id,quote:continuation,offset:3200}]})):[];
   const coverage=work!.members.map(target=>({key:target.key,state:target.key===member?.key?'checked':'no_candidates',candidateIndexes:target.key===member?.key?memories.map((_memory,index)=>index):[]}));
   const result=parseAnswer(JSON.stringify({answer:JSON.stringify({memories,coverage}),citationIds:member?[member.id]:[]}),bridge.records);
   return {...result,runId:randomUUID(),trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }finally{await bridge.close();}
 };
 const observedGenerate=async(input:QueryInput,reader:ContextReader)=>{try{return await generate(input,reader);}catch(error){spyFailures.push(error instanceof Error?error.message:String(error));throw error;}};
 const dependencies={backgroundWorker:false,createModelAgent:async(_settings:unknown,reader:ContextReader)=>({configured:true,close:async()=>{},query:(input:QueryInput)=>observedGenerate(input,reader)})};
 const open=async()=>{node=await buildApp(config,dependencies);await node.app.ready();};await open();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const api=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'}});
 const view=(await api('GET','/api/memory-settings')).json(),settings=view.settings;
 const configured=await api('PUT','/api/memory-settings',{revision:view.revision,settings:{...settings,batchCharacters:2048}});assert.equal(configured.statusCode,200,configured.body);
 const created=await api('POST','/api/sources',{id:'generated-composition',name:'Generated composition',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});assert.equal(created.statusCode,200,created.body);
 const item={externalId:'generated-diary',observedAt:at,kind:'message',layer:'original',document:{contentRole:'authored',recordedAt:'2025-02-03T00:00:00Z',timeBasis:'recorded'}};
 const inserted=await api('PUT','/api/sources/generated-composition/items',{...item,revision:'1',text:original});assert.equal(inserted.statusCode,200,inserted.body);
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();
 const material=node.materials.list({sourceId:'generated-composition'}).items[0];assert.ok(material);
 const ids=node.materials.input(material.ref,['source-body'])!.evidenceIds;
 assert.equal(ids.length,1,'select only the formal source-body output');
 const started=await api('POST','/api/memory-jobs',{evidenceIds:ids,recipes:[{id:'mote.personal-memory',version:'5'}]});assert.equal(started.statusCode,202,started.body);
 const done=await node.memoryPipeline.run(started.json().id);assert.equal(done.status,'completed',JSON.stringify({spyFailures,batches:done.batches.map(batch=>({status:batch.status,error:batch.errorCode,validation:batch.validationFailures}))}));assert.equal(done.memoryCount,40);
 assert.ok(done.authorizedChunks.length>0);
 assert.ok(done.batches.every(batch=>batch.strategy?.workContract==='range-evaluation@1'&&!batch.supersededBy));
 const selected=done.batches.find(batch=>batch.memoryIds.length===40)!;assert.ok(selected);assert.equal(selected.coverage!.length,1,'context reads do not add coverage rows');
 const phases=calls.filter(call=>call.jobId===done.id&&call.contextRead);assert.deepEqual(phases.map(call=>call.phase),['extract','review']);
 for(const id of done.memoryIds){const memory=node.memories.get(id)!;assert.equal(memory.reviewReceipt?.decision,'independent');assert.notEqual(memory.reviewReceipt?.draftRunId,memory.reviewReceipt?.reviewRunId);assert.ok(memory.evidence!.some(span=>span.offset===3200&&span.quote===continuation));}
 const before=calls.length;
 const changed=await api('PUT','/api/sources/generated-composition/items',{...item,revision:'2',text:'Generated replacement diary; the earlier choices are withdrawn.'});assert.equal(changed.statusCode,200,changed.body);
 const verify=async()=>{
  const detailResponse=await api('GET','/api/memory-jobs/'+done.id);assert.equal(detailResponse.statusCode,200,detailResponse.body);const detail=detailResponse.json();
  const page=await api('GET','/api/memory-jobs');assert.equal(page.statusCode,200,page.body);const summary=page.json().items.find((row:{id:string})=>row.id===done.id);assert.ok(summary);
  assert.equal(detail.outcome,'input_invalidated');assert.equal(detail.failedBatches,0);assert.equal(detail.invalidatedBatches,detail.totalBatches);assert.equal(detail.completedBatches,0);
  assert.equal(summary.outcome,detail.outcome);assert.equal(summary.failedBatches,0);assert.equal(summary.invalidatedBatches,detail.invalidatedBatches);
  assert.equal(node.memories.list({limit:100}).length,0);assert.equal(calls.length,before,'a source correction must not authorize fresh model work');
  return detail;
 };
 const invalidated=await verify();await node.app.close();await open();
 const restored=await verify();assert.deepEqual(restored.batches.map((batch:{id:string;status:string})=>[batch.id,batch.status]),invalidated.batches.map((batch:{id:string;status:string})=>[batch.id,batch.status]));
});
