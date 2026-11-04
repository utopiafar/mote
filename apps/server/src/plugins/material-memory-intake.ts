import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {CaptureInput} from '@mote/shared';
import {StoreError} from '../store.js';
import type {MaterialStore} from '../materials.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {MemoryInputSelection} from '../evidence-read-ports.js';
import {MaterialMemoryWork} from '../material-memory-work.js';
import {installCaptureMemoryIntake} from '../capture-memory-intake.js';
import {centralServices,type MaterialMemoryCandidates} from './central-contracts.js';

/** C19E owns the durable Material-to-Memory candidate ledger and the capture
 * receipts that mint new raw input grants. It borrows the canonical Material
 * repository; the reader-backed selection implementation is bound by the
 * materials assembly after the single EvidenceReader exists. */
export const materialMemoryIntakeContribution={
  id:'material-memory-intake',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.materialRepository.id,version:'1.0.0'},
  ],
  provides:[centralServices.memoryCandidates,centralServices.memoryInputSelection].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const materialMemoryIntakeDeclaration={id:materialMemoryIntakeContribution.id,apiVersion:'1'} as const;
export const materialMemoryIntakeReplacement='hot' as const;

export interface MaterialMemoryIntakeDependencies {
  readonly store:MaterialStore['store'];
  readonly materials:MaterialStore;
  readonly recipes?:MemoryRecipeSettings;
  readonly now?:()=>number;
  readonly automaticEnabled?:()=>boolean;
  readonly newInputAdmission?:()=>boolean;
  /** Trusted capture receipt hook. When present this owner installs and later
   * removes the single `Store.captureInputReceived` observer. The current root
   * still installs it in app.ts until K04 moves that call site. */
  readonly captureOriginal?:(input:CaptureInput)=>void;
}

export interface MaterialMemoryIntakeBindings {
  readonly memoryCandidates:ServiceBinding;
  readonly memoryInputSelection:ServiceBinding;
}

const unavailable=()=>new StoreError('Material Memory intake is unavailable',503);
type Phase='created'|'prepared'|'active'|'quiescing'|'stopped';

/** Owns one MaterialMemoryWork ledger plus, when bound by the trusted root, the
 * capture input receipt observer. Reads and withdrawals outlive quiesce; new
 * observations require an active activation. A stopped platform is never
 * revived: a new activation constructs a fresh work owner on the same store. */
export function createMaterialMemoryIntake(dependencies:MaterialMemoryIntakeDependencies){
  const {store,materials}=dependencies;
  if(materials.store!==store)throw unavailable();
  let phase:Phase='created',work:MaterialMemoryWork|undefined,uninstallCapture:(()=>void)|undefined,closed=false;
  const prepared=()=>{
    if(!work||phase==='created'||phase==='stopped')throw unavailable();
    return work;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return prepared();
  };
  const removeCapture=()=>{const remove=uninstallCapture;uninstallCapture=undefined;remove?.();};
  const close=()=>{
    if(closed)return;
    closed=true;removeCapture();
    work?.dispose();work=undefined;phase='stopped';
  };
  const memoryCandidates:MaterialMemoryCandidates=Object.freeze({
    observe:(materialId,required,observation,settleMs)=>active().observe(materialId,required,observation,settleMs),
    withdraw:materialId=>prepared().withdraw(materialId),
    planningInput:(candidate,jobId)=>prepared().planningInput(candidate,jobId),
    sourceRequirements:ref=>prepared().sourceRequirements(ref),
    authorized:job=>prepared().authorized(job),
  });
  const memoryInputSelection:MemoryInputSelection=Object.freeze({
    memoryPlanSelection:(...args:Parameters<MemoryInputSelection['memoryPlanSelection']>)=>prepared().inputSelection().memoryPlanSelection(...args),
    memorySelection:(...args:Parameters<MemoryInputSelection['memorySelection']>)=>prepared().inputSelection().memorySelection(...args),
  });
  return Object.freeze({
    prepare(){
      if(phase!=='created')throw unavailable();
      try{
        work=new MaterialMemoryWork(store,materials,dependencies.now??Date.now,dependencies.automaticEnabled??(()=>true),dependencies.recipes,
          dependencies.newInputAdmission??dependencies.automaticEnabled??(()=>true));
        phase='prepared';
      }catch(error){
        try{close();}catch{}
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      if(dependencies.captureOriginal&&!uninstallCapture)uninstallCapture=installCaptureMemoryIntake(store,work!,dependencies.captureOriginal);
      phase='active';
    },
    quiesce(_reason?:StopReason){if(phase==='active'){removeCapture();phase='quiescing';}},
    stop(_reason?:StopReason){close();},
    dispose(){close();},
    close,
    /** Trusted materials assembly: the single EvidenceReader supplies manual
     * input selection only after it exists, without constructing a second one. */
    bindSelection(selection:MemoryInputSelection){prepared().bindSelection(selection);},
    /** Trusted root hook for the capture receipt observer when it moves from app.ts. */
    installCaptureIntake(onOriginal:(input:CaptureInput)=>void){
      const current=prepared();
      if(uninstallCapture)throw new StoreError('Capture Memory intake is already installed',409);
      uninstallCapture=installCaptureMemoryIntake(store,current,onOriginal);
      return uninstallCapture;
    },
    get workForAssembly(){
      if(!work||phase==='created'||phase==='stopped')throw unavailable();
      return work;
    },
    memoryCandidates,memoryInputSelection,
  });
}
export type MaterialMemoryIntake=ReturnType<typeof createMaterialMemoryIntake>;

export function createMaterialMemoryIntakeFactory(platform:MaterialMemoryIntake,onStarted?:(bindings:MaterialMemoryIntakeBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const memoryCandidates=context.provide(materialMemoryIntakeContribution.id,centralServices.memoryCandidates,platform.memoryCandidates);
        const memoryInputSelection=context.provide(materialMemoryIntakeContribution.id,centralServices.memoryInputSelection,platform.memoryInputSelection);
        onStarted?.({memoryCandidates,memoryInputSelection});
      },
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
