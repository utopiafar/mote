import type {Plugin} from '@deepseek-ai/cordis';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError,type Store} from '../store.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import {codingSourcePlugin} from '../coding-source-plugin.js';
import {SourcePipelineRuntime} from '../source-pipelines.js';
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

export function createSourceRuntime(options:SourceRuntimeOptions,dependencies:SourceRuntimeDependencies){
  // Recipe components and the default Coding recipe are owned by this plugin
  // activation, never registered by the server assembly.
  const plugins=[codingSourcePlugin,...(options.plugins??[])];
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let runtime:SourcePipelineRuntime|undefined,handlers:ReturnType<ExecutionPlatform['handlersForAssembly']>|undefined,closing:Promise<void>|undefined;
  function close(){
    if(closing)return closing;phase='stopped';
    // Runtime.close fences synchronously before it starts its local reader drain.
    const tasks=[runtime?.close(),handlers?.close()].filter((task):task is Promise<void>=>Boolean(task));
    closing=Promise.allSettled(tasks).then(results=>{phase='disposed';const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Source runtime disposal failed');});return closing;
  }
  return Object.freeze({
    async prepare(scope:PluginScope){
      if(phase!=='created')throw unavailable();phase='preparing';
      try{
        scope.assertCurrent();const engine=dependencies.execution.assembly.executor;
        if(!dependencies.memoryWork)throw new StoreError('Shared source memory receipts are required',503);
        if(engine.store!==dependencies.store||dependencies.materials.store!==dependencies.store)throw new StoreError('Source runtime repository mismatch',503);
        handlers=dependencies.execution.handlersForAssembly(scope);
        runtime=new SourcePipelineRuntime(dependencies.store,dependencies.materials,plugins,undefined,engine,dependencies.memoryWork,handlers);
        runtime.quiesce();await runtime.ready;scope.assertCurrent();if(phase!=='preparing')throw unavailable();phase='prepared';
      }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source runtime preparation and cleanup failed',{cause:error});}throw error;}
    },
    start(){if(phase!=='prepared')throw unavailable();runtime!.start();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';runtime!.quiesce();handlers!.quiesce();}},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    /** Trusted root creates SourceStore with this exact runtime; C04 binds its
     * actual sourceIntake to that SourceStore. Never publish this bridge. */
    get runtimeForAssembly(){if(!runtime||!['prepared','active','quiescing'].includes(phase))throw unavailable();return runtime;},
  });
}
export type SourceRuntime=ReturnType<typeof createSourceRuntime>;
export function createSourceRuntimeFactory(platform:SourceRuntime){
  return (context:HostPluginContext):PluginLifecycle=>{
    const abort=()=>{void platform.close().catch(()=>{});};context.scope.signal.addEventListener('abort',abort,{once:true});
    context.scope.defer(async()=>{try{await platform.close();}finally{context.scope.signal.removeEventListener('abort',abort);}});
    return {prepare:()=>platform.prepare(context.scope),start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.close};
  };
}
