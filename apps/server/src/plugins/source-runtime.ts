import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';
import type {SourceRuntimeLifecyclePort} from '../source-runtime-storage.js';

export interface SourceRuntimeOptions {}
export interface SourceRuntimeDependencies {readonly port:SourceRuntimeLifecyclePort;}
/** Compiled trusted local factory, not a second package/archive Manifest. Intake
 * is the existing SourceStore -> receive transaction, authorized by the current
 * authorization and source owners.
 * No ordinary plugin gets a raw runtime, validate callback or binding writer. */
export const sourceRuntimeContribution={id:'source-runtime',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'service',id:centralServices.execution.id,version:'1.0.0'}],provides:[],
} as const satisfies ManifestContribution;
export const sourceRuntimeDeclaration={id:sourceRuntimeContribution.id,apiVersion:'1'} as const;
export const sourceRuntimeReplacement='hot' as const;
const unavailable=()=>new StoreError('Source runtime is unavailable',503);

export function createSourceRuntime(_options:SourceRuntimeOptions,dependencies:SourceRuntimeDependencies){
  const {port}=dependencies;
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created',closing:Promise<void>|undefined;
  const close=()=>{
    if(closing)return closing;
    let resolve!:()=>void,reject!:(error:unknown)=>void;
    closing=new Promise<void>((done,failed)=>{resolve=done;reject=failed;});
    void port.close().then(()=>{phase='disposed';resolve();},reject);
    return closing;
  };
  return Object.freeze({
    async prepare(scope:Parameters<SourceRuntimeLifecyclePort['open']>[0]){
      if(phase!=='created')throw unavailable();
      try{await port.open(scope);phase='prepared';}
      catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source runtime preparation and disposal failed',{cause:error});}throw error;}
    },
    start(){if(phase!=='prepared')throw unavailable();port.start();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';port.quiesce();},
    async stop(){if(phase!=='disposed')await close();},
    dispose:close,
    close,
  });
}
export type SourceRuntime=ReturnType<typeof createSourceRuntime>;
export function createSourceRuntimeFactory(platform:SourceRuntime){
  return (context:HostPluginContext):PluginLifecycle=>{
    const abort=()=>{void platform.close().catch(()=>{});};context.scope.signal.addEventListener('abort',abort,{once:true});
    context.scope.defer(async()=>{try{await platform.close();}finally{context.scope.signal.removeEventListener('abort',abort);}});
    return {prepare:()=>platform.prepare(context.scope),start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.dispose};
  };
}
