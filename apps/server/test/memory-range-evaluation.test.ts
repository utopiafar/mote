import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentResponseError,type QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore,MemoryOutputValidationError} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryPlan} from './fixtures/memory-planning.js';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {materialId} from '../src/materials.js';

const contract='range-evaluation@1';
const at='2026-10-13T00:00:00Z';
const facts=(count:number)=>Array.from({length:count},(_,index)=>`Generated owner choice ${index}: option ${index}.`);
type Work={workContract?:string;maxCandidates?:number;members:MemoryWorkMember[]};
const work=(input:QueryInput)=>input.taskContext!.memoryWork as Work;
type Pick={member:MemoryWorkMember;quote:string;offset?:number;index?:number};
function result(input:QueryInput,picks:Pick[]=[],runId=randomUUID()):QueryResult{
 const memories=picks.map(({member,quote,offset,index},position)=>({domain:'personal',title:'Generated selected choice '+(index??position),statement:`Selected generated choice ${index??position}: ${quote} [${member.id}]`,uncertainty:'This generated source only',admission:{layer:'memory',reason:'A model-selected generated choice',scope:'This generated record',attribution:'user'},evidenceIds:[member.id],evidence:[{id:member.id,quote,...(offset===undefined?{}:{offset})}]}));
 const coverage=work(input).members.map(member=>{const candidateIndexes=picks.flatMap((pick,index)=>pick.member.key===member.key?[index]:[]);return {key:member.key,state:candidateIndexes.length?'checked':'no_candidates',candidateIndexes};});
 return {runId,answer:JSON.stringify({memories,coverage,...(work(input).workContract===contract?{}:{capacity:{saturated:false}})}),citations:[...new Set(picks.map(pick=>pick.member.id))].map(id=>({id,capturedAt:at,appName:'Generated',excerpt:''})),trace:[]};
}
async function fixture(t:TestContext,texts:string[],batchCharacters=12000,reviewEnabled=true){
 const directory=mkdtempSync(join(tmpdir(),'mote-range-evaluation-'));
 let store:Store,sources:SourceStore,memories:MemoryStore,pipeline:MemoryPipeline;
 const extracts:MemoryPipelineQuery[]=[],reviews:MemoryPipelineQuery[]=[];
 let generate:(input:MemoryPipelineQuery)=>Promise<QueryResult>=async input=>result(input),review:(input:MemoryPipelineQuery,draft:QueryResult)=>Promise<QueryResult>=async(_input,draft)=>({...draft,runId:randomUUID()});
 function open(){store=new Store(directory);sources=new SourceStore(store);memories=new MemoryStore(store);pipeline=new MemoryPipeline({store,memories,batchCharacters,configured:()=>true,model:()=> 'generated-range-model',requireAdmission:true,query:async input=>{extracts.push(input);return generate(input);},...(reviewEnabled?{review:(input:MemoryPipelineQuery,draft:QueryResult,strategy:NonNullable<Parameters<typeof reviewMemory>[3]>['strategy'],draftOrigin:NonNullable<Parameters<typeof reviewMemory>[3]>['draftOrigin'])=>reviewMemory(input,draft,async request=>{reviews.push(request as MemoryPipelineQuery);return review(request as MemoryPipelineQuery,draft);},{strategy,draftOrigin})}:{})});}
 open();sources!.register({id:'generated-ranges',name:'Generated ranges',kind:'custom',deviceId:'generated',platform:'import'});
 const ids:string[]=[];for(const [index,text] of texts.entries())ids.push((await sources!.upsert('generated-ranges',{externalId:String(index),revision:'1',text,observedAt:at,kind:'file',layer:'original'})).id);
 async function close(){await pipeline.close();store.close();}
 t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
 return {get store(){return store;},get sources(){return sources;},get memories(){return memories;},get pipeline(){return pipeline;},ids,extracts,reviews,setGenerate(fn:typeof generate){generate=fn;},setReview(fn:typeof review){review=fn;},create(extra:Partial<Parameters<MemoryPipeline['create']>[0]>={}){return pipeline.create({evidenceIds:ids,workPackage:{id:'generated-range-package',goal:'Assess every authorized generated range and select useful memories',instruction:'Assessment completeness is separate from the number of selected results'},...extra});},async restart(){await close();reviewEnabled=true;open();}};
}

for(const count of [8,32,80])test(`${count} selected exact-quoted candidates complete one fully assessed range without count-driven subdivision`,async t=>{
 const lines=facts(count),f=await fixture(t,[lines.join('\n')]);
 f.setGenerate(async input=>{assert.equal(work(input).workContract,contract);assert.equal(work(input).maxCandidates,undefined);return result(input,lines.map((quote,index)=>({member:work(input).members[0],quote,index})));});
 const done=await f.pipeline.run(f.create().id);
 assert.equal(done.status,'completed');assert.equal(done.batches.length,1);assert.equal(done.memoryIds.length,count);
 assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
 assert.equal(done.batches[0].coverage![0].state,'checked');assert.equal(done.batches[0].coverage![0].memoryIds.length,count);
 assert.equal(done.batches.length,1);assert.equal((f.reviews[0].taskContext!.untrustedMemoryDraft as {capacity?:unknown}).capacity,undefined,'new independent review receives selected candidates and coverage, without semantic saturation');
});

for(const changeDuringReview of [false,true])test(`240 short targets form one initial range-evaluation batch and ${changeDuringReview?'fence an original correction during review':'receive one complete extraction and independent review'}`,async t=>{
 const texts=Array.from({length:240},(_,index)=>`Generated paragraph ${index}.`),f=await fixture(t,texts);
 const read=async(input:QueryInput,answer:QueryResult)=>{
  const bridge=await startBridge({search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async({ids})=>f.memories.readEvidence(ids),activity:async()=>({}),devices:async()=>[]},input);
  try{assert.equal(bridge.seedEvidence.length,240);assert.equal(bridge.deliveredRanges.length,240);assert.deepEqual(new Set(bridge.seedEvidence.map(record=>record.id)),new Set(f.ids));return {...answer,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};}finally{await bridge.close();}
 };
 let extractionError:unknown;
 f.setGenerate(async input=>{try{assert.equal(work(input).members.length,240);assert.equal(input.evidenceReadRanges!.length,240);assert.equal(Object.keys(input.processingEvidence!).length,240);return await read(input,result(input,[{member:work(input).members[0],quote:texts[0]},{member:work(input).members[239],quote:texts[239]}]));}catch(error){extractionError=error;throw error;}});
 f.setReview(async(input,draft)=>{assert.equal(work(input).members.length,240);const reviewed=await read(input,{...draft,runId:randomUUID()});if(changeDuringReview)await f.sources.upsert('generated-ranges',{externalId:'239',revision:'2',observedAt:at,kind:'file',layer:'original',text:'Generated corrected last paragraph.'});return reviewed;});
 const job=f.create();assert.equal(job.totalBatches,1);const before=job.batches[0].evidenceRanges;
 const done=await f.pipeline.run(job.id);if(extractionError)throw extractionError;assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,1,JSON.stringify(done));assert.equal(done.batches.length,1);assert.deepEqual(done.batches[0].evidenceRanges,before);
 if(changeDuringReview){assert.notEqual(done.status,'completed');assert.equal(done.memoryCount,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);return;}
 assert.equal(done.status,'completed');assert.equal(done.batches[0].coverage!.length,240);assert.equal(done.batches[0].coverage!.filter(row=>row.state==='checked').length,2);assert.equal(done.batches[0].coverage!.filter(row=>row.state==='no_candidates').length,238);assert.equal(done.memoryCount,2);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,240);
 for(const memoryId of done.memoryIds){const memory=f.memories.get(memoryId);assert.equal(memory.reviewReceipt!.decision,'independent');for(const span of memory.evidence!)assert.equal(f.memories.readEvidence([span.id])[0].ocrText.slice(span.offset!,span.offset!+span.length!),span.quote);}
});

test('a wide saved range batch resumes only its independent review after restart without repartitioning targets',async t=>{
 const texts=Array.from({length:150},(_,index)=>`Generated restart paragraph ${index}.`),f=await fixture(t,texts);let entered!:()=>void,hold=true;const reviewEntered=new Promise<void>(resolve=>entered=resolve);
 f.setGenerate(async input=>result(input,[{member:work(input).members[149],quote:texts[149]}]));
 f.setReview(async(input,draft)=>{assert.equal(work(input).members.length,150);if(hold){entered();return new Promise((_,reject)=>input.signal!.addEventListener('abort',()=>reject(input.signal!.reason),{once:true}));}return {...draft,runId:randomUUID()};});
 const job=f.create(),initial=job.batches[0].evidenceRanges,first=f.pipeline.run(job.id);await reviewEntered;hold=false;await f.restart();await first;
 const done=await f.pipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(done.totalBatches,1);assert.deepEqual(done.batches[0].evidenceRanges,initial);assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,2);assert.equal(done.batches[0].coverage!.length,150);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,150);
});

test('the formal Memory job API coalesces 270 authorized paragraphs across Materials once under concurrent drains',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-wide-memory-http-')),calls:QueryInput[]=[];
 const config:Config={dataDir:directory,token:'generated-wide-memory-token',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 let node:Awaited<ReturnType<typeof buildApp>>,outsideId:string,selected:string[]=[];
 const failures:unknown[]=[];
 node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  calls.push(input);const bridge=await startBridge(reader,input);
  try{
   assert.equal(work(input).members.length,270);assert.equal(bridge.seedEvidence.length,270);assert.equal(input.processingMaterialInputs!.length,2);
   assert.deepEqual(new Set(bridge.seedEvidence.map(record=>record.id)),new Set(selected));
   const denied=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:outsideId,offset:0,length:1})});assert.equal(denied.status,400,'unselected Material receives no context or target authority');
   const members=work(input).members,picks=[members[0],members[269]].map(member=>({member,quote:bridge.records.get(member.id)!.ocrText}));
   return {...result(input,picks),evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){failures.push(error);throw error;}finally{await bridge.close();}
 }})});await node.app.ready();t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 for(const [index,count] of [135,135,1].entries()){
  const sourceId='generated-wide-'+index,texts=Array.from({length:count},(_,line)=>`Generated ${index} paragraph ${line}.`);
  node.sources.register({id:sourceId,name:sourceId,kind:'custom',deviceId:'generated',platform:'import'});
  const original=await node.sources.upsert(sourceId,{externalId:'body',revision:'1',observedAt:at,kind:'message',layer:'original',text:texts.join('\n')});
  const material=node.materials.publish({id:materialId(sourceId,'generated-paragraphs'),kind:'mote.note',schemaVersion:1,title:'Generated paragraphs',origin:{sourceId,externalId:'generated-paragraphs',deviceId:'generated',firstAt:at,lastAt:at},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:texts.map((text,line)=>({id:'line-'+line,kind:'text' as const,format:'plain',text,memberIds:[original.id]})),artifacts:[{key:'source-body',state:'ready',blockIds:texts.map((_,line)=>'line-'+line)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  const ids=node.materials.input(material.ref,['source-body'])!.evidenceIds;if(index<2)selected.push(...ids);else outsideId=ids[0];
 }
 const created=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+config.token},payload:{evidenceIds:selected,recipes:[{id:'mote.personal-memory',version:'5'}]}});assert.equal(created.statusCode,202,created.body);
 const drains=await Promise.all(Array.from({length:3},()=>node.memoryPipeline.run(created.json().id)));if(failures.length)throw failures[0];
 for(const done of drains){assert.equal(done.status,'completed',JSON.stringify({status:done.status,errorCode:done.errorCode,batches:done.batches.map(batch=>({status:batch.status,errorCode:batch.errorCode,validationFailures:batch.validationFailures})),calls:calls.map(input=>input.traceContext?.phase)}));assert.equal(done.batches.length,1);assert.equal(done.memoryCount,2);assert.equal(done.batches[0].coverage!.length,270);assert.deepEqual(new Set(done.batches[0].evidenceRanges.map(range=>range.id)),new Set(selected));}
 assert.deepEqual(calls.map(input=>input.traceContext?.phase),['extract','review']);assert.equal(node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,270);
 const read=await node.app.inject({url:'/api/memory-jobs/'+created.json().id,headers:{authorization:'Bearer '+config.token}});assert.equal(read.statusCode,200);assert.equal(read.json().completedBatches,1);
});

test('model selection may retain one useful claim while independent review assesses every other target',async t=>{
 const f=await fixture(t,[facts(40).join('\n'),facts(20).join('\n'),'Generated neutral source.']);
 f.setGenerate(async input=>result(input,[{member:work(input).members[0],quote:facts(40)[0]}]));
 const done=await f.pipeline.run(f.create().id);
 assert.equal(done.status,'completed');assert.equal(done.batches.length,1);assert.equal(done.memoryIds.length,1);
 assert.equal(f.reviews.length,1);assert.equal(work(f.reviews[0]).members.length,3);
 assert.deepEqual(done.batches[0].coverage!.map(member=>member.state),['checked','no_candidates','no_candidates']);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,3);
 assert.ok(!done.batches[0].supersededBy);
});

test('explicit incomplete assessment remains unfinished without committing partial proposals or semantically subdividing',async t=>{
 const f=await fixture(t,[facts(12).join('\n')]);
 f.setGenerate(async input=>{const draft=result(input,[{member:work(input).members[0],quote:facts(12)[0]}]),value=JSON.parse(draft.answer);value.coverage[0]={...value.coverage[0],state:'incomplete',reason:'Generated fixture did not assess the final supplied passages'};return {...draft,answer:JSON.stringify(value)};});
 const job=f.create(),blocked=await f.pipeline.run(job.id);
 assert.notEqual(blocked.status,'completed');assert.equal(blocked.errorCode,'memory_evaluation_incomplete');assert.equal(blocked.batches.length,1);
 assert.equal(blocked.batches[0].coverage![0].state,'incomplete');assert.ok(blocked.batches[0].coverage![0].reason);assert.ok(!blocked.batches[0].supersededBy);
 assert.equal(f.reviews.length,1);assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 await f.restart();assert.equal(f.pipeline.get(job.id).errorCode,'memory_evaluation_incomplete');assert.equal(f.memories.list().length,0);
});

test('missing target coverage is repaired from the same grant and cannot complete through a subset response',async t=>{
 const f=await fixture(t,['Generated first independent input.','Generated second independent input.']);
 f.setGenerate(async input=>{const draft=result(input),value=JSON.parse(draft.answer);value.coverage.pop();return {...draft,answer:JSON.stringify(value)};});
 const failed=await f.pipeline.run(f.create().id);
 assert.notEqual(failed.status,'completed');assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.equal(f.extracts.length,2,'missing member accounting receives the existing bounded extraction repair');
 assert.deepEqual(f.extracts[0].evidenceRanges,f.extracts[1].evidenceRanges);
 assert.ok(failed.batches.every(batch=>!batch.supersededBy),'invalid accounting cannot silently turn into successful smaller semantic scopes');
});

for(const malformed of ['incomplete-without-reason','legacy-capacity-envelope'])test(`new work rejects ${malformed} without completing its supplied range`,async t=>{
 const f=await fixture(t,['Generated fully supplied source.']);
 f.setGenerate(async input=>{const draft=result(input),value=JSON.parse(draft.answer);if(malformed==='incomplete-without-reason')value.coverage[0].state='incomplete';else value.capacity={saturated:false};return {...draft,answer:JSON.stringify(value)};});
 const failed=await f.pipeline.run(f.create().id);assert.notEqual(failed.status,'completed');assert.equal(f.extracts.length,2);assert.equal(f.reviews.length,0);
 assert.ok(failed.batches.every(batch=>!batch.supersededBy));assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('every supporting target range declares cross-range ownership, including two windows of one evidence record',async t=>{
 const text='Generated first option.\nGenerated second option.',f=await fixture(t,[text]);
 const firstLength=text.indexOf('\n'),secondOffset=firstLength+1;
 let reviewAttempt=0;
 f.setGenerate(async input=>{const members=work(input).members,draft=result(input,[{member:members[0],quote:'Generated first option.',offset:0}]),value=JSON.parse(draft.answer);value.memories[0].statement=`The owner selected both generated options [${f.ids[0]}]`;value.memories[0].evidence.push({id:f.ids[0],quote:'Generated second option.',offset:secondOffset});value.coverage[1]={key:members[1].key,state:'checked',candidateIndexes:[0]};return {...draft,answer:JSON.stringify(value)};});
 f.setReview(async(_input,draft)=>{if(++reviewAttempt>1)return {...draft,runId:'generated-repaired-review'};const value=JSON.parse(draft.answer);value.coverage[1]={...value.coverage[1],state:'no_candidates',candidateIndexes:[]};return {...draft,runId:'generated-missing-context-owner',answer:JSON.stringify(value)};});
 const done=await f.pipeline.run(f.create({evidenceRanges:[{id:f.ids[0],offset:0,length:firstLength},{id:f.ids[0],offset:secondOffset,length:text.length-secondOffset}]}).id);
 assert.equal(done.status,'completed');assert.equal(done.memoryIds.length,1);assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,2);
 assert.equal(done.batches[0].validationFailures![0].code,'coverage');assert.ok(done.batches[0].coverage!.every(member=>member.state==='checked'&&member.memoryIds[0]===done.memoryIds[0]));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
});

test('a source replacement during independent review fences all selected candidates and checkpoints',async t=>{
 const lines=facts(40),f=await fixture(t,[lines.join('\n')]);
 f.setGenerate(async input=>result(input,lines.map((quote,index)=>({member:work(input).members[0],quote,index}))));
 f.setReview(async(_input,draft)=>{await f.sources.upsert('generated-ranges',{externalId:'0',revision:'2',text:'Generated corrected source.',observedAt:'2026-10-13T01:00:00Z',kind:'file',layer:'original'});return {...draft,runId:'generated-obsolete-review'};});
 const failed=await f.pipeline.run(f.create().id);assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'evidence_changed');assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('a pinned policy reviewer receives host repair after an inner validation failure without repeating extraction',async t=>{
 const lines=facts(2),f=await fixture(t,[lines.join('\n')]);let attempts=0,originalDraft:unknown;
 f.setGenerate(async input=>result(input,lines.map((quote,index)=>({member:work(input).members[0],quote,index}))));
 f.setReview(async(input,draft)=>{
  const supplied=input.taskContext!.untrustedMemoryDraft;
  if(++attempts===1){originalDraft=structuredClone(supplied);throw new MemoryOutputValidationError('quote_not_found','Generated reviewer could not verify an exact quote',{workContract:contract,candidateIndex:0,evidenceId:f.ids[0]});}
  const repair=input.memoryReviewRepair;
  assert.ok(repair);assert.match(repair,/quote|exact/i);assert.match(input.question,/Host review repair:/);assert.ok(input.question.includes(repair));
  assert.deepEqual(supplied,originalDraft,'repair retains the same valid draft for independent review');assert.deepEqual(input.evidenceRanges,f.extracts[0].evidenceRanges);assert.equal(work(input).workContract,contract);
  return {...draft,runId:'generated-repaired-pinned-review'};
 });
 const done=await f.pipeline.run(f.create({recipes:[{id:'mote.personal-memory',version:'5'}]}).id);
 assert.equal(done.status,'completed');assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,2);assert.equal(done.memoryIds.length,2);
 assert.equal(done.batches[0].validationFailures![0].code,'quote_not_found');assert.equal(done.batches[0].reviewReceipt!.reviewRunId,'generated-repaired-pinned-review');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
});

for(const unbound of [false,true])test(`a saved legacy ${unbound?'unbound':'pinned-policy'} task repairs independent review without introducing a target coverage contract`,async t=>{
 const quote='Generated legacy original.',f=await fixture(t,[quote],12000,!unbound);let attempts=0;
 f.setGenerate(async()=>({runId:'generated-legacy-draft',trace:[],citations:[{id:f.ids[0],capturedAt:at,appName:'Generated',excerpt:quote}],answer:JSON.stringify({memories:[{title:'Generated legacy selection',statement:`Generated legacy selection [${f.ids[0]}]`,uncertainty:'Generated only',admission:{layer:'memory',reason:'Generated fixture decision',scope:'Generated only',attribution:'user'},evidenceIds:[f.ids[0]],evidence:[{id:f.ids[0],quote}]}]})}));
 f.setReview(async(input,draft)=>{assert.equal(input.taskContext?.memoryWork,undefined);assert.equal(JSON.parse(draft.answer).coverage,undefined);
  if(++attempts===1)throw new MemoryOutputValidationError('quote_not_found','Generated legacy reviewer validation failure');
  assert.ok(input.memoryReviewRepair);assert.match(input.question,/Host review repair:/);assert.ok(input.question.includes(input.memoryReviewRepair));return {...draft,runId:'generated-legacy-repaired-review'};
 });
 const job=f.create({workPackage:undefined,...(unbound?{}:{recipes:[{id:'mote.personal-memory',version:'2'}]})});assert.equal(job.workContract,undefined);await f.restart();assert.equal(f.extracts.length+f.reviews.length,0,'restart does not execute old work implicitly');
 const done=await f.pipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(done.batches[0].strategy?.workContract,undefined);assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,2);assert.equal(done.memoryIds.length,1);assert.equal(done.batches[0].coverage,undefined);if(unbound){assert.equal(done.batches[0].strategy,undefined);assert.equal(f.pipeline.create({evidenceIds:f.ids}).workContract,contract,'only a new reviewed unbound job receives the new contract');}
});

test('raw extraction and independent review repairs retain exact scope within the existing Agent question budget',async t=>{
 const quote='Generated owner choice: retain explicit transaction boundaries.',f=await fixture(t,[quote]);let generation=0,reviewAttempt=0;
 f.setGenerate(async input=>{assert.ok(input.question.length<=20000);const draft=result(input,[{member:work(input).members[0],quote}]);if(++generation===1){const value=JSON.parse(draft.answer);value.memories[0].admission.attribution='generated-invalid-enum';return {...draft,answer:JSON.stringify(value)};}assert.match(input.question,/Host validation rejected the previous output/);return draft;});
 f.setReview(async(input,draft)=>{assert.ok(input.question.length<=20000,'the independent Agent receives one canonical policy within its question limit');assert.doesNotMatch(input.question,/Host validation rejected the previous output/,'extraction repair does not become repeated independent-review policy');
  if(++reviewAttempt===1)throw new MemoryOutputValidationError('schema','Generated reviewer schema failure',{workContract:contract,fieldPath:'memories[0].admission.attribution',problem:'invalid_enum_value'});
  assert.ok(input.memoryReviewRepair);assert.ok(input.question.includes(input.memoryReviewRepair));assert.deepEqual(input.evidenceRanges,f.extracts[0].evidenceRanges);return {...draft,runId:'generated-two-stage-repaired-review'};
 });
 const done=await f.pipeline.run(f.pipeline.create({evidenceIds:f.ids}).id);assert.equal(done.status,'completed');assert.equal(f.extracts.length,2);assert.equal(f.reviews.length,2);assert.equal(done.memoryIds.length,1);
 assert.deepEqual(done.batches[0].validationFailures!.map(failure=>failure.phase),['extract','review']);assert.equal(f.memories.get(done.memoryIds[0]).evidence![0].quote,quote);
});

for(const variant of ['coding-original','personal-correction','coding-correction'] as const)test(`new raw range assessment preserves the ${variant} provenance procedure`,async t=>{
 const text='Generated owner uses explicit transaction boundaries.',f=await fixture(t,[text]);let id=f.ids[0];
 if(variant!=='personal-correction')id=(await f.sources.upsert('generated-ranges',{externalId:'coding',revision:'1',text,observedAt:at,kind:'message',layer:'original',document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'generated-event',role:'user',part:0,parts:1}}})).id;
 if(variant!=='coding-original'){
  const coding=variant==='coding-correction',candidate={domain:coding?'coding':'personal',title:'Generated source decision',statement:`Generated owner decision [${id}]`,uncertainty:'Generated project only',admission:{layer:'memory',reason:'Generated owner expression',scope:'This project only',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:text}],...(coding?{coding:{kind:'decision',scope:'session',applicability:'Generated transaction work',validation:'observed'}}:{})};
  const saved=f.memories.extract({answer:JSON.stringify({memories:[candidate]}),citations:[{id,capturedAt:at,appName:'Generated',excerpt:''}],trace:[],runId:'generated-original-memory'},'generated',{profile:coding?'coding':'personal'}).items[0];
  const corrected=await f.memories.correct(saved.id,{version:saved.version,title:'Generated owner correction',statement:'Generated owner correction: transactions apply only to batched writes.'});id=corrected.evidenceIds[0];
 }
 f.setGenerate(async input=>{assert.equal(work(input).workContract,contract);assert.equal(input.skill,'memory-strategy');assert.doesNotMatch(input.question,/at most (?:3|8)|at most eight/i);if(variant!=='personal-correction')assert.match(input.question,/speaker\/tool role|provenance-specific input procedure/);if(variant!=='coding-original')assert.match(input.question,/explicit owner correction already saved/);return result(input);});
 const before=f.memories.list().length,done=await f.pipeline.run(f.pipeline.create({evidenceIds:[id]}).id);assert.equal(done.status,'completed');assert.equal(done.memoryIds.length,0);assert.equal(f.memories.list().length,before,'reassessment does not restate a confirmed owner correction');assert.equal(f.reviews.length,1);
});

test('actual provider context capacity leaves exact target ranges unfinished without recursion',async t=>{
 const text=facts(8).join('\n')+'\n'+'🌱'.repeat(2000),f=await fixture(t,[text,...Array.from({length:6},()=> 'Generated short neutral input.')]);
 f.setGenerate(async()=>{throw new ProviderFailure({category:'permanent',code:'processing_limit'});});
 const job=f.create(),failed=await f.pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.batches.length,job.batches.length);assert.equal(f.extracts.length,job.batches.length);assert.equal(f.reviews.length,0);
 assert.ok(failed.batches.every(batch=>batch.errorCode==='processing_limit'&&!batch.supersededBy));assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('an actual output-limit error remains failed and one explicit retry preserves completed siblings across restart',async t=>{
 const f=await fixture(t,['Generated completed sibling.'.padEnd(300,'.'),'Generated failed sibling.'.padEnd(300,'.')],300);let fail=true;
 f.setGenerate(async input=>{if(input.evidenceIds[0]===f.ids[1]&&fail)throw new AgentResponseError('Generated provider exhausted output tokens','output_limit');return result(input);});
 const job=f.create(),failed=await f.pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.completedBatches,1);assert.equal(failed.failedBatches,1);
 const completed=failed.batches.find(batch=>batch.status==='completed')!,checkpoint=f.store.db.prepare('SELECT key FROM memory_checkpoints').all(),before=f.extracts.length;
 await f.restart();fail=false;const done=await f.pipeline.retry(job.id);
 assert.equal(done.status,'completed');assert.equal(f.extracts.length,before+1);assert.equal(done.batches.find(batch=>batch.id===completed.id)!.attempts,completed.attempts);
 assert.ok(checkpoint.every(row=>f.store.db.prepare('SELECT key FROM memory_checkpoints WHERE key=?').get(row.key)));assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
});

test('an oversized adapter answer is rejected rather than trimmed into apparent complete evaluation',async t=>{
 const f=await fixture(t,['Generated bounded original.']);
 f.setGenerate(async input=>({...result(input),answer:' '.repeat(1_000_001)}));
 const job=f.create(),failed=await f.pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(failed.batches.length,1);assert.ok(f.extracts.length<=2,'resource rejection cannot create an unbounded regeneration loop');
 assert.equal(f.reviews.length,0);assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 f.setGenerate(async input=>result(input));const done=await f.pipeline.retry(job.id);assert.equal(done.status,'completed');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
});

test('actual oversized response fails once with no partial proposal or checkpoint',async t=>{
 const f=await fixture(t,['Generated large original.'.padEnd(8192,'.')]);f.setGenerate(async()=>{throw new AgentResponseError('Generated actual transport response capacity','response_too_large');});
 const failed=await f.pipeline.run(f.create().id);assert.equal(failed.status,'failed');assert.equal(failed.batches.length,1);assert.equal(f.extracts.length,1);assert.equal(f.reviews.length,0);assert.equal(failed.batches[0].errorCode,'model_output_capacity');assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('absent saved work contract and pinned old recipes retain legacy capacity behavior without implicit replay',async t=>{
 const lines=facts(8),f=await fixture(t,[lines.join('\n')]);
 f.setGenerate(async input=>{assert.equal(work(input).workContract,undefined);return result(input,lines.map((quote,index)=>({member:work(input).members[0],quote,index})));});
 const job=f.create({recipes:[{id:'mote.personal-memory',version:'2'}]});
 const failed=await f.pipeline.run(job.id);assert.equal(failed.status,'failed');assert.equal(failed.batches[0].errorCode,'memory_capacity_saturated');
 const calls=f.extracts.length+f.reviews.length,oldBinding=failed.batches[0].strategy;
 await f.restart();assert.equal(f.pipeline.get(job.id).status,'failed');assert.equal(f.extracts.length+f.reviews.length,calls);assert.deepEqual(f.pipeline.get(job.id).batches[0].strategy,oldBinding);
 assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.equal(f.pipeline.strategies.resolve({id:'mote.personal-memory',version:'5'}).binding.workContract,contract);
});

for(const explicitRecipe of [false,true])test(`public source and Memory job API complete 40 selected results and retain the new frozen policy through app restart${explicitRecipe?' with personal-v5 selection':' with omitted recipes'}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-range-evaluation-http-')),lines=facts(40),calls:QueryInput[]=[];
 const config:Config={dataDir:directory,token:'generated-range-evaluation-token',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-unused',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 let node:Awaited<ReturnType<typeof buildApp>>;
 const generate=async(input:QueryInput):Promise<QueryResult>=>{calls.push(input);const plan=await fixtureMemoryPlan(input);if(plan)return plan;assert.equal(work(input).workContract,contract);const member=work(input).members.find(member=>node.memories.readEvidence([member.id])[0].ocrText.includes(lines[0]));return result(input,member?lines.map((quote,index)=>({member,quote,index})):[]);};
 const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:generate},createModelAgent:async()=>({configured:true,close:async()=>{},query:generate})};
 const open=async()=>{node=await buildApp(config,dependencies);await node.app.ready();};await open();
 const api=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal((await api('POST','/api/sources',{id:'generated-selection',name:'Generated selection',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'})).statusCode,200);
 const inserted=await api('PUT','/api/sources/generated-selection/items',{externalId:'choices',revision:'1',observedAt:at,kind:'message',layer:'original',text:lines.join('\n'),document:{contentRole:'authored',recordedAt:at,timeBasis:'recorded'}});assert.equal(inserted.statusCode,200,inserted.body);
 await node.materialOrganizer.tick();await node.sourcePipelines.tick();
 const material=node.materials.list({sourceId:'generated-selection'}).items[0];assert.ok(material);
 const created=await api('POST','/api/memory-jobs',{evidenceIds:node.materials.evidenceIds(material.ref),...(explicitRecipe?{recipes:[{id:'mote.personal-memory',version:'5'}]}:{})});assert.equal(created.statusCode,202,created.body);
 const done=await node.memoryPipeline.run(created.json().id);assert.equal(done.status,'completed');assert.equal(done.memoryIds.length,40);assert.ok(done.batches.every(batch=>batch.evaluation?.workContract===contract));if(explicitRecipe)assert.ok(done.batches.every(batch=>batch.strategy?.workContract===contract));else assert.equal(done.workContract,contract);
 const read=await api('GET','/api/memory-jobs/'+done.id);assert.equal(read.statusCode,200);assert.equal(read.json().memoryCount,40);
 const before=calls.length,memoryIds=[...done.memoryIds];await node.app.close();await open();
 const restored=await api('GET','/api/memory-jobs/'+done.id);assert.equal(restored.statusCode,200);assert.deepEqual(restored.json().memoryIds,memoryIds);
 assert.equal((await api('POST','/api/memory-jobs/'+done.id+'/retry')).statusCode,202);await node.memoryPipeline.run(done.id);assert.equal(calls.length,before,'completed API work never repeats generation or review after restart');
 assert.equal(node.memories.list({limit:100}).length,40);
});

test('owner retry after incomplete assessment preserves successful sibling and phase receipts across restart',async t=>{
 const texts=['Generated completed sibling. '+'.'.repeat(8000),'Generated incomplete sibling. '+'.'.repeat(8000)],f=await fixture(t,texts);
 f.setGenerate(async input=>{
  const member=work(input).members[0],draft=result(input,[{member,quote:member.id===f.ids[0]?'Generated completed sibling.':'Generated incomplete sibling.'}]);
  if(member.id===f.ids[1]){const value=JSON.parse(draft.answer);value.coverage[0].state='incomplete';value.coverage[0].reason='Generated target was not fully assessed';draft.answer=JSON.stringify(value);}
  return draft;
 });
 const job=f.create(),blocked=await f.pipeline.run(job.id);
 assert.equal(blocked.completedBatches,1);assert.equal(blocked.failedBatches,1);assert.equal(blocked.memoryCount,1);
 assert.equal(f.extracts.length,2);assert.equal(f.reviews.length,2);
 const phases=()=>f.store.db.prepare('SELECT step_id,output_hash FROM memory_phase_outputs ORDER BY step_id').all();
 const before=phases(),completed=blocked.batches.find(batch=>batch.status==='completed')!;
 assert.equal(before.length,4);
 const failed=blocked.batches.find(batch=>batch.status==='failed')!;
 assert.equal((f.extracts[1].taskContext!.memoryWork as Work&{history:unknown[]}).history.length,0);
 assert.equal(failed.evaluation!.incompleteTargets,1);
 await f.restart();
 const retried=await f.pipeline.retry(job.id);
 assert.equal(retried.errorCode,'memory_evaluation_incomplete');assert.equal(retried.completedBatches,1);assert.equal(retried.failedBatches,1);
 assert.equal(f.extracts.length,2,'retry does not issue another extraction');assert.equal(f.reviews.length,2,'retry does not issue another review');
 assert.deepEqual(phases(),before,'all successful phase outputs survive restart and retry');
 assert.deepEqual(retried.batches.find(batch=>batch.id===completed.id)!.memoryIds,completed.memoryIds);
 assert.equal(f.memories.list().length,1,'failed batch remains unpublished');
});
