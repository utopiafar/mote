import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type PluginLifecycle,type StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {ProviderFailure,type MediaModelStatus} from '@mote/shared';
import {LOCAL_IMAGE_ERRORS,type LocalImagePluginState} from '../local-image-contract.js';
import type {TrustedPluginBuild} from '../plugin-center.js';
import type {BuildSelection} from './plugin-control-store.js';
import {StoreError} from '../store.js';

export const LOCAL_IMAGE_PROCESSING_INSTANCE='local-image';
export const localImageProcessingSelection={packageId:'mote.local-image-processing',version:'1.0.0',configurationRevision:0} as const satisfies BuildSelection;

/** This port selects intake only. A waiting/failed local selection remains
 * selected; callers may use their configured image model only when selection()
 * returns undefined. It grants no pixel access or background model authority. */
export interface LocalImageProcessingPort {
  state():LocalImagePluginState;
  /** Recheck a newly installed model, or explicitly retry runtime preparation. */
  refresh():Promise<LocalImagePluginState>;
  /** IMG-03 supplies the authorized HTTP call. Existing host scopes cancel or
   * drain it; CORE-02 owns the physical worker, health and termination facts. */
  run<T>(task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>;
}
export const localImageProcessingService=serviceContract<LocalImageProcessingPort>('mote.local-image-processing','1');
export const localImageProcessingContribution={
  id:'local-image-processing',version:localImageProcessingSelection.version,surface:'processing',runtime:'host',
  provides:[{kind:'service',id:localImageProcessingService.id,apiVersion:localImageProcessingService.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const localImageProcessingDeclaration={id:localImageProcessingContribution.id,apiVersion:'1'} as const;

export interface LocalImageProcessingDependencies {
  /** The existing PluginCenter build record is the sole durable switch. The
   * trusted assembly reads its fixed instance's desired selection here. */
  readonly desired:()=>BuildSelection|null|undefined;
  /** CORE-01/02's actual shared status, not catalog membership or a model path. */
  readonly modelStatus:()=>MediaModelStatus|undefined|Promise<MediaModelStatus|undefined>;
  /** A CORE-02-owned lifecycle over already installed weights. No download,
   * model deletion, process supervision or health protocol lives in this plugin.
   * The signal cancels startup; stop/dispose must join physical termination. */
  readonly createWorker:(startupSignal:AbortSignal)=>PluginLifecycle;
}
type Activation={context:HostPluginContext;accepting:boolean};
type Worker={lifecycle:PluginLifecycle;controller:AbortController;calls:Set<Promise<unknown>>;closing?:Promise<void>};
const unavailable=(reason?:string)=>{
  const missing=reason==='model_missing'||reason==='model_failed',failure=LOCAL_IMAGE_ERRORS[missing?'model_missing':'worker_unavailable'];
  return new ProviderFailure({category:failure.category,code:failure.hostCode});
};

/** One compiled optional service build, registered but off until the owner
 * selects it through PluginCenter. Its factory is installed by PluginHost;
 * there is no second control store, external package installer or host runtime.
 * Repeated hot selections transfer the same domain worker to the new activation
 * before the previous host handle drains, rather than starting a second model. */
export function createLocalImageProcessing(dependencies:LocalImageProcessingDependencies){
  let current:Activation|undefined,worker:Worker|undefined;
  let observed:Omit<LocalImagePluginState,'enabled'>={state:'stopped'};
  let tail:Promise<unknown>=Promise.resolve();
  const enabled=()=>dependencies.desired()?.packageId===localImageProcessingSelection.packageId;
  const serial=<T>(task:()=>Promise<T>)=>{
    const pending=tail.then(task);tail=pending.catch(()=>{});return pending;
  };
  const state=():LocalImagePluginState=>!enabled()?{enabled:false,state:'stopped'}:
    {enabled:true,...(observed.state==='ready'&&!current?.accepting?{state:'stopped' as const}:observed)};
  const retire=(reason:StopReason):Promise<void>=>{
    const owned=worker;if(!owned)return Promise.resolve();
    return owned.closing??=(async()=>{
      owned.controller.abort(unavailable());
      const errors:unknown[]=[];
      const attempt=async(task:()=>unknown|Promise<unknown>)=>{try{await task();}catch(error){errors.push(error);}};
      await attempt(()=>owned.lifecycle.quiesce(reason));
      await Promise.allSettled([...owned.calls]);
      await attempt(()=>owned.lifecycle.stop(reason));
      await attempt(()=>owned.lifecycle.dispose());
      // Failed termination is not permission to launch another worker. Retain
      // the failed cleanup promise so subsequent prepares fail closed as well.
      if(errors.length){observed={state:'failed',reason:'worker_stop_failed'};throw new AggregateError(errors,'Local image worker disposal failed');}
      if(worker===owned)worker=undefined;
    })();
  };
  const update=async(signal:AbortSignal,retry:boolean)=>{
    signal.throwIfAborted();
    if(!enabled())return;
    let model:MediaModelStatus|undefined;
    try{model=await dependencies.modelStatus();signal.throwIfAborted();}
    catch{
      // A caller withdrawing while a health probe is in flight does not make
      // the shared worker unhealthy or revoke other callers' accepted work.
      signal.throwIfAborted();
      observed={state:'failed',reason:'worker_unavailable'};
      await retire('dependency_unavailable');return;
    }
    if(model?.role!=='local-image'||model.state!=='ready'){
      await retire('dependency_unavailable');
      observed=model?.state==='failed'?{state:'failed',reason:'model_failed'}:{state:'waiting',reason:'model_missing'};
      return;
    }
    if(worker){
      if(!worker.controller.signal.aborted&&model.runtimeReady){observed={state:'ready'};return;}
      await retire('dependency_unavailable');observed={state:'failed',reason:'worker_unavailable'};
    }
    if(!retry&&observed.state==='failed')return;
    const controller=new AbortController(),startup=AbortSignal.any([signal,controller.signal]);
    try{
      const owned:Worker={lifecycle:dependencies.createWorker(startup),controller,calls:new Set()};worker=owned;
      await owned.lifecycle.prepare();startup.throwIfAborted();
      await owned.lifecycle.start();startup.throwIfAborted();
      const ready=await dependencies.modelStatus();startup.throwIfAborted();
      if(ready?.role!=='local-image'||ready.state!=='ready'||!ready.runtimeReady)throw unavailable();
      observed={state:'ready'};
    }catch{
      observed={state:'failed',reason:'worker_unavailable'};
      await retire('startup_failed');signal.throwIfAborted();
    }
  };
  const port:LocalImageProcessingPort=Object.freeze({
    state,
    async refresh(){
      const activation=current;
      if(!enabled()||!activation?.accepting)return state();
      const result=await activation.context.scope.run(async signal=>{
        await serial(()=>update(signal,true));return state();
      });
      return result??state();
    },
    async run<T>(task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
      const activation=current;
      if(!enabled()||!activation?.accepting)throw unavailable();
      const accepted=await activation.context.scope.run(async scopeSignal=>{
        const requestSignal=AbortSignal.any([scopeSignal,signal]);
        await serial(()=>update(requestSignal,false));requestSignal.throwIfAborted();
        const owned=worker;
        if(current!==activation||!activation.accepting||!enabled()||observed.state!=='ready'||!owned)throw unavailable(observed.reason);
        const callSignal=AbortSignal.any([requestSignal,owned.controller.signal]);
        const pending=Promise.resolve().then(()=>{callSignal.throwIfAborted();return task(callSignal);}).then(value=>{
          callSignal.throwIfAborted();if(!enabled())throw unavailable();return value;
        });
        owned.calls.add(pending);
        try{return {value:await pending};}
        catch(error){
          if(!callSignal.aborted){
            let health:MediaModelStatus|undefined;
            try{health=await dependencies.modelStatus();}catch{/* An unavailable health probe cannot certify readiness. */}
            callSignal.throwIfAborted();
            if(worker===owned&&(health?.role!=='local-image'||health.state!=='ready'||!health.runtimeReady)){
              observed={state:'failed',reason:'worker_unavailable'};
              owned.controller.abort(unavailable());
              throw unavailable();
            }
          }
          throw error;
        }
        finally{owned.calls.delete(pending);}
      });
      if(!accepted)throw unavailable();
      return accepted.value;
    },
  });
  const factory=(context:HostPluginContext):PluginLifecycle=>{
    if(context.scope.identity.instanceId!==LOCAL_IMAGE_PROCESSING_INSTANCE||context.scope.identity.packageId!==localImageProcessingSelection.packageId)
      throw new StoreError('Use the bundled local image instance',409);
    const activation:Activation={context,accepting:false};
    let prepared=false,disposed=false,stopping:Promise<void>|undefined;
    const stop=(reason:StopReason)=>stopping??=(async()=>{
      activation.accepting=false;
      await serial(async()=>{
        // A repeated selection has already adopted this worker. Retiring the
        // older host scope must not quiesce or dispose its successor's worker.
        if(current&&current!==activation)return;
        if(current===activation)current=undefined;
        await retire(reason);observed={state:'stopped'};
      });
    })();
    const dispose=async()=>{if(disposed)return;disposed=true;await stop('shutdown');};
    context.scope.defer(dispose);
    return {
      async prepare(){
        if(disposed||prepared)throw new StoreError('Local image activation is unavailable',503);
        await serial(()=>update(context.scope.signal,true));context.scope.assertCurrent();prepared=true;
      },
      start(){
        if(!prepared||disposed||!enabled())throw new StoreError('Local image activation is unavailable',503);
        context.provide(localImageProcessingContribution.id,localImageProcessingService,port);
        activation.accepting=true;current=activation;
      },
      quiesce(reason){
        activation.accepting=false;
        if(current!==activation)return;
        if(reason!=='upgrade'&&reason!=='restart')worker?.controller.abort(unavailable());
      },
      stop,
      dispose,
    };
  };
  const build:TrustedPluginBuild=Object.freeze({packageId:localImageProcessingSelection.packageId,version:localImageProcessingSelection.version,replacement:'hot',contribution:localImageProcessingContribution,factory});
  return Object.freeze({build,port,factory,selection:():LocalImageProcessingPort|undefined=>enabled()?port:undefined});
}
