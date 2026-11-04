import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MemoryAutomation,type MemoryAutomationStore,type MemoryAutomationState} from '../memory-automation.js';
import {StoreError} from '../store.js';
import {centralServices,type MemoryAdmission} from './central-contracts.js';

/** C21C's durable admission owner: automatic-work pause/resume/stop commands and
 * the host switch cutover fence. Binding state and local stop participants stay
 * with their own owners; this plugin only decides whether new automatic work may
 * be admitted. */
export const memoryAutomationAdmissionContribution={
  id:'memory-automation-admission',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[centralServices.memoryAdmission].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const memoryAutomationAdmissionDeclaration={id:memoryAutomationAdmissionContribution.id,apiVersion:'1'} as const;
export const memoryAutomationAdmissionReplacement='hot' as const;

export interface MemoryAutomationAdmissionBindings {
  readonly admission:ServiceBinding;
}

const unavailable=()=>new StoreError('Memory automation admission is unavailable',503);

/** Owns the one durable MemoryAutomation instance. The control port never
 * exposes the local resume/stop/count projections that trusted assembly binds;
 * those callbacks remain on the leased assembly bridge. */
export function createMemoryAutomationAdmission(store:MemoryAutomationStore,now=Date.now){
  let phase:'created'|'prepared'|'active'|'quiescing'|'disposed'='created';
  let automation:MemoryAutomation|undefined,closing:Promise<void>|undefined;
  const ready=()=>{
    if(!automation||phase==='created'||phase==='disposed')throw unavailable();
    return automation;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return automation!;
  };
  const close=()=>closing??=(async()=>{
    phase='disposed';
    // MemoryAutomation owns no timer, file handle or database lock of its own:
    // the borrowed vault store remains owned by its provider.
    automation=undefined;
  })();
  const admission:MemoryAdmission=Object.freeze({
    state:():MemoryAutomationState=>ready().state(),
    view:()=>ready().view(),
    // Quiescing rejects new automatic admission even when the durable owner is
    // enabled; persisted desired/barrier state is not rewritten here.
    accepting:()=>phase==='active'&&ready().accepting(),
    command:(kind,raw)=>active().command(kind,raw),
    freeze:(operationId:string)=>active().freeze(operationId),
    release:(operationId:string)=>active().release(operationId),
    touch:()=>active().touch(),
  });
  return Object.freeze({
    prepare(){
      if(phase!=='created')throw unavailable();
      try{
        automation=new MemoryAutomation(store,now);
        phase='prepared';
      }catch(error){
        void close();
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,
    /** Trusted composition bridge until K04 installs this domain through the
     * host. Consumers receive the narrower MemoryAdmission service instead. */
    get automationForAssembly(){return ready();},
    admission,
  });
}
export type MemoryAutomationAdmission=ReturnType<typeof createMemoryAutomationAdmission>;

/** Compiled trusted H04 owner. The host stages the port until start succeeds,
 * so a prepare failure cannot leave an acquirable admission service behind. */
export function createMemoryAutomationAdmissionFactory(platform:MemoryAutomationAdmission,onStarted?:(bindings:MemoryAutomationAdmissionBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const admission=context.provide(memoryAutomationAdmissionContribution.id,centralServices.memoryAdmission,platform.admission);
        onStarted?.({admission});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
