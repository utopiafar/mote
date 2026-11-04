import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {PluginHost} from '@mote/plugin-host';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {MemoryPublication} from '../src/plugins/memory-publication.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import type {MemoryProviderNamespace} from '../src/memory-provider-contract.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {centralServices,checkCentralServiceDeclarations} from '../src/plugins/central-contracts.js';
import {
  createMemoryPhasePipeline,createMemoryPhasePipelineFactory,memoryPhasePipelineContribution,
  memoryPhasePipelineDeclaration,type MemoryPhasePipelineBindings,type MemoryPhasePipelineOptions,
} from '../src/plugins/memory-phase-pipeline.js';

const config={owner:'models' as const,fingerprint:'generated-fixed-pin',revision:1,profileId:'generated-profile',provider:'generated',model:'generated-model'};

function resultFor(record:{id:string;ocrText:string;capturedAt:string;appName?:string},runId:string):QueryResult{
  const quote=record.ocrText.slice(0,Math.min(48,record.ocrText.length));
  return {answer:JSON.stringify({memories:[{title:'Generated reviewed decision',statement:`Generated fixture retains the selected decision [${record.id}]`,uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Generated fixture selection',scope:'This generated fixture only',attribution:'observed'},evidenceIds:[record.id],evidence:[{id:record.id,quote}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName??'Generated',excerpt:quote}],trace:[],runId};
}

async function source(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-phase-plugin-')),store=new Store(directory),sources=new SourceStore(store);
  t.after(()=>{if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
  const receipt=await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated',kind:'file',layer:'original',text:'Generated original for an independent Memory phase.'});
  const record=store.evidence([receipt.id])[0]!;
  return {directory,store,sources,record};
}

function fakeBindings(namespace:MemoryProviderNamespace){
  const memoryByKey=new Map<string,unknown>(),writes:Array<{key:unknown;memory:unknown}>=[];
  const binding={planId:'instance:generated-engine',generation:1,namespace};
  const provider={
    async put(input:{key:unknown;memory:unknown}){const key=JSON.stringify(input.key);memoryByKey.set(key,input.memory);writes.push(input);return {key:input.key,state:'applied'};},
    async read(input:{key:unknown}){return memoryByKey.get(JSON.stringify(input.key))??null;},
    async export(){return [...memoryByKey.entries()].map(([key,memory])=>({key:JSON.parse(key),memory}));},
    async remove(){},
  };
  const bindings={
    binding:()=>structuredClone(binding),provider:()=>provider,plugins:{references:()=>[]},assertNewManualWork:()=>{},
  } as unknown as MemoryBindings;
  return {bindings,provider,writes};
}

function phaseOptions(store:Store,memories:MemoryStore,publication:MemoryPublication,engine:ExecutionEngine,query:(input:QueryInput)=>Promise<QueryResult>):MemoryPhasePipelineOptions{
  return {store,memories,publication,executor:engine,requireAdmission:true,models:{configuration:()=>config,model:()=>config.model,configured:()=>true},phases:{query:async input=>fixtureMemoryResult(memories,await query(input),input.evidenceRanges,input)}} as MemoryPhasePipelineOptions;
}
function reviewed(memories:MemoryStore,record:{id:string;ocrText:string;capturedAt:string;appName?:string},runId:string){
  return async(input:QueryInput)=>fixtureMemoryResult(memories,resultFor(record,runId),input.evidenceRanges,input);
}

test('real publication consumes the exact range, required admission, fixed pin and independent review verdict',async t=>{
  const {store,record}=await source(t),memories=new MemoryStore(store),engine=new ExecutionEngine(store);
  t.after(()=>engine.close());
  const namespace={ownerId:'generated-owner',instanceId:'generated-engine',bindingRevision:1},fake=fakeBindings(namespace);
  const publication=new MemoryPublication(store,memories,fake.bindings,engine);
  t.after(()=>publication.close());
  const seen:any[]=[],stage=publication.stageExtract.bind(publication);
  publication.stageExtract=async(...args)=>{seen.push(structuredClone(args[3]));return stage(...args);};
  let reviewInput:QueryInput|undefined;
  const platform=createMemoryPhasePipeline({
    pipeline:phaseOptions(store,memories,publication,engine,async()=>resultFor(record,'generated-extract')),
    review:{query:async input=>{reviewInput=input;return fixtureMemoryResult(memories,resultFor(record,'generated-independent-review'),input.evidenceRanges,input);},deletions:memories.deletions},
  });
  t.after(()=>platform.close());
  platform.prepare();platform.start();
  const job=await platform.pipeline.run(platform.pipeline.create({evidenceIds:[record.id]}).id);
  assert.equal(job.status,'completed',JSON.stringify(job));
  assert.equal(seen.length,1);
  const options=seen[0];
  assert.deepEqual(options.evidenceRanges,job.batches[0]!.evidenceRanges,'publication receives the exact reviewed range');
  assert.equal(options.requireAdmission,true,'canonical admission remains required');
  assert.equal(options.profile,'personal');
  assert.ok(Object.keys(options.expectedFingerprints).includes(record.id));
  assert.equal(options.reviewReceipt.decision,'independent');
  assert.equal(options.reviewReceipt.draftRunId,'generated-extract');
  assert.equal(options.reviewReceipt.reviewRunId,'generated-independent-review');
  assert.equal(options.reviewRunId,'generated-independent-review');
  assert.equal(reviewInput?.traceContext?.phase,'review');
  const memory=memories.get(job.memoryIds[0]!);
  assert.equal(memory.status,'published');
  assert.deepEqual(memory.reviewReceipt,options.reviewReceipt);
  assert.equal(fake.writes.length,1,'real publication consumed the reviewed body');
  assert.deepEqual(fake.writes[0]!.memory,memory);
  assert.equal(store.db.prepare('SELECT state FROM memory_publications WHERE id=?').get(job.batches[0]!.id)?.state,'committed');
  assert.equal(platform.reviews.get('generated-missing'),undefined);
});

test('quiesce refuses new reviews, stop fences a held review, re-enable resumes the fixed pin and restart keeps the accepted result',async t=>{
  const {directory,store,record}=await source(t),memories=new MemoryStore(store),engine=new ExecutionEngine(store);
  let currentStore=store,currentMemories=memories,currentEngine=engine;
  const namespace={ownerId:'generated-owner',instanceId:'generated-engine',bindingRevision:1},fake=fakeBindings(namespace);
  let publication=new MemoryPublication(store,memories,fake.bindings,engine);
  let platform=createMemoryPhasePipeline({pipeline:phaseOptions(store,memories,publication,engine,async()=>resultFor(record,'generated-extract')),review:{query:reviewed(memories,record,'generated-review'),deletions:memories.deletions}});
  const close=async()=>{await platform.close();await publication.close();};
  t.after(async()=>{await close().catch(()=>{});await currentEngine.close().catch(()=>{});if(currentStore.db.isOpen)currentStore.close();rmSync(directory,{recursive:true,force:true});});
  platform.prepare();platform.start();
  const job=platform.pipeline.create({evidenceIds:[record.id]});
  platform.quiesce('disabled');
  assert.throws(()=>platform.pipeline.create({evidenceIds:[record.id]}),{statusCode:503});
  await assert.rejects(platform.pipeline.run(job.id),{statusCode:503});
  await assert.rejects(platform.review({question:'Generated new review',skill:'memory-extraction',responseMode:'memory-extraction',evidenceIds:[record.id],evidenceRanges:[{id:record.id,offset:0,length:8}],contextTime:'2026-10-01T00:00:00Z'} as QueryInput,resultFor(record,'generated-draft')),{statusCode:503});
  platform.start();
  const done=await platform.pipeline.run(job.id);
  assert.equal(done.status,'completed');
  assert.equal((await platform.pipeline.get(job.id)).batches[0]!.configuration?.fingerprint,config.fingerprint);

  // An explicit stop fences a held independent review before its late result.
  await close();
  await engine.close();store.close();
  currentStore=new Store(directory);currentMemories=new MemoryStore(currentStore);currentEngine=new ExecutionEngine(currentStore);
  const second=fakeBindings(namespace),secondSources=new SourceStore(currentStore);
  const secondReceipt=await secondSources.upsert('generated',{externalId:'two',revision:'1',observedAt:'2026-10-02T00:00:00Z',title:'Generated second',kind:'file',layer:'original',text:'Generated second original for the stopped Memory phase.'});
  const secondRecord=currentStore.evidence([secondReceipt.id])[0]!;
  publication=new MemoryPublication(currentStore,currentMemories,second.bindings,currentEngine);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  platform=createMemoryPhasePipeline({
    pipeline:phaseOptions(currentStore,currentMemories,publication,currentEngine,async()=>resultFor(secondRecord,'generated-extract')),
    review:{query:async input=>{entered();await held;return fixtureMemoryResult(currentMemories,resultFor(secondRecord,'generated-review'),input.evidenceRanges,input);},deletions:currentMemories.deletions},
  });
  platform.prepare();platform.start();
  const blocked=platform.pipeline.create({evidenceIds:[secondRecord.id]}),running=platform.pipeline.run(blocked.id);await started;
  const stopping=platform.stop('disabled');release();
  await stopping;
  const ended=await running;
  assert.equal(ended.memoryIds.length,0,'the held review result never advances the job');
  assert.equal(currentMemories.list().filter(memory=>memory.evidence?.some(span=>span.id===secondRecord.id)).length,0);
  assert.equal(currentStore.db.prepare('SELECT count(*) n FROM memory_checkpoints WHERE evidence_id=?').get(secondRecord.id)!.n,0);
  platform.prepare();platform.start();
  const late=platform.pipeline.create({evidenceIds:[secondRecord.id]});
  const again=await platform.pipeline.run(late.id);
  assert.equal(again.status,'completed');
  const saved=currentMemories.get(again.memoryIds[0]!);
  assert.equal(saved.reviewReceipt?.decision,'independent');
  assert.equal(saved.reviewReceipt?.reviewRunId,'generated-review');
  assert.equal((await platform.pipeline.get(late.id)).batches[0]!.configuration?.fingerprint,config.fingerprint);
});

test('the host factory provides the phase port and releases it on quiesce/stop',async t=>{
  const {store,record}=await source(t),memories=new MemoryStore(store),engine=new ExecutionEngine(store);
  t.after(()=>engine.close());
  const namespace={ownerId:'generated-owner',instanceId:'generated-engine',bindingRevision:1},fake=fakeBindings(namespace);
  const publication=new MemoryPublication(store,memories,fake.bindings,engine);
  t.after(()=>publication.close());
  const platform=createMemoryPhasePipeline({pipeline:phaseOptions(store,memories,publication,engine,async()=>resultFor(record,'generated-extract')),review:{query:reviewed(memories,record,'generated-review'),deletions:memories.deletions}});
  const issues=checkCentralServiceDeclarations(
    [{service:{id:memoryPhasePipelineContribution.provides[0].id,apiVersion:memoryPhasePipelineContribution.provides[0].apiVersion},provider:{scope:{host:{kind:'central',id:'generated'},packageId:'mote.memory-phase-pipeline',installationId:'generated',instanceId:'memory-phase-pipeline',activationId:'generated'},contributionId:memoryPhasePipelineContribution.id}}],
    [{consumer:'mote.memory',service:{id:centralServices.memoryPhase.id,apiVersion:centralServices.memoryPhase.apiVersion}}]);
  assert.deepEqual(issues,[]);
  const host=new PluginHost({kind:'central',id:'generated-memory-phase-host'});
  t.after(()=>host.close());
  let bindings:MemoryPhasePipelineBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'mote.memory-phase-pipeline',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},contributions:[memoryPhasePipelineDeclaration],factory:createMemoryPhasePipelineFactory(platform,value=>{bindings=value;})});
  const lease=await host.acquire(centralServices.memoryPhase,bindings!.phase);
  assert.ok(lease.value.pipeline instanceof MemoryPipeline);
  await handle.quiesce('upgrade');
  assert.throws(()=>lease.value.pipeline.create({evidenceIds:[record.id]}),{statusCode:503});
  await handle.close('disabled');
  assert.throws(()=>lease.value.pipeline,{code:'dependency_unavailable'});
  await lease.release();
});
