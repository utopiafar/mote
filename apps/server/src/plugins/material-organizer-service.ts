import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ExecutionEngine} from '../execution-engine.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {MaterialStore} from '../materials.js';
import {StoreError} from '../store.js';
import {MaterialOrganizerRuntime,type MaterialOrganizer} from '../material-organizers.js';
import {centralServices} from './central-contracts.js';

/** C19B owns the organizer registry, cursor/backlog and its poll. It writes
 * through the canonical Material repository leased by the materials assembly;
 * Memory observations go through the C19E candidate port. */
export const materialOrganizerServiceContribution={
  id:'material-organizer-service',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.execution.id,version:'1.0.0'},
    {kind:'service',id:centralServices.materialRepository.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryCandidates.id,version:'1.0.0'},
  ],
  provides:[],
} as const satisfies ManifestContribution;
export const materialOrganizerServiceDeclaration={id:materialOrganizerServiceContribution.id,apiVersion:'1'} as const;
export const materialOrganizerServiceReplacement='hot' as const;

export interface MaterialOrganizerServiceDependencies {
  /** Borrowed vault handle for the durable cursor/backlog tables. */
  readonly store:MaterialStore['store'];
  /** The leased Material repository, never a second store or publication channel. */
  readonly materials:MaterialStore;
  readonly executor:ExecutionEngine;
  readonly memoryCandidates?:Pick<MaterialMemoryWork,'observe'|'withdraw'>;
  readonly organizers?:readonly MaterialOrganizer[];
}

export type OrganizerInterval=(ms:number,work:()=>unknown|Promise<unknown>)=>()=>void;
const localInterval:OrganizerInterval=(ms,work)=>{
  let running=false;
  const timer=setInterval(()=>{if(running)return;running=true;void Promise.resolve().then(work).catch(()=>{}).finally(()=>{running=false;});},ms);
  timer.unref();return()=>clearInterval(timer);
};
const unavailable=()=>new StoreError('Material organizer is unavailable',503);

/** Owns one runtime generation. Quiesce fences both the poll and every accepted
 * generation; stop drains those generations so no late result publishes. */
export function createMaterialOrganizerService(dependencies:MaterialOrganizerServiceDependencies){
  const {store,materials,executor}=dependencies;
  if(!store||!materials||!executor)throw unavailable();
  if(materials.store!==store)throw unavailable();
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let runtime:MaterialOrganizerRuntime|undefined,stopTimer:(()=>void)|undefined,closing:Promise<void>|undefined;
  const ready=()=>{
    if(!runtime||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return runtime;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return ready();
  };
  const stopPoll=()=>{stopTimer?.();stopTimer=undefined;};
  const close=()=>{
    if(closing)return closing;
    stopPoll();phase='stopped';
    closing=(async()=>{
      const errors:unknown[]=[];
      try{await runtime?.stop();}catch(error){errors.push(error);}
      runtime=undefined;phase='disposed';
      if(errors.length)throw new AggregateError(errors,'Material organizer disposal failed');
    })();
    return closing;
  };
  return Object.freeze({
    prepare(){
      if(phase!=='created')throw unavailable();
      phase='preparing';
      try{
        runtime=new MaterialOrganizerRuntime(store,materials,[...(dependencies.organizers??[])],executor,dependencies.memoryCandidates);
        phase='prepared';
      }catch(error){
        try{void close().catch(()=>{});}catch(cleanup){throw new AggregateError([error,cleanup],'Material organizer preparation and cleanup failed',{cause:error});}
        throw error;
      }
    },
    start(interval:OrganizerInterval=localInterval){
      if(phase!=='prepared')throw unavailable();
      phase='active';stopTimer=interval(5000,()=>runtime!.tick(200));
    },
    tick(limit=100){return active().tick(limit);},
    status(){return ready().status();},
    quiesce(_reason?:StopReason){stopPoll();if(phase==='active')phase='quiescing';runtime?.quiesce();},
    stop:async(_reason?:StopReason)=>{await close();},
    dispose:close,close,
    /** Trusted materials assembly bridge for the route table, connectors and the
     * unique EvidenceReader. Never provided as an ordinary plugin service. */
    get organizerForAssembly(){return ready();},
    get runtimeForAssembly(){return ready();},
    get sourceItemRecipes(){return ready().sourceItemRecipes;},
  });
}
export type MaterialOrganizerService=ReturnType<typeof createMaterialOrganizerService>;

export function createMaterialOrganizerServiceFactory(platform:MaterialOrganizerService){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start:()=>platform.start((ms,work)=>context.scope.every(ms,work)),
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),
      stop:(reason?:StopReason)=>platform.stop(reason),
      dispose:platform.dispose,
    };
  };
}
