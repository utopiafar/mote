import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentResponseError,assembleHostContext,estimateSerializedTokens,resolveModelCapabilities,type QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';
import {OPENCODE_GO_PROVIDER} from '@mote/shared/models';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {boundedModelFetch} from '../../../packages/agent/dist/models/http-transport.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {materialId} from '../src/materials.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {memoryWorkInstruction} from '../src/memory-work-contract.js';
import {assertMemoryRequestFits,memoryRequestUsage,memoryRequestSizer,type MemoryRequestCapacity} from '../src/memory-request-budget.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';

const at='2026-11-01T08:00:00Z';

test('OpenCode Go Memory fits a long recording through the HTTP transport guard and reviews every original range',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-http-memory-budget-'));
 const {id:provider,baseUrl,protocol}=OPENCODE_GO_PROVIDER;
 const model='deepseek-v4.1-flash',maxTokens=16384;
 const config:ConfigurationPlatformOptions={
  path:join(directory,'mote.yaml'),privateCredential:{token:'generated-http-budget',tokenPath:'generated'},
  initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},
   server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
   models:{deployment:{model,provider,protocol,baseUrl,maxTokens,reasoningEffort:'max',apiKey:'generated',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},
   diagnostics:{enabled:false,traceEnabled:false,level:'silent'}},
 };
 const {contextWindow}=resolveModelCapabilities({maxTokens});
 let sent=0,refused=0;
 const transport=boundedModelFetch(async()=>{sent++;return new Response('{}');},'http://127.0.0.1:4001',undefined,
  {baseUrl,provider,protocol,contextWindow,maxTokens},()=>{refused++;});
 const calls:{phase:string;ids:string[]}[]=[];
 const failures:unknown[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({
  configured:true,close:async()=>{},query:async input=>{
   const bridge=await startBridge(reader,input);
   try{
    const {system,tools,prompt,outputSchema}=assembleHostContext(input,bridge.seedEvidence,maxTokens);
    const response=await transport(baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({
     model,max_tokens:maxTokens,tools,response_format:outputSchema,
     messages:[{role:'system',content:system},{role:'user',content:prompt}],
    })});
    await response.body?.cancel();
    if(!response.ok)throw new ProviderFailure({category:'permanent',code:'processing_limit',executionStarted:false});
    const members=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;
    assert.deepEqual(bridge.seedEvidence.map(record=>record.id),members.map(member=>member.id));
    assert.deepEqual(bridge.seedEvidence.map(record=>record.ocrText.length),members.map(member=>member.length));
    assert.ok(input.evidenceReadRanges!.length>=members.length);
    calls.push({phase:input.traceContext!.phase!,ids:members.map(member=>member.id)});
    return {answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID(),evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
   }catch(error){failures.push(error);throw error;}finally{await bridge.close();}
  },
 })});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 const sourceId='generated-http-recording';
 node.sources.register({id:sourceId,name:'Generated HTTP recording',kind:'custom',deviceId:'generated',platform:'import'});
 const texts=Array.from({length:320},(_,index)=>`第${String(index).padStart(3,'0')}段合成转写：只读核对虚构的设备流水记录。`);
 const original=await node.sources.upsert(sourceId,{externalId:'recording',revision:'1',text:texts.join('\n'),observedAt:at,kind:'file',layer:'original',document:{contentRole:'transcript',recordedAt:at,timeBasis:'recorded'}});
 const material=node.materials.publish({id:materialId(sourceId,'segmented-recording'),kind:'mote.note',schemaVersion:1,title:'Generated segmented recording',origin:{sourceId,externalId:'segmented-recording',deviceId:'generated',firstAt:at,lastAt:at},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],
  blocks:texts.map((text,index)=>({id:'segment-'+index,kind:'text' as const,format:'plain',text,memberIds:[original.id],evidenceContext:{observedAt:new Date(Date.parse(at)+index*1000).toISOString(),document:{contentRole:'transcript' as const,recordedAt:at,timeBasis:'recorded' as const}}})),
  artifacts:[{key:'transcript',state:'ready',blockIds:texts.map((_,index)=>'segment-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const evidenceIds=node.materials.input(material.ref,['transcript'])!.evidenceIds;
 assert.equal(evidenceIds.length,320);
 const headers={authorization:'Bearer '+config.privateCredential!.token};
 const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds,recipes:[{id:'mote.personal-memory',version:'5'}]}});
 assert.equal(response.statusCode,202,response.body);
 const job=await node.memoryPipeline.run(response.json().id);
 assert.equal(refused,0,'the HTTP transport accepts every planned request');
 if(failures.length)throw failures[0];
 assert.equal(job.status,'completed');
 assert.ok(job.batches.length>1,'the oversized original target list is partitioned before dispatch');
 assert.equal(job.inputPlans.completed,1);
 assert.equal(sent,job.batches.length*2);
 for(const phase of ['extract','review']){
  const delivered=calls.filter(call=>call.phase===phase).flatMap(call=>call.ids);
  assert.equal(delivered.length,evidenceIds.length);
  assert.deepEqual(new Set(delivered),new Set(evidenceIds));
 }
 assert.ok(job.batches.every(batch=>batch.reviewReceipt?.decision==='independent'));
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,evidenceIds.length);
});

test('the serialized request fits exactly at its buffered boundary and fails before dispatch just above it',async t=>{
 const id=randomUUID(),record={id,capturedAt:at,appName:'Generated audio',deviceId:'generated',ocrText:'合成的原始录音🧪'.repeat(600),provenance:{sourceId:'generated-budget',externalId:'generated-original',layer:'original',document:{recordedAt:at,contentRole:'transcript',timeBasis:'recorded'}}};
 const member:MemoryWorkMember={key:'a'.repeat(64),id,offset:0,length:record.ocrText.length,fingerprint:'b'.repeat(64),contextTime:at,state:'pending',memoryIds:[]};
 const input:QueryInput={question:'Independently inspect the complete generated recording.',skill:'memory-strategy',responseMode:'memory-extraction',contextTime:at,evidenceIds:[id],evidenceRanges:[{id,offset:0,length:record.ocrText.length}],evidenceReadRanges:[{id,offset:0,length:record.ocrText.length}],taskContext:{turns:[],memoryWork:{members:[member],contextMembers:[],authorizedMembers:[member],history:[],workContract:'range-evaluation@1',instruction:memoryWorkInstruction([member])}}};
 const bridge=await startBridge({search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[record],activity:async()=>({}),devices:async()=>[]},input);t.after(()=>bridge.close());
 const assembled=assembleHostContext(input,bridge.seedEvidence,65536);
 const serialized=estimateSerializedTokens({system:assembled.system,tools:assembled.tools,prompt:assembled.prompt,outputSchema:assembled.outputSchema}).tokens;
 const base=serialized+128000,window=Math.ceil(base*10/9),capacity={contextWindow:window,maxOutputTokens:128000,draftTokens:65536};
 const usage=memoryRequestUsage(input,[record],capacity);
 assert.equal(usage.inputTokens,serialized,'the planner measures the real producer envelope, including Unicode, exact ranges, metadata, tools and schema');
 assert.equal(usage.totalTokens,window);assert.equal(usage.fits,true);assert.doesNotThrow(()=>assertMemoryRequestFits(input,[record],capacity));
 for(const deficit of [1,50000]){
  const smaller={...capacity,contextWindow:window-deficit};assert.equal(memoryRequestUsage(input,[record],smaller).fits,false);
  assert.throws(()=>assertMemoryRequestFits(input,[record],smaller),(error:unknown)=>error instanceof ProviderFailure&&error.details.code==='processing_limit'&&error.details.executionStarted===false);
 }
 const withDraft=memoryRequestUsage(input,[record],capacity,65536);assert.equal(withDraft.totalTokens-usage.totalTokens,65536,'planning reserves review draft space separately from the native output ceiling');assert.equal(withDraft.fits,false);
 const reviewed={...input,taskContext:{...input.taskContext!,untrustedMemoryDraft:{memories:[],coverage:[],generatedDetail:'x'.repeat(100000)}}};
 assert.throws(()=>assertMemoryRequestFits(reviewed,[record],capacity),ProviderFailure,'an unexpectedly large real review draft is rejected before calling the provider');
 assert.equal(bridge.deliveredRanges[0].length,record.ocrText.length,'budget rejection does not shorten the original or certify its coverage');
 const measure=memoryRequestSizer([record],capacity);
 for(const timeZone of ['UTC','Asia/Shanghai','UTC']){
  const request={...input,timeZone},consumer=await startBridge({search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[record],activity:async()=>({}),devices:async()=>[]},request);
  try{const actual=assembleHostContext(request,consumer.seedEvidence,capacity.draftTokens);assert.equal(measure(request).inputTokens,estimateSerializedTokens({system:actual.system,tools:actual.tools,prompt:actual.prompt,outputSchema:actual.outputSchema}).tokens,'repeated sizing preserves the real consumer envelope and each requested time zone');}finally{await consumer.close();}
 }
});

test('owner retry repartitions a saved overflow using current budgets without certifying or losing any old target',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-budget-retry-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 const capacity:MemoryRequestCapacity={contextWindow:200000,maxOutputTokens:128000,draftTokens:16000};let budgetEnabled=false;
 const calls:{phase:string;ids:string[]}[]=[];
 const query=async(input:MemoryPipelineQuery)=>{
  assertMemoryRequestFits(input,memories.readEvidence(input.evidenceIds),capacity);
  const members=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;
  calls.push({phase:input.traceContext!.phase!,ids:members.map(member=>member.id)});
  return {answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID()};
 };
 const pipeline=new MemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'gpt-6.1-terra',capacity:()=>budgetEnabled?capacity:undefined},phases:{query,review:(input,draft,strategy)=>reviewMemory(input,draft,query,{strategy})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-retry',name:'Generated retry recording',kind:'custom',deviceId:'generated',platform:'import'});
 const ids:string[]=[];
 for(let index=0;index<160;index++){const recordedAt=new Date(Date.parse(at)+index*1000).toISOString();ids.push((await sources.upsert('generated-retry',{externalId:String(index),revision:'1',title:`Generated recording segment ${index} `+'generated metadata '.repeat(40),text:`Generated recording segment ${String(index).padStart(3,'0')}.`,observedAt:recordedAt,kind:'file',layer:'original',document:{contentRole:'transcript',recordedAt,timeBasis:'recorded'}})).id);}
 const job=pipeline.create({evidenceIds:ids});assert.equal(job.totalBatches,1);
 const failed=await pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'processing_limit');assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 budgetEnabled=true;
 const done=await pipeline.retry(job.id),parent=done.batches.find(batch=>batch.id===job.batches[0].id)!,leaves=done.batches.filter(batch=>!batch.supersededBy?.length);
 assert.equal(done.status,'completed');assert.ok(parent.supersededBy!.length>1);assert.deepEqual(parent.evidenceRanges,job.batches[0].evidenceRanges,'the failed parent retains its exact historical target vector');
 assert.deepEqual(leaves.flatMap(batch=>batch.evidenceRanges),job.batches[0].evidenceRanges,'all replacement batches preserve the complete original range vector in order');
 for(const phase of ['extract','review']){const evaluated=calls.filter(call=>call.phase===phase).flatMap(call=>call.ids);assert.equal(evaluated.length,160);assert.deepEqual(new Set(evaluated),new Set(ids));}
 assert.ok(leaves.every(batch=>batch.reviewReceipt?.decision==='independent'));assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,160);
});

for(const {phase,limit} of [
 {phase:'extract',limit:'context'},
 {phase:'extract',limit:'output'},
 {phase:'review',limit:'context'},
 {phase:'review',limit:'output'},
] as const)test(`owner retry of an ${phase} ${limit} capacity failure preserves the frozen ranges`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-live-capacity-'));
 const store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 const capacity:MemoryRequestCapacity={contextWindow:98304,maxOutputTokens:16384,draftTokens:16384};
 const calls:{phase:string;ranges:NonNullable<QueryInput['evidenceRanges']>;readRanges:number;draft?:unknown}[]=[];
 const query=async(input:MemoryPipelineQuery)=>{
  assertMemoryRequestFits(input,memories.readEvidence(input.evidenceIds),capacity);
  const stage=input.traceContext!.phase!,ranges=input.evidenceRanges!;
  calls.push({phase:stage,ranges,readRanges:input.evidenceReadRanges!.length,draft:input.taskContext?.untrustedMemoryDraft});
  const hitCapacity=stage===phase&&(phase==='extract'?ranges.length>8:calls.filter(call=>call.phase==='review').length===1);
  if(hitCapacity){
   if(limit==='output')throw new AgentResponseError('Generated output limit','output_limit');
   throw new ProviderFailure({category:'permanent',code:'processing_limit'});
  }
  const {members}=input.taskContext!.memoryWork as {members:MemoryWorkMember[]};
  return {answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID()};
 };
 const pipeline=new MemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'generated-provider',capacity:()=>capacity},phases:{query,review:(input,draft,strategy)=>reviewMemory(input,draft,query,{strategy})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-capacity',name:'Generated capacity recording',kind:'custom',deviceId:'generated',platform:'import'});
 const evidenceIds=[];
 for(let index=0;index<16;index++){
  const original=await sources.upsert('generated-capacity',{externalId:String(index),revision:'1',text:'Generated recording fragment '+index,observedAt:at,kind:'file',layer:'original',document:{contentRole:'transcript',recordedAt:at,timeBasis:'recorded'}});
  evidenceIds.push(original.id);
 }
 const job=pipeline.create({evidenceIds});
 assert.equal(job.totalBatches,1);
 const failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');
 assert.equal(failed.batches[0].errorCode,limit==='output'?'model_output_capacity':'processing_limit');
 assert.equal(failed.batches[0].phase,phase);
 assert.equal(failed.batches.length,1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 const firstCalls=calls.length;
 await pipeline.run(job.id);
 assert.equal(calls.length,firstCalls,'ordinary re-entry cannot reopen the failed transport step');
 const done=await pipeline.retry(job.id);
 if(phase==='extract'&&limit==='output'){
  assert.equal(done.status,'failed');
  assert.equal(done.batches[0].errorCode,'model_output_capacity');
  assert.equal(done.batches.length,1);
  assert.deepEqual(calls.map(call=>call.ranges),[job.batches[0].evidenceRanges,job.batches[0].evidenceRanges]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  return;
 }
 assert.equal(done.status,'completed');
 if(phase==='extract'){
  const parent=done.batches.find(batch=>batch.id===job.batches[0].id)!;
  const children=parent.supersededBy!.map(id=>done.batches.find(batch=>batch.id===id)!);
  assert.equal(children.length,2);
  assert.deepEqual(children.flatMap(batch=>batch.evidenceRanges),job.batches[0].evidenceRanges);
  for(const call of calls.slice(firstCalls)){
   assert.equal(call.ranges.length,8);
   assert.equal(call.readRanges,8,'the smaller retry leaves room for provider continuations');
  }
  assert.ok(children.every(batch=>batch.reviewReceipt?.decision==='independent'));
 }else{
  assert.deepEqual(calls.map(call=>call.phase),['extract','review','review']);
  assert.deepEqual(calls[2].ranges,calls[1].ranges);
  assert.deepEqual(calls[2].draft,calls[1].draft);
  assert.equal(done.batches.length,1);
  assert.equal(done.batches[0].reviewReceipt?.decision,'independent');
 }
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,16);
});

test('an owner-selected long-output profile resumes the original paused batch under the new allowance',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-profile-retry-'));
 const store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 const old='generated-default',selected='generated-long-output';
 const capacity=(id?:string)=>id===selected
  ?{contextWindow:1000000,maxOutputTokens:128000,draftTokens:128000}
  :{contextWindow:98304,maxOutputTokens:16384,draftTokens:16384};
 const calls:{profile?:string;phase?:string;ranges:QueryInput['evidenceRanges']}[]=[];
 const query=async(input:MemoryPipelineQuery)=>{
  const {modelProfileId,traceContext,evidenceRanges}=input;
  assertMemoryRequestFits(input,memories.readEvidence(input.evidenceIds),capacity(modelProfileId));
  calls.push({profile:modelProfileId,phase:traceContext?.phase,ranges:evidenceRanges});
  if(modelProfileId!==selected)throw new ProviderFailure({category:'permanent',code:'processing_limit'});
  const {members}=input.taskContext!.memoryWork as {members:MemoryWorkMember[]};
  return {answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID()};
 };
 const models={configured:()=>true,model:()=> 'generated-model',capacity,configuration:(id=old)=>({owner:'models' as const,fingerprint:id,revision:1,profileId:id,provider:'generated',model:'generated-model'})};
 const pipeline=new MemoryPipeline({store,memories,models,phases:{query,review:(input,draft,strategy)=>reviewMemory(input,draft,query,{strategy})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-rebind',name:'Generated rebind',kind:'custom',deviceId:'generated',platform:'import'});
 const evidenceIds=[];
 for(let index=0;index<16;index++){
  const original=await sources.upsert('generated-rebind',{externalId:String(index),revision:'1',text:'Generated original '+index,observedAt:at,kind:'file',layer:'original'});
  evidenceIds.push(original.id);
 }
 const job=pipeline.create({evidenceIds});
 assert.equal(job.batches.length,1);
 const first=await pipeline.run(job.id);
 assert.equal(first.status,'failed');
 const queued=pipeline.acceptRetry(job.id,true);
 assert.equal(pipeline.pause(job.id).status,'paused');
 await queued.completion;
 assert.equal(store.db.prepare("SELECT json_extract(json,'$.splitForCapacityRetry') split FROM memory_batches WHERE id=?").get(job.batches[0].id)?.split,1);
 const done=await pipeline.acceptRetry(job.id,true,selected).completion;
 assert.equal(done.status,'completed');
 assert.equal(done.modelProfileId,selected);
 assert.equal(done.batches.length,1);
 assert.equal(done.batches[0].id,job.batches[0].id);
 assert.deepEqual(done.batches[0].evidenceRanges,job.batches[0].evidenceRanges);
 assert.deepEqual(calls.map(call=>call.profile),[old,selected,selected]);
 assert.equal(done.batches[0].reviewReceipt?.decision,'independent');
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,16);
});

for(const withdrawal of ['cancel','replace-original','change-model'] as const)test(`recovered native-budget planning yields to ${withdrawal} before dispatch and preserves its frozen targets`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-budget-withdrawal-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 let enabled=false,capacityReads=0,calls=0,entered!:()=>void,fingerprint='a'.repeat(64);
 const measuring=new Promise<void>(resolve=>entered=resolve),capacity={contextWindow:200000,maxOutputTokens:128000,draftTokens:16000};
 const pipeline=new MemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'gpt-6.1-terra',configuration:()=>({owner:'models',fingerprint,revision:0,profileId:'generated',provider:'codex',model:'gpt-6.1-terra'}),capacity:()=>{if(!enabled)return;if(++capacityReads===2)entered();return capacity;}},phases:{query:async()=>{calls++;throw Error('Withdrawn originals must not reach the provider');},review:async()=>{throw Error('Withdrawn originals must not reach review');}}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-budget-withdrawal',name:'Generated recovery originals',kind:'custom',deviceId:'generated',platform:'import'});
 const originals=[];
 for(let index=0;index<160;index++)originals.push(await sources.upsert('generated-budget-withdrawal',{externalId:String(index),revision:'1',title:'Generated recorded metadata '.repeat(40),text:'Generated original segment '+index,observedAt:at,kind:'file',layer:'original'}));
 const job=pipeline.create({evidenceIds:originals.map(original=>original.id)}),ranges=job.batches.map(batch=>batch.evidenceRanges);assert.equal(job.totalBatches,1);
 enabled=true;const done=pipeline.run(job.id);await measuring;
 // The capacity has been sampled inside the real planning pass. The owner
 // mutation runs at its next yielded boundary, before any model dispatch.
 if(withdrawal==='cancel')pipeline.cancel(job.id);
 else if(withdrawal==='replace-original')await sources.upsert('generated-budget-withdrawal',{externalId:'0',revision:'2',text:'Generated replacement invalidates the old exact proof.',observedAt:at,kind:'file',layer:'original'});
 else fingerprint='b'.repeat(64);
 const stopped=await done;
 assert.equal(calls,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.deepEqual(stopped.batches.map(batch=>batch.evidenceRanges),ranges,'withdrawal cannot erase the original target vector or publish planned replacement batches');
 assert.equal(stopped.status,withdrawal==='cancel'?'cancelled':withdrawal==='change-model'?'waiting_for_model':'failed');
 if(withdrawal==='replace-original')assert.equal(stopped.outcome,'input_invalidated');
 if(withdrawal==='change-model')assert.equal(stopped.errorCode,'configuration_changed');
});

test('owner retry of an explicit incomplete evaluation performs a fresh review and never reuses it as completed coverage',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-incomplete-retry-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 let incomplete=true,extracts=0,reviews=0;
 const empty=(input:MemoryPipelineQuery)=>({answer:JSON.stringify({memories:[],coverage:(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID()});
 const pipeline=new MemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'gpt-6.1-terra',capacity:()=>({contextWindow:272000,maxOutputTokens:128000,draftTokens:65536})},phases:{query:async input=>{extracts++;return empty(input);},review:(input,draft,strategy)=>reviewMemory(input,draft,async request=>{reviews++;const value=empty(request as MemoryPipelineQuery);if(incomplete){const output=JSON.parse(value.answer);output.coverage[0]={...output.coverage[0],state:'incomplete',reason:'Generated reviewer explicitly did not assess this target'};value.answer=JSON.stringify(output);}return value;},{strategy})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-incomplete',name:'Generated incomplete original',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-incomplete',{externalId:'one',revision:'1',text:'A complete generated original for an explicit retry.',observedAt:at,kind:'file',layer:'original'});
 const job=pipeline.create({evidenceIds:[original.id]}),failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'memory_evaluation_incomplete');assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.equal(reviews,2,'an unresolved text assessment uses only the existing two-attempt review budget');await pipeline.run(job.id);assert.equal(reviews,2,'ordinary reentry cannot reopen the failed assessment');
 assert.equal((await pipeline.retry(job.id)).status,'failed','another independently reported incomplete outcome stays failed');assert.equal(reviews,4);assert.equal(extracts,2,'the first owner retry includes the saved exact incomplete inspection history in its new generation');
 incomplete=false;const done=await pipeline.retry(job.id);
 assert.equal(done.status,'completed');assert.equal(reviews,5);assert.equal(extracts,2,'the unchanged generation retains its valid extraction while review runs again');assert.equal(done.batches[0].coverage![0].state,'no_candidates');assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
});

test('owner retry reopens a timed-out review against its saved bounded scope before recalculating the allowance',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-budget-timeout-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 let timeout=true,extracts=0,reviews=0;
 const empty=(input:MemoryPipelineQuery)=>({answer:JSON.stringify({memories:[],coverage:(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID()});
 const pipeline=new MemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'gpt-6.1-terra',capacity:()=>({contextWindow:272000,maxOutputTokens:128000,draftTokens:65536})},phases:{query:async input=>{extracts++;return empty(input);},review:(input,draft,strategy)=>reviewMemory(input,draft,async request=>{reviews++;if(timeout)throw new ProviderFailure({category:'permanent',code:'provider_timeout',retryAfterMs:0});return empty(request as MemoryPipelineQuery);},{strategy})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-timeout',name:'Generated retry original',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-timeout',{externalId:'one',revision:'1',text:'Generated whole original for a bounded independent review.',observedAt:at,kind:'file',layer:'original'});
 const job=pipeline.create({evidenceIds:[original.id]}),failed=await pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'provider_timeout');
 timeout=false;const done=await pipeline.retry(job.id);assert.equal(done.status,'completed');assert.equal(reviews,2);assert.equal(extracts,1);assert.equal(done.totalBatches,1);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
});

test('808 generated recording segments retain every exact range and bounded read grant across independent review and restart',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-request-budget-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-budget-owner',tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'gpt-6.1-terra',provider:'codex',protocol:'codex-app-server',reasoningEffort:'auto',maxTokens:65536,modelRequestTimeoutMs:null,agentTimeoutMs:null,apiKey:'',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false,traceEnabled:false,level:'silent'}}};
 const calls:{phase:string;targets:string[];readIds:string[];tokens:number}[]=[];
 const failures:unknown[]=[];
 let holdReview=true,enteredReview!:()=>void;
 const reviewEntered=new Promise<void>(resolve=>enteredReview=resolve);
 const overrides:NonNullable<Parameters<typeof buildApp>[1]>={backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  const bridge=await startBridge(reader,input);
  try{
   const {system,tools,prompt,outputSchema}=assembleHostContext(input,bridge.seedEvidence,65536);
   const tokens=estimateSerializedTokens({system,tools,prompt,outputSchema}).tokens;
   // This fixture is the native send boundary, independent of the planner.
   // Its documented output ceiling is not the Host's requested maxTokens.
   if(tokens+128000>272000)throw new ProviderFailure({category:'permanent',code:'processing_limit',executionStarted:false});
   const members=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;
   const allowedIds=new Set(input.evidenceReadRanges!.map(range=>range.id));
   for(const pin of input.processingMaterialInputs??[])assert.ok(pin.evidenceIds.every(id=>allowedIds.has(id)),'the frozen Material identity grants only this call\'s bounded original IDs, including any optional image locators');
   if(holdReview&&input.traceContext!.phase==='review'){enteredReview();return await new Promise<never>((_,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true}));}
   const omitted=selected.find(id=>!input.evidenceReadRanges!.some(range=>range.id===id));
   if(omitted){const denied=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:omitted,offset:0,length:1})});assert.equal(denied.status,400,'an omitted optional context range acquires no read authority in this call');assert.equal(bridge.records.has(omitted),false);}
   calls.push({phase:input.traceContext!.phase!,targets:members.map(member=>member.id),readIds:input.evidenceReadRanges!.map(range=>range.id),tokens});
   assert.equal(bridge.seedEvidence.length,members.length);
   for(const member of members){const record=bridge.seedEvidence.find(record=>record.id===member.id)!;assert.equal(record.ocrText.length,member.length);assert.equal(record.ocrText,texts[selected.indexOf(member.id)]);}
   return {answer:JSON.stringify({memories:[],coverage:members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],runId:randomUUID(),evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
  }catch(error){if(!input.signal?.aborted)failures.push(error);throw error;}finally{await bridge.close();}
 }})};
 let node=await buildApp(config,overrides);
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.app.ready();
 const sourceId='generated-recording-budget';
 node.sources.register({id:sourceId,name:'Generated recording',kind:'custom',deviceId:'generated',platform:'import'});
 node.sources.updateContext(sourceId,{expectedVersion:0,description:'这是虚构的合成录音资料；说话人标签只在当前文件内有效，各段保持自己的录音时间和原始出处。'});
 const texts=Array.from({length:808},(_,index)=>`第${String(index).padStart(4,'0')}段合成录音：虚构的设备检查记录，已逐项阅读；本段无须保存长期记忆。`);
 const original=await node.sources.upsert(sourceId,{externalId:'generated-recording',revision:'1',text:texts.join('\n'),observedAt:at,kind:'file',layer:'original',document:{contentRole:'transcript',recordedAt:at,timeBasis:'recorded'}});
 const material=node.materials.publish({id:materialId(sourceId,'generated-segments'),kind:'mote.note',schemaVersion:1,title:'Generated segmented recording',origin:{sourceId,externalId:'generated-segments',deviceId:'generated',firstAt:at,lastAt:at},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:texts.map((text,index)=>{const recordedAt=new Date(Date.parse(at)+index*1000).toISOString();return {id:'segment-'+index,kind:'text' as const,format:'plain',text,memberIds:[original.id],evidenceContext:{observedAt:recordedAt,document:{contentRole:'transcript' as const,recordedAt,timeBasis:'recorded' as const}}};}),artifacts:[{key:'transcript',state:'ready',blockIds:texts.map((_,index)=>'segment-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const selected=node.materials.input(material.ref,['transcript'])!.evidenceIds;
 assert.equal(selected.length,808);
 const headers={authorization:'Bearer '+config.privateCredential!.token};
 const accepted=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:selected,recipes:[{id:'mote.personal-memory',version:'5'}]}});
 assert.equal(accepted.statusCode,202,accepted.body);
 assert.equal(accepted.json().inputPlans.total,1,'the original Material retains one real input plan across transport partitions');
 const first=node.memoryPipeline.run(accepted.json().id);await reviewEntered;
 const frozen=node.memoryPipeline.get(accepted.json().id).batches.map(batch=>batch.evidenceRanges);
 holdReview=false;await node.app.close();await first;
 node=await buildApp(config,overrides);await node.app.ready();
 const done=await node.memoryPipeline.run(accepted.json().id);
 assert.equal(done.status,'completed',JSON.stringify({status:done.status,batches:done.batches.map(batch=>({status:batch.status,errorCode:batch.errorCode}))}));
 assert.equal(done.inputPlans.completed,1);assert.equal(done.inputPlans.waiting,0);assert.equal(done.inputPlans.blocked,0);
 assert.deepEqual(failures,[]);
 const extracts=calls.filter(call=>call.phase==='extract'),reviews=calls.filter(call=>call.phase==='review');
 assert.ok(extracts.some(call=>call.readIds.length<808),'the full job catalog is retained by the job while each call receives a bounded legal read scope');
 assert.deepEqual(done.batches.map(batch=>batch.evidenceRanges),frozen,'restart reuses the frozen exact target partitions');
 assert.equal(extracts.length,done.totalBatches);assert.equal(reviews.length,done.totalBatches,'every extraction, including empty candidate selection, has its own independent review');
 for(const phase of [extracts,reviews]){assert.equal(phase.flatMap(call=>call.targets).length,808);assert.deepEqual(new Set(phase.flatMap(call=>call.targets)),new Set(selected),'the complete target vector is read exactly once per phase');for(const call of phase)assert.ok(frozen.some(ranges=>JSON.stringify(ranges.map(range=>range.id))===JSON.stringify(call.targets)),'each call preserves its frozen target order independently of completion order');}
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,808);
 assert.equal(done.batches.flatMap(batch=>batch.coverage??[]).length,808);
 assert.ok(done.batches.every(batch=>batch.reviewReceipt?.decision==='independent'&&batch.coverage!.every(member=>member.state==='no_candidates')));
});
