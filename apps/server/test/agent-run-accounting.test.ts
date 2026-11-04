import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentYieldError,type QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import {createModelAgent,type ModelAgentFactory} from '../src/model-agent.js';
import {ReloadableAgent} from '../src/agent-runtime-registry.js';
import {PluginHost,PluginResourceScope} from '@mote/plugin-host';
import {serviceContract,type ScopeIdentity} from '@mote/plugin-api/contracts';
import {createHostRunSession} from '../../../packages/agent/dist/host/run-session.js';
import {hostOutputService} from '../../../packages/agent/dist/host/run-contracts.js';
import {createHostOutputProvider} from '../../../packages/agent/dist/host/output.js';
import {runtimeService,type HostRunPort,type RuntimeProvider} from '../../../packages/agent/dist/runtime/contracts.js';
import {ActiveExecutionBudget} from '../../../packages/agent/dist/active-budget.js';
import type {ContextReader} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {QueryAgent} from '../src/query-agent.js';
import type {Config} from '../src/config.js';

type HostEvent=Parameters<NonNullable<QueryInput['onHostRunEvent']>>[0];
const token='generated-run-accounting-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const answer=()=>({answer:'Generated accounting answer',citations:[],trace:[],runId:randomUUID()});
const identity=(runId:string)=>({runId,runtime:{id:'generated-runtime',revision:1,profileId:'generated-profile',profileRevision:1,assemblyFingerprint:'generated-fingerprint'},model:{modelId:'generated-model',modelRevision:1,profileId:'generated-profile',profileRevision:1,transport:'generated'}});
const usageEvent=(runId:string,inputTokens=10):HostEvent=>({identity:identity(runId),attemptId:'attempt-1',event:{type:'usage',usage:{requests:1,reportedRequests:1,inputTokens,outputTokens:5,totalTokens:inputTokens+5,cacheReadTokens:0,cacheWriteTokens:0}}});
const terminalEvent=(runId:string):HostEvent=>({identity:identity(runId),attemptId:'attempt-1',event:{type:'run.terminal',terminal:{kind:'completed'}}});

/** A generated leaf that emulates the production declaration contract: it
 * reports its own finalizer once, before any await, and never lets the
 * composites decide the mode. */
function leaf(behaviour:{hostEvents?:boolean;runIds?:string[];terminal?:boolean}):QueryAgent{
  return {configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    if(behaviour.hostEvents){
      const ids=behaviour.runIds??['generated-run'];
      input.onHostRunEvent?.(usageEvent(ids[0]));
      for(const id of ids.slice(1))input.onHostRunEvent?.(usageEvent(id));
      if(behaviour.terminal!==false)input.onHostRunEvent?.(terminalEvent(ids[0]));
    }
    return answer();
  }};
}
async function app(t:import('node:test').TestContext,agent:QueryAgent){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-run-accounting-'));
  const node=await buildApp(config(dataDir),{backgroundWorker:false,createModelAgent:(async()=>agent as unknown) as ModelAgentFactory});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  return node;
}
const receipts=(node:Awaited<ReturnType<typeof buildApp>>)=>(node.store.db.prepare('SELECT json FROM model_usage ORDER BY created_at,id').all() as {json:string}[]).map(row=>JSON.parse(row.json) as {status:string;tokens?:{inputTokens:number}});

test('a Host leaf finalizes once through the observer and reports the captured receipt',async t=>{
  const node=await app(t,leaf({hostEvents:true}));
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated Host question'}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().answer,'Generated accounting answer');
  const rows=receipts(node);
  assert.equal(rows.length,1,'the Host path must not create a second receipt');
  assert.equal(rows[0].status,'completed');
  assert.equal(rows[0].tokens?.inputTokens,10);
  assert.equal(response.json().usage?.status,'completed','the response carries the captured Host receipt');
});

test('caller-supplied usage samples no longer create a legacy receipt',async t=>{
  const node=await app(t,{configured:true,close:async()=>{},query:async input=>{
    input.onUsage?.({requests:1,reportedRequests:1,inputTokens:20,outputTokens:6,totalTokens:26,cacheReadTokens:0,cacheWriteTokens:0});
    return answer();
  }});
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated legacy question'}});
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().usage,undefined,'no Host run session means no reported receipt');
  assert.equal(receipts(node).length,0,'onUsage alone must not write model_usage');
});

test('a second run id in one query is rejected and cannot finalize as success',async t=>{
  const node=await app(t,leaf({hostEvents:true,runIds:['generated-run-a','generated-run-b']}));
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated second identity question'}});
  assert.notEqual(response.statusCode,200,response.body);
  assert.equal(receipts(node).length,1,'the first identity still owns the one receipt');
});

test('a Host path that settles without a run terminal is rejected, not reported as success',async t=>{
  const node=await app(t,leaf({hostEvents:true,terminal:false}));
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated missing terminal question'}});
  assert.notEqual(response.statusCode,200,response.body);
  const rows=receipts(node);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'running','no app-side finalizer may close a Host receipt');
});

test('a configuration switch mid-query keeps the pinned generation lease and reports once',async t=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const reports:string[]=[];let usedSecond=false;
  const first:QueryAgent={configured:true,close:async()=>{},query:async(_input,lease)=>{lease?.onFinalizer?.('host');entered();await held;return answer();}};
  const second:QueryAgent={configured:true,close:async()=>{},query:async()=>{usedSecond=true;return answer();}};
  const reloading=new ReloadableAgent();
  const prepared=await reloading.prepare(first,()=>{});prepared.activate();prepared.complete();
  const pending=reloading.query({question:'Generated pinned question'},{onFinalizer:mode=>reports.push(mode)});await started;
  const next=await reloading.prepare(second,()=>{});next.activate();
  release();await pending;await reloading.close();
  assert.deepEqual(reports,['host'],'the pinned generation reports exactly once');
  assert.equal(usedSecond,false,'the new generation must not serve the in-flight query');
});

test('an early Host failure before any envelope keeps its original error and creates no receipt',async t=>{
  const early:QueryAgent={configured:true,close:async()=>{},query:async(_input,lease)=>{
    lease?.onFinalizer?.('host');
    throw Object.assign(new Error('Generated early host failure'),{name:'AgentNotConfiguredError'});
  }};
  const node=await app(t,early);
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated early failure question'}});
  assert.notEqual(response.statusCode,200,response.body);
  assert.equal(response.json().error,'model_not_configured','the leaf error must not be replaced by a terminal gap');
  assert.equal(receipts(node).length,0,'no Host session means no receipt');
});

test('a Host failure after Host events keeps the primary error when its terminal is missing',async t=>{
  const failing:QueryAgent={configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    input.onHostRunEvent?.(usageEvent('generated-run-failure'));
    throw Object.assign(new Error('Generated host failure after usage'),{name:'AgentResponseError',reason:'invalid_response'});
  }};
  const node=await app(t,failing);
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated host failure question'}});
  assert.notEqual(response.statusCode,200,response.body);
  assert.notEqual(response.statusCode,409,'a missing terminal must not replace the primary failure');
  const rows=receipts(node);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'running','app must not finalize the Host receipt in the failure gap');
});

/** Production evidence, separated from the injected-double cases above: the
 * real public createAgent leaf must report host before any Host session exists,
 * so the app consumes the published contract instead of a synthetic one. */
test('the public leaf reports host before any Host session and preserves its original error',async()=>{
  const reader:ContextReader={
    search:async()=>[],timeline:async()=>({items:[],nextCursor:null,totalCount:0}),evidence:async()=>[],activity:async()=>({captures:0}),
    devices:async()=>[],sources:async()=>[],sourceItems:async()=>({items:[],nextCursor:null,totalCount:0}),sourceHistory:async()=>[],memories:async()=>({items:[]}),
  };
  const settings:ModelSettings={provider:'custom',protocol:'deepseek',baseUrl:'',model:'',apiKey:'',headers:{},extraBody:{},allowUnauthenticatedLocal:false,reasoningEffort:'auto',maxTokens:1024};
  const agent=await createModelAgent(settings,reader);
  assert.equal(agent.configured,false);
  const reports:string[]=[];
  let failure:unknown;
  try{await agent.query({question:'Generated unconfigured question'},{onFinalizer:mode=>reports.push(mode)});}catch(error){failure=error;}
  assert.ok(failure,'an unconfigured public leaf must reject');
  assert.equal((failure as {name?:string}).name,'AgentNotConfiguredError');
  assert.deepEqual(reports,['host'],'the published leaf reports exactly once before the failed session');
  await agent.close();
});

test('the production factory path fails as model_not_configured, never as an accounting rejection',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-run-accounting-public-'));
  const node=await buildApp(config(dataDir),{backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated production question'}});
  assert.equal(response.statusCode,503,response.body);
  assert.equal(response.json().error,'model_not_configured');
  assert.equal(receipts(node).length,0);
});

test('a Host leaf that uses the supplied runModel hook starts only the Host receipt',async t=>{
  const factory:ModelAgentFactory=async(_settings,_reader,host)=>({configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    // Production admission path: runModelFor marks the model start through the
    // per-query accounting context before the model task runs.
    await host!.runModel!(async()=>{});
    input.onHostRunEvent?.(usageEvent('generated-run-admission'));
    input.onHostRunEvent?.(terminalEvent('generated-run-admission'));
    return answer();
  }});
  const dataDir=mkdtempSync(join(tmpdir(),'mote-run-accounting-admission-'));
  const node=await buildApp(config(dataDir),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated admission question'}});
  assert.equal(response.statusCode,200,response.body);
  const rows=receipts(node);
  assert.equal(rows.length,1,'admission must not start a second legacy receipt');
  assert.equal(rows[0].status,'completed');
});

/** Real HostRunSession leaf: no SDK and no network. The provider's model run
 * throws inside the supplied host.runModel task, so the Host itself stamps the
 * identity/attempt and emits one failed run.terminal after cleanup. */
const realHostLeaf=(failure:Error,seen:HostEvent[]=[]):ModelAgentFactory=>async(_settings,_reader,hooks)=>({configured:true,close:async()=>{},query:async(input,lease)=>{
  lease?.onFinalizer?.('host');
  const hostIdentity={kind:'central' as const,id:randomUUID()},host=new PluginHost(hostIdentity),resources=new PluginResourceScope();
  const identity=(id:string):ScopeIdentity=>({packageId:'generated',installationId:'generated-install',instanceId:id,activationId:randomUUID(),host:hostIdentity});
  const scope=Object.assign(resources,{identity:identity('consumer')});
  let port:HostRunPort|undefined;
  const provider:RuntimeProvider={capabilities:{modelTransports:['fixture'],taskKinds:['query'],tools:false,images:false,importWorkspace:false,hostDelegation:false,nativeDelegation:false,recovery:'none',replacement:'restart'},async prepare(_profile,_model,value){
    port=value;value.emit({type:'tools.ready',tools:[]},null);
    return {run:request=>value.runModel(request.attempt,async()=>{throw failure;}),repair:async()=>{throw Error('Generated repair is unreachable');},async cancel(){},async close(){}};
  }};
  const modelContract=serviceContract<unknown>('generated.model','1'),bindings:Record<string,{service:{id:string;apiVersion:string}}> = {};
  try{
    await host.install({identity:identity('foundation'),contributions:[runtimeService,modelContract,hostOutputService],factory:context=>({prepare(){},start(){
      bindings.runtime=context.provide(runtimeService.id,runtimeService,provider);
      bindings.model=context.provide(modelContract.id,modelContract,{});
      bindings.output=context.provide(hostOutputService.id,hostOutputService,createHostOutputProvider());},quiesce(){},stop(){},dispose(){}})});
    const runtime=await host.acquire(runtimeService,bindings.runtime as never,scope.signal);
    const model=await host.acquire(modelContract,bindings.model as never,scope.signal);
    const output=await host.acquire(hostOutputService,bindings.output as never,scope.signal);
    const selection={modelId:'generated-model',modelRevision:1,profileId:'generated-profile',profileRevision:1,transport:'fixture'};
    const session=await createHostRunSession({scope:scope as never,input,identity:{runId:randomUUID(),runtime:{id:'fixture',revision:1,profileId:'fixture-runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64)},model:selection},profile:{binding:runtime.binding,runtimeId:'fixture',profileId:'fixture-runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64),taskKind:'query',configuration:{}},runtime,model:{...model,selection},output,tools:{definitions:[],bindings:[],assertCurrent:()=>scope.assertCurrent()},budget:{activeTimeoutMs:null},activeBudget:new ActiveExecutionBudget(null),commitFence:{assertCurrent:()=>scope.assertCurrent()}},{systemPrompt:'Generated Host policy',prompt:'Generated prompt',contextUsage:{unit:'utf16_characters',system:0,tools:0,question:0,conversation:0,task:0,evidence:0,prompt:0,outputTokenReserve:100,toolResults:0},evidence:()=>({records:new Map(),deliveredRanges:[],imageReadReceipts:[],sourceContextDependencies:[],evidenceDependencies:{version:1,complete:true,ids:[]},trace:[],deliveredCharacters:0}),async readTool(){throw Error('This fixture has no tools');},admit:(task,signal)=>hooks!.runModel!(task,signal),async close(){},observe:event=>{seen.push(structuredClone(event));input.onHostRunEvent?.(event);}});
    try{return await session.execute();}finally{await session.close();}
  }finally{await resources.close();await host.close();}
}});

test('a real Host session finalizes one failed receipt through its own terminal, with no app fallback',async t=>{
  const failure=Object.assign(new Error('Generated model failure before usage'),{name:'AgentResponseError',reason:'invalid_response'});
  const dataDir=mkdtempSync(join(tmpdir(),'mote-run-accounting-real-host-'));
  const seen:HostEvent[]=[];
  const node=await buildApp(config(dataDir),{backgroundWorker:false,createModelAgent:realHostLeaf(failure,seen)});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated real Host failure question'}});
  assert.equal(response.statusCode,502,response.body);
  assert.equal(response.json().error,'agent_response','the original failure classification survives');
  const rows=receipts(node);
  assert.equal(rows.length,1,'exactly the selected Host meter row exists');
  assert.equal(rows[0].status,'failed','the Host run terminal failed the selected receipt');
  assert.equal(rows[0].tokens,undefined,'no usage sample was fabricated');
  const terminals=seen.filter(event=>event.event.type==='run.terminal');
  assert.equal(terminals.length,1,'the Host emits exactly one run terminal');
  const terminal=terminals[0].event as {type:'run.terminal';terminal:{kind:string}};
  assert.equal(terminal.terminal.kind,'failed');
  assert.notEqual(terminals[0].attemptId,null,'the failed terminal carries the last attempt id');
  assert.equal(seen.filter(event=>event.event.type==='usage').length,0,'no usage event was emitted');
});

test('a Host yield without its run terminal rejects instead of completing',async t=>{
  const yielding:QueryAgent={configured:true,close:async()=>{},query:async(_input,lease)=>{
    lease?.onFinalizer?.('host');
    throw new AgentYieldError();
  }};
  const node=await app(t,yielding);
  const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated yield question'}});
  assert.equal(response.statusCode,409,response.body);
  assert.equal(response.json().error,'conflict');
  assert.equal(receipts(node).length,0,'no Host session means no receipt');
});
