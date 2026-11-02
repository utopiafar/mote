import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {Store} from '../store.js';
import {StoreError} from '../store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionHandler,type ExecutionGrant} from '../execution-engine.js';
import {executionSettingsSchema,type ExecutionSettings} from '../execution-settings.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import {ProviderAdmission} from '../provider-admission.js';
import {ConcurrencyGate} from '../concurrency.js';
import {Operations} from '../operations.js';
import {centralServices,type ExecutionSubmission} from './central-contracts.js';

export interface ExecutionPlatformDependencies {
  /** Borrowed from C02; execution disposal never closes the vault. */
  readonly store:Store;
  /** Fixed trusted C04 authority, not supplied by a handler or submission. */
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly settings:Pick<ExecutionSettings,'execution'>;
  readonly clock?:()=>number;
}
export const executionPlatformContribution={id:'execution-platform',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'},{kind:'host',id:'mote.configuration',version:'1.0.0'}],
  provides:[{kind:'service',id:centralServices.execution.id,apiVersion:centralServices.execution.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const executionPlatformDeclaration={id:executionPlatformContribution.id,apiVersion:'1'} as const;
export const executionPlatformReplacement='restart' as const;
const unavailable=()=>new StoreError('Execution platform is unavailable',503);

/** One trusted resource owner. Raw assembly is transitional server bootstrap only;
 * ordinary plugins get a flat submission port, never Store, gates or engine controls.
 * Durable input/model/commit authority remains checked by the existing domain engine. */
export function createExecutionPlatform(dependencies:ExecutionPlatformDependencies){
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let executor:ExecutionEngine|undefined,providerAdmission:ProviderAdmission|undefined,operations:Operations|undefined;
  let gates:{agentGate:ConcurrencyGate;llmGate:ConcurrencyGate;interactiveGate:ConcurrencyGate;interactiveModelGate:ConcurrencyGate}|undefined;
  let closing:Promise<void>|undefined;
  const owners=new Map<string,{accepting:()=>boolean;dispose:()=>Promise<void>}>(),bindings=new Set<{quiesce:()=>void;close:()=>Promise<void>}>();
  const ready=()=>{if(!executor||phase==='stopped'||phase==='disposed')throw unavailable();};
  const active=()=>{if(phase!=='active')throw unavailable();};
  const current=()=>{ready();if(phase!=='active'&&phase!=='quiescing')throw unavailable();};
  /** C03's synchronous publish/rollback supplies its exact next/previous snapshot. */
  function refreshSettings(next:ReturnType<ExecutionSettings['execution']>=dependencies.settings.execution()){
    ready();const value=executionSettingsSchema.parse(next);
    gates!.agentGate.configure(value.agentConcurrency);gates!.llmGate.configure(value.llmConcurrency);
    gates!.interactiveGate.configure(value.interactiveConcurrency);gates!.interactiveModelGate.configure(value.interactiveConcurrency);
  }
  const submission=Object.freeze({
    enqueue(...args:Parameters<ExecutionEngine['enqueue']>){active();if(!owners.get(args[1])?.accepting())throw unavailable();return executor!.enqueue(...args);},
    get(...args:Parameters<ExecutionEngine['get']>){current();return executor!.get(...args);},
    drain(...args:Parameters<ExecutionEngine['drain']>){current();return executor!.drain(...args);},
  }) satisfies ExecutionSubmission;
  /** Only a trusted H04 factory passes its fixed context.scope here. Never publish
   * this binder or accept an ordinary consumer's self-selected scope as ownership. */
  function handlersForAssembly(scope:PluginScope){
    active();scope.assertCurrent();let accepting=true,disposed=false,draining:Promise<void>|undefined;
    const installed=new Set<()=>Promise<void>>();
    const assert=()=>{current();scope.assertCurrent();if(disposed)throw unavailable();};
    const binding={
      register(handler:ExecutionHandler){
        active();scope.assertCurrent();if(!accepting||disposed)throw unavailable();
        const pinned={...handler,policy:handler.policy?Object.freeze({...handler.policy}):undefined};
        const live=()=>{try{assert();return true;}catch{return false;}};
        const wrapped:ExecutionHandler={...pinned,
          validate:step=>live()&&pinned.validate(step),validateGrant:step=>live()&&(pinned.validateGrant?.(step)??true),
          admit:step=>!accepting?new ExecutionFailure('waiting','handler_quiescing',1000):pinned.admit?.(step),
          execute:(step,signal,grant)=>{
            assert();const guarded:ExecutionGrant=Object.freeze({assert(){assert();grant.assert();},commit<T>(write:()=>T){return grant.commit(()=>{assert();const value=write();assert();return value;});}});
            return pinned.execute(step,AbortSignal.any([signal,scope.signal]),guarded);
          },
          commit:(step,result)=>{assert();pinned.commit(step,result);assert();},
        };
        const unregister=executor!.register(wrapped);let pending:Promise<void>|undefined;
        const owner={accepting:()=>accepting&&!disposed&&!scope.signal.aborted&&phase==='active',dispose:()=>{
          if(pending)return pending;
          if(owners.get(pinned.kind)===owner)owners.delete(pinned.kind);
          // unregister synchronously removes admission and aborts the local lease
          // before it awaits drain. Remote calls may still have unknown outcomes.
          pending=unregister().finally(()=>installed.delete(owner.dispose));return pending;
        }};
        owners.set(pinned.kind,owner);installed.add(owner.dispose);return owner.dispose;
      },
      quiesce(){accepting=false;},
      close(){
        if(draining)return draining;accepting=false;disposed=true;scope.signal.removeEventListener('abort',abort);
        const tasks=[...installed].map(dispose=>dispose());
        draining=Promise.allSettled(tasks).then(results=>{bindings.delete(binding);const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Execution handlers disposal failed');});return draining;
      },
    };
    const abort=()=>{void binding.close().catch(()=>{});};
    scope.signal.addEventListener('abort',abort,{once:true});
    try{scope.defer(binding.close);bindings.add(binding);scope.assertCurrent();}catch(error){void binding.close().catch(()=>{});throw error;}
    return Object.freeze(binding);
  }
  function quiesce(_reason?:StopReason){
    if(phase!=='active')return;phase='quiescing';executor!.quiesce();for(const binding of bindings)binding.quiesce();
    // Gates are private to trusted assembly. Accepted leases may still be queued
    // here or request a later stage; actual stop revokes leases before closing gates.
  }
  function close(){
    if(closing)return closing;quiesce();phase='stopped';
    // All local fences are revoked before awaiting any handler's drain.
    const tasks=[...bindings].map(binding=>binding.close());
    if(gates)for(const gate of Object.values(gates))gate.close();
    providerAdmission?.close();
    if(executor)tasks.push(executor.close());
    closing=Promise.allSettled(tasks).then(results=>{phase='disposed';const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Execution platform disposal failed');});return closing;
  }
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        if(!dependencies.modelAuthorization)throw unavailable();
        const value=executionSettingsSchema.parse(dependencies.settings.execution());
        executor=new ExecutionEngine(dependencies.store,dependencies.clock);executor.bindModelAuthority(dependencies.modelAuthorization);
        providerAdmission=new ProviderAdmission(dependencies.store,dependencies.clock);operations=new Operations(dependencies.store);
        gates={agentGate:new ConcurrencyGate(value.agentConcurrency),llmGate:new ConcurrencyGate(value.llmConcurrency),interactiveGate:new ConcurrencyGate(value.interactiveConcurrency),interactiveModelGate:new ConcurrencyGate(value.interactiveConcurrency)};
        phase='prepared';
      }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Execution preparation and cleanup failed',{cause:error});}throw error;}
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},quiesce,stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    submission,handlersForAssembly,refreshSettings,
    tick(){current();return executor!.tick();},
    cancel(...args:Parameters<ExecutionEngine['cancel']>){active();return executor!.cancel(...args);},
    retry(...args:Parameters<ExecutionEngine['retry']>){active();return executor!.retry(...args);},
    receipt(id:string){current();return {step:executor!.get(id),failure:executor!.failure(id)};},
    /** Fixed trusted bootstrap only. No raw object is a normal provided service. */
    get assembly(){ready();return Object.freeze({executor:executor!,providerAdmission:providerAdmission!,operations:operations!,...gates!});},
  });
}
export type ExecutionPlatform=ReturnType<typeof createExecutionPlatform>;
export function createExecutionPlatformFactory(platform:ExecutionPlatform){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(platform.close);
    return {prepare:platform.prepare,start:()=>{platform.start();context.provide(executionPlatformContribution.id,centralServices.execution,platform.submission);},quiesce:platform.quiesce,stop:platform.stop,dispose:platform.close};
  };
}
/** The host chooses this factory and its definitions; consumers never pass a scope. */
export function createExecutionHandlersFactory(platform:ExecutionPlatform,handlers:readonly ExecutionHandler[]){
  return (context:HostPluginContext):PluginLifecycle=>{
    const binding=platform.handlersForAssembly(context.scope);
    return {prepare:()=>{for(const handler of handlers)binding.register(handler);},start:()=>{},quiesce:()=>binding.quiesce(),stop:()=>binding.close(),dispose:binding.close};
  };
}
