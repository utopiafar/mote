import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput,ContextReader} from '@mote/agent';
import {buildApp} from '../src/app.js';
import {materialId} from '../src/materials.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import type {Config} from '../src/config.js';

const at='2026-10-13T00:00:00Z';
async function fixture(t:import('node:test').TestContext){
 const dataDir=await mkdtemp(join(tmpdir(),'mote-context-only-grant-'));
 const config:Config={dataDir,token:'generated-context-grant-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 const calls:QueryInput[]=[],failures:unknown[]=[];let inspect:(input:QueryInput,reader:ContextReader)=>Promise<ReturnType<typeof response>>=async input=>response(input);
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{calls.push(input);try{return await inspect(input,reader);}catch(error){failures.push(error);throw error;}}})});await node.app.ready();t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 node.sources.register({id:'generated-context-source',name:'Generated scope',kind:'custom',deviceId:'generated',platform:'import'});
 async function material(key:string,texts:string[]){const original=await node.sources.upsert('generated-context-source',{externalId:key,revision:'1',text:texts.join('\n'),kind:'message',layer:'original',observedAt:at});const value=node.materials.publish({id:materialId('generated-context-source',key),kind:'mote.note',schemaVersion:1,title:'Generated '+key,origin:{sourceId:'generated-context-source',externalId:key,deviceId:'generated'},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:texts.map((text,index)=>({id:'line-'+index,kind:'text' as const,format:'plain',text,memberIds:[original.id]})),artifacts:[{key:'source-body',state:'ready',blockIds:texts.map((_,index)=>'line-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});return {value,ids:node.materials.input(value.ref,['source-body'])!.evidenceIds,texts,originalId:original.id};}
 return {node,calls,failures,material,setInspect(callback:typeof inspect){inspect=callback;}};
}
function response(input:QueryInput){return {answer:generatedMemoryOutput(input,[]),runId:randomUUID(),trace:[],citations:[]};}

test('a persisted manual target difference keeps more than 64 full originals as context-only grants',async t=>{
 const f=await fixture(t),selected=await f.material('selected',Array.from({length:82},(_,index)=>'Generated paragraph '+index+' describes an authorized narrator/date context.')),outside=await f.material('outside',['Generated unselected original.']);
 const targetId=selected.ids[81],targetOffset=20,targetText=selected.texts[81].slice(targetOffset),ranges=[{id:targetId,offset:targetOffset,length:targetText.length}],context=selected.ids.map((id,index)=>({id,offset:0,length:selected.texts[index].length}));let contextReads=0;
 f.setInspect(async(input,reader)=>{
  const work=input.taskContext!.memoryWork as {members:{id:string;offset:number;length:number}[];authorizedMembers:{id:string}[]};
  assert.equal(work.members.length,1);assert.equal(work.members[0].id,targetId);assert.equal(work.members[0].offset,targetOffset);
  assert.ok(work.authorizedMembers.some(member=>member.id===selected.ids[80]),'a context beyond the former 64-member clip remains navigable');
  assert.equal(new Set(input.evidenceReadRanges!.map(range=>range.id)).size,82);
  const bridge=await startBridge(reader,input);try{
   const read=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:selected.ids[80],offset:0,length:selected.texts[80].length})});assert.equal(read.status,200);contextReads++;
   const denied=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:outside.ids[0],offset:0,length:1})});assert.equal(denied.status,400);
   const contextOnly={domain:'personal',title:'Generated context-only proposal',statement:`Generated context-only proposal [${selected.ids[80]}]`,uncertainty:'Generated test only',admission:{layer:'memory',reason:'Generated proposal',scope:'Generated source',attribution:'observed'},evidenceIds:[selected.ids[80]],evidence:[{id:selected.ids[80],quote:selected.texts[80]}]};
   const rejected=await input.validateOutput!({...response(input),answer:generatedMemoryOutput(input,[contextOnly]),citations:[{id:selected.ids[80],capturedAt:at,appName:'Generated',excerpt:''}],evidenceReadRanges:bridge.deliveredRanges});assert.ok(rejected,'a successfully read context-only original cannot become an additional Memory target');
   const answer=response(input);return {...answer,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }finally{await bridge.close();}
 });
 const job=f.node.memoryPipeline.create({evidenceIds:selected.ids,evidenceRanges:ranges,contextEvidenceRanges:context,recipes:[{id:'mote.personal-memory',version:'5'}],timeZone:'Asia/Shanghai'});assert.equal(job.totalBatches,1);assert.deepEqual(job.batches[0].evidenceRanges,ranges);assert.equal(job.authorizedChunks!.length,83,'the target suffix and all full original grants are retained separately');
 const done=await withFixtureOwnerModelWork(f.node,()=>f.node.memoryPipeline.run(job.id));if(f.failures.length)throw f.failures[0];assert.equal(done.status,'completed');assert.equal(contextReads,2,'extractor and independent reviewer both use the real read-only bridge');assert.equal(done.batches[0].coverage!.length,1);assert.equal(done.memoryCount,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1,'reading context never completes additional targets');assert.deepEqual(done.batches[0].evidenceRanges,ranges);
});

test('manual context reads reject unselected IDs, out-of-body ranges and split UTF-16 boundaries',async t=>{
 const f=await fixture(t),selected=await f.material('selected',['Generated target.','A😀B']),outside=await f.material('outside',['Generated outside.']),target={id:selected.ids[0],offset:0,length:selected.texts[0].length};
 const input={evidenceIds:selected.ids,evidenceRanges:[target],recipes:[{id:'mote.personal-memory',version:'5'}]};
 assert.throws(()=>f.node.memoryPipeline.create({...input,contextEvidenceRanges:[{id:outside.ids[0],offset:0,length:1}]}),/explicit manual target selection/);
 assert.throws(()=>f.node.memoryPipeline.create({...input,contextEvidenceRanges:[{id:selected.ids[1],offset:0,length:5}]}),/range changed/);
 assert.throws(()=>f.node.memoryPipeline.create({...input,contextEvidenceRanges:[{id:selected.ids[1],offset:2,length:1}]}),/UTF-16 pair/);
 assert.throws(()=>f.node.memoryPipeline.create({...input,evidenceRanges:undefined,contextEvidenceRanges:[{id:selected.ids[1],offset:0,length:4}]}),/explicit manual target selection/);
 assert.equal(f.node.memoryPipeline.list().length,0);assert.equal(f.calls.length,0);
});

for(const change of ['cancel','delete'] as const)test(`an admitted Memory query rechecks ${change} after yielding before model disclosure`,async t=>{
 const f=await fixture(t),selected=await f.material('yield-boundary',['Generated selected original.']);
 const abort=new AbortController(),gate=f.node.featureServices.agentGate,run=gate.run.bind(gate) as typeof gate.run;
 let entered=0,callsAtSuspension=-1;
 // Keep actual gate admission and the complete app wrapper. Change the
 // generated grant immediately after the admitted callback first suspends.
 gate.run=<T>(work:()=>Promise<T>,signal?:AbortSignal,key?:string):Promise<T>=>run<T>(async()=>{
  const pending=work();entered++;callsAtSuspension=f.calls.length;
  if(change==='cancel')abort.abort();else f.node.store.delete(selected.originalId);
  return pending;
 },signal,key);
 const records=f.node.featureServices.evidenceReader.memories.readEvidence(selected.ids);
 const input:QueryInput={question:'Generated Memory scheduling boundary',responseMode:'memory-extraction',signal:abort.signal,evidenceIds:selected.ids,evidenceRanges:selected.ids.map((id,index)=>({id,offset:0,length:selected.texts[index].length})),processingEvidence:Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)])),processingMaterialInputs:[f.node.materials.input(selected.value.ref,['source-body'])!]};
 const outcome=await withFixtureOwnerModelWork(f.node,()=>f.node.featureServices.queryAgent(input))
  .then(result=>({result,error:undefined}),error=>({result:undefined,error}));
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(entered,1);assert.equal(callsAtSuspension,0,'the admitted callback must suspend before disclosure');
 assert.equal(outcome.result,undefined);assert.equal(f.calls.length,0,'changed authority never reaches the fake model');
 if(change==='cancel')assert.equal(outcome.error?.name,'AbortError');else assert.equal(outcome.error?.code,'context_evidence_restricted');
 assert.equal(gate.snapshot().active,0,'a denied admitted query releases its execution slot');
 if(change==='cancel'){
  gate.run=run;
  const later=await withFixtureOwnerModelWork(f.node,()=>f.node.featureServices.queryAgent({...input,signal:new AbortController().signal}));
  assert.deepEqual(JSON.parse(later.answer),{memories:[]});assert.equal(f.calls.length,1,'a cancelled preparation turn cannot block a later query');
 }
});
