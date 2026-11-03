import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {QueryInput} from '@mote/agent';
import type {TokenUsage} from '@mote/shared';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import {sha256,StoreError} from '../store.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {FileStore} from '../files.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialIndexRuntime} from '../material-index.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import {modelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {Indexer} from '../indexer.js';
import {centralServices,type MaterialIndexWork,type RetrievalIndex} from './central-contracts.js';

export const materialRetrievalIndexContribution={
  id:'material-retrieval-index',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'},
    {kind:'service',id:centralServices.materialRepository.id,version:'1.0.0'},{kind:'service',id:centralServices.execution.id,version:'1.0.0'}],
  provides:[centralServices.retrievalIndex,centralServices.materialIndex].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const materialRetrievalIndexDeclaration={id:materialRetrievalIndexContribution.id,apiVersion:'1'} as const;
export const materialRetrievalIndexReplacement='hot' as const;

export interface MaterialRetrievalIndexBindings {
  readonly retrievalIndex:ServiceBinding;
  readonly materialIndex:ServiceBinding;
}

/** Borrowed trusted roots — the same composition inputs the inline assembly
 * passed to Indexer. This factory never constructs a second Store, engine or
 * MaterialStore; vector-work/vector-worker remain the Indexer's read-only
 * subprocess detail and need no separate owner. */
export interface MaterialRetrievalIndexDependencies {
  readonly store:MaterialStore['store'];
  readonly config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>;
  readonly diagnostics?:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly usageLedger?:UsageLedger;
  readonly modelContext?:AsyncLocalStorage<QueryInput>;
  readonly modelAuthorization?:BackgroundModelAuthorization;
  readonly modelAuthorizationHost?:ModelAuthorizationHost;
  readonly files?:FileStore;
  readonly materials:MaterialStore;
}

const unavailable=()=>new StoreError('Material retrieval index is unavailable',503);
type Interval=(ms:number,work:()=>unknown|Promise<unknown>)=>()=>void;
const localInterval:Interval=(ms,work)=>{
  let running=false;
  const timer=setInterval(()=>{if(running)return;running=true;void Promise.resolve().then(work).catch(()=>{}).finally(()=>{running=false;});},ms);
  timer.unref();return()=>clearInterval(timer);
};

/** Owns the Indexer and the bound material FTS index runtime on the shared
 * engine. Search/index reads stay live while prepared; accepting new work is an
 * active-only operation. Deletion/revision/commit fencing lives in the
 * domain objects — this owner decides when they exist. */
export function createMaterialRetrievalIndex(dependencies:MaterialRetrievalIndexDependencies){
  if(!dependencies.store||!dependencies.executor||!dependencies.materials)throw unavailable();
  const {store,config,executor,materials}=dependencies;
  let phase:'created'|'prepared'|'active'|'quiescing'|'disposed'='created';
  let indexer:Indexer|undefined,boundIndex:MaterialIndexRuntime|undefined,closing:Promise<void>|undefined,stopTimer:(()=>void)|undefined;
  const ready=()=>{if(!indexer||phase==='created'||phase==='disposed')throw unavailable();return indexer;};
  const active=()=>{if(phase!=='active')throw unavailable();return indexer!;};
  const indexWork=()=>{active();if(!boundIndex)throw unavailable();return boundIndex;};
  const close=()=>closing??=(async()=>{
    phase='disposed';stopTimer?.();stopTimer=undefined;
    const errors:unknown[]=[];
    for(const task of [()=>indexer?.close(),()=>boundIndex?.close()])try{await task();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Material retrieval index disposal failed');
  })();
  const retrievalIndex:RetrievalIndex=Object.freeze({
    get configured(){return ready().configured;},
    search:(args:Parameters<Indexer['search']>[0])=>ready().search(args),
    tick:()=>active().tick(),
    retry:()=>active().retry(),
  });
  const materialIndex:MaterialIndexWork=Object.freeze({
    tick:(limit?:number)=>indexWork().tick(limit),
    retry:(id:string)=>indexWork().retry(id),
  });
  return Object.freeze({
    prepare(){
      if(phase!=='created')throw unavailable();
      try{
        const {diagnostics,files,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost}=dependencies;
        indexer=new Indexer(store,config,diagnostics,files,
          usageLedger?input=>{
            const operationId=input.operationId??modelContext?.getStore()?.traceContext?.operationId??'embedding:'+randomUUID(),provider='embedding',model=config.embeddingModel;
            const meter=usageLedger.start(provider,model,'embedding',{agentId:'embedding',moduleId:'retrieval',skillId:null,operationId});
            return {finish:(usage:TokenUsage|undefined,failed?:boolean)=>{if(usage)meter.update(usage);meter.finish(failed?'failed':'completed');}};
          }:undefined,
          {executor,operationId:()=>modelContext?.getStore()?.traceContext?.operationId,
            assertModel:modelAuthorization?()=>modelAuthorization.assertCurrent(modelConnection('embedding:central',{model:config.embeddingModel,baseUrl:config.embeddingBaseUrl,apiKey:config.embeddingApiKey})):undefined,
            authorize:modelAuthorizationHost?(id,signal,task)=>{
              const roots=modelAuthorizationHost.evidenceTriggers([id]),work='automatic-embedding:'+sha256(JSON.stringify(roots));
              return modelAuthorizationHost.automatic(work,'embedding',roots,authorizedSignal=>{modelAuthorizationHost.assertEvidence([id]);return task(authorizedSignal);},signal);
            }:undefined,
          });
        // bindIndexEngine reuses the single per-engine runtime; the plugin owns
        // its close from here on. A previously closed binding yields a fresh one.
        boundIndex=materials.bindIndexEngine(executor);
        phase='prepared';
      }catch(error){
        // Registered handlers must be rolled back even though the owner cannot
        // await disposal inside a synchronous prepare; the deferred close below
        // or the host teardown completes it.
        void close().catch(()=>{});
        throw error;
      }
    },
    start(interval:Interval=localInterval){
      if(phase!=='prepared')throw unavailable();
      phase='active';stopTimer=interval(5000,()=>indexer!.tick());
    },
    quiesce(_reason?:StopReason){stopTimer?.();stopTimer=undefined;if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    retrievalIndex,materialIndex,
  });
}
export type MaterialRetrievalIndex=ReturnType<typeof createMaterialRetrievalIndex>;

export function createMaterialRetrievalIndexFactory(platform:MaterialRetrievalIndex,onStarted?:(bindings:MaterialRetrievalIndexBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start((ms,work)=>context.scope.every(ms,work));
        const retrievalIndex=context.provide(materialRetrievalIndexContribution.id,centralServices.retrievalIndex,platform.retrievalIndex);
        const materialIndex=context.provide(materialRetrievalIndexContribution.id,centralServices.materialIndex,platform.materialIndex);
        onStarted?.({retrievalIndex,materialIndex});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
