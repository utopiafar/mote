import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MemoryBindings} from '../memory-bindings.js';
import {createMemoryControl,type MemoryControl} from '../memory-control.js';
import type {MemoryAutomation} from '../memory-automation.js';
import type {MemoryLifecycle} from '../memory-lifecycle.js';
import type {MemoryPipeline} from '../memory-pipeline.js';
import type {MemoryPublication} from './memory-publication.js';
import {StoreError} from '../store.js';
import {centralServices,type MemoryBindingControl} from './central-contracts.js';

/** C21D owns the authoritative binding state machine and the local control
 * projections that pause/resume/stop consume. Readers and publication borrow
 * the actual binding object; this factory is the only construction path. */
export const memoryBindingControlContribution={
  id:'memory-binding-control',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.memoryRecords.id,version:'1.0.0'},
    {kind:'service',id:centralServices.memoryAdmission.id,version:'1.0.0'},
  ],
  provides:[{kind:'service',id:centralServices.memoryBindingControl.id,apiVersion:centralServices.memoryBindingControl.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const memoryBindingControlDeclaration={id:memoryBindingControlContribution.id,apiVersion:'1'} as const;
/** Binding commands and durable preparation/receipt rows live in the vault, so
 * a fresh activation resumes them without a process restart. */
export const memoryBindingControlReplacement='hot' as const;

type BindingsStore=ConstructorParameters<typeof MemoryBindings>[0];
type BindingsMemories=ConstructorParameters<typeof MemoryBindings>[1];
type BindingsAutomation=ConstructorParameters<typeof MemoryBindings>[2];
type BindingsPlugins=ConstructorParameters<typeof MemoryBindings>[3];
type BindingsExecutor=ConstructorParameters<typeof MemoryBindings>[4];

/** Objects available when the early admission callbacks are installed. The
 * binding itself is constructed in prepare after the material intake exists. */
export interface MemoryBindingControlDependencies {
  readonly store:BindingsStore;
  readonly automation:BindingsAutomation;
  readonly now?:()=>number;
}

/** Runtime collaborators are resolved from the owning assembly. Publication is
 * constructed from the binding object, so its lookup is called during start. */
export interface MemoryBindingControlRuntime {
  readonly memories:BindingsMemories;
  readonly plugins:BindingsPlugins;
  readonly executor:BindingsExecutor;
  readonly pipeline:()=>Pick<MemoryPipeline,'get'|'cancel'>;
  readonly lifecycle:()=>Pick<MemoryLifecycle,'view'|'cancel'|'skipAutomaticBacklog'|'automaticAdmission'>;
  readonly publication:()=>Pick<MemoryPublication,'pending'>;
}

export interface MemoryBindingControlBindings {
  readonly bindings:ServiceBinding;
}

export interface MemoryBindingControlPlatform extends PluginLifecycle {
  readonly bindings:MemoryBindings;
  readonly control:MemoryControl;
  readonly port:MemoryBindingControl;
  attach(runtime:MemoryBindingControlRuntime):void;
  accepting():boolean;
  references(instanceId:string):string[];
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory binding control is unavailable',503);

/** Owns MemoryBindings and the control projections wired onto MemoryAutomation.
 * Prepare constructs the binding and its execution handler; start installs the
 * local stop/resume/count projections and the admission callbacks. Quiesce
 * refuses new commands while reads keep serving the prepared binding. */
export function createMemoryBindingControl(dependencies:MemoryBindingControlDependencies):MemoryBindingControlPlatform {
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let runtime:MemoryBindingControlRuntime|undefined,bindings:MemoryBindings|undefined,control:MemoryControl|undefined,closing:Promise<void>|undefined;
  const readable=()=>{
    if(!bindings||phase==='created'||phase==='stopped')throw unavailable();
    return bindings;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return readable();
  };
  const accepting=()=>{
    if(phase==='created')return dependencies.automation.accepting();
    return phase==='active'&&Boolean(bindings)&&bindings!.accepting();
  };
  const references=(instanceId:string)=>{
    if(phase==='created'||!runtime)return [];
    return runtime.plugins.references(instanceId);
  };
  const close=()=>closing??=(async()=>{
    const owned=bindings;
    phase='stopped';
    if(control){
      if(dependencies.automation.onResume===control.resume)dependencies.automation.onResume=undefined;
      if(dependencies.automation.onStop===control.stop)dependencies.automation.onStop=undefined;
    }
    bindings=undefined;control=undefined;
    if(owned)await owned.close();
  })().finally(()=>{closing=undefined;});
  const port:MemoryBindingControl=Object.freeze({
    view:()=>readable().view(),
    prepare:raw=>active().prepare(raw),
    action:(kind,raw)=>active().action(kind,raw),
    binding:()=>readable().binding(),
    accepting,
    assertNewManualWork:()=>active().assertNewManualWork(),
    pendingTail:()=>readable().pendingTail(),
  });
  const platform:MemoryBindingControlPlatform=Object.freeze({
    port,
    get bindings(){return readable();},
    get control(){if(!control||phase==='created'||phase==='stopped')throw unavailable();return control;},
    accepting,
    references,
    attach(value:MemoryBindingControlRuntime){
      if(phase!=='created'||runtime)throw unavailable();
      runtime=value;
    },
    prepare(){
      if(phase!=='created'||!runtime)throw unavailable();
      try{
        bindings=new MemoryBindings(dependencies.store,runtime.memories,dependencies.automation,runtime.plugins,runtime.executor);
        phase='prepared';
      }catch(error){
        phase='stopped';
        bindings=undefined;
        throw error;
      }
    },
    start(){
      if(phase!=='prepared'||!runtime)throw unavailable();
      const current=bindings!,lifecycle=runtime.lifecycle();
      try{
        control=createMemoryControl({store:dependencies.store,pipeline:runtime.pipeline(),lifecycle,executor:runtime.executor,publication:runtime.publication(),now:dependencies.now});
        current.pendingTail=control.pendingTail;
        dependencies.automation.onResume=control.resume;
        dependencies.automation.onStop=control.stop;
        dependencies.automation.counts=control.counts;
        lifecycle.automaticAdmission=id=>!['extraction','consolidation'].includes(id)||accepting();
        current.onReleased=()=>lifecycle.skipAutomaticBacklog();
        runtime.plugins.admissionChanged=(id,enabled)=>{
          if(phase!=='active')return;
          if(current.binding().namespace?.instanceId===id){if(enabled)lifecycle.skipAutomaticBacklog();dependencies.automation.touch();}
        };
        phase='active';
      }catch(error){
        phase='prepared';
        control=undefined;
        throw error;
      }
    },
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,
  });
  return platform;
}
export type MemoryBindingControlService=ReturnType<typeof createMemoryBindingControl>;

export function createMemoryBindingControlFactory(platform:MemoryBindingControlPlatform,onStarted?:(bindings:MemoryBindingControlBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const bindings=context.provide(memoryBindingControlContribution.id,centralServices.memoryBindingControl,platform.port);
        onStarted?.({bindings});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
