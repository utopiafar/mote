import assert from 'node:assert/strict';
import type {ServiceLease} from '@mote/plugin-api/contracts';
import type {QueryInput} from '../../dist/query-contracts.js';
import type {RuntimeProvider,RuntimeOutcome,HostRunPort,RuntimeAttempt} from '../../dist/runtime/contracts.js';
import type {HostEvidenceSnapshot} from '../../dist/host/run-contracts.js';
import type {PrepareToolDelivery} from '../../dist/bridge-contracts.js';
import {createHostRunSession} from '../../dist/host/run-session.js';
import {createHostOutputProvider} from '../../dist/host/output.js';
import {ActiveExecutionBudget} from '../../dist/active-budget.js';
import {contextToolSnapshot,releaseContextTools} from '../../dist/tool-contributions.js';
import {toRuntimeToolDefinitions} from '../../dist/tools/runtime-schema.js';

const metrics={unit:'utf16_characters' as const,system:0,tools:0,question:0,conversation:0,task:0,evidence:0,prompt:0,outputTokenReserve:100,toolResults:0};
/** Real Host orchestration with a controlled local runtime, never a model or a
 * second ledger. Tests supply the actual bridge and its producer's read view. */
export async function hostFixture(
  bridge:HostEvidenceSnapshot&{prepareDelivery:PrepareToolDelivery;close():Promise<void>},
  input:QueryInput,
  run:(host:HostRunPort,attempt:RuntimeAttempt)=>Promise<RuntimeOutcome>,
  options:{afterOutputRelease?:()=>void}={},
){
  const controller=new AbortController();
  const identity={packageId:'generated',installationId:'install',instanceId:'instance',host:{kind:'central' as const,id:'fixture'},activationId:'active'};
  const lease=<T,>(id:string,value:T):ServiceLease<T>=>{let active=true;return {binding:{service:{id,apiVersion:'1'},provider:{scope:identity,contributionId:id},revision:1},value,signal:controller.signal,assertCurrent(){assert.ok(active);},async release(){active=false;if(id==='mote.agent.host-output')options.afterOutputRelease?.();}};};
  const snapshot=contextToolSnapshot(input),definitions=toRuntimeToolDefinitions(snapshot),selection={modelId:'generated',modelRevision:1,profileId:'model',profileRevision:1,transport:'fixture'};
  const provider:RuntimeProvider={capabilities:{modelTransports:['fixture'],taskKinds:['query'],tools:true,images:false,importWorkspace:false,hostDelegation:false,nativeDelegation:false,recovery:'none',replacement:'restart'},async prepare(_profile,_model,host){
    host.emit({type:'tools.ready',tools:definitions},null);
    return {run:request=>host.runModel(request.attempt,()=>run(host,request.attempt)),repair:async()=>{throw Error('Unexpected repair');},cancel:async()=>{},close:async()=>{}};
  }};
  const runtime=lease('generated.runtime',provider);
  const session=await createHostRunSession({
    scope:{identity,signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();},defer(){}},
    identity:{runId:'generated-run',runtime:{id:'fixture',revision:1,profileId:'runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64)},model:selection},input,
    profile:{binding:runtime.binding,runtimeId:'fixture',profileId:'runtime',profileRevision:1,assemblyFingerprint:'a'.repeat(64),taskKind:'query',configuration:{}},runtime,
    model:{...lease('generated.model',{}),selection},output:lease('mote.agent.host-output',createHostOutputProvider()),
    tools:{definitions,bindings:[],assertCurrent(){for(const pin of snapshot.entries)snapshot.assertActive(pin);}},
    budget:{activeTimeoutMs:null},activeBudget:new ActiveExecutionBudget(null),commitFence:{assertCurrent(){controller.signal.throwIfAborted();for(const pin of snapshot.entries)snapshot.assertActive(pin);}},
  },{
    systemPrompt:'Generated Host policy',prompt:'Generated prompt',contextUsage:metrics,evidence:()=>bridge,
    async readTool(call,signal){const staged=await bridge.prepareDelivery(call.name,call.arguments as Record<string,unknown>,signal);return {payload:{text:JSON.stringify(staged.value)},confirm:staged.confirm,discard:staged.discard};},close:()=>bridge.close(),
  });
  const execute=session.execute.bind(session),close=session.close.bind(session);
  session.execute=async()=>{try{return await execute();}finally{releaseContextTools(input);}};
  session.close=async()=>{try{await close();}finally{releaseContextTools(input);}};
  return session;
}
