import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {parseAnswer,type QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId} from '../src/materials.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';

// Entirely generated evidence. Exact boundaries reproduce a diary header and a
// sentence continuation being separated from the event's extraction target.
const header='Recorded on 2025-02-03. I am alone, reviewing my diary from 2024-01-01 through 2024-12-31. ';
const repair='I repaired my blue bicycle on April 20.';
const guest='My guest said, "I plan to buy a red bicycle." I plan a picnic next month. ';
const cat="I trimmed the toy cat's claws; the toy cat looked displeased.";
const beginning=header.padEnd(256,'.'),middle=(repair+' '+guest).padEnd(224,'.');
const diary=(beginning+middle+cat).padEnd(1024,'.');
assert.equal(diary.indexOf(repair),256);assert.equal(diary.indexOf(cat),480);assert.equal(diary.length,1024);
const instruction='Most of these recordings are my diary; a few are conversations or consultations with others. Filename dates are recording dates in UTC+8.';
const otherText='A generated continuation confirms this diary retrospective covers 2024.';
type Scenario='read-context'|'unread-quote'|'context-only-candidate'|'corrected-during-read'|'cross-original-context'|'review-only-context'|'unused-context-correction'|'unused-context-deletion';
type Call={phase:string|undefined;target:{id:string;offset:number;length:number}[];seedIds:string[];readRanges:{id:string;offset:number;length:number}[];contextReads:{id:string;offset:number;length:number}[]};

async function until<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
 const deadline=Date.now()+15000;
 do{const value=await read();if(done(value))return value;await setTimeout(20);}while(Date.now()<deadline);
 throw Error('Generated HTTP Memory journey did not finish within 15 seconds');
}

async function fixture(t:TestContext,scenario:Scenario){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-memory-context-http-')),token='generated-memory-context-owner';
 const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:2_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,memoryConcurrency:1};
 const calls:Call[]=[],rejections:{code:string;feedback:string}[]=[],spyFailures:string[]=[];let otherId='',otherCaptureId='',otherMaterialRef='',materialRef='',corrected=false;
 let node:Awaited<ReturnType<typeof buildApp>>;
 node=await buildApp(config,{backgroundWorker:false,prepareImport:async({workspace,inputPaths})=>{
  const records=[{externalId:'generated-diary',text:diary,title:'2025_02_03_20_45_27.md'},{externalId:'generated-unselected',text:otherText,title:'Generated independent continuation'}];
  writeFileSync(join(workspace,'records.jsonl'),records.map(record=>JSON.stringify({item:{...record,revision:'generated-v1',kind:'file',layer:'original',observedAt:'2025-02-03T12:45:27Z',document:{recordedAt:'2025-02-03T20:45:27+08:00',timeBasis:'recorded',contentRole:'transcript'}},evidencePaths:inputPaths})).join('\n')+'\n');
  return {summary:'Two generated independent diary originals'};
 },createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async(input:QueryInput):Promise<QueryResult>=>{
  const targets=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;
  if((scenario==='unused-context-correction'||scenario==='unused-context-deletion')&&targets.length===1&&targets[0].offset===256&&targets[0].length===256&&input.traceContext?.phase==='extract'&&!corrected){
   corrected=true;
   if(scenario==='unused-context-correction'){const other=node.materials.get(otherMaterialRef)!;node.materials.correctContext(other.id,other.revision,'third_party');}
   else{const deleted=await node.app.inject({method:'DELETE',url:'/api/captures/'+otherCaptureId,headers:{authorization:'Bearer '+token}});assert.equal(deleted.statusCode,200,deleted.body);}
  }
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const bridge=await startBridge(reader,input,24);
  try{
   const members=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members,member=members[0],target=members.map(({id,offset,length})=>({id,offset,length}));
   assert.equal(member.attributionContext?.importStatements?.[0].instruction,instruction);
   const call:Call={phase:input.traceContext?.phase,target,seedIds:[...(input.evidenceIds??[])],readRanges:[],contextReads:[]};calls.push(call);
   const tool=async(name:string,args:Record<string,unknown>)=>{
    const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});
    return {status:response.status,body:await response.json()};
   };
   const read=async(offset:number,length:number)=>{
    const result=await tool('context_evidence',{id:member.id,offset,length});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.data[0].ocrText,diary.slice(offset,offset+length));
    call.contextReads.push({id:member.id,offset,length});
   };
   const claim=(title:string,statement:string,spans:{quote:string;offset:number}[])=>({domain:'personal',title,statement:statement+` [${member.id}]`,uncertainty:'The generated diary supports the narrator inference; guest plans remain attributed to the guest. A future picnic is not completed.',admission:{layer:'observation',reason:'A concrete generated diary experience',scope:'The retrospective 2024 diary only',attribution:'inferred'},evidenceIds:[member.id],evidence:spans.map(span=>({id:member.id,...span}))});
   const memories:any[]=[];
   if(target.length===1&&target[0].offset===256&&target[0].length===256){
    assert.ok(input.evidenceReadRanges?.some(range=>range.id===member.id&&range.offset===0&&range.length===diary.length),'the frozen selected original remains readable after configured initial partitioning');
    const denied=await tool('context_evidence',{id:['cross-original-context','review-only-context','unused-context-correction','unused-context-deletion'].includes(scenario)?randomUUID():otherId,offset:0,length:12});assert.equal(denied.status,400,'an original outside this job selection has no read grant');
    const ordinary=await tool('evidence',{ids:[member.id],offset:0,length:header.length});assert.equal(ordinary.status,input.traceContext?.phase==='review'?200:400,'ordinary evidence uses only the seeds supplied to its own phase');
    const prefix={quote:header,offset:0},event={quote:repair,offset:256};
    if(scenario==='unread-quote'&&input.traceContext?.phase==='extract'){
     const invalid=claim('Unread diary context','The owner repaired a blue bicycle in 2024',[prefix,event]);
     const answer=JSON.stringify({memories:[invalid],coverage:[{key:member.key,state:'checked',candidateIndexes:[0]}]});
     const result=parseAnswer(JSON.stringify({answer,citationIds:[member.id]}),bridge.records);
     const failure=await input.validateOutput!({...result,trace:bridge.trace,runId:randomUUID(),evidenceReadRanges:bridge.deliveredRanges});
     assert.ok(failure,'authorization alone never proves original text was delivered');assert.match(failure.code,/quote|scope/);rejections.push(failure);
    }
    await read(0,header.length);await read(480,cat.length);
    if(scenario==='context-only-candidate'&&input.traceContext?.phase==='extract'){
     const invalid=claim('Context-only diary header','The owner recorded a diary on 2025-02-03',[prefix]);
     const answer=JSON.stringify({memories:[invalid],coverage:[{key:member.key,state:'checked',candidateIndexes:[0]}]});
     const result=parseAnswer(JSON.stringify({answer,citationIds:[member.id]}),bridge.records);
     const failure=await input.validateOutput!({...result,trace:bridge.trace,runId:randomUUID(),evidenceReadRanges:bridge.deliveredRanges});
     assert.ok(failure,'reading context cannot produce a separate card unrelated to this target');assert.match(failure.feedback,/exact supporting quote wholly within a listed target range/);assert.match(failure.feedback,/context-only claim/);rejections.push(failure);
    }
    memories.push(claim('Generated bicycle repair','The owner reported repairing a blue bicycle on 2024-04-20',[prefix,event]),claim('Generated toy-cat reaction','The toy cat looked displeased after claw trimming',[{quote:cat.slice(0,32),offset:480},{quote:cat,offset:480}]));
    if(scenario==='cross-original-context'||scenario==='review-only-context'&&input.traceContext?.phase==='review'){
     const context=await tool('context_evidence',{id:otherId,offset:0,length:otherText.length});assert.equal(context.status,200,JSON.stringify(context.body));assert.equal(context.body.data[0].ocrText,otherText);
     call.contextReads.push({id:otherId,offset:0,length:otherText.length});
     memories[0].evidenceIds.push(otherId);memories[0].evidence.push({id:otherId,quote:otherText,offset:0});
     memories[0].statement+=` [${otherId}]`;
    }
    if(scenario==='corrected-during-read'&&input.traceContext?.phase==='review'&&!corrected){
     corrected=true;const material=node.materials.get(materialRef)!;node.materials.correctContext(material.id,material.revision,'third_party');
    }
   }
   const answer=JSON.stringify({memories,coverage:members.map(targetMember=>({key:targetMember.key,state:memories.length&&targetMember.key===member.key?'checked':'no_candidates',candidateIndexes:targetMember.key===member.key?memories.map((_memory,index)=>index):[]}))});
   const result=parseAnswer(JSON.stringify({answer,citationIds:[...new Set(memories.flatMap(memory=>memory.evidenceIds))]}),bridge.records);
   call.readRanges=bridge.deliveredRanges;
   return {...result,trace:bridge.trace,runId:randomUUID(),evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){spyFailures.push(error instanceof Error?error.message:String(error));throw error;}finally{await bridge.close();}
 }})});
 await node.lifecycle.save({revision:node.configService.revision,settings:{...node.lifecycle.settings(),batchCharacters:256}});
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'},api=(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload});
 const created=await api('POST','/api/imports',{instruction,files:[{name:'generated.md',dataBase64:Buffer.from(diary).toString('base64')}]});assert.equal(created.statusCode,202,created.body);
 const importId=created.json().id;
 await until(async()=>(await api('GET','/api/imports/'+importId)).json(),job=>job.status==='awaiting_confirmation');
 const confirmation=await api('POST','/api/imports/'+importId+'/confirm');assert.equal(confirmation.statusCode,202,confirmation.body);
 const imported=await until(async()=>(await api('GET','/api/imports/'+importId)).json(),job=>job.status==='completed');
 await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
 const material=node.materials.get(materialId(imported.sourceId,'generated-diary'))!;assert.ok(material);materialRef=material.ref;
 const other=node.materials.get(materialId(imported.sourceId,'generated-unselected'))!;assert.ok(other);otherMaterialRef=other.ref;otherId=node.materials.input(other.ref,['source-body'])!.evidenceIds[0];
 otherCaptureId=node.store.evidence(imported.captureIds).find(record=>record.provenance?.externalId==='generated-unselected')!.id;
 const source=await api('GET',`/api/materials/${material.id}/read?offset=0&length=1024`);assert.equal(source.statusCode,200,source.body);assert.equal(source.json().text,diary);assert.equal(source.json().material.attributionContext.importStatements[0].instruction,instruction);
 const selected=[...node.materials.input(material.ref,['source-body'])!.evidenceIds,...(['cross-original-context','review-only-context','unused-context-correction','unused-context-deletion'].includes(scenario)?[otherId]:[])];
 const start=await api('POST','/api/memory-jobs',{evidenceIds:selected,recipes:[{id:'mote.personal-memory',version:'5'}]});assert.equal(start.statusCode,202,start.body);
 const done=await until(async()=>(await api('GET','/api/memory-jobs/'+start.json().id)).json(),job=>['completed','failed','cancelled'].includes(job.status));
 return {node,api,done,calls,rejections,material,selected,spyFailures,otherId,otherCaptureId};
}

const failureSummary=(f:Awaited<ReturnType<typeof fixture>>)=>JSON.stringify({spyFailures:f.spyFailures,batches:f.done.batches.map((batch:any)=>({offset:batch.evidenceRanges[0]?.offset,length:batch.evidenceRanges[0]?.length,status:batch.status,error:batch.errorCode,failures:batch.validationFailures}))});

test('HTTP diary import preserves model-selected retrospective and continuation reads through configured range extraction, independent review and publication',{timeout:30000},async t=>{
 const f=await fixture(t,'read-context');assert.equal(f.done.status,'completed',failureSummary(f));
 assert.ok(f.done.batches.every((batch:any)=>!batch.supersededBy),'processing never recursively halves the originally selected ranges');
 const middle=f.calls.filter(call=>call.target[0].offset===256&&call.target[0].length===256);assert.deepEqual(middle.map(call=>call.phase),['extract','review']);
 for(const call of middle){assert.deepEqual(call.contextReads.map(range=>({offset:range.offset,length:range.length})),[{offset:0,length:header.length},{offset:480,length:cat.length}]);assert.ok(call.readRanges.some(range=>range.offset===0&&range.length>=header.length));assert.ok(call.readRanges.some(range=>range.offset<=480&&range.offset+range.length>=480+cat.length));}
 const leaf=f.done.batches.find((batch:any)=>batch.evidenceRanges[0]?.offset===256&&batch.evidenceRanges[0]?.length===256);
 const draft=JSON.parse(String(f.node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE batch_id=?').get(leaf.id)!.json));
 assert.deepEqual(draft.evidenceReadRanges,middle[0].readRanges,'private draft recovery preserves actual delivery, not the broader authorization catalog');
 assert.equal(f.done.memoryIds.length,2);
 for(const id of f.done.memoryIds){const response=await f.api('GET','/api/memories/'+id);assert.equal(response.statusCode,200,response.body);const memory=response.json();assert.equal(memory.reviewReceipt.decision,'independent');assert.notEqual(memory.reviewReceipt.draftRunId,memory.reviewReceipt.reviewRunId);assert.ok(memory.evidence.every((span:any)=>span.externalId===f.material.id&&span.revision===f.material.revision&&diary.slice(span.offset,span.offset+span.length)===span.quote));}
 const saved=f.done.memoryIds.map((id:string)=>f.node.memories.get(id));assert.ok(saved.some((memory:any)=>memory.statement.includes('2024-04-20')));assert.ok(saved.some((memory:any)=>memory.evidence.some((span:any)=>span.offset===480&&span.quote===cat)));
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4,'only exact independently reviewed leaf targets are checkpointed');
});

for(const scenario of ['unread-quote','context-only-candidate'] as const)test(`HTTP configured-range Memory rejects ${scenario} before saving the corrected independently reviewed target`,{timeout:30000},async t=>{
 const f=await fixture(t,scenario);assert.equal(f.done.status,'completed',failureSummary(f));assert.equal(f.rejections.length,1);assert.equal(f.done.memoryIds.length,2);
 assert.ok(f.done.batches.some((batch:any)=>batch.validationFailures?.some((failure:any)=>failure.phase==='extract')));
 assert.ok(f.done.memoryIds.every((id:string)=>!f.node.memories.get(id).title.includes('Unread')&&!f.node.memories.get(id).title.includes('Context-only')));
});

test('HTTP configured-range Memory cannot publish context read before an owner correction supersedes the selected Material',{timeout:30000},async t=>{
 const f=await fixture(t,'corrected-during-read');assert.notEqual(f.done.status,'completed');assert.equal(f.done.memoryIds.length,0);assert.equal(f.node.memories.list().length,0);assert.equal(f.node.materials.get(f.material.ref),undefined);
 assert.equal(f.node.materials.get(f.material.id)!.attributionContext?.ownerRelation,'third_party');
});

test('HTTP selected originals allow cross-original context citations and redisclose them to an independent reviewer',{timeout:30000},async t=>{
 const f=await fixture(t,'cross-original-context');assert.equal(f.done.status,'completed',failureSummary(f));assert.equal(f.done.memoryIds.length,2);
 const middle=f.calls.filter(call=>call.target.length===1&&call.target[0].offset===256&&call.target[0].length===256);assert.deepEqual(middle.map(call=>call.phase),['extract','review']);
 assert.ok(!middle[0].seedIds.includes(f.otherId),'cross-original context is not an extraction seed');assert.ok(middle[1].seedIds.includes(f.otherId),'the reviewer receives every original actually read by extraction');
 for(const call of middle)assert.ok(call.readRanges.some(range=>range.id===f.otherId&&range.offset===0&&range.length===otherText.length));
 const memory=f.done.memoryIds.map((id:string)=>f.node.memories.get(id)).find((memory:any)=>memory.title==='Generated bicycle repair')!;
 assert.deepEqual(new Set(memory.evidenceIds),new Set(f.selected));assert.ok(memory.evidence.some((span:any)=>span.id===f.otherId&&span.quote===otherText));
 const leaf=f.done.batches.find((batch:any)=>batch.evidenceRanges.length===1&&batch.evidenceRanges[0].offset===256&&batch.evidenceRanges[0].length===256);
 assert.deepEqual(leaf.coverage.map((member:any)=>member.id),[f.selected[0]],'context-original support does not enlarge target coverage');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,5,'the context original gets only its own separately reviewed checkpoint');
});

test('deleting an actually read context original purges its private cross-original draft and dependent Memory',{timeout:30000},async t=>{
 const f=await fixture(t,'cross-original-context');assert.equal(f.done.status,'completed',failureSummary(f));
 const leaf=f.done.batches.find((batch:any)=>batch.evidenceRanges.length===1&&batch.evidenceRanges[0].offset===256&&batch.evidenceRanges[0].length===256);
 const prior=f.node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE batch_id=?').get(leaf.id)!;assert.ok(String(prior.json).includes(otherText),'the private stage really contains the additional original');
 const dependent=f.done.memoryIds.map((id:string)=>f.node.memories.get(id)).find((memory:any)=>memory.evidenceIds.includes(f.otherId))!;
 const deleted=await f.api('DELETE','/api/captures/'+f.otherCaptureId);assert.equal(deleted.statusCode,200,deleted.body);
 assert.equal(f.node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE batch_id=?').get(leaf.id),undefined,'a retired context original cannot remain in a reusable private target draft');
 const removed=await f.api('GET','/api/memories/'+dependent.id);assert.equal(removed.statusCode,404,removed.body);
 assert.ok(f.node.memories.list().some(memory=>memory.title==='Generated toy-cat reaction'&&memory.status==='published'),'the separately supported target event remains available');
});

test('a reviewer-only context read gains durable dependencies before publication and cannot survive original deletion',{timeout:30000},async t=>{
 const f=await fixture(t,'review-only-context');assert.equal(f.done.status,'completed',failureSummary(f));
 const middle=f.calls.filter(call=>call.target.length===1&&call.target[0].offset===256&&call.target[0].length===256);assert.deepEqual(middle.map(call=>call.phase),['extract','review']);
 assert.ok(middle.every(call=>!call.seedIds.includes(f.otherId)),'neither phase receives the additional original as an initial seed');
 assert.ok(!middle[0].readRanges.some(range=>range.id===f.otherId));assert.ok(middle[1].readRanges.some(range=>range.id===f.otherId));
 const leaf=f.done.batches.find((batch:any)=>batch.evidenceRanges.length===1&&batch.evidenceRanges[0].offset===256&&batch.evidenceRanges[0].length===256);
 const draft=f.node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE batch_id=?').get(leaf.id)!;assert.ok(!String(draft.json).includes(otherText),'extraction did not preserve a body it never read');
 assert.ok(f.node.store.db.prepare('SELECT 1 FROM memory_batch_dependencies WHERE batch_id=? AND evidence_id=?').get(leaf.id,f.otherId),'review-only disclosure becomes a durable batch dependency');
 const dependent=f.done.memoryIds.map((id:string)=>f.node.memories.get(id)).find((memory:any)=>memory.evidenceIds.includes(f.otherId))!;assert.ok(dependent);
 const deleted=await f.api('DELETE','/api/captures/'+f.otherCaptureId);assert.equal(deleted.statusCode,200,deleted.body);
 assert.equal(f.node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE batch_id=?').get(leaf.id),undefined);
 const removed=await f.api('GET','/api/memories/'+dependent.id);assert.equal(removed.statusCode,404,removed.body);
});

for(const scenario of ['unused-context-correction','unused-context-deletion'] as const)test(`HTTP Memory rejects already-disclosed catalog metadata after ${scenario} before a possible body read`,{timeout:30000},async t=>{
 const f=await fixture(t,scenario);assert.equal(f.done.memoryIds.length,0,failureSummary(f));
 assert.notEqual(f.done.status,'completed');assert.ok(f.done.batches.some((batch:{errorCode?:string})=>batch.errorCode==='context_evidence_restricted'));
 // The custom fixture mutates inside its extraction callback. The real host
 // final fence refuses that output before invoking a reviewer or publishing.
 // Native first-request fencing is covered by memory-catalog-metadata-http.
 const middle=f.calls.filter(call=>call.target.length===1&&call.target[0].offset===256&&call.target[0].length===256);assert.deepEqual(middle.map(call=>call.phase),['extract']);
 for(const call of middle){assert.ok(!call.seedIds.includes(f.otherId));assert.ok(!call.readRanges.some(range=>range.id===f.otherId));assert.ok(!call.contextReads.some(range=>range.id===f.otherId));}
 assert.ok(f.done.batches.filter((batch:{errorCode?:string})=>batch.errorCode==='context_evidence_restricted').every((batch:{attempts:number})=>batch.attempts===1),'metadata revocation is not a provider retry');
});
