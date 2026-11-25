import {fixtureMemoryPipeline,fixtureMemoryResult} from './fixtures/memory-result.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {reviewMemory,memoryReviewReceipt} from '../src/memory-review.js';
import {MemoryReviewCache} from '../src/memory-review-cache.js';
import {EvidenceStore as Store,sha256} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore,MEMORY_ADMISSION_PROMPT,MEMORY_EXTRACTION_PROMPT} from '../src/memory.js';
import {CONSOLIDATION_RELATION_POLICY} from '../src/memory-policy.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {defaultMemoryReviewStrategy} from '../src/memory-review-policy.js';
import {memoryStrategyPin} from '../src/memory-strategy-contract.js';
import {memorySchema,memoryReviewReceiptSchema} from '../src/memory-schema.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {SINGLE_PASS_PERSONAL_RECIPE} from '../src/memory-range-selection-policy.js';
import {decodeMemoryPrivate} from '../src/plugins/memory-private-storage.js';

const id=randomUUID();
const draft=()=>({answer:JSON.stringify({memories:[{title:'Untrusted candidate',statement:`Proposed meeting [${id}]`,uncertainty:'Outcome unknown',admission:{layer:'observation',attribution:'observed',reason:'Model says low risk',scope:'Generated'},evidenceIds:[id],evidence:[{id,quote:'Meeting proposed'}]}]}),citations:[{id,capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:'Meeting proposed'}],trace:[],runId:randomUUID()});
const input=():QueryInput=>({contextTime:'2026-09-01T00:00:00Z',question:'Keep speaker and event state',skill:'memory-extraction',responseMode:'memory-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:0,length:16}],validateOutput:()=>undefined});

test('review of a complete consolidation task fits the Agent question limit without discarding its context',async()=>{
 const context='Generated candidate context. '.repeat(100),question=MEMORY_EXTRACTION_PROMPT+'\n'+CONSOLIDATION_RELATION_POLICY+'\n'+context,d=draft();
 assert.ok(question.length+MEMORY_ADMISSION_PROMPT.length>20000,'Fixture must cross the old duplicate-policy limit');
 await reviewMemory({...input(),question,skill:'memory-consolidation'},d,async request=>{
  assert.ok(request.question.length<=20000);assert.equal(request.question.split(MEMORY_ADMISSION_PROMPT).length-1,1);
  assert.ok(request.question.includes(context));assert.ok(request.question.includes(CONSOLIDATION_RELATION_POLICY));
  assert.deepEqual(request.taskContext?.untrustedMemoryDraft,JSON.parse(d.answer));return {...d,runId:'review'};
 });
});

test('only an identical independently reviewed verdict is reused; no duplicate usage or false run receipt',async()=>{
 const cache=new MemoryReviewCache(),options={cache,snapshot:()=> 'host-version'},d=draft();let calls=0,validations=0;
 const request={...input(),validateOutput:()=>{validations++;return undefined;}};
 const query=async()=>{calls++;return {...d,runId:'actual-review',answer:'{"memories":[]}',usage:{id:randomUUID(),provider:'fixture',model:'fixture',operation:'memory',createdAt:new Date().toISOString(),durationMs:1,status:'completed' as const,estimatedCost:null,currency:'USD'}};};
 const first=await reviewMemory(request,d,query,options);assert.equal(memoryReviewReceipt(first)?.decision,'independent');assert.equal(calls,1);
 const second=await reviewMemory({...request,traceContext:{jobId:'another-job'},onTrace:()=>{}},{...d,runId:'later-extraction'},query,options);
 assert.equal(calls,1);assert.equal(validations,4);assert.equal(second.answer,first.answer);assert.equal(second.usage,undefined);
 assert.deepEqual(memoryReviewReceipt(second),{deletionSnapshot:undefined,resultHash:sha256(second.answer),strategy:memoryStrategyPin(defaultMemoryReviewStrategy),policy:'bounded-exact-review@1',decision:'reused',draftRunId:'later-extraction',reviewRunId:'actual-review',checkedAt:memoryReviewReceipt(second)!.checkedAt,contextTime:input().contextTime,inputHash:memoryReviewReceipt(first)!.inputHash,model:'fixture'});
 second.answer='mutated by caller';assert.equal((await reviewMemory(request,d,query,options)).answer,'{"memories":[]}');
});

test('range, original metadata/version, model configuration and every semantic input invalidate reuse',async()=>{
 const cache=new MemoryReviewCache();let version='source-v1-model-a',calls=0;const options={cache,snapshot:()=>version},d=draft();
 const query=async()=>{calls++;return {...d,runId:'review-'+calls};};
 await reviewMemory(input(),d,query,options);
 for(const change of [{timeZone:'UTC'},{language:'en' as const},{question:'Changed instructions'},{deviceId:'other-device'},{modelProfileId:'other-profile'},{modelOverride:'other-model'},{evidenceRanges:[{id,offset:1,length:15}]},{taskContext:{turns:[],previousSummary:'Changed context'}}])await reviewMemory({...input(),...change},d,query,options);
 assert.equal(calls,9);
 for(const next of ['source-v2-model-a','source-v2-model-b','speaker-corrected-model-b']){version=next;await reviewMemory(input(),d,query,options);}
 assert.equal(calls,12);
 await reviewMemory(input(),{...d,answer:d.answer.replace('Untrusted candidate','Changed title')},query,options);assert.equal(calls,13);
 await reviewMemory(input(),{...d,citations:[{...d.citations[0],excerpt:'Changed quote context'}]},query,options);assert.equal(calls,14);
 await reviewMemory({...input(),contextTime:'2026-09-02T00:00:00Z'},d,query,options);assert.equal(calls,15);
});

test('unbounded retrieval, consolidation and missing host validation always require independent review',async()=>{
 const options={cache:new MemoryReviewCache(),snapshot:()=> 'same'};let calls=0;const query=async()=>{calls++;return draft();};
 for(const request of [{...input(),contextTime:undefined},{...input(),evidenceIds:undefined},{...input(),evidenceRanges:undefined},{...input(),skill:'memory-consolidation' as const},{...input(),validateOutput:undefined}]){const d=draft();await reviewMemory(request,d,query,options);await reviewMemory(request,d,query,options);}
 assert.equal(calls,10);
 const empty=await reviewMemory(input(),{...draft(),answer:'{"memories":[]}'},query,options);assert.equal(calls,11);assert.equal(memoryReviewReceipt(empty)?.decision,'independent');assert.ok(memoryReviewReceipt(empty)?.reviewRunId);
});

test('invalid output, deletion during review, validation race and cancellation cannot populate or use cache',async()=>{
 const cache=new MemoryReviewCache(),d=draft();let version='1',calls=0,invalid=true;
 const options={cache,snapshot:()=>version},query=async()=>{calls++;return {...d,runId:'review'};};
 const request={...input(),validateOutput:(result:{runId:string})=>result.runId===d.runId?undefined:invalid?{code:'scope',feedback:'Host rejection'}:undefined};
 await assert.rejects(reviewMemory(request,d,query,options),/host validation/);invalid=false;
 await reviewMemory(request,d,query,options);assert.equal(calls,2);
 const abort=new AbortController();abort.abort();await assert.rejects(reviewMemory({...input(),signal:abort.signal},d,query,options),{name:'AbortError'});assert.equal(calls,2);
 const changed={...input(),question:'new question'};
 await assert.rejects(reviewMemory(changed,d,async()=>{version='2';return query();},options),/inputs changed/);
 await reviewMemory(changed,d,query,options);assert.equal(calls,4);
 await assert.rejects(reviewMemory({...input(),validateOutput:async()=>{version='3';return undefined;}},d,query,options),/inputs changed/);
 await assert.rejects(reviewMemory(input(),d,query,{cache,snapshot:()=>{throw Error('source deleted');}}),/source deleted/);
});

test('review reuse obeys TTL, count/byte bounds and archive isolation',()=>{
 let now=0;const d=draft(),bytes=Buffer.byteLength(JSON.stringify({answer:d.answer,citations:d.citations,trace:[],runId:d.runId})),cache=new MemoryReviewCache(()=>now,bytes*2,2,100);
 cache.put('a',d);cache.put('b',d);assert.ok(cache.get('a'));cache.put('c',d);assert.equal(cache.get('b'),undefined);assert.ok(cache.get('a'));assert.ok(cache.get('c'));
 cache.put('oversized',{...d,answer:'x'.repeat(bytes*3)});assert.equal(cache.get('oversized'),undefined);
 now=100;assert.equal(cache.get('a'),undefined);assert.equal(cache.get('c'),undefined);
 cache.put('a',d);assert.equal(new MemoryReviewCache().get('a'),undefined);cache.clear();assert.equal(cache.get('a'),undefined);
});

test('pipeline saves the host review receipt and activates the validated Memory automatically',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-review-pipeline-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated',{externalId:'1',revision:'1',text:'Meeting proposed',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
 const d=draft();d.answer=d.answer.replaceAll(id,original.id);d.citations[0].id=original.id;
 const pipeline=fixtureMemoryPipeline({store,memories,requireAdmission:true,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>d,review:(request,value)=>reviewMemory(request,value,async()=>({...value,runId:'independent-review'}),{cache:new MemoryReviewCache(),snapshot:()=> 'fixed'})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const job=await pipeline.run(pipeline.create({evidenceIds:[original.id]}).id);assert.equal(job.status,'completed');
 const m=memorySchema.parse(memories.get(job.memoryIds[0]));assert.equal(m.reviewRunId,'independent-review');assert.equal(m.reviewReceipt?.decision,'independent');assert.equal(m.reviewReceipt?.draftRunId,d.runId);assert.equal(m.status,'published');
 assert.equal(memories.publish(m.id).status,'published');
});

test('transaction rollback reuses the validated draft and original independent verdict without duplicate charges',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-review-recovery-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store),cache=new MemoryReviewCache();
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated',{externalId:'1',revision:'1',text:'Meeting proposed',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
 const d=draft();d.answer=d.answer.replaceAll(id,original.id);d.citations[0].id=original.id;let reviews=0,extractions=0;
 const pipeline=fixtureMemoryPipeline({store,memories,requireAdmission:true,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>({...d,runId:'draft-'+ ++extractions}),review:(request,value)=>reviewMemory(request,value,async()=>{reviews++;return {...value,runId:'original-independent-review'};},{cache,snapshot:()=>JSON.stringify(memories.readEvidence([original.id]))})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 store.db.exec("CREATE TRIGGER fixture_commit_failure BEFORE INSERT ON memory_checkpoints BEGIN SELECT RAISE(ABORT,'generated commit failure'); END");
 const job=await pipeline.run(pipeline.create({evidenceIds:[original.id]}).id);assert.equal(job.status,'failed');assert.equal(memories.list().length,0);assert.equal(reviews,1);
 store.db.exec('DROP TRIGGER fixture_commit_failure');
 const recovered=await pipeline.retry(job.id);assert.equal(recovered.status,'completed');assert.equal(extractions,1);assert.equal(reviews,1);
 const m=memories.get(recovered.memoryIds[0]);assert.equal(m.reviewReceipt?.decision,'independent');assert.equal(m.reviewReceipt?.draftRunId,'draft-1');assert.equal(m.reviewRunId,'original-independent-review');assert.equal(m.status,'published');
});

for(const changedDeletion of [false,true])test(`direct publication rollback ${changedDeletion?'rechecks a changed deletion policy':'preserves the exact durable decision'} without repeating extraction or inventing review`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-direct-recovery-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated-direct',name:'Generated direct source',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-direct',{externalId:'one',revision:'1',text:'Meeting proposed',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
 const d=draft();d.answer=d.answer.replaceAll(id,original.id);d.citations[0].id=original.id;let extractions=0,reviews=0,deletionCalls=0;
 const pipeline=fixtureMemoryPipeline({store,memories,requireAdmission:true,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>({...d,runId:'direct-extraction-'+ ++extractions}),review:(input,draft,strategy,draftOrigin,recipe)=>reviewMemory(input,draft,async request=>{
   if(request.question.startsWith('Host Memory deletion review.')){deletionCalls++;return {answer:'{"sameConclusion":true,"newSupportEvidenceIds":[]}',citations:[],trace:[],runId:'generated-deletion-check'};}
   reviews++;throw Error('The selected direct recipe must not invoke an independent reviewer');
 },{strategy,draftOrigin,recipe,deletions:memories.deletions})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 store.db.exec("CREATE TRIGGER fixture_direct_commit_failure BEFORE INSERT ON memory_checkpoints BEGIN SELECT RAISE(ABORT,'generated direct commit failure'); END");
 const failed=await pipeline.run(pipeline.create({evidenceIds:[original.id],recipes:[SINGLE_PASS_PERSONAL_RECIPE]}).id);
 assert.equal(failed.status,'failed');assert.equal(memories.list().length,0);assert.equal(extractions,1);assert.equal(reviews,0);
 const output=store.db.prepare("SELECT json FROM memory_phase_outputs WHERE batch_id=? AND phase='extract'").get(failed.batches[0].id)!;
 const saved=decodeMemoryPrivate<{reviewReceipt:unknown}>(store,JSON.parse(String(output.json)).private),receipt=memoryReviewReceiptSchema.parse(saved.reviewReceipt);
 assert.equal(receipt.decision,'not_required');assert.equal(receipt.validation,'host-evidence@1');assert.equal(receipt.reviewRunId,undefined);
 assert.equal(memoryReviewReceiptSchema.safeParse({...receipt,reviewRunId:'invented-review'}).success,false);
 assert.equal(memoryReviewReceiptSchema.safeParse({...receipt,strategy:undefined}).success,false);
 store.db.exec('DROP TRIGGER fixture_direct_commit_failure');
 if(changedDeletion){const prior=memories.extract(d,'fixture',{requireAdmission:true}).items[0];memories.delete(prior.id);assert.notEqual(memories.deletions.snapshot(),receipt.deletionSnapshot);}
 const recovered=await pipeline.retry(failed.id);assert.equal(recovered.status,'completed');assert.equal(extractions,1);assert.equal(reviews,0);
 if(changedDeletion){
   assert.equal(deletionCalls,1);assert.equal(recovered.memoryIds.length,0);assert.equal(memories.list().length,0);assert.equal(recovered.batches[0].reviewReceipt?.deletionSnapshot,memories.deletions.snapshot());assert.notEqual(recovered.batches[0].reviewReceipt?.resultHash,receipt.resultHash);return;
 }
 assert.equal(deletionCalls,0);
 const memory=memories.get(recovered.memoryIds[0]);assert.equal(memory.status,'published');assert.deepEqual(memory.reviewReceipt,receipt);assert.equal(memory.runId,'direct-extraction-1');assert.equal(memory.reviewRunId,undefined);
 const result={...d,runId:memory.runId};
 assert.throws(()=>memories.extract(result,'fixture',{reviewReceipt:receipt,strategy:new MemoryStrategies().resolve({id:'mote.personal-memory',version:'5'}).binding}),/does not match/,'a no-review receipt cannot publish under a reviewed recipe');
 assert.throws(()=>memories.extract(result,'fixture',{reviewReceipt:receipt,strategy:memory.strategy,reviewRunId:'invented-review'}),/does not match/);
});

for(const canonical of [true,false])test(`native direct extraction ${canonical?'publishes the canonical contract':'rejects an upstream-only draft'} without a review fallback`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-native-direct-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated-native-direct',name:'Generated native direct source',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-native-direct',{externalId:'one',revision:'1',text:'Meeting proposed',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
 let preparations=0,queries=0;
 const pipeline=new MemoryPipeline({store,memories,requireAdmission:true,models:{configured:()=>true,model:()=> 'fixture'},nativeStages:{prepare:async(input,context)=>{
   preparations++;const d=draft();d.citations[0].id=original.id;d.runId=context.opId;
   const value=JSON.parse(d.answer.replaceAll(id,original.id));
   const members=(input.taskContext!.memoryWork as {members:{key:string}[]}).members;
   return {...d,answer:canonical?JSON.stringify({...value,coverage:members.map(member=>({key:member.key,state:'checked',candidateIndexes:[0]}))}):JSON.stringify({nativeFacts:['unconverted upstream fact']})};
 }},phases:{query:async()=>{queries++;throw Error('Native direct extraction supplies the result');},review:(input,draft,strategy,draftOrigin,recipe)=>reviewMemory(input,draft,async()=>{queries++;throw Error('Native direct extraction must not silently select a reviewer');},{strategy,draftOrigin,recipe,deletions:memories.deletions})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const job=await pipeline.run(pipeline.create({evidenceIds:[original.id],recipes:[SINGLE_PASS_PERSONAL_RECIPE]}).id);
 assert.equal(job.status,canonical?'completed':'failed');assert.equal(job.memoryIds.length,canonical?1:0);assert.equal(queries,0);assert.equal(preparations,canonical?1:2);
 if(canonical){const memory=memories.get(job.memoryIds[0]);assert.equal(memory.status,'published');assert.equal(memory.reviewReceipt?.decision,'not_required');assert.equal(memory.reviewRunId,undefined);}
 else{assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);}
});

test('changed host integration instructions invalidate a bounded review cache entry',async()=>{
 const d=draft(),cache=new MemoryReviewCache(),options={cache,snapshot:()=> 'same',strategy:defaultMemoryReviewStrategy};let calls=0;
 const query=async(request:QueryInput)=>{calls++;assert.ok(request.question.includes('Generated host scope'));return {...d,runId:'review-'+calls};};
 await reviewMemory(input(),d,query,{...options,taskInstructions:'Generated host scope A'});
 await reviewMemory(input(),d,query,{...options,taskInstructions:'Generated host scope B'});
 await reviewMemory(input(),d,query,{...options,taskInstructions:'Generated host scope B'});assert.equal(calls,2);
});

test('native eighteen-fact proposals reach independent review before canonical admission; only reviewed output passes the real store contract', async t => {
 const directory=mkdtempSync(join(tmpdir(),'mote-native-review-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-native',name:'Generated native original',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-native',{externalId:'one',revision:'1',text:'The generated owner uses a silver telescope.',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original'});
 const proposal:QueryResult={answer:JSON.stringify({memories:Array.from({length:18},(_,index)=>({title:'Unreviewed native fact '+index,statement:`Native proposal ${index} [${original.id}]`,uncertainty:'Unreviewed generated native fact',admission:{layer:'observation',reason:'Generated native staging proposal',scope:'Only the frozen generated original',attribution:'observed'},evidenceIds:[original.id],evidence:[{id:original.id,quote:'The generated owner uses a silver telescope.'}]}))}),citations:[{id:original.id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:original.id}],trace:[],runId:'generated-native-eighteen'};
 let reviews=0,draftValidations=0,reviewedValidations=0;
 const request:QueryInput={contextTime:'2026-10-01T00:00:00Z',question:'Review only the supplied generated original.',skill:'memory-extraction',responseMode:'memory-extraction',evidenceIds:[original.id],evidenceRanges:[{id:original.id,offset:0,length:memories.readEvidence([original.id])[0].ocrText.length}],validateOutput:value=>{
  if(value.runId===proposal.runId)draftValidations++;else reviewedValidations++;
  try{memories.extract(value,'generated',{requireAdmission:true,validateOnly:true});return undefined;}
  catch{return {code:'schema',feedback:'Generated host requires an independently admitted exact original quote and bounded canonical candidates.'};}
 }};
 const approved=()=>fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated reviewed fact',statement:`The owner uses a silver telescope [${original.id}]`,uncertainty:'Generated fixture only',evidenceIds:[original.id]}]}),citations:proposal.citations,trace:[],runId:'generated-independent-review'});
 const reviewed=await reviewMemory(request,proposal,async input=>{reviews++;assert.equal(input.traceContext?.phase,'review');assert.equal((input.taskContext?.untrustedMemoryDraft as {memories:unknown[]}).memories.length,18);return approved();},{draftOrigin:'native-engine'});
 assert.equal(reviews,1);assert.equal(draftValidations,0);assert.equal(reviewedValidations,1);assert.equal(memoryReviewReceipt(reviewed)?.decision,'independent');assert.equal(memoryReviewReceipt(reviewed)?.draftRunId,proposal.runId);
 assert.equal(memories.list().length,0,'review is read-only; publication remains a separate fenced host step');
 await assert.rejects(reviewMemory(request,proposal,async()=>({...approved(),answer:proposal.answer,runId:'generated-invalid-review'}),{draftOrigin:'native-engine'}),/host validation/);
 assert.equal(reviewedValidations,2);assert.equal(memories.list().length,0,'native origin never grants reviewed-output bypass');
 await assert.rejects(reviewMemory(request,proposal,async()=>{throw Error('Mote proposal must fail before reviewer');},{draftOrigin:'mote'}),/host validation/);
 assert.equal(draftValidations,1,'ordinary Mote draft admission remains required');
});

test('empty native and Mote proposals both require independent review under a reviewed recipe',async()=>{
 const native={answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-empty-native'};let calls=0,validations=0;
 const request={...input(),validateOutput:()=>{validations++;return undefined;}};
 const reviewed=await reviewMemory(request,native,async value=>{calls++;assert.equal(value.traceContext?.phase,'review');return {...native,runId:'generated-empty-native-review'};},{draftOrigin:'native-engine'});
 assert.equal(calls,1);assert.equal(validations,1);assert.equal(memoryReviewReceipt(reviewed)?.decision,'independent');assert.equal(memoryReviewReceipt(reviewed)?.reviewRunId,'generated-empty-native-review');
 const ordinary=await reviewMemory(request,native,async value=>{calls++;assert.equal(value.memoryReviewDraft,undefined);return {...native,runId:'generated-empty-mote-review'};},{draftOrigin:'mote'});
 assert.equal(memoryReviewReceipt(ordinary)?.decision,'independent');assert.equal(memoryReviewReceipt(ordinary)?.reviewRunId,'generated-empty-mote-review');assert.equal(calls,2);
});

test('native and Mote review cache identities are isolated and cached native output cannot bypass validation',async()=>{
 const cache=new MemoryReviewCache(),d=draft();let calls=0,rejectReviewed=false;
 const request={...input(),validateOutput:(value:QueryResult)=>rejectReviewed&&value.runId==='generated-origin-review'?{code:'scope',feedback:'Generated current authority rejects cached result'}:undefined};
 const query=async()=>{calls++;return {...d,answer:'{"memories":[]}',runId:'generated-origin-review'};};
 const options={cache,snapshot:()=> 'generated-fixed-snapshot'};
 const first=await reviewMemory(request,d,query,{...options,draftOrigin:'native-engine'});assert.equal(memoryReviewReceipt(first)?.decision,'independent');
 const reused=await reviewMemory(request,d,query,{...options,draftOrigin:'native-engine'});assert.equal(memoryReviewReceipt(reused)?.decision,'reused');assert.equal(calls,1);
 const different=await reviewMemory(request,d,query,{...options,draftOrigin:'mote'});assert.equal(memoryReviewReceipt(different)?.decision,'independent');assert.equal(calls,2,'same draft/original/model may not reuse a verdict across different host origins');
 rejectReviewed=true;await assert.rejects(reviewMemory(request,d,query,{...options,draftOrigin:'native-engine'}),/host validation/);assert.equal(calls,2,'revoked cached output is rejected before another model call');
});
