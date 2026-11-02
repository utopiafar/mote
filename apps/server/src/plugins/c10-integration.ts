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
import type {LayersReadModel} from '../layers-read-model.js';
import type {ConnectionCredential} from '../connections.js';
import {registerSourceRoutes} from '../source-routes.js';
import type {AuthorizationPlatform} from './authorization-platform.js';
import type {CaptureIntakePlatform} from './capture-intake.js';
import {centralServices,type RequestAuthority} from './central-contracts.js';

export interface C10IntegrationDependencies {
  readonly store:Store;
  readonly runtime:SourcePipelineRuntime;
  readonly memoryWork:MaterialMemoryWork;
  /** Trusted ownership transfer of source admission only; database is borrowed. */
  readonly sources?:SourceStore;
}
export interface C10SourceRouteBindings {
  readonly authorization:AuthorizationPlatform;
  readonly capture:CaptureIntakePlatform;
  readonly files:FileStore;
  readonly evidenceReader:SourceFileCatalogRead;
  readonly layers:Pick<LayersReadModel,'summary'>;
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

/** Owns one source repository and source routes. Capture, Notes, Devices,
 * runtime, MemoryWork, C04 and the vault retain their independent owners. */
export function createC10Integration(dependencies:C10IntegrationDependencies){
  const {store,runtime,memoryWork}=dependencies;
  if(runtime.store!==store||runtime.memoryWork!==memoryWork)throw new StoreError('Source integration repository mismatch',503);
  const sources=dependencies.sources??new SourceStore(store,runtime,memoryWork.inputs);
  if(sources.store!==store||sources.pipelines!==runtime||!sources.usesMemoryInputs(memoryWork.inputs))throw new StoreError('Source integration repository mismatch',503);
  const initialDrain=sources.quiesce();
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created',scope:PluginScope|undefined,bindings:C10SourceRouteBindings|undefined,closing:Promise<void>|undefined,mounted=false;
  const requests=new Map<FastifyRequest,{pin:RequestAuthority;credential?:ConnectionCredential}>();
  const release=(request:FastifyRequest)=>{const entry=requests.get(request);if(entry){requests.delete(request);bindings!.authorization.releaseRequest(entry.pin);}};
  const assertRequest=(request:FastifyRequest)=>{
    if(phase!=='active'&&phase!=='quiescing')throw unavailable();scope!.assertCurrent();
    const entry=requests.get(request);if(!entry)throw new StoreError('Owner authorization is required',401);
    bindings!.authorization.requests.assertCurrent(entry.pin);return entry;
  };
  const close=()=>{
    if(closing)return closing;phase='stopped';for(const request of requests.keys())release(request);
    return closing=sources.close().finally(()=>{phase='disposed';});
  };
  return Object.freeze({
    /** The sole private root bridge for C10A/C04/C11/C12. Not a service value. */
    get sourcesForAssembly(){if(phase==='stopped'||phase==='disposed')throw unavailable();return sources;},
    bindRoutes(value:C10SourceRouteBindings){
      if(bindings||phase!=='created'&&phase!=='prepared')throw unavailable();
      if(value.files.store!==store||!value.authorization.assembly.connections?.usesStore(store))throw new StoreError('Source authorization repository mismatch',503);
      bindings=value;
    },
    async prepare(value:PluginScope){
      if(phase!=='created')throw unavailable();phase='preparing';scope=value;
      try{value.assertCurrent();await initialDrain;value.assertCurrent();if(phase!=='preparing')throw unavailable();phase='prepared';}
      catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Source integration preparation and cleanup failed',{cause:error});}throw error;}
    },
    start(){if(phase!=='prepared'||!bindings)throw unavailable();scope!.assertCurrent();sources.start();phase='active';},
    async quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';await sources.quiesce();}},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    routes(app:FastifyInstance){
      if(mounted||!bindings||phase==='stopped'||phase==='disposed')throw unavailable();mounted=true;
      const fixed=bindings,connections=fixed.authorization.assembly.connections!;
      // Scoped Fastify hooks cannot capture unrelated feature routes.
      app.register(async child=>{
        child.addHook('onRequest',async request=>{
          if(phase!=='active')throw unavailable();scope!.assertCurrent();
          const pin=fixed.authorization.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin,signal:scope!.signal});
          const credential=connections.authenticate(request.headers.authorization);
          requests.set(request,{pin,...(credential&&!connections.isOwner(credential)?{credential:Object.freeze({...credential})}:{})});
        });
        child.addHook('onSend',async(request,reply,payload)=>{if(reply.statusCode<400)assertRequest(request);return payload;});
        child.addHook('onResponse',async request=>{release(request);});
        const sourceOwner=(request:FastifyRequest,id:string)=>{const entry=assertRequest(request);if(entry.credential)fixed.authorization.requests.assertOwnSource(entry.pin,id);};
        registerSourceRoutes(child,{sources,connections,credential:request=>assertRequest(request).credential,sourceOwner,
          evidenceReader:fixed.evidenceReader,layers:fixed.layers,ingress:fixed.capture.ingress,
          admission:{assertCurrent:request=>{assertRequest(request);},
            sourceItem:(request,id,input)=>{const {pin}=assertRequest(request);return fixed.authorization.withSource(pin,id,input,()=>fixed.capture.ports.sourceIntake.sourceItem(id,input,fixed.authorization.commits.capture()));},
            sourceBatch:(request,id,inputs)=>{const {pin}=assertRequest(request);return fixed.authorization.withSource(pin,id,inputs,()=>fixed.capture.ports.sourceIntake.sourceBatch(id,inputs,fixed.authorization.commits.capture()));},
          },
        });
      });
    },
  });
}
export type C10Integration=ReturnType<typeof createC10Integration>;
/** Lifecycle only; no child owner, raw repository or commit issuer is published. */
export function createC10IntegrationFactory(platform:C10Integration,registerRoutes?:(platform:C10Integration)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    const abort=()=>{void platform.close().catch(()=>{});};context.scope.signal.addEventListener('abort',abort,{once:true});
    context.scope.defer(async()=>{try{await platform.close();}finally{context.scope.signal.removeEventListener('abort',abort);}});
    return {async prepare(){await platform.prepare(context.scope);registerRoutes?.(platform);},start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.close};
  };
}
