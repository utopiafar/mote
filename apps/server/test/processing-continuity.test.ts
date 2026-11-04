import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ProcessingRuntime,type ProcessingLane} from '../src/processing-runtime.js';
import {MaterialConsumerRegistry} from '../src/material-consumers.js';
import {SourcePipelineRegistry} from '../src/source-pipelines.js';
import {PluginHost} from '@mote/plugin-host';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {ExecutionEngine,ExecutionFailure} from '../src/execution-engine.js';
import type {Context} from '@deepseek-ai/cordis';
import {UsageLedger} from '../src/usage.js';
import {linkOperationParent} from '../src/operation-projection.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';

const lanes:ProcessingLane[]=['extract','aggregate','semantic','memory'];
const observation=(text='Generated evidence')=>({id:randomUUID(),deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-10-05T00:00:00Z',durationMs:0,source:'note',appName:'Fixture',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-continuity-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;
}

test('semantic and memory lanes continue beyond both former daily allowances across midnight',async t=>{
  const store=fixture(t);let now=Date.parse('2026-10-05T23:59:59Z');
  const runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:2},memory:{concurrency:2}},()=>now);t.after(()=>runtime.close());
  const record=observation('G'.repeat(12000));await store.ingest(record);
  const calls={semantic:0,memory:0},active={semantic:0,memory:0},peak={semantic:0,memory:0};
  for(const lane of ['semantic','memory'] as const){
    runtime.registry.register({id:'fixture.'+lane,version:'1',lane,async process(input){
      calls[lane]++;active[lane]++;peak[lane]=Math.max(peak[lane],active[lane]);
      assert.equal(input.observations[0].ocrText.length,12000);await new Promise(resolve=>setImmediate(resolve));active[lane]--;
      return [{kind:'generated',text:'Complete',metadata:{}}];
    }});
    for(let index=0;index<105;index++)runtime.enqueue([{name:'s',processor:'fixture.'+lane,inputs:[record.id],config:{index}}]);
  }
  for(let i=0;i<10&&calls.semantic+calls.memory<210;i++)await runtime.tick();
  assert.deepEqual(calls,{semantic:105,memory:105});assert.deepEqual(peak,{semantic:2,memory:2});
  assert.equal(store.db.prepare("SELECT count(*) n FROM processing_jobs WHERE state!='succeeded'").get()!.n,0);
  now+=2000;
  runtime.enqueue([{name:'next',processor:'fixture.semantic',inputs:[record.id],config:{index:105}}]);await runtime.tick();assert.equal(calls.semantic,106);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='processing_usage'").get(),undefined);
});

test('parent re-entry preserves a failed semantic child until an explicit retry',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());
 const record=observation();await store.ingest(record);let calls=0,fail=true;
 runtime.registry.register({id:'fixture.terminal-semantic',version:'1',lane:'semantic',async process(){calls++;if(fail)throw Error('Generated unknown processing failure');return [{kind:'generated',text:'Generated explicitly retried result',metadata:{}}];}});
 runtime.engine.register({kind:'fixture.parent',pool:'fixture.parent',policy:EXECUTION_POLICIES.orchestration,concurrency:()=>1,validate:()=>true,admit:()=>new ExecutionFailure('waiting','generated_resource_wait',60000),execute:async()=>undefined,commit:()=>{}});
 const parent=runtime.engine.enqueue('fixture.parent','fixture.parent',{}),steps=[{name:'child',processor:'fixture.terminal-semantic',inputs:[record.id]}];
 const id=runtime.enqueue(steps,{stepId:parent,fence:'generated-first-grant'}).child;await runtime.tick();
 assert.equal(calls,1);assert.equal(runtime.engine.get(id)?.state,'failed');
 const failed=store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id)!.json;
 for(const fence of ['generated-first-grant','generated-renewed-grant']){
  assert.equal(runtime.enqueue(steps,{stepId:parent,fence}).child,id);await runtime.tick();
  assert.equal(calls,1);assert.equal(runtime.engine.get(id)?.state,'failed');assert.equal(store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id)!.json,failed);
 }
 fail=false;runtime.retry(id);await runtime.tick();assert.equal(calls,2);assert.equal(runtime.engine.get(id)?.state,'succeeded');
 runtime.enqueue(steps,{stepId:parent,fence:'generated-next-grant'});await runtime.tick();assert.equal(calls,2,'completed semantic output is reused');
});


test('stopping the host activation fences in-flight processor output and every registration epoch',async t=>{
  const store=fixture(t),host=new PluginHost({kind:'central',id:'generated-continuity-host'});
  let runtime!:ProcessingRuntime,pipeline!:SourcePipelineRegistry,consumers!:MaterialConsumerRegistry;
  let pipelineEpoch:string|undefined,consumerEpoch:string|undefined;
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const identity={host:{kind:'central' as const,id:'generated-continuity-host'},packageId:'generated.continuity',installationId:'generated-install',instanceId:'generated-processing',activationId:randomUUID()};
  const handle=await host.install({identity,contributions:[],factory:context=>{
    runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,undefined,context.scope);
    runtime.registry.register({id:'fixture.host-scope',version:'1',lane:'extract',async process(){entered();await held;return [{kind:'generated',text:'Generated late host output',metadata:{}}];}});
    pipeline=new SourcePipelineRegistry(context.scope);
    pipeline.register({id:'fixture.host-pipeline',version:'1',sourceKinds:['note'],storage:'records',index:'none',modelInput:'material'});
    consumers=new MaterialConsumerRegistry(context.scope);
    consumers.register({id:'fixture.host-consumer',version:'1',processor:'fixture.host-scope',processorVersion:'1',accepts:{kind:'note',schemaVersion:1,key:'body'}});
    pipelineEpoch=pipeline.epochs.get('fixture.host-pipeline');consumerEpoch=consumers.epochs.get('fixture.host-consumer');
    return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
  }});
  t.after(async()=>{release();await runtime?.close();await host.close();});
  const record=observation('Generated host scope input');await store.ingest(record);
  const id=runtime.enqueue([{name:'held',processor:'fixture.host-scope',inputs:[record.id]}]).held;
  const running=runtime.tick();await started;
  await handle.close('disabled');release();await running;
  assert.equal(runtime.engine.get(id)?.state,'blocked');
  assert.equal(runtime.engine.get(id)?.error,'processor_instance_unavailable');
  assert.equal(store.db.prepare("SELECT count(*) n FROM context_artifacts WHERE json_extract(json,'$.processor')='fixture.host-scope'").get()!.n,0);
  assert.equal(pipeline.epochs.matches('fixture.host-pipeline',pipelineEpoch),false);
  assert.equal(consumers.epochs.matches('fixture.host-consumer',consumerEpoch),false);
});

test('module close waits for a held async processor before plugin retirement while sibling execution continues',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-processing-module-close-')),store=new Store(directory),engine=new ExecutionEngine(store);
 let entered!:()=>void,release!:()=>void,retired=0,observedSignal:AbortSignal|undefined;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 const plugin=(ctx:Context)=>{
   ctx.effect(()=>ctx.moteContextProcessors.register({id:'fixture.held-close',version:'1',lane:'extract',async process(input){
     observedSignal=input.signal;entered();await held;assert.equal(retired,0,'plugin stays installed through processor exit');
     assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,1,'owned SQLite remains usable through processor exit');
     return [{kind:'generated',text:'Generated late processor output',metadata:{}}];
   }}));
   ctx.effect(()=>()=>{retired++;});
 };
 const runtime=new ProcessingRuntime(store,[plugin],{},Date.now,engine);await runtime.ready;
 t.after(async()=>{release();await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const record=observation('Generated held processor source');await store.ingest(record);
 const id=runtime.enqueue([{name:'held',processor:'fixture.held-close',inputs:[record.id]}]).held;
 const running=runtime.tick();await started;const closing=runtime.close();assert.equal(runtime.close(),closing);
 let closed=false;void closing.then(()=>closed=true);await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(observedSignal?.aborted,true);assert.equal(closed,false);assert.equal(retired,0);
 let siblingResult=0;engine.register({kind:'fixture.processing-sibling',pool:'fixture.processing-sibling',concurrency:()=>1,validate:()=>true,execute:async()=>17,commit:(_step,value)=>{siblingResult=Number(value);}});
 const sibling=engine.enqueue('fixture:processing-sibling','fixture.processing-sibling',{});await engine.drain([sibling]);assert.equal(siblingResult,17);
 release();await Promise.all([closing,running]);assert.equal(retired,1);assert.equal(engine.closed,false);
 assert.equal(engine.get(id)?.state,'waiting');assert.equal(engine.get(id)?.error,'interrupted');
 assert.deepEqual(runtime.view().jobs.find(job=>job.id===id)?.outputs,[]);assert.equal(store.db.prepare("SELECT count(*) n FROM context_artifacts WHERE json_extract(json,'$.processor')='fixture.held-close'").get()!.n,0);
});
