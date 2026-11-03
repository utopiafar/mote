import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {SourceStore} from '../sources.js';
import {StoreError,type Store} from '../store.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {FileStore} from '../files.js';
import type {SourceFileCatalogRead} from '../evidence-read-ports.js';
import {LayersReadModel} from '../layers-read-model.js';
import type {MemoryStore} from '../memory.js';
import type {ConnectionCredential} from '../connections.js';
import {registerSourceRoutes} from '../source-routes.js';
import type {AuthorizationPlatform} from './authorization-platform.js';
import type {CaptureIntakePlatform} from './capture-intake.js';
import {centralServices,type RequestAuthority} from './central-contracts.js';

export interface C10IntegrationDependencies {
  readonly store:Store;
  readonly runtime:SourcePipelineRuntime;
  readonly memoryWork:MaterialMemoryWork;
  /** Actual shared repository; independent owners keep their own write authority. */
  readonly sources?:SourceStore;
}
export interface C10SourceRouteBindings {
  readonly authorization:AuthorizationPlatform;
  readonly capture:CaptureIntakePlatform;
  readonly files:FileStore;
  readonly evidenceReader:SourceFileCatalogRead;
  readonly memories:Pick<MemoryStore,'count'>;
}
interface C10BoundSourceRoutes extends Omit<C10SourceRouteBindings,'memories'> {
  readonly layers:LayersReadModel;
}
/** No ordinary sources service: C01's repository still includes an unguarded
 * register method. Requests use the existing owner/collector route policy. */
export const c10IntegrationContribution={id:'source-integration',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'},{kind:'service',id:centralServices.sourceIntake.id,version:'1.0.0'}],provides:[]} as const satisfies ManifestContribution;
export const c10IntegrationDeclaration={id:c10IntegrationContribution.id,apiVersion:'1'} as const;
// C04 and file/capture owners retain this exact repository; replacement restarts
// the trusted assembly rather than leaving those owners on a detached instance.
export const c10IntegrationReplacement='restart' as const;
const unavailable=()=>new StoreError('Source integration is unavailable',503);

interface C10RouteActivation {
  readonly bindings:C10BoundSourceRoutes;
  readonly sources:SourceStore;
  admit(request:FastifyRequest):void;
  assert(request:FastifyRequest):void;
  release(request:FastifyRequest):void;
  credential(request:FastifyRequest):ConnectionCredential|undefined;
  sourceOwner(request:FastifyRequest,id:string):void;
  writable(request:FastifyRequest):void;
  sourceItem(request:FastifyRequest,id:string,input:unknown):ReturnType<CaptureIntakePlatform['ports']['sourceIntake']['sourceItem']>;
  sourceBatch(request:FastifyRequest,id:string,inputs:unknown):ReturnType<CaptureIntakePlatform['ports']['sourceIntake']['sourceBatch']>;
}
const routeActivations=new WeakMap<C10Integration,C10RouteActivation>();

/** Owns source routes over one shared repository. Capture, Notes, Devices,
 * runtime, MemoryWork, C04 and the vault retain their independent owners. */
export function createC10Integration(dependencies:C10IntegrationDependencies){
  const {store,runtime,memoryWork}=dependencies;
  if(runtime.store!==store||runtime.memoryWork!==memoryWork)throw new StoreError('Source integration repository mismatch',503);
  const sources=dependencies.sources??new SourceStore(store,runtime,memoryWork.inputs);
  if(sources.store!==store||sources.pipelines!==runtime||!sources.usesMemoryInputs(memoryWork.inputs))throw new StoreError('Source integration repository mismatch',503);
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created',scope:PluginScope|undefined,bindings:C10BoundSourceRoutes|undefined,closing:Promise<void>|undefined,mounted=false;
  const pending=new Set<Promise<unknown>>();
  const track=<T>(task:Promise<T>):Promise<T>=>{
    const owned=task.catch(error=>{if(phase==='stopped'||phase==='disposed')throw Object.assign(unavailable(),{cause:error});throw error;});
    pending.add(owned);void owned.then(()=>pending.delete(owned),()=>pending.delete(owned));return owned;
  };
  const drain=async()=>{await Promise.allSettled([...pending]);};
  const requests=new Map<FastifyRequest,{pin:RequestAuthority;credential?:ConnectionCredential}>();
  const release=(request:FastifyRequest)=>{const entry=requests.get(request);if(entry){requests.delete(request);bindings!.authorization.releaseRequest(entry.pin);}};
  const assertRequest=(request:FastifyRequest)=>{
    if(phase!=='active'&&phase!=='quiescing')throw unavailable();scope!.assertCurrent();
    const entry=requests.get(request);if(!entry)throw new StoreError('Owner authorization is required',401);
    bindings!.authorization.requests.assertCurrent(entry.pin);return entry;
  };
  const writable=(request:FastifyRequest)=>{if(phase!=='active')throw unavailable();return assertRequest(request);};
  const close=()=>{
    if(closing)return closing;phase='stopped';for(const request of requests.keys())release(request);
    return closing=drain().finally(()=>{phase='disposed';});
  };
  const activation:C10RouteActivation={
    get bindings(){if(!bindings)throw unavailable();return bindings;},sources,
    admit(request){
      if(phase!=='active'&&!(phase==='quiescing'&&['GET','HEAD'].includes(request.method)))throw unavailable();scope!.assertCurrent();
      const fixed=activation.bindings,connections=fixed.authorization.assembly.connections!;
      const pin=fixed.authorization.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin,signal:scope!.signal});
      const credential=connections.authenticate(request.headers.authorization);
      requests.set(request,{pin,...(credential&&!connections.isOwner(credential)?{credential:Object.freeze({...credential})}:{})});
    },
    assert:assertRequest,release,credential:request=>assertRequest(request).credential,
    sourceOwner(request,id){const entry=assertRequest(request);if(entry.credential)activation.bindings.authorization.requests.assertOwnSource(entry.pin,id);},
    writable(request){writable(request);},
    sourceItem(request,id,input){const {pin}=writable(request),fixed=activation.bindings;return track(fixed.authorization.withSource(pin,id,input,()=>fixed.capture.ports.sourceIntake.sourceItem(id,input,fixed.authorization.commits.capture())));},
    sourceBatch(request,id,inputs){const {pin}=writable(request),fixed=activation.bindings;return track(fixed.authorization.withSource(pin,id,inputs,()=>fixed.capture.ports.sourceIntake.sourceBatch(id,inputs,fixed.authorization.commits.capture())));},
  };
  const platform=Object.freeze({
    /** The sole private root bridge for C10A/C04/C11/C12. Not a service value. */
    get sourcesForAssembly(){if(phase!=='created')throw unavailable();return sources;},
    bindRoutes(value:C10SourceRouteBindings){
      if(bindings||phase!=='created'&&phase!=='prepared')throw unavailable();
      if(value.files.store!==store||!value.capture.ingress.usesRepositories(store,sources,value.files)||!value.authorization.assembly.connections?.usesStore(store))throw new StoreError('Source authorization repository mismatch',503);
      bindings={authorization:value.authorization,capture:value.capture,files:value.files,evidenceReader:value.evidenceReader,layers:new LayersReadModel(sources,value.memories)};
    },
    async prepare(value:PluginScope){
      if(phase!=='created')throw unavailable();phase='preparing';scope=value;
      try{value.assertCurrent();if(phase!=='preparing')throw unavailable();phase='prepared';}
      catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source integration preparation and cleanup failed',{cause:error});}throw error;}
    },
    start(){if(phase!=='prepared'||!bindings)throw unavailable();scope!.assertCurrent();phase='active';},
    async quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';if(phase==='quiescing')await drain();},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    routes(app:FastifyInstance){
      if(mounted||!bindings||phase==='stopped'||phase==='disposed')throw unavailable();mounted=true;
      mountC10SourceRoutes(app,()=>activation);
    },
  });
  routeActivations.set(platform,activation);return platform;
}
export type C10Integration=ReturnType<typeof createC10Integration>;

function mountC10SourceRoutes(app:FastifyInstance,current:()=>C10RouteActivation){
  const initial=current(),fixed=initial.bindings,connections=fixed.authorization.assembly.connections!,dispatched=new WeakMap<FastifyRequest,C10RouteActivation>();
  const activation=(request:FastifyRequest)=>{const value=dispatched.get(request);if(!value)throw unavailable();return value;};
  // Scoped Fastify hooks cannot capture unrelated feature routes.
  app.register(async child=>{
    child.addHook('onRequest',async request=>{const value=current();value.admit(request);dispatched.set(request,value);});
    child.addHook('onSend',async(request,reply,payload)=>{if(reply.statusCode<400)activation(request).assert(request);return payload;});
    child.addHook('onResponse',async request=>{dispatched.get(request)?.release(request);dispatched.delete(request);});
    child.addHook('onRequestAbort',async request=>{dispatched.get(request)?.release(request);dispatched.delete(request);});
    registerSourceRoutes(child,{sources:initial.sources,connections,credential:request=>activation(request).credential(request),sourceOwner:(request,id)=>activation(request).sourceOwner(request,id),
      evidenceReader:fixed.evidenceReader,layers:fixed.layers,ingress:fixed.capture.ingress,
      admission:{assertCurrent:request=>{activation(request).assert(request);},assertWritable:request=>{activation(request).writable(request);},
        sourceItem:(request,id,input)=>activation(request).sourceItem(request,id,input),sourceBatch:(request,id,inputs)=>activation(request).sourceBatch(request,id,inputs),
      },
    });
  });
}

/** Each activation owns a fresh platform; the route table dispatches to the current one. */
export function createC10IntegrationFactory(createPlatform:()=>C10Integration,registerRoutes?:(mount:(app:FastifyInstance)=>void)=>void){
  let current:C10Integration|undefined,mounted=false;
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createPlatform();
    const close=()=>{if(current===platform)current=undefined;return platform.close();};
    const abort=()=>{void close().catch(()=>{});};context.scope.signal.addEventListener('abort',abort,{once:true});
    context.scope.defer(async()=>{try{await close();}finally{context.scope.signal.removeEventListener('abort',abort);}});
    return {async prepare(){
      await platform.prepare(context.scope);current=platform;
      try{if(!mounted){mounted=true;registerRoutes?.(app=>mountC10SourceRoutes(app,()=>{const active=current;if(!active)throw unavailable();return routeActivations.get(active)!;}));}}
      catch(error){if(current===platform)current=undefined;throw error;}
    },start:platform.start,quiesce:platform.quiesce,stop:close,dispose:close};
  };
}
