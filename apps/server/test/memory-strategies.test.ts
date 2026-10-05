import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {personalMemoryReviewStrategyV2} from '../src/personal-memory-review-policy.js';
import type {MemoryStrategyRef} from '../src/memory-strategy-contract.js';

const ref=(id:string,version='1'):MemoryStrategyRef=>({id:'fixture.'+id,version});
const contextTime='2026-09-01T12:00:00Z';
const original='I felt proud of finishing the prototype. I fixed duplicate writes by using an idempotency key and verified the retry.';
const understanding=(input:QueryInput)=>input.question.includes('FINAL UNIFIED RESPONSE CONTRACT:\nInterpret every supplied part');
const extraction={...ref('extract'),input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],prompt:'GENERATED_EXTRACTION_1'};
const review=(id:string,policy:string)=>({...ref(id),input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy});
const recipe=(id:string,extract:string,reviewId:string)=>({...ref(id),extract:ref(extract),review:ref(reviewId)});

async function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-strategies-')),modulePath=join(directory,'generated-strategies.mjs');
  const extracts=[extraction,{...extraction,version:'2',prompt:'GENERATED_EXTRACTION_2'}];
  const reviews=[review('personal-review','GENERATED_PERSONAL'),review('coding-review','GENERATED_CODING'),{...review('coding-review','GENERATED_CODING_REPLACEMENT'),version:'2'},review('reject-review','GENERATED_REJECT'),review('bad-review','GENERATED_INVALID')];
  const recipes=[recipe('personal','extract','personal-review'),recipe('coding','extract','coding-review'),{...recipe('review-replaced','extract','coding-review'),review:ref('coding-review','2')},{...recipe('extraction-replaced','extract','coding-review'),extract:ref('extract','2'),review:ref('coding-review','2')},recipe('reject','extract','reject-review'),recipe('bad','extract','bad-review')];
  writeFileSync(modulePath,`export default {apiVersion:1,id:'generated-memory-strategies',sourceKinds:[],create(ctx){const disposers=[];return {init:async()=>{
    for(const value of ${JSON.stringify(extracts)})disposers.push(ctx.memoryStrategies.registerExtraction(value));
    for(const value of ${JSON.stringify(reviews)})disposers.push(ctx.memoryStrategies.registerReview(value));
    for(const value of ${JSON.stringify(recipes)})disposers.push(ctx.memoryStrategies.registerRecipe(value));
  },close(){for(const dispose of disposers.reverse())dispose();}};}};`);
  const config:Config={dataDir:join(directory,'vault'),token:'generated-strategy-test-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,connectors:{directory:join(directory,'connectors'),modules:[modulePath]}};
  const calls:QueryInput[]=[],control:{failCoding:boolean;duringExtract?:()=>void;duringReview?:()=>void}={failCoding:false};
  const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input:QueryInput):Promise<QueryResult>=>{
    calls.push(input);if(input.traceContext?.phase==='extract')control.duringExtract?.();const id=input.evidenceIds![0],record=node.memories.readEvidence([id])[0];
    if(understanding(input))assert.ok(input.question.includes('GENERATED_EXTRACTION_1'),'the selected installed extractor also governs unified Coding candidates');
    const common={uncertainty:'Only the supplied generated source is known.',admission:{layer:'memory',reason:'Generated test claim',scope:'Generated session',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:record.ocrText.trim()}]};
    const candidates=[{...common,domain:'personal',title:'Generated personal context',statement:`Felt proud of finishing the prototype [${id}]`},{...common,domain:'coding',title:'Generated coding experience',statement:`Used an idempotency key to prevent duplicate writes and verified retry [${id}]`,coding:{kind:'pitfall',scope:'session',applicability:'Generated prototype retry',validation:'tested'}}];
    let memories=candidates;
    if(input.traceContext?.phase==='review'){
      control.duringReview?.();
      if(control.failCoding&&input.question.includes('GENERATED_CODING'))throw Error('Generated reviewer failure');
      memories=input.question.includes('GENERATED_REJECT')?[]:(input.question.includes('GENERATED_PERSONAL')||input.question.includes('This strategy admits only personal-domain')||input.question.startsWith(personalMemoryReviewStrategyV2.policy))?[candidates[0]]:[candidates[1]];
      if(input.question.includes('GENERATED_INVALID'))memories=[{...candidates[1],evidence:[{id,quote:'This quote never occurred.'}]}];
    }
    const range=input.evidenceRanges?.find(range=>range.id===id),quote=range?record.ocrText.slice(range.offset,range.offset+Math.min(range.length,120)):record.ocrText.slice(0,120);
    return {answer:JSON.stringify(understanding(input)?{summary:'Generated bounded conversation interpretation',evidence:[{id,quote,offset:range?.offset??0}],workRecords:[],events:[],memoryCandidates:memories,actionCues:[]}:{memories}),citations:[{id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()};
  }}};
  let node=await buildApp(config,dependencies);await node.app.ready();
  const disable=()=>{const settings=node.lifecycle.settings();node.lifecycle.configure({...settings,extraction:{...settings.extraction,enabled:false}});};disable();
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const add=async(sourceId:string,coding=false,revision='1')=>{
    if(!node.sources.listSources().some(s=>s.id===sourceId))node.sources.register({id:sourceId,name:'Generated source',kind:coding?'coding-agent':'custom',deviceId:'fixture',platform:'import'});
    if(coding)node.sourcePipelines.configure(sourceId,{memory:false,settleSeconds:0});
    const ack=await node.sources.upsert(sourceId,{externalId:'original',revision,observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text:original+(revision==='1'?'':` Revision ${revision}.`),...(coding?{document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'fixture',sessionId:'session',eventId:'original',role:'user',attribution:'human',part:0,parts:1}}}:{document:{contentRole:'authored'}})});
    await node.materialOrganizer.tick();await node.sourcePipelines.tick();
    const material=node.materials.list({sourceId}).items[0];assert.ok(material);
    return {id:ack.id,evidenceIds:node.materials.evidenceIds(material.ref),material};
  };
  const run=async(evidenceIds:string[],ids:string[])=>{
    const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+config.token},payload:{contextTime,evidenceIds,recipes:ids.map(id=>id.includes('.')?{id,version:'1'}:ref(id))}});
    assert.equal(response.statusCode,202,response.body);return node.memoryPipeline.run(response.json().id);
  };
  return {get node(){return node;},calls,control,add,run,async restart(changed=false){await node.app.close();const selectedConfig={...config};if(changed){const changedPath=join(directory,'changed-strategies.mjs');writeFileSync(changedPath,readFileSync(modulePath,'utf8').replace('GENERATED_EXTRACTION_1','Changed generation'));selectedConfig.connectors={...config.connectors!,modules:[changedPath]};}node=await buildApp(selectedConfig,dependencies);await node.app.ready();disable();},count:(phase:string)=>calls.filter(c=>(c.traceContext?.phase??'extract')===phase).length};
}

test('installed recipes compose independent products, replace either strategy, and reuse extraction across sources and restart',async t=>{
  const f=await fixture(t);assert.equal(f.calls.length,0,'installation is not execution');
  const source=await f.add('diary'),first=await f.run(source.evidenceIds,['personal','coding']);
  assert.equal(first.status,'completed');assert.equal(first.batches.length,2);assert.equal(first.memoryIds.length,2);
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
  const products=first.memoryIds.map(id=>f.node.memories.get(id));
  assert.deepEqual(products.map(m=>m.domain).sort(),['coding','personal']);
  for(const product of products){assert.deepEqual(product.evidenceIds,source.evidenceIds);assert.ok(product.strategy);assert.equal(product.reviewReceipt?.strategy?.fingerprint,product.strategy.review.fingerprint);}
  const personal=products.find(m=>m.domain==='personal')!;f.node.memories.publish(personal.id);
  const replacedReview=await f.run(source.evidenceIds,['review-replaced']);
  assert.equal(replacedReview.status,'completed');assert.equal(replacedReview.batches.length,1,'a different reviewer cannot hit the old completion checkpoint');
  assert.equal(f.count('extract'),1,'same extraction inputs and evaluation time reuse the valid product');assert.equal(f.count('review'),3);
  assert.equal(f.node.memories.get(personal.id).status,'published','reviewing another strategy never overwrites confirmed facts');
  const replacedExtraction=await f.run(source.evidenceIds,['extraction-replaced']);assert.equal(f.node.memories.get(replacedExtraction.memoryIds[0]).skillVersion,'fixture.extract@2');assert.equal(replacedReview.batches[0].strategy?.review.version,'2');assert.equal(replacedReview.batches[0].strategy?.extract.version,'1');assert.equal(f.count('extract'),2);assert.equal(f.count('review'),4);
  const before=f.calls.length;await f.restart();
  assert.equal(f.calls.length,before,'restart and plugin installation do not replay history');
  assert.equal((await f.run(source.evidenceIds,['personal','coding'])).batches.length,0);assert.equal(f.calls.length,before);
  const coding=await f.add('coding',true);await f.run(coding.evidenceIds,['reject','coding']);
  assert.equal(f.count('extract'),3);assert.equal(f.count('review'),6);
  const codingProducts=f.node.memories.list().map(m=>f.node.memories.get(m.id)).filter(m=>m.evidenceIds.some(id=>coding.evidenceIds.includes(id)));
  assert.equal(codingProducts.length,1);assert.equal(codingProducts[0].domain,'coding','one strategy refusing input does not veto another');
  const builtin=await f.run(source.evidenceIds,['mote.personal-memory','mote.coding-memory']);
  assert.equal(builtin.status,'completed');assert.deepEqual(builtin.memoryIds.map(id=>f.node.memories.get(id).domain).sort(),['coding','personal']);
  assert.equal(f.count('extract'),4);assert.equal(f.count('review'),8);
  const oldBinding=f.node.memoryStrategies.resolve({id:'mote.personal-memory',version:'1'}).binding;
  const next=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[{id:'mote.personal-memory',version:'2'}]});
  const nextResult=await f.node.memoryPipeline.run(next.id);
  assert.equal(nextResult.status,'completed');
  assert.equal(f.node.memories.get(nextResult.memoryIds[0]).domain,'personal','the selected v2 reviewer receives its own policy');
  assert.equal(f.count('extract'),4,'the new personal review recipe reuses the unchanged extractor');
  assert.equal(f.count('review'),9);assert.equal(next.batches[0].strategy?.review.version,'2');
  assert.deepEqual(f.node.memoryStrategies.resolve({id:'mote.personal-memory',version:'1'}).binding,oldBinding,'prior strategy pins remain available and unchanged');
  const codingBinding=f.node.memoryStrategies.resolve({id:'mote.coding-memory',version:'1'}).binding;
  const existing=new Map(f.node.store.db.prepare('SELECT id,json FROM memories').all().map(row=>[row.id,row.json]));
  const codingV2=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[{id:'mote.coding-memory',version:'2'}]});
  const codingResult=await f.node.memoryPipeline.run(codingV2.id);
  assert.equal(codingResult.status,'completed');assert.equal(f.count('extract'),4);assert.equal(f.count('review'),10);
  const codingProduct=f.node.memories.get(codingResult.memoryIds[0]);assert.equal(codingProduct.domain,'coding');
  assert.equal(codingProduct.strategy?.review.version,'2');assert.equal(codingProduct.reviewReceipt?.strategy?.fingerprint,codingProduct.strategy?.review.fingerprint);
  assert.deepEqual(codingProduct.strategy?.extract,codingBinding.extract,'Coding v2 changes the reviewer independently');
  assert.deepEqual(f.node.memoryStrategies.resolve({id:'mote.coding-memory',version:'1'}).binding,codingBinding);
  for(const [id,json] of existing)assert.equal(f.node.store.db.prepare('SELECT json FROM memories WHERE id=?').get(id)?.json,json);
  assert.ok(f.calls.every(c=>(c.skill==='memory-strategy'||understanding(c))&&c.evidenceRanges?.length));
});

test('one failed reviewer leaves the other product intact and retries only its needed work',async t=>{
  const f=await fixture(t),source=await f.add('diary');f.control.failCoding=true;
  const failed=await f.run(source.evidenceIds,['personal','coding']);assert.equal(failed.status,'failed');
  assert.equal(failed.completedBatches,1);assert.equal(failed.failedBatches,1);assert.equal(f.count('extract'),1);
  const preserved=failed.batches.find(b=>b.status==='completed')!;f.control.failCoding=false;
  await f.restart();
  const resumed=await f.node.memoryPipeline.retry(failed.id);assert.equal(resumed.status,'completed');
  assert.equal(f.count('extract'),1,'restart reuses the shared validated extraction');
  assert.equal(f.count('review'),3);assert.deepEqual(resumed.batches.find(b=>b.id===preserved.id),preserved);
  const rawMemory=resumed.memoryIds.map(id=>f.node.memories.get(id));assert.equal(rawMemory.length,2);
  await f.add('diary',false,'2');
  assert.ok(rawMemory.every(m=>f.node.memories.get(m.id).status==='stale'));
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts WHERE shared=1').get()!.n,0,'changed evidence invalidates its shared intermediate');
});

test('revising one source invalidates and recomputes only its product while another source stays byte-identical',async t=>{
  const f=await fixture(t),a=await f.add('generated-source-a'),b=await f.add('generated-source-b',true);
  const firstA=await f.run(a.evidenceIds,['coding']),firstB=await f.run(b.evidenceIds,['coding']);
  assert.equal(firstA.status,'completed');assert.equal(firstB.status,'completed');
  assert.equal(firstA.memoryIds.length,1);assert.equal(firstB.memoryIds.length,1);
  const oldA=firstA.memoryIds[0],keptB=firstB.memoryIds[0];
  const rawB=()=>f.node.store.db.prepare('SELECT json FROM memories WHERE id=?').get(keptB)!.json;
  const beforeB=rawB(),beforeCalls=f.calls.length;
  const callsForB=()=>f.calls.filter(call=>call.evidenceIds?.some(id=>b.evidenceIds.includes(id))).length;
  const beforeBCalls=callsForB();assert.equal(beforeBCalls,2);
  assert.equal(f.node.memories.get(keptB).status,'published');
  const revisedA=await f.add('generated-source-a',false,'2');
  assert.equal(f.node.memories.get(oldA).status,'stale');
  assert.equal(rawB(),beforeB,'source invalidation preserves every serialized field of the unrelated Memory');
  assert.equal(f.calls.length,beforeCalls,'updating a source does not itself authorize model work');
  const recomputed=await f.run([...revisedA.evidenceIds,...b.evidenceIds],['coding']);
  assert.equal(recomputed.status,'completed');assert.equal(recomputed.batches.length,1,'unchanged B reuses its fixed-context completion checkpoint');
  assert.equal(recomputed.memoryIds.length,1);
  const fresh=f.node.memories.get(recomputed.memoryIds[0]);assert.equal(fresh.status,'published');assert.notEqual(fresh.id,oldA);
  assert.deepEqual(fresh.evidenceIds,revisedA.evidenceIds);
  assert.equal(f.node.memories.get(oldA).status,'stale','recomputation never revives the superseded evidence product');
  assert.equal(f.calls.length,beforeCalls+2,'only the changed source needs one extraction and one review');
  assert.ok(f.calls.slice(beforeCalls).every(call=>call.evidenceIds?.every(id=>revisedA.evidenceIds.includes(id))));
  assert.equal(callsForB(),beforeBCalls,'no new model phase reads B');
  assert.equal(rawB(),beforeB,'B keeps its full JSON including receipt, versions and timestamps after A recomputes');
});

test('replaceable semantic review cannot bypass exact evidence validation',async t=>{
  const f=await fixture(t),source=await f.add('diary');
  const job=await f.run(source.evidenceIds,['bad']);assert.equal(job.status,'failed');assert.equal(job.memoryIds.length,0);
  assert.ok(job.batches[0].validationFailures?.some(v=>v.phase==='review'&&v.code==='quote_not_found'));
  assert.ok(f.count('extract')<=2&&f.count('review')<=2,'invalid strategies still obey bounded repair');
});

test('recipe contracts are immutable and removed components cannot silently fall back',()=>{
  const registry=new MemoryStrategies(),removeExtract=registry.registerExtraction(extraction),removeReview=registry.registerReview(review('review','Generated'));
  registry.registerRecipe(recipe('recipe','extract','review'));const resolved=registry.resolve(ref('recipe'));
  assert.throws(()=>{resolved.extract.prompt='mutated';},TypeError);
  removeReview();assert.throws(()=>registry.resolvePinned(resolved.binding),/unavailable/);
  assert.equal(registry.list().find(r=>r.id==='fixture.recipe')?.available,false);
  assert.throws(()=>registry.registerReview(review('review','Changed without a version')),/new version/);
  removeExtract();assert.throws(()=>registry.registerExtraction({...extraction,permissions:['evidence.read','shell']}));
});

test('removed strategies stop before billing and during commit; reinstall resumes only the original pinned definition',async t=>{
  const f=await fixture(t),source=await f.add('diary'),definition=review('temporary-review','GENERATED_CODING');
  let remove=f.node.memoryStrategies.registerReview(definition);
  f.node.memoryStrategies.registerRecipe(recipe('temporary','extract','temporary-review'));
  const queued=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[ref('temporary')]});remove();
  const unavailable=await f.node.memoryPipeline.run(queued.id);assert.equal(unavailable.status,'failed');assert.equal(f.calls.length,0);
  assert.equal(unavailable.batches[0].errorCode,'memory_strategy_unavailable');
  remove=f.node.memoryStrategies.registerReview(definition);
  f.control.duringReview=()=>{remove();f.control.duringReview=undefined;};
  const interrupted=await f.node.memoryPipeline.retry(queued.id);assert.equal(interrupted.status,'failed');assert.equal(interrupted.memoryIds.length,0);
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),1);
  f.node.memoryStrategies.registerReview(definition);
  const recovered=await f.node.memoryPipeline.retry(queued.id);assert.equal(recovered.status,'completed');assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
});

test('a recipe pin cannot be replaced by different code under the same version after restart',async t=>{
  const f=await fixture(t),source=await f.add('diary');
  const queued=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[ref('coding')]});
  await f.restart(true);
  const recovered=await f.node.memoryPipeline.run(queued.id);
  assert.equal(recovered.status,'failed');assert.equal(recovered.batches[0].errorCode,'memory_strategy_unavailable');
  assert.equal(f.calls.length,0,'changed installed content cannot run an old pinned job');
});

for(const mutation of ['cancel','delete'] as const)test(`${mutation} during composed review fences late output and preserves only still-valid shared stages`,async t=>{
  const f=await fixture(t),source=await f.add('diary');
  const job=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[ref('personal'),ref('coding')]});
  f.control.duringReview=()=>{f.control.duringReview=undefined;if(mutation==='cancel')f.node.memoryPipeline.cancel(job.id);else f.node.store.delete(source.id);};
  const result=await f.node.memoryPipeline.run(job.id);
  assert.equal(result.status,mutation==='cancel'?'cancelled':'failed');assert.equal(result.memoryIds.length,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts WHERE shared=1').get()!.n,mutation==='cancel'?1:0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  if(mutation==='cancel'){
    assert.equal((await f.run(source.evidenceIds,['coding'])).status,'completed','a separate owner request may consume a validated stage');
    assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
    assert.equal(f.node.memoryPipeline.get(job.id).status,'cancelled','reuse cannot revive the cancelled consumer');
    f.node.store.delete(source.id);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
  }
});

test('cancellation before extraction validation cannot populate shared drafts with late output',async t=>{
  const f=await fixture(t),source=await f.add('diary'),job=f.node.memoryPipeline.create({contextTime,evidenceIds:source.evidenceIds,recipes:[ref('personal')]});
  f.control.duringExtract=()=>f.node.memoryPipeline.cancel(job.id);
  assert.equal((await f.node.memoryPipeline.run(job.id)).status,'cancelled');
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),0);assert.equal(f.node.memories.list().length,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('an explicitly changed evaluation time cannot hit a prior recipe completion checkpoint',async t=>{
  const f=await fixture(t),source=await f.add('diary');await f.run(source.evidenceIds,['personal']);
  const changed=f.node.memoryPipeline.create({contextTime:'2026-09-02T12:00:00Z',evidenceIds:source.evidenceIds,recipes:[ref('personal')]});
  assert.equal(changed.batches.length,1);
  assert.equal((await f.node.memoryPipeline.run(changed.id)).status,'completed');assert.equal(f.count('extract'),2);assert.equal(f.count('review'),2);
  assert.equal((await f.run(source.evidenceIds,['personal'])).batches.length,0,'the unchanged explicit evaluation still reuses its own checkpoint');
});
