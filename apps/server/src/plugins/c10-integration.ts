import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError} from '../store.js';
import type {SourceFileCatalogRead} from '../evidence-read-ports.js';
import {LayersReadModel} from '../layers-read-model.js';
import type {ConnectionCredential} from '../connections.js';
import {registerSourceRoutes} from '../source-routes.js';
import type {CapturePort} from '../capture-storage.js';
import type {C10AuthorizationPort,SourceControlPort,SourceIdentityPort} from '../source-runtime-storage.js';
import {centralServices,type RequestAuthority} from './central-contracts.js';

export interface C10IntegrationDependencies {
  readonly sources:SourceControlPort;
  readonly identity:SourceIdentityPort;
  readonly authorization:C10AuthorizationPort;
  readonly capture:CapturePort;
  readonly fileCatalog:(sourceId:string,args:Parameters<SourceFileCatalogRead['fileCatalog']>[1])=>ReturnType<SourceFileCatalogRead['fileCatalog']>;
  readonly memoryCount:()=>number;
}
export interface C10SourceRouteBindings {
  readonly authorization:C10AuthorizationPort;
  readonly capture:CapturePort;
  readonly fileCatalog:(sourceId:string,args:Parameters<SourceFileCatalogRead['fileCatalog']>[1])=>ReturnType<SourceFileCatalogRead['fileCatalog']>;
}
interface C10BoundSourceRoutes extends C10SourceRouteBindings {
  readonly layers:LayersReadModel;
}
/** No ordinary sources service: the shared source repository still includes an unguarded
 * register method. Requests use the existing owner/collector route policy. */
export const c10IntegrationContribution={id:'source-integration',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'},{kind:'service',id:centralServices.sourceIntake.id,version:'1.0.0'}],provides:[]} as const satisfies ManifestContribution;
export const c10IntegrationDeclaration={id:c10IntegrationContribution.id,apiVersion:'1'} as const;
// The authorization, file and capture owners retain this exact repository; replacement restarts
// the trusted assembly rather than leaving those owners on a detached instance.
export const c10IntegrationReplacement='restart' as const;
const unavailable=()=>new StoreError('Source integration is unavailable',503);

interface C10RouteActivation {
  readonly bindings:C10BoundSourceRoutes;
  readonly sources:SourceControlPort;
  admit(request:FastifyRequest):void;
  assert(request:FastifyRequest):void;
  release(request:FastifyRequest):void;
  credential(request:FastifyRequest):ConnectionCredential|undefined;
  sourceOwner(request:FastifyRequest,id:string):void;
  writable(request:FastifyRequest):void;
  sourceItem(request:FastifyRequest,id:string,input:unknown):ReturnType<C10AuthorizationPort['sourceItem']>;
  sourceBatch(request:FastifyRequest,id:string,inputs:unknown):ReturnType<C10AuthorizationPort['sourceBatch']>;
}
const routeActivations=new WeakMap<C10Integration,C10RouteActivation>();

/** Owns source routes over one shared repository. Capture, Notes, Devices,
 * runtime, MemoryWork, authorization and the vault retain their independent owners. */
export function createC10Integration(dependencies:C10IntegrationDependencies){
  const {sources,identity,authorization,capture,fileCatalog,memoryCount}=dependencies;
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
    bindings!.authorization.assertRequest(entry.pin);return entry;
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
      const fixed=activation.bindings;
      const pin=fixed.authorization.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin,signal:scope!.signal});
      const credential=fixed.authorization.authenticate(request.headers.authorization);
      requests.set(request,{pin,...(credential&&!fixed.authorization.isOwner(credential)?{credential:Object.freeze({...credential})}:{})});
    },
    assert:assertRequest,release,credential:request=>assertRequest(request).credential,
    sourceOwner(request,id){const entry=assertRequest(request);if(entry.credential)activation.bindings.authorization.assertOwnSource(entry.pin,id);},
    writable(request){writable(request);},
    sourceItem(request,id,input){const {pin}=writable(request),fixed=activation.bindings;if(!sources.getSource(id).enabled)throw new StoreError('Source is paused',409);return track(fixed.authorization.withSource(pin,id,input,()=>fixed.authorization.sourceItem(id,input,fixed.authorization.captureCommit())));},
    sourceBatch(request,id,inputs){const {pin}=writable(request),fixed=activation.bindings;if(!sources.getSource(id).enabled)throw new StoreError('Source is paused',409);return track(fixed.authorization.withSource(pin,id,inputs,()=>fixed.authorization.sourceBatch(id,inputs,fixed.authorization.captureCommit())));},
  };
  const platform=Object.freeze({
    /** The sole private root bridge for source integration, authorization, files and connectors. Not a service value. */
    get sourcesForAssembly(){if(phase!=='created')throw unavailable();return sources;},
    bindRoutes(value:C10SourceRouteBindings){
      if(bindings||phase!=='created'&&phase!=='prepared')throw unavailable();
      identity.assertBindings({sources,capture:value.capture,authorization:value.authorization});
      bindings={authorization:value.authorization,capture:value.capture,fileCatalog:value.fileCatalog,layers:new LayersReadModel(sources,memoryCount)};
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
  const initial=current(),fixed=initial.bindings,dispatched=new WeakMap<FastifyRequest,C10RouteActivation>();
  const activation=(request:FastifyRequest)=>{const value=dispatched.get(request);if(!value)throw unavailable();return value;};
  const connections=Object.freeze({
    authenticate:(header:string|undefined)=>fixed.authorization.authenticate(header),
    isOwner:(credential:ConnectionCredential)=>fixed.authorization.isOwner(credential),
    assertActive:(credential:ConnectionCredential)=>fixed.authorization.assertActive(credential),
    assertOwnDevice:(credential:ConnectionCredential,input:{deviceId:string})=>fixed.authorization.assertOwnDevice(credential,input),
    assertPlatform:(credential:ConnectionCredential,platform:unknown)=>fixed.authorization.assertPlatform(credential,platform),
    assertOwnSource:(credential:ConnectionCredential,sourceId:string)=>fixed.authorization.assertOwnCredentialSource(credential,sourceId),
  });
  // Scoped Fastify hooks cannot capture unrelated feature routes.
  app.register(async child=>{
    child.addHook('onRequest',async request=>{const value=current();value.admit(request);dispatched.set(request,value);});
    child.addHook('onSend',async(request,reply,payload)=>{if(reply.statusCode<400)activation(request).assert(request);return payload;});
    child.addHook('onResponse',async request=>{dispatched.get(request)?.release(request);dispatched.delete(request);});
    child.addHook('onRequestAbort',async request=>{dispatched.get(request)?.release(request);dispatched.delete(request);});
    registerSourceRoutes(child,{sources:initial.sources,connections,credential:request=>activation(request).credential(request),sourceOwner:(request,id)=>activation(request).sourceOwner(request,id),
      fileCatalog:fixed.fileCatalog,layers:fixed.layers,
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
