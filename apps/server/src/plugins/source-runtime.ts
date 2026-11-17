import type {Plugin} from '@deepseek-ai/cordis';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle} from '@mote/plugin-api/contracts';
import type {HostPluginContext,HostScope} from '@mote/plugin-host';
import {StoreError,type Store} from '../store.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import {SourcePipelineRuntime} from '../source-pipelines.js';
import {SourceStore} from '../sources.js';
import {centralServices} from './central-contracts.js';
import type {ExecutionPlatform} from './execution-platform.js';

export interface SourceRuntimeOptions {readonly plugins?:readonly Plugin[];}
export interface SourceRuntimeDependencies {
  readonly store:Store;readonly materials:MaterialStore;readonly execution:ExecutionPlatform;
  readonly memoryWork:MaterialMemoryWork;
}
/** Compiled trusted local factory, not a second package/archive Manifest. Intake
 * is the existing SourceStore -> receive transaction, authorized by C04/C10.
 * No ordinary plugin gets a raw runtime, validate callback or binding writer. */
export const sourceRuntimeContribution={id:'source-runtime',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'service',id:centralServices.execution.id,version:'1.0.0'}],provides:[],
} as const satisfies ManifestContribution;
export const sourceRuntimeDeclaration={id:sourceRuntimeContribution.id,apiVersion:'1'} as const;
export const sourceRuntimeReplacement='hot' as const;
const unavailable=()=>new StoreError('Source runtime is unavailable',503);

/** Trusted assembly seam only: the source repository is constructed by this
 * domain module and borrows the prepared runtime, never a second runtime. */
export function openSourceStore(store:Store,pipelines:SourcePipelineRuntime){return new SourceStore(store,pipelines);}

export function createSourceRuntime(options:SourceRuntimeOptions,dependencies:SourceRuntimeDependencies){
  const plugins=[...(options.plugins??[])];
  // The host orders lifecycle calls. Locally, preparation exposes a read bridge
  // and admission is one-way: quiesce needs a fresh activation to admit again.
  let prepared=false,admission:boolean|undefined;
  let runtime:SourcePipelineRuntime|undefined,handlers:ReturnType<ExecutionPlatform['handlersForAssembly']>|undefined,closing:Promise<void>|undefined;
  function close(){
    if(closing)return closing;admission=false;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    closing=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});
    // Publish the terminal promise before a disposer can reenter or throw.
    // Runtime.close fences synchronously before it starts its local reader drain.
    const tasks=[()=>runtime?.close(),()=>handlers?.close()].map(dispose=>{try{return Promise.resolve(dispose());}catch(error){return Promise.reject(error);}});
    void Promise.allSettled(tasks).then(results=>{const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Source runtime disposal failed',{cause:errors[0]});}).then(resolve,reject);
    return closing;
  }
  return Object.freeze({
    async prepare(scope:HostScope){
      if(runtime||handlers||closing)throw unavailable();
      try{
        scope.assertCurrent();const engine=dependencies.execution.assembly.executor;
        if(!dependencies.memoryWork)throw new StoreError('Shared source memory receipts are required',503);
        if(engine.store!==dependencies.store||dependencies.materials.store!==dependencies.store)throw new StoreError('Source runtime repository mismatch',503);
        handlers=dependencies.execution.handlersForAssembly(scope);
        runtime=new SourcePipelineRuntime(dependencies.store,dependencies.materials,plugins,scope,engine,dependencies.memoryWork,handlers);
        runtime.quiesce();await runtime.ready;scope.assertCurrent();if(closing)throw unavailable();prepared=true;
      }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source runtime preparation and cleanup failed',{cause:error});}throw error;}
    },
    start(){if(!prepared||closing||admission!==undefined)throw unavailable();runtime!.start();admission=true;},
    quiesce(){if(admission){admission=false;runtime!.quiesce();handlers!.quiesce();}},
    close,
    /** Trusted root creates SourceStore with this exact runtime; C04 binds its
     * actual sourceIntake to that SourceStore. Never publish this bridge. */
    get runtimeForAssembly(){if(!runtime||!prepared||closing)throw unavailable();return runtime;},
  });
}
export type SourceRuntime=ReturnType<typeof createSourceRuntime>;
export function createSourceRuntimeFactory(platform:SourceRuntime){
  return (context:HostPluginContext):PluginLifecycle=>{
    const abort=()=>{void platform.close().catch(()=>{});};context.scope.signal.addEventListener('abort',abort,{once:true});
    context.scope.defer(async()=>{try{await platform.close();}finally{context.scope.signal.removeEventListener('abort',abort);}});
    return {prepare:()=>platform.prepare(context.scope),start:platform.start,quiesce:platform.quiesce,stop:platform.close,dispose:platform.close};
  };
}
