import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PluginHost,PluginResourceScope} from '@mote/plugin-host';
import {serviceContract,type Cancellation,type ScopeIdentity} from '@mote/plugin-api/contracts';
import {hasCompleteTokenUsage,type TokenUsage} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {createHostRunSession,type HostSessionAssembly} from '../../../packages/agent/dist/host/run-session.js';
import {hostOutputService,type HostRunSession} from '../../../packages/agent/dist/host/run-contracts.js';
import {createHostOutputProvider} from '../../../packages/agent/dist/host/output.js';
import {runtimeService,type HostRunPort,type RuntimeProvider,type RuntimeRunRequest,type RuntimeOutcome} from '../../../packages/agent/dist/runtime/contracts.js';
import {ActiveExecutionBudget} from '../../../packages/agent/dist/active-budget.js';
import {createHostRunUsageObserver,type HostRunEventObserver} from '../src/agent-runtime-events.js';
import {createAdmittedUsage,type AdmittedUsageMeter} from '../src/plugins/observability-platform.js';
import {Store} from '../src/store.js';
import {UsageLedger} from '../src/usage.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

type HostEvent=Parameters<HostRunEventObserver>[0];
type Scenario={
  run?:(port:HostRunPort,request:RuntimeRunRequest)=>Promise<RuntimeOutcome>;
  repair?:(port:HostRunPort,request:RuntimeRunRequest)=>Promise<RuntimeOutcome>;
  cancel?:(cause:Cancellation)=>void;
  admit?:HostSessionAssembly['admit'];
  prepareError?:Error;
  observerThrows?:boolean;
};
const completed=(answer='Generated answer'):RuntimeOutcome=>({terminal:{kind:'completed'},candidate:{text:JSON.stringify({answer,citationIds:[]})}});
const sample=(total:number,extra:Partial<TokenUsage>={}):TokenUsage=>({requests:1,reportedRequests:1,inputTokens:total-100,outputTokens:100,totalTokens:total,...extra});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

async function fixture(t:import('node:test').TestContext,scenario:Scenario={}){
  const directory=mkdtempSync(join(tmpdir(),'mote-host-events-')),store=new Store(directory),ledger=new UsageLedger(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:true,level:'info'});await diagnostics.init();
  const hostIdentity={kind:'central' as const,id:randomUUID()},host=new PluginHost(hostIdentity),resources=new PluginResourceScope();
  const identity=(id:string):ScopeIdentity=>({packageId:'generated',installationId:'generated-install',instanceId:id,activationId:randomUUID(),host:hostIdentity});
  const scope=Object.assign(resources,{identity:identity('consumer')}),runId=randomUUID(),operationId=randomUUID();
  const rawMeter=createAdmittedUsage(ledger)('generated-provider','generated-model','query',{operationId,agentId:'query',moduleId:'query',skillId:null});
  const counts={updates:0,completed:0,failed:0},meter:AdmittedUsageMeter={modelStarted:()=>rawMeter.modelStarted(),update:usage=>{counts.updates++;rawMeter.update(usage);},complete:()=>{counts.completed++;return rawMeter.complete();},fail:()=>{counts.failed++;return rawMeter.fail();}};
  const events:HostEvent[]=[],observe=createHostRunUsageObserver({runId,meter,diagnostics:{record:(...args)=>{const result=diagnostics.record(...args);if(scenario.observerThrows)throw Error('Generated diagnostic observer error');return result;}}});
  let session:HostRunSession|undefined,port:HostRunPort|undefined,modelCalls=0;
  t.after(async()=>{await session?.close();await resources.close();await host.close();await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});assert.equal(existsSync(directory),false);});
  const provider:RuntimeProvider={capabilities:{modelTransports:['fixture'],taskKinds:['query'],tools:false,images:false,importWorkspace:false,hostDelegation:false,recovery:'none',replacement:'restart'},async prepare(_profile,_model,value){
    port=value;if(scenario.prepareError)throw scenario.prepareError;
    value.emit({type:'tools.ready',tools:[]},null);
    const drive=(request:RuntimeRunRequest,run:Scenario['run'])=>value.runModel(request.attempt,async()=>{modelCalls++;meter.modelStarted();return run?run(value,request):completed();});
    return {run:request=>drive(request,scenario.run),repair:request=>drive(request,scenario.repair),async cancel(cause){scenario.cancel?.(cause);},async close(){}};
  }};
  const modelContract=serviceContract<unknown>('generated.model','1');
  const bindings:Partial<Record<'runtime'|'model'|'output',import('@mote/plugin-api/contracts').ServiceBinding>>={};
  await host.install({identity:identity('foundation'),contributions:[runtimeService,modelContract,hostOutputService],factory:context=>({prepare(){},start(){bindings.runtime=context.provide(runtimeService.id,runtimeService,provider);bindings.model=context.provide(modelContract.id,modelContract,{});bindings.output=context.provide(hostOutputService.id,hostOutputService,createHostOutputProvider());},quiesce(){},stop(){},dispose(){}})});
  const input:QueryInput={question:'Generated Host event query',onHostRunEvent:event=>{events.push(structuredClone(event));observe(event);if(scenario.observerThrows)throw Error('Generated Host event observer error');}};
  const create=async()=>{
    const runtime=await host.acquire(runtimeService,bindings.runtime!,scope.signal),model=await host.acquire(modelContract,bindings.model!,scope.signal),output=await host.acquire(hostOutputService,bindings.output!,scope.signal);
    const selection={modelId:'generated-model',modelRevision:1,profileId:'generated-profile',profileRevision:1,transport:'fixture'};
    session=await createHostRunSession({scope,input,identity:{runId,runtime:{id:'fixture',revision:1,profileId:'fixture-runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64)},model:selection},profile:{binding:runtime.binding,runtimeId:'fixture',profileId:'fixture-runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64),taskKind:'query',configuration:{}},runtime,model:{...model,selection},output,tools:{definitions:[],bindings:[],assertCurrent:()=>scope.assertCurrent()},budget:{activeTimeoutMs:null},activeBudget:new ActiveExecutionBudget(null),commitFence:{assertCurrent:()=>scope.assertCurrent()}},{systemPrompt:'Generated Host policy',prompt:'Generated prompt',contextUsage:{unit:'utf16_characters',system:0,tools:0,question:0,conversation:0,task:0,evidence:0,prompt:0,outputTokenReserve:100,toolResults:0},evidence:()=>({records:new Map(),deliveredRanges:[],imageReadReceipts:[],sourceContextDependencies:[],evidenceDependencies:{version:1,complete:true,ids:[]},trace:[],deliveredCharacters:0}),async readTool(){throw Error('This fixture has no tools');},async close(){},observe:event=>input.onHostRunEvent?.(event),...(scenario.admit?{admit:scenario.admit}:{})});
    return session;
  };
  return {create,runId,events,observe,counts,meter,get port(){return port!;},get modelCalls(){return modelCalls;},receipts:()=>ledger.operation(operationId).items,diagnosticEvents:()=>diagnostics.events(0,100).items};
}

test('actual Host repairs keep one cumulative C06 receipt and terminal identity without double finalization',async t=>{
  let f:Awaited<ReturnType<typeof fixture>>;
  f=await fixture(t,{run:async(port,request)=>{port.emit({type:'usage',usage:sample(1000)},request.attempt);return {terminal:{kind:'completed'},candidate:{text:'not valid JSON'}};},repair:async(port,request)=>{
    assert.equal(f.counts.completed,0,'an attempt terminal cannot finalize the run meter');assert.equal(f.counts.failed,0);
    const previous=f.events.find(event=>event.event.type==='attempt.terminal')!;f.observe(previous);
    port.emit({type:'usage',usage:sample(1125)},request.attempt);port.emit({type:'usage',usage:sample(1250,{requests:2,reportedRequests:2})},request.attempt);port.emit({type:'usage',usage:sample(1250,{requests:2,reportedRequests:2})},request.attempt);return completed();
  }});
  const session=await f.create(),result=await session.execute();assert.equal(result.answer,'Generated answer');assert.equal(session.repairs,1);
  const [receipt]=f.receipts();assert.equal(f.receipts().length,1);assert.equal(receipt.status,'completed');assert.equal(receipt.tokens!.totalTokens,1250);assert.equal(receipt.tokens!.cacheReadTokens,undefined);assert.equal(hasCompleteTokenUsage(receipt.tokens),true);
  assert.equal(f.counts.updates,4,'successive samples in the same attempt must not be dropped by an event-type key');assert.equal(f.counts.completed,1);assert.equal(f.counts.failed,0);
  const attempts=f.diagnosticEvents().filter(event=>event.event==='agent.runtime_attempt_terminal');assert.equal(attempts.length,2);assert.equal(new Set(attempts.map(event=>event.attemptId)).size,2);assert.ok(attempts.every(event=>event.runId===f.runId));
  const terminal=f.events.find(event=>event.event.type==='run.terminal')!;assert.notEqual(terminal.attemptId,null);f.observe(terminal);f.observe({...terminal,event:{type:'run.terminal',terminal:{kind:'failed',failure:{code:'internal'}}}});f.observe({...terminal,event:{type:'usage',usage:sample(9000)}} as HostEvent);
  assert.equal(f.counts.completed,1);assert.equal(f.counts.failed,0);assert.equal(f.receipts()[0].tokens!.totalTokens,1250);assert.equal(f.diagnosticEvents().filter(event=>event.event==='agent.runtime_run_terminal').length,1);
});

test('Host cancellation preserves partial usage and fences actual late usage without leaking pending work',async t=>{
  const started=deferred(),drain=deferred();let f:Awaited<ReturnType<typeof fixture>>,lateRefused=false;
  f=await fixture(t,{run:async(port,request)=>{port.emit({type:'usage',usage:sample(1250,{requests:2,reportedRequests:1,complete:false})},request.attempt);started.resolve();await drain.promise;assert.throws(()=>port.emit({type:'usage',usage:sample(9000)},request.attempt));lateRefused=true;return completed();},cancel:()=>drain.resolve()});
  const session=await f.create(),running=session.execute(),refused=assert.rejects(running);await started.promise;await session.cancel({kind:'cancelled'});await refused;
  assert.equal(lateRefused,true);assert.equal(f.counts.failed,1);assert.equal(f.counts.completed,0);assert.equal(f.receipts().length,1);assert.equal(f.receipts()[0].status,'failed');assert.equal(f.receipts()[0].tokens!.totalTokens,1250);assert.equal(f.receipts()[0].tokens!.complete,false);assert.equal(hasCompleteTokenUsage(f.receipts()[0].tokens),false);
  f.observe(f.events.find(event=>event.event.type==='run.terminal')!);assert.equal(f.counts.failed,1);
});

test('a Host run cancelled inside the real admission boundary creates no fabricated usage row',async t=>{
  const queued=deferred(),f=await fixture(t,{admit:async(_task,signal)=>{queued.resolve();return new Promise((_,reject)=>{const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();});}});
  const session=await f.create(),running=session.execute(),refused=assert.rejects(running);await queued.promise;await session.cancel({kind:'cancelled'});await refused;
  assert.equal(f.modelCalls,0);assert.deepEqual(f.receipts(),[]);assert.equal(f.counts.failed,1);assert.equal(f.events.filter(event=>event.event.type==='run.terminal').length,1);
});

test('preparation failure finalizes the null-attempt observation without starting a receipt',async t=>{
  const failure=Error('Generated provider prepare refusal'),f=await fixture(t,{prepareError:failure});await assert.rejects(f.create(),error=>error===failure);
  assert.deepEqual(f.receipts(),[]);assert.equal(f.modelCalls,0);assert.equal(f.counts.failed,1);const terminal=f.events.find(event=>event.event.type==='run.terminal')!;assert.equal(terminal.attemptId,null);
});

test('a yielded Host run keeps the existing completed usage mapping',async t=>{
  const f=await fixture(t,{run:async(port,request)=>{port.emit({type:'usage',usage:sample(1000)},request.attempt);return {terminal:{kind:'yielded'}};}}),session=await f.create();await assert.rejects(session.execute(),error=>(error as Error).name==='AgentYieldError');
  assert.equal(f.counts.completed,1);assert.equal(f.counts.failed,0);assert.equal(f.receipts()[0].status,'completed');assert.equal(f.diagnosticEvents().find(event=>event.event==='agent.runtime_run_terminal')!.status,'yielded');
});

test('throwing Host and diagnostics observers cannot turn an accepted Host candidate into a failure',async t=>{
  const f=await fixture(t,{observerThrows:true,run:async(port,request)=>{port.emit({type:'usage',usage:sample(1000)},request.attempt);return completed();}}),session=await f.create();assert.equal((await session.execute()).answer,'Generated answer');
  assert.equal(f.counts.completed,1);assert.equal(f.receipts()[0].status,'completed');assert.ok(f.events.some(event=>event.identity.runId===f.runId&&event.event.type==='run.terminal'));
});

test('foreign or invalid samples cannot poison the bound run and unknown usage fields are not persisted',async t=>{
  const secret='GENERATED_PRIVATE_UNKNOWN_USAGE_FIELD',f=await fixture(t,{run:async(port,request)=>{
    port.emit({type:'usage',usage:sample(-1)},request.attempt);port.emit({type:'usage',usage:sample(Number.POSITIVE_INFINITY)},request.attempt);port.emit({type:'usage',usage:{...sample(1000),privateBody:secret} as TokenUsage},request.attempt);return completed();
  }}),session=await f.create();
  const ready=f.events[0];f.observe({...ready,identity:{...ready.identity,runId:'different-run'},attemptId:'foreign',event:{type:'usage',usage:sample(9000)}});
  await session.execute();assert.equal(f.counts.updates,1);assert.equal(f.receipts()[0].tokens!.totalTokens,1000);assert.ok(!JSON.stringify(f.receipts()).includes(secret));assert.ok(!JSON.stringify(f.diagnosticEvents()).includes(secret));assert.equal(f.diagnosticEvents().filter(event=>event.event==='agent.runtime_event_rejected').length,3);
});
