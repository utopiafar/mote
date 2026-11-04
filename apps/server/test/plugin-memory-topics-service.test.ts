import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';
import {ContextTreeRegistry} from '../src/context-trees.js';
import type {BackgroundModelAuthorization} from '../src/background-model-authorization.js';
import type {ModelAuthorizationHost} from '../src/model-authorization-host.js';
import type {TopicAuthority,TopicMemoryRead} from '../src/automatic-topics.js';
import {createMemoryTopicsService,createMemoryTopicsServiceFactory,memoryTopicsServiceDeclaration,type MemoryTopicsServiceBindings,type MemoryTopicsServiceDependencies} from '../src/plugins/memory-topics-service.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const at='2026-11-04T10:00:00.000Z';
const output=(ids:string[])=>({trees:[{id:'generated',label:'Generated topics',nodes:[{id:'focus',label:'Generated focus',memoryIds:ids}]}]});
const authority=(controller=new AbortController()):TopicAuthority=>({admissionId:'generated-original-admission',signal:controller.signal,assertCurrent:()=>{controller.signal.throwIfAborted();}});

function profile(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-topics-service-')),store=new Store(directory),memories=new MemoryStore(store),executor=new ExecutionEngine(store),contextTrees=new ContextTreeRegistry();
  t.after(async()=>{await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,memories,executor,contextTrees,reopen(){store.close();return new Store(directory);}};
}

async function seed(store:Store,memories:MemoryStore,titles:string[]){
  const id=randomUUID();
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:at,durationMs:0,ocrText:'Generated topic input evidence.'});
  const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:titles.map(title=>({title,statement:`${title} [${id}]`,uncertainty:'Generated fixture only',evidenceIds:[id]}))}),citations:[{id,capturedAt:at,appName:'Generated',excerpt:'Generated topic input evidence.'}],trace:[],runId:randomUUID()});
  const saved=memories.extract(result,'fixture').items;
  return {id,items:saved.map(memory=>memories.publish(memory.id,memory.version))};
}

function reader(memories:MemoryStore):TopicMemoryRead{
  return {memories,memoryAsync:async ref=>memories.get(String(ref).replace(/^memory:/,'')),assertMemoryReadable:()=>{}};
}

function dependencies(store:Store,memories:MemoryStore,executor:ExecutionEngine,contextTrees:ContextTreeRegistry,classifierCalls:{count:number}):MemoryTopicsServiceDependencies{
  return {
    store,memories,executor,contextTrees,reader:reader(memories),
    control:{stepAuthority:()=> 'generated-admission',inheritStep:()=>{}} as unknown as BackgroundModelAuthorization,
    host:{assertEvidence:()=>{}} as unknown as ModelAuthorizationHost,
    canPublish:()=>true,
    assertReadable:()=>{},
    select:()=>({profileId:'generated-profile',model:'generated-model',connection:{id:'generated-connection',fingerprint:'generated-fingerprint'} as never}),
    query:async()=>{classifierCalls.count++;throw Error('Generated topic host must not call the model directly');},
  };
}

test('a published Memory event is the only enqueued topic input; a stopped plugin fences its late result without stopping Memory reads',async t=>{
  const f=profile(t),{items}=await seed(f.store,f.memories,['Generated published']),published=items[0]!;
  assert.equal(published.status,'published');
  // Extract but do not publish a record, so the host must filter it out.
  const draftId=randomUUID();
  await f.store.ingest({id:draftId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'message',capturedAt:at,durationMs:0,ocrText:'Generated unpublished topic input.'});
  const draft=fixtureMemoryResult(f.memories,{answer:JSON.stringify({memories:[{title:'Generated draft',statement:`Generated draft [${draftId}]`,uncertainty:'Generated fixture only',evidenceIds:[draftId]}]}),citations:[{id:draftId,capturedAt:at,appName:'Generated',excerpt:'Generated unpublished topic input.'}],trace:[],runId:randomUUID()});
  const unpublished=f.memories.extract(draft,'fixture').items[0]!;
  assert.equal(unpublished.status,'proposed');

  const calls={count:0},service=createMemoryTopicsService(dependencies(f.store,f.memories,f.executor,f.contextTrees,calls));
  service.prepare();service.start();
  assert.equal(f.contextTrees.automatic,service.automatic);
  const parentHandler:ExecutionHandler={kind:'fixture.parent',pool:'fixture.parent',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}};
  f.executor.register(parentHandler);
  const parent=f.executor.enqueue('generated-operation','fixture.parent',{generated:true});
  f.store.db.exec('BEGIN IMMEDIATE');
  try{service.host.enqueue(f.executor.get(parent)!, [published,unpublished], 'generated-profile','generated-model');f.store.db.exec('COMMIT');}catch(error){f.store.db.exec('ROLLBACK');throw error;}
  const steps=f.store.db.prepare("SELECT input FROM execution_steps WHERE kind='memory.topics'").all() as {input:string}[];
  assert.equal(steps.length,1);
  assert.deepEqual((JSON.parse(steps[0]!.input) as {memories:{id:string}[]}).memories.map(memory=>memory.id),[published.id],'only the actually published Memory enters the topic task');

  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve),automatic=service.automatic;
  service.topics.register({id:'fixture',version:'1',classify:async()=>{entered();await barrier;return output(items.map(memory=>memory.id));}});
  const running=automatic.classify({operationId:'late-generated',classifierId:'fixture',memoryIds:items.map(memory=>memory.id)},authority());
  await started;
  await service.stop('disabled');
  assert.equal(f.contextTrees.automatic,undefined,'the stopped plugin no longer serves derived trees');
  release();
  await assert.rejects(running);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0,'a late topic result never publishes after plugin stop');
  assert.equal(f.memories.get(published.id).statement,published.statement,'the Memory body and its work remain available');
  await service.close();
  assert.equal(f.store.db.isTransaction,false);
});

test('duplicate delivery and a fresh activation reuse the persisted topic task without a second model call',async t=>{
  const f=profile(t),{items}=await seed(f.store,f.memories,['Generated restart topic']),ids=items.map(memory=>memory.id);
  let calls=0;
  const open=async()=>{
    const service=createMemoryTopicsService(dependencies(f.store,f.memories,f.executor,f.contextTrees,{count:0}));
    service.prepare();service.start();
    service.topics.register({id:'fixture',version:'1',classify:async()=>{calls++;return output(ids);}});
    return service;
  };
  let service=await open(),input={operationId:'generated-restart',classifierId:'fixture',memoryIds:ids};
  await service.topics.classify(input,authority());
  assert.equal(calls,1);assert.equal((await service.topics.trees()).length,1);
  await service.topics.classify(input,authority());
  assert.equal(calls,1,'duplicate delivery keeps one valid topic task');
  await service.stop('upgrade');

  service=await open();
  await service.topics.classify(input,authority());
  assert.equal(calls,1,'a fresh activation resumes the durable task without a new model call');
  assert.equal((await service.topics.trees()).length,1);
  await service.stop('disabled');

  // A process restart keeps the same topic batch and stable tree identity.
  f.store.close();const reopened=f.reopen(),reopenedMemories=new MemoryStore(reopened),reopenedExecutor=new ExecutionEngine(reopened);
  try{
    const restarted=createMemoryTopicsService({...dependencies(reopened,reopenedMemories,reopenedExecutor,new ContextTreeRegistry(),{count:0})});
    restarted.prepare();restarted.start();
    restarted.topics.register({id:'fixture',version:'1',classify:async()=>{calls++;return output(ids);}});
    await restarted.topics.classify(input,authority());
    assert.equal(calls,1);
    assert.equal((await restarted.topics.trees()).length,1);
    await restarted.stop('shutdown');
  }finally{await reopenedExecutor.close();reopened.close();}
});

test('the host factory provides the topic port and fences it after the activation stops',async t=>{
  const f=profile(t),platform=createMemoryTopicsService(dependencies(f.store,f.memories,f.executor,f.contextTrees,{count:0})),host=new PluginHost({kind:'central',id:'generated-memory-topics-host'});
  t.after(()=>host.close());
  let bindings:MemoryTopicsServiceBindings|undefined;
  const handle=await host.install({identity:{host:host.identity,packageId:'generated.memory-topics-service',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[memoryTopicsServiceDeclaration],factory:createMemoryTopicsServiceFactory(platform,value=>{bindings=value;})});
  const lease=await host.acquire(centralServices.memoryTopics,bindings!.topics);
  assert.deepEqual(lease.value.state(),{state:'ready'});
  await handle.quiesce('upgrade');
  assert.throws(()=>lease.value.register({id:'late',version:'1',classify:async()=>({trees:[]})}),{statusCode:503});
  await handle.close('disabled');
  assert.equal(f.contextTrees.automatic,undefined);
  assert.throws(()=>lease.value.state(),{code:'dependency_unavailable'},'the stopped activation no longer serves its port');
});

test('prepare failure detaches the automatic index instead of leaving a half-owned classifier',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-topics-failure-')),store=new Store(directory),memories=new MemoryStore(store),contextTrees=new ContextTreeRegistry();
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const broken={register(){throw Error('Generated duplicate topic handler');}} as unknown as ExecutionEngine;
  const service=createMemoryTopicsService({...dependencies(store,memories,broken,contextTrees,{count:0})});
  assert.throws(()=>service.prepare(),/Generated duplicate topic handler/);
  assert.equal(contextTrees.automatic,undefined,'a failed prepare releases the attached index');
  await assert.rejects(async()=>service.start(),{statusCode:503});
  await service.close();
});
