import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {AgentOptions} from '@mote/agent';
import type {TokenUsage} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import type {PluginCenter} from '../plugin-center.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {UsageLedger} from '../usage.js';
import type {HindsightModelRequest} from '../hindsight-runtime.js';
import {MemoryAdapters} from '../memory-adapters.js';
import {StoreError} from '../store.js';
import {centralServices,type MemoryProviderAdapters} from './central-contracts.js';

/** C23 owns the external Memory provider adapters: Mem0, the pinned native
 * Hindsight runtime and generic worker providers, plus their fixed namespace/
 * configuration readers, the native model authority/usage maps, prepared-stage
 * cleanup and the actual capability probe. Provider objects are only built
 * here; consumers use the leased port or the trusted assembly bridge. */
export const memoryProviderAdaptersContribution={
  id:'memory-provider-adapters',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.pluginControlRead.id,version:'1.0.0'},
    {kind:'service',id:centralServices.usage.id,version:'1.0.0'},
  ],
  provides:[{kind:'service',id:centralServices.memoryProviderAdapters.id,apiVersion:centralServices.memoryProviderAdapters.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const memoryProviderAdaptersDeclaration={id:memoryProviderAdaptersContribution.id,apiVersion:'1'} as const;
/** Provider writes, fixed configurations and prepared-stage cleanup journals
 * live in the vault, so a fresh activation resumes them without a restart. */
export const memoryProviderAdaptersReplacement='hot' as const;

export interface MemoryProviderAdaptersDependencies {
  readonly directory:string;
  readonly plugins:PluginCenter;
  readonly models:ModelSettingsStore;
  readonly usage:Pick<UsageLedger,'start'>;
  readonly codex?:{executable?:string;home?:string};
  readonly runModelFor?:(settings:ModelSettings)=>AgentOptions['runModel'];
}

export interface MemoryProviderAdaptersBindings {
  readonly bindings:ServiceBinding;
}

export interface MemoryProviderAdaptersPlatform extends PluginLifecycle {
  readonly port:MemoryProviderAdapters;
  /** The owned domain object for the trusted assembly bridge only. */
  readonly adapters:MemoryAdapters;
  /** The pipeline pins an admitted native operation's model-transport fence for
   * the duration of its engine call; the adapter asserts it on every request. */
  pinModelAuthority(opId:string,assert:(settings:ModelSettings)=>void):void;
  releaseModelAuthority(opId:string,assert:(settings:ModelSettings)=>void):void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory provider adapters are unavailable',503);

/** Prepare constructs MemoryAdapters and its durable tables; start installs the
 * PluginCenter probe/configuration/retirement handlers. Quiesce stops new
 * probes and native engine work while providers/reads/cleanup keep draining;
 * stop closes every live provider transport. */
export function createMemoryProviderAdapters(dependencies:MemoryProviderAdaptersDependencies):MemoryProviderAdaptersPlatform {
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let adapters:MemoryAdapters|undefined,closing:Promise<void>|undefined;
  const meters=new Map<string,ReturnType<UsageLedger['start']>>();
  const authorities=new Map<string,(settings:ModelSettings)=>void>();
  const readable=()=>{
    if(!adapters||phase==='created'||phase==='stopped')throw unavailable();
    return adapters;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return readable();
  };
  const close=()=>closing??=(async()=>{
    const owned=adapters;
    phase='stopped';
    adapters=undefined;
    authorities.clear();meters.clear();
    if(owned)await owned.close();
  })().finally(()=>{closing=undefined;});
  const port:MemoryProviderAdapters=Object.freeze({
    provider:(id,namespace)=>readable().provider(id,namespace),
    engine:(id,namespace)=>active().engine(id,namespace),
    configurationIdentity:(id,namespace)=>readable().configurationIdentity(id,namespace),
    configurationAllowed:(type,value)=>readable().configurationAllowed(type,value),
    probe:(id,signal)=>active().probe(id,signal),
    discardPrepared:input=>readable().discardPrepared(input),
    erasePreparedEvidence:ids=>readable().erasePreparedEvidence(ids),
    retire:id=>readable().retire(id),
  });
  const platform:MemoryProviderAdaptersPlatform=Object.freeze({
    port,
    get adapters(){return readable();},
    pinModelAuthority(opId:string,assert:(settings:ModelSettings)=>void){active();authorities.set(opId,assert);},
    releaseModelAuthority(opId:string,assert:(settings:ModelSettings)=>void){if(authorities.get(opId)===assert)authorities.delete(opId);},
    prepare(){
      if(phase!=='created'&&phase!=='stopped')throw unavailable();
      try{
        adapters=new MemoryAdapters(dependencies.directory,dependencies.plugins,dependencies.models,{
          codex:dependencies.codex,runModelFor:dependencies.runModelFor,
          assertModelAuthority:(settings:ModelSettings,request:HindsightModelRequest)=>{if(request.purpose==='startup'||request.purpose==='capability_probe')return;const assert=request.opId&&authorities.get(request.opId);if(!assert)throw new StoreError('Native Memory operation authority expired',409);assert(settings);},
          onRequestStarted:(settings:ModelSettings,request:{requestId:string;opId?:string})=>meters.set(request.requestId,dependencies.usage.start(settings.provider,settings.model,'hindsight-engine',{agentId:'hindsight-engine',moduleId:'memories',skillId:null,operationId:request.opId,requestId:request.requestId})),
          onUsage:(_settings:ModelSettings,usage:TokenUsage,request:{requestId:string;opId?:string})=>meters.get(request.requestId)?.update(usage),
          onRequestFinished:(request:{requestId:string;opId?:string;status:'completed'|'failed'})=>{meters.get(request.requestId)?.finish(request.status);meters.delete(request.requestId);},
        });
        phase='prepared';
      }catch(error){
        phase='stopped';
        adapters=undefined;
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      const plugins=dependencies.plugins,current=adapters!;
      // These handlers belong to this activation. A stopped activation never
      // answers a probe or retires a runtime that a newer activation owns.
      plugins.probe=(id,signal)=>adapters===current&&phase==='active'?current.probe(id,signal):Promise.reject(unavailable());
      plugins.configurationAllowed=(field,value)=>adapters===current?current.configurationAllowed(field.type,value):false;
      plugins.retired=id=>{if(adapters===current)void current.retire(id);};
      phase='active';
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,
  });
  return platform;
}
export type MemoryProviderAdaptersService=ReturnType<typeof createMemoryProviderAdapters>;

export function createMemoryProviderAdaptersFactory(platform:MemoryProviderAdaptersPlatform,onStarted?:(bindings:MemoryProviderAdaptersBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const bindings=context.provide(memoryProviderAdaptersContribution.id,centralServices.memoryProviderAdapters,platform.port);
        onStarted?.({bindings});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
