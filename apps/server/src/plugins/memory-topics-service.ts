import type {QueryInput} from '@mote/agent';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {QueryResult} from '@mote/shared';
import {AutomaticTopics,type TopicMemoryRead} from '../automatic-topics.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {Memory} from '../memory-schema.js';
import type {MemoryStore} from '../memory.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {ContextTreeRegistry} from '../context-trees.js';
import {MemoryTopicsHost,type MemoryTopicsSelection} from '../memory-topics-host.js';
import {StoreError} from '../store.js';
import {centralServices,type MemoryTopics} from './central-contracts.js';

/** C22C owns automatic topics end to end: the derived tree index, the
 * durable topic dependent registered on the execution engine, and the model
 * classifier registration. The Memory pipeline only publishes; the context
 * catalog only reads the attached index. */
export const memoryTopicsServiceContribution={
  id:'memory-topics-service',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.memoryRecords.id,version:'1.0.0'},
  ],
  provides:[{kind:'service',id:centralServices.memoryTopics.id,apiVersion:centralServices.memoryTopics.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const memoryTopicsServiceDeclaration={id:memoryTopicsServiceContribution.id,apiVersion:'1'} as const;
/** Persisted topic batches and heads live in the vault; a new activation
 * reuses them without a process restart. */
export const memoryTopicsServiceReplacement='hot' as const;

export interface MemoryTopicsServiceDependencies {
  readonly store:MemoryStore['store'];
  readonly memories:MemoryStore;
  readonly executor:ExecutionEngine;
  readonly control:BackgroundModelAuthorization;
  readonly host:ModelAuthorizationHost;
  readonly contextTrees:ContextTreeRegistry;
  readonly reader:TopicMemoryRead;
  readonly canPublish:()=>boolean;
  readonly assertReadable:(memories:Memory[])=>void;
  readonly select:(profileId?:string,model?:string)=>MemoryTopicsSelection;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
}

export interface MemoryTopicsServiceBindings {
  readonly topics:ServiceBinding;
}

export interface MemoryTopicsService extends PluginLifecycle {
  readonly topics:MemoryTopics;
  readonly automatic:AutomaticTopics;
  readonly host:MemoryTopicsHost;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory topics are unavailable',503);

/** Owns the two topic objects. Reads survive quiesce; new enqueue, classifier
 * registration and classification require the active activation. Stop removes
 * the classifier and execution handler before the context catalog stops
 * serving the derived trees, so a late model result can never publish. */
export function createMemoryTopicsService(dependencies:MemoryTopicsServiceDependencies):MemoryTopicsService {
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let automatic:AutomaticTopics|undefined,host:MemoryTopicsHost|undefined,closing:Promise<void>|undefined,lifetime:AbortController|undefined;
  const prepared=()=>{
    if(!automatic||!host||phase==='created'||phase==='stopped')throw unavailable();
    return {automatic,host};
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return prepared();
  };
  const topics:MemoryTopics=Object.freeze({
    enqueue:(parent:Parameters<MemoryTopicsHost['enqueue']>[0],memories:Parameters<MemoryTopicsHost['enqueue']>[1],profileId?:string,model?:string)=>{
      // Publication must never fail because the optional topic plugin stopped.
      if(phase!=='active')return;
      host!.enqueue(parent,memories,profileId,model);
    },
    register:(classifier:Parameters<AutomaticTopics['register']>[0])=>active().automatic.register(classifier),
    classify:(input:Parameters<AutomaticTopics['classify']>[0],authority:Parameters<AutomaticTopics['classify']>[1])=>{
      const current=active(),signal=lifetime!.signal,assert=()=>{
        if(phase!=='active')throw unavailable();
        authority.assertCurrent();
      };
      return current.automatic.classify(input,{...authority,signal:AbortSignal.any([authority.signal,signal]),assertCurrent:assert});
    },
    trees:()=>prepared().automatic.trees(),
    state:()=>prepared().automatic.state(),
  });
  const detach=()=>{if(automatic)dependencies.contextTrees.detachAutomatic(automatic);};
  const close=()=>closing??=(async()=>{
    const errors:unknown[]=[];lifetime?.abort();
    try{detach();}catch(error){errors.push(error);}
    try{automatic?.close();}catch(error){errors.push(error);}
    const owned=host;host=undefined;
    if(owned)try{await owned.close();}catch(error){errors.push(error);}
    automatic=undefined;phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Memory topics disposal failed');
  })();
  return Object.freeze({
    topics,
    get automatic(){return prepared().automatic;},
    get host(){return prepared().host;},
    prepare(){
      if(phase!=='created')throw unavailable();
      let created:AutomaticTopics|undefined,owned:MemoryTopicsHost|undefined;
      try{
        created=new AutomaticTopics(dependencies.store,dependencies.reader);
        dependencies.contextTrees.attachAutomatic(created,{store:dependencies.store,canPublish:dependencies.canPublish});
        owned=new MemoryTopicsHost({
          store:dependencies.store,memories:dependencies.memories,executor:dependencies.executor,control:dependencies.control,host:dependencies.host,
          topics:created,assertReadable:dependencies.assertReadable,select:dependencies.select,query:dependencies.query,
        });
        automatic=created;host=owned;lifetime=new AbortController();phase='prepared';
      }catch(error){
        try{dependencies.contextTrees.detachAutomatic(created!);}catch{}
        try{created?.close();}catch{}
        if(owned)void owned.close();
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason:StopReason)=>{await close();},
    dispose(){return close();},
    close,
  });
}
export type MemoryTopicsServicePlatform=ReturnType<typeof createMemoryTopicsService>;

export function createMemoryTopicsServiceFactory(platform:MemoryTopicsService,onStarted?:(bindings:MemoryTopicsServiceBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const topics=context.provide(memoryTopicsServiceContribution.id,centralServices.memoryTopics,platform.topics);
        onStarted?.({topics});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
