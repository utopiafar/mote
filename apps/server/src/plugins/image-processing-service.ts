import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,PluginScope,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ModelSettings} from '@mote/shared/models';
import type {TokenUsage,UsageReceipt} from '@mote/shared';
import type {ConfigService} from '../config-service.js';
import type {FileAnalysis,FileProcessing} from '../file-processing.js';
import type {MaterialStore} from '../materials.js';
import type {MediaAssets} from '../media-assets.js';
import type {MediaRuntimeSettings} from '../media-configuration.js';
import type {ModelAgentFactory,ModelAgentIdentity} from '../model-agent.js';
import type {ModelProcessingAuthority} from '../model-processing-authority.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {UsageLedger} from '../usage.js';
import {ImageProcessing} from '../image-processing.js';
import {imageUnderstanding} from '../image-understanding.js';
import {modelConfiguration} from '../model-configuration.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';

/** C18C's image intake, OCR/understanding stages and their model receipts. */
export const imageProcessingServiceContribution={
  id:'image-processing-service',version:'1.0.0',surface:'data',runtime:'host',
  requires:[
    {kind:'host',id:'mote.vault-platform',version:'1.0.0'},
    {kind:'service',id:centralServices.execution.id,version:'1.0.0'},
    {kind:'service',id:centralServices.processing.id,version:'1.0.0'},
  ],
  provides:[{kind:'service' as const,id:centralServices.imageProcessing.id,apiVersion:centralServices.imageProcessing.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const imageProcessingServiceDeclaration={id:imageProcessingServiceContribution.id,apiVersion:'1'} as const;
/** Image recipes, handlers, routes and admitted work are activation-owned. */
export const imageProcessingServiceReplacement='hot' as const;

export type ImageProcessingPhase='created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed';
export type ImageProcessingPort=Pick<ImageProcessing,'view'|'detail'|'settings'|'save'|'configure'|'retry'|'cancel'|'cancellation'|'previewHistoricalOcr'|'historicalOcrTargets'|'processHistoricalOcr'>&{readonly phase:ImageProcessingPhase};

type ImageMeter=(...args:Parameters<UsageLedger['start']>)=>{
  run<T>(task:()=>Promise<T>):Promise<T>;
  update(tokens:TokenUsage):void;
  completed():UsageReceipt|undefined;
  failed(error:unknown):UsageReceipt|undefined;
};
export type ImageModelResolver=(settings:Parameters<FileAnalysis>[2])=>{settings:ModelSettings;identity:ModelAgentIdentity};

export interface ImageProcessingServiceDependencies {
  readonly store:ConstructorParameters<typeof ImageProcessing>[0];
  readonly processing:FileProcessing;
  readonly executor:ConstructorParameters<typeof ImageProcessing>[2];
  readonly configService?:ConfigService;
  readonly materials?:MaterialStore;
  readonly mediaAssets?:MediaAssets;
  readonly media?:Partial<MediaRuntimeSettings>;
  readonly modelAuthority?:ModelProcessingAuthority;
  readonly modelSettings:ModelSettingsStore;
  readonly resolveFileModel:ImageModelResolver;
  readonly factory:ModelAgentFactory;
  readonly admittedUsage:ImageMeter;
  /** Late-bound because the agent registry is assembled after processing. */
  readonly configuredFor?:(id:string)=>boolean;
  readonly probeOcr?:()=>Promise<boolean>;
  /** Image background model runs use their own trace context instead of the
   * interactive query runtime, so retain their events in the same log. */
  readonly diagnostics?:Pick<ServerDiagnostics,'agentTrace'|'requestId'>;
}
export interface ImageProcessingServiceBindings {readonly imageProcessing:ServiceBinding}
export interface ImageProcessingService extends PluginLifecycle {
  readonly port:ImageProcessingPort;
  /** Trusted assembly bridge for the existing APP/perception handle. */
  readonly perceptionForAssembly:ImageProcessing;
  prepare(scope?:Pick<PluginScope,'defer'>):Promise<void>;
  start():void;
  quiesce(reason?:StopReason):void;
  stop(reason?:StopReason):Promise<void>;
  dispose():Promise<void>;
  close():Promise<void>;
  /** One image-owned pass; the processing poll invokes the attached control. */
  tick():Promise<void>;
  bindAgent(configuredFor:(id:string)=>boolean):void;
}

const unavailable=()=>new StoreError('Image processing is unavailable',503);

/** Owns the image object, its understanding adapter and image recipes. Stop
 * closes the generation and detaches its file control so non-image work keeps
 * running; prepare after stop creates a fresh generation over the same profile. */
export function createImageProcessingService(dependencies:ImageProcessingServiceDependencies):ImageProcessingService {
  let phase:ImageProcessingPhase='created',images:ImageProcessing|undefined,removeRecipes:(()=>void)|undefined,closing:Promise<void>|undefined;
  let configuredFor=dependencies.configuredFor??(()=>false);
  const inflight=new Set<Promise<void>>();
  const readable=()=>{
    if(!images||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return images;
  };
  const writable=()=>{
    if(!images||phase!=='active')throw unavailable();
    return images;
  };
  const understanding=imageUnderstanding({
    factory:dependencies.factory,
    metered:async(settings,attribution,task)=>{
      const meter=dependencies.admittedUsage(settings.provider,settings.model,'image-understanding',{agentId:'image-understanding',moduleId:'images',skillId:null,...attribution});
      return meter.run(async()=>{try{const output=await task(meter.update);meter.completed();return output;}catch(error){meter.failed(error);throw error;}});
    },
    selection:service=>{
      const selected=dependencies.modelSettings.select('file'),resolved=dependencies.resolveFileModel({...dependencies.processing.currentSettings(),analysisModel:service}),settings=resolved.settings;
      const configuration=modelConfiguration(service?.id??selected.id,settings,dependencies.modelSettings.view().revision);
      return {identity:resolved.identity,fingerprint:configuration.fingerprint,configured:service?Boolean(service.apiKey||service.execution==='local'):configuredFor(selected.id),settings,
        receipt:{profileId:service?.id??selected.id,provider:settings.provider,model:settings.model,revision:dependencies.modelSettings.view().revision}};
    },
    onTrace:(event,context)=>{
      const diagnostics=dependencies.diagnostics;if(!diagnostics)return;
      diagnostics.agentTrace(event,{traceId:randomUUID(),requestId:diagnostics.requestId(),operation:'query',moduleId:'images',operationId:context.operationId,jobId:context.jobId,
        profileId:typeof context.selection.receipt.profileId==='string'?context.selection.receipt.profileId:context.selection.identity?.id,
        provider:context.selection.settings.provider,protocol:context.selection.settings.protocol,model:context.selection.settings.model});
    },
  });
  const track=(task:Promise<void>)=>{
    inflight.add(task);
    void task.finally(()=>{inflight.delete(task);}).catch(()=>{});
    return task;
  };
  const control:NonNullable<FileProcessing['imageControl']>=Object.freeze({
    owns:id=>Boolean(images?.owns(id)),
    prepare:()=>phase==='active'&&images?images.prepare():[],
    tick:()=>phase==='active'||phase==='quiescing'?images?track(images.tick()):Promise.resolve():Promise.resolve(),
    retry:(id,recompute,confirmUnknown)=>writable().retry(id,recompute,confirmUnknown),
    cancel:id=>writable().cancel(id),
    cancellation:id=>readable().cancellation(id),
    configurationChanged:()=>{if(images&&['prepared','active','quiescing'].includes(phase))images.configurationChanged();},
    mediaCallCurrent:call=>Boolean(images&&['prepared','active','quiescing'].includes(phase)&&images.mediaCallCurrent(call)),
  });
  const port:ImageProcessingPort=Object.freeze({
    get phase(){return phase;},
    view:()=>readable().view(),
    detail:id=>readable().detail(id),
    settings:()=>readable().settings(),
    save:raw=>writable().save(raw),
    configure:raw=>writable().configure(raw),
    retry:(id,recompute,confirmUnknown)=>writable().retry(id,recompute,confirmUnknown),
    cancel:id=>writable().cancel(id),
    cancellation:id=>readable().cancellation(id),
    previewHistoricalOcr:raw=>writable().previewHistoricalOcr(raw),
    historicalOcrTargets:raw=>readable().historicalOcrTargets(raw),
    processHistoricalOcr:raw=>writable().processHistoricalOcr(raw),
  });
  const removeImageRecipes=()=>{
    const remove=removeRecipes;removeRecipes=undefined;remove?.();
  };
  const disposeOwned=async()=>{
    const owned=images;images=undefined;
    if(dependencies.processing.imageControl===control)dependencies.processing.imageControl=undefined;
    try{await owned?.close();}
    finally{removeImageRecipes();}
  };
  const stop=async()=>{
    if(phase==='stopped'||phase==='disposed')return;
    if(phase==='created'){phase='stopped';return;}
    phase='quiescing';images?.quiesce();
    await Promise.allSettled([...inflight]);
    await disposeOwned();
    phase='stopped';
  };
  const close=()=>closing??=(async()=>{try{await stop();}finally{phase='disposed';}})();
  return Object.freeze({
    port,
    async prepare(){
      if(!['created','stopped'].includes(phase))throw unavailable();
      closing=undefined;
      try{
        // Recipes are a plugin contribution, not a file-processing side effect.
        // A duplicate definition rejects before any image generation starts.
        removeRecipes=dependencies.processing.installImageRecipes();
        images=new ImageProcessing(dependencies.store,dependencies.processing,dependencies.executor,{
          modelAuthority:dependencies.modelAuthority,configService:dependencies.configService,materials:dependencies.materials,
          mediaAssets:dependencies.mediaAssets,media:dependencies.media,understanding,
          ...(dependencies.probeOcr?{probeOcr:dependencies.probeOcr}:{}),
        });
        dependencies.processing.imageControl=undefined;
        phase='prepared';
      }catch(error){
        try{await disposeOwned();}
        catch(cleanup){throw new AggregateError([error,cleanup],'Image processing preparation and disposal failed',{cause:error});}
        phase='disposed';throw error;
      }
    },
    start(){
      if(phase!=='prepared'||!images)throw unavailable();
      dependencies.processing.imageControl=control;
      phase='active';
    },
    quiesce(_reason?:StopReason){
      if(phase!=='active')return;
      phase='quiescing';images?.quiesce();
    },
    stop,
    dispose:close,
    close,
    tick(){return control.tick();},
    bindAgent:(configured:(id:string)=>boolean)=>{configuredFor=configured;},
    get perceptionForAssembly(){return readable();},
  });
}
export type ImageProcessingPlatform=ReturnType<typeof createImageProcessingService>;

/** Stable pre-H14 image routes. A new activation replaces the current port
 * without mounting a second table; stopped or missing activations return 503. */
export function createImageProcessingRoutes(owner?:{readonly withMediaOwnerBatch?:<T>(ids:readonly string[],task:()=>T)=>Promise<T>;readonly withMediaOwnerIntent?:<T>(id:string,task:()=>T|Promise<T>)=>Promise<T>}){
  let current:ImageProcessingPort|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  const required=()=>{
    if(!current)throw unavailable();
    return current;
  };
  return Object.freeze({
    activate(port:ImageProcessingPort){current=port;},
    deactivate(){current=undefined;},
    mount(app:FastifyInstance){
      if(mounted.has(app))throw new StoreError('Image processing routes are already installed',409);
      mounted.add(app);
      const withOwnerIntent=owner?.withMediaOwnerIntent??(async(_id,task)=>task()),withOwnerBatch=owner?.withMediaOwnerBatch??(async(_ids,task)=>task());
      app.register(async child=>{
        child.addHook('onRequest',async(request,reply)=>{
          const write=['POST','PUT','PATCH','DELETE'].includes(request.method);
          if(write?current?.phase!=='active':!current||!['prepared','active','quiescing'].includes(current.phase))return reply.code(503).send({error:'feature_unavailable'});
        });
        child.get('/api/perception',async()=>required().view());
        child.get('/api/images/:id',async req=>required().detail(z.object({id:z.string().uuid()}).parse(req.params).id));
        child.post('/api/images/:id/cancel',async req=>required().cancel(z.object({id:z.string().uuid()}).parse(req.params).id));
        child.post('/api/images/:id/retry',async req=>{const {mode,confirmUnknown}=z.object({mode:z.enum(['complete','recompute']).default('complete'),confirmUnknown:z.boolean().default(false)}).strict().parse(req.body??{});const id=z.object({id:z.string().uuid()}).parse(req.params).id;return withOwnerIntent(id,()=>required().retry(id,mode==='recompute',confirmUnknown));});
        child.put('/api/perception',async req=>required().save(req.body));
        child.post('/api/perception/:id/retry',async req=>{const {id}=z.object({id:z.string().uuid()}).parse(req.params);z.object({kind:z.literal('ocr')}).strict().parse(req.body);return withOwnerIntent(id,()=>required().retry(id));});
        child.post('/api/perception/ocr/historical-preview',async req=>required().previewHistoricalOcr(req.body??{}));
        child.post('/api/perception/ocr/historical-process',async req=>withOwnerBatch(required().historicalOcrTargets(req.body),()=>required().processHistoricalOcr(req.body)));
      });
    },
  });
}
export type ImageProcessingRoutes=ReturnType<typeof createImageProcessingRoutes>;

export function createImageProcessingServiceFactory(platform:ImageProcessingService,onStarted?:(bindings:ImageProcessingServiceBindings)=>void,onStopped?:()=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:()=>platform.prepare(context.scope),
      start(){
        platform.start();
        const imageProcessing=context.provide(imageProcessingServiceContribution.id,centralServices.imageProcessing,platform.port);
        onStarted?.({imageProcessing});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),
      stop:async(reason:StopReason)=>{try{await platform.stop(reason);}finally{onStopped?.();}},
      dispose:async()=>{try{await platform.dispose();}finally{onStopped?.();}},
    };
  };
}

/** Same-domain trusted handoff from the processing assembly to the existing
 * perception return value. The plugin, not the assembly, owns construction. */
const assemblyServices=new WeakMap<FileProcessing,ImageProcessingService>();
export function registerImageProcessingServiceForAssembly(service:ImageProcessingService,processing:FileProcessing){assemblyServices.set(processing,service);return service;}
export function imageProcessingServiceForAssembly(processing:FileProcessing){
  const service=assemblyServices.get(processing);if(!service)throw unavailable();return service;
}
