import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Context,Plugin} from '@deepseek-ai/cordis';
import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type ServiceContract} from '@mote/plugin-api/contracts';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryAgent} from '../query-agent.js';
import type {CaptureRecord,TokenUsage,UsageReceipt} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {mediaConfigDomain,serverConfigDomain,storageConfigDomain,type ConfigurationBootstrap} from '../config.js';
import type {MediaConfiguration} from '../media-configuration.js';
import type {ConfigService} from '../config-service.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import {StoreError,type Store} from '../store.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {MaterialStore} from '../materials.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {SourceContextStore} from '../source-context.js';
import type {FileStore} from '../files.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {ModelAgentFactory,ModelAgentIdentity} from '../model-agent.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import {captureModelIdentity,type ModelAuthorizationHost} from '../model-authorization-host.js';
import {modelConfiguration} from '../model-configuration.js';
import {requestLocale} from '../i18n.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from '../source-context-lineage.js';
import type {ModelProcessingAuthority} from '../model-processing-authority.js';
import type {MediaAssets} from '../media-assets.js';
import type {CentralDomainPlugin,bootstrapCentral} from '../bootstrap.js';
import {createDomainActivations} from '../domain-activation.js';
import {createMediaAssetsService,mediaAssetsServiceContribution,mediaAssetsServiceDeclaration,mediaAssetsServiceReplacement,lazyTarget,type LazyTarget,type MediaAssetsService} from '../plugins/media-assets-service.js';
import {createOcrAsrReadiness,ocrAsrReadinessContribution,ocrAsrReadinessDeclaration,ocrAsrReadinessForAssembly,ocrAsrReadinessReplacement,registerOcrAsrReadinessForAssembly,type MediaReadinessPort,type OcrAsrReadiness,type OcrAsrReadinessDependencies} from '../plugins/ocr-asr-readiness.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {vaultStorageRoutes} from '../plugins/vault-storage-routes.js';
import {createProcessingServices,processingServicesContribution,processingServicesDeclaration,processingServicesReplacement,type ProcessingServices} from '../plugins/processing-services.js';
import {createImageProcessingRoutes,createImageProcessingService,imageProcessingServiceContribution,imageProcessingServiceDeclaration,imageProcessingServiceForAssembly,imageProcessingServiceReplacement,registerImageProcessingServiceForAssembly,type ImageProcessingService} from '../plugins/image-processing-service.js';
import type {FileAnalysis,FileProcessing,TranscriptionProvider} from '../file-processing.js';
import type {PluginCenter} from '../plugin-center.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../plugins/local-image-processing.js';
import {centralServices} from '../plugins/central-contracts.js';

/** Admitted usage accounting shared with query/import metering: the ledger
 * receipt starts lazily inside the admitted task. */
export type AdmittedUsageMeter=(...args:Parameters<UsageLedger['start']>)=>{
  run<T>(task:()=>Promise<T>):Promise<T>;
  update(tokens:TokenUsage):void;
  completed():UsageReceipt|undefined;
  failed(error:unknown):UsageReceipt|undefined;
};

/** Resolves the file-analysis model selection; shared by the file and image
 * processing wiring in this assembly. */
export type FileModelResolver=(settings:Parameters<FileAnalysis>[2])=>{settings:ModelSettings;identity:ModelAgentIdentity};

type MediaLazyState={readonly assets:LazyTarget<MediaAssets>;readonly preparation:LazyTarget<MediaReadinessPort>;readonly backgroundWorker?:boolean;readonly prepare?:OcrAsrReadinessDependencies['prepare']};
const mediaLazy=new WeakMap<object,MediaLazyState>();

/** Private constructor capabilities. The consumer activation opens them only
 * after its own selection and exact binding requirements are satisfied. */
export interface MediaAssetsServiceInputs {open():MediaAssetsService}
export interface OcrAsrReadinessInputs {open():OcrAsrReadiness}
export interface ProcessingServicesInputs {open():ProcessingServices}
export interface ImageProcessingServiceInputs {open():ImageProcessingService}
export const mediaAssetsServiceInputsContract=serviceContract<MediaAssetsServiceInputs>('mote.central.media-assets-service-inputs','1');
export const ocrAsrReadinessInputsContract=serviceContract<OcrAsrReadinessInputs>('mote.central.ocr-asr-readiness-inputs','1');
export const processingServicesInputsContract=serviceContract<ProcessingServicesInputs>('mote.central.processing-services-inputs','1');
export const imageProcessingServiceInputsContract=serviceContract<ImageProcessingServiceInputs>('mote.central.image-processing-service-inputs','1');
export const mediaAssetsServiceInputsContribution={id:'media-assets-service-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:mediaAssetsServiceInputsContract.id,apiVersion:mediaAssetsServiceInputsContract.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const mediaAssetsServiceInputsDeclaration={id:mediaAssetsServiceInputsContribution.id,apiVersion:'1'} as const;
export const ocrAsrReadinessInputsContribution={id:'ocr-asr-readiness-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:ocrAsrReadinessInputsContract.id,apiVersion:ocrAsrReadinessInputsContract.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const ocrAsrReadinessInputsDeclaration={id:ocrAsrReadinessInputsContribution.id,apiVersion:'1'} as const;
export const processingServicesInputsContribution={id:'processing-services-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:processingServicesInputsContract.id,apiVersion:processingServicesInputsContract.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const processingServicesInputsDeclaration={id:processingServicesInputsContribution.id,apiVersion:'1'} as const;
export const imageProcessingServiceInputsContribution={id:'image-processing-service-inputs',version:'1.0.0',surface:'data',runtime:'host',
  provides:[{kind:'service',id:imageProcessingServiceInputsContract.id,apiVersion:imageProcessingServiceInputsContract.apiVersion,cardinality:'single'}],
} as const satisfies ManifestContribution;
export const imageProcessingServiceInputsDeclaration={id:imageProcessingServiceInputsContribution.id,apiVersion:'1'} as const;

/** Declared build-time domain plugins the media and processing assembly wires;
 * the distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:mediaAssetsServiceInputsContribution,declaration:mediaAssetsServiceInputsDeclaration,replacement:'restart'},
  {contribution:ocrAsrReadinessInputsContribution,declaration:ocrAsrReadinessInputsDeclaration,replacement:'restart'},
  {contribution:processingServicesInputsContribution,declaration:processingServicesInputsDeclaration,replacement:'restart'},
  {contribution:imageProcessingServiceInputsContribution,declaration:imageProcessingServiceInputsDeclaration,replacement:'restart'},
  {contribution:processingServicesContribution,declaration:processingServicesDeclaration,replacement:processingServicesReplacement},
  {contribution:mediaAssetsServiceContribution,declaration:mediaAssetsServiceDeclaration,replacement:mediaAssetsServiceReplacement},
  {contribution:ocrAsrReadinessContribution,declaration:ocrAsrReadinessDeclaration,replacement:ocrAsrReadinessReplacement},
  {contribution:imageProcessingServiceContribution,declaration:imageProcessingServiceDeclaration,replacement:imageProcessingServiceReplacement},
]);

export interface MediaAssemblyDependencies {
  readonly bootstrap:ConfigurationBootstrap;
  readonly store:Store;
  readonly configService:ConfigService;
  readonly resources:ServerResources;
  readonly backgroundWorker?:boolean;
  readonly prepareMediaRuntime?:OcrAsrReadinessDependencies['prepare'];
}

/** Media assets remain available to the later processing assembly. C18B is
 * constructed here but prepared, started and closed only by its host factory. */
export function assembleMedia(dependencies:MediaAssemblyDependencies){
  const {bootstrap,store,configService,resources}=dependencies;
  const selected=configService.current(mediaConfigDomain),media={...selected,modelDirectory:selected.modelDirectory?resolve(bootstrap.baseDir,selected.modelDirectory):join(store.directory,'media-models')};
  const mediaAssets=lazyTarget<MediaAssets>('Media assets');
  const mediaPreparation=lazyTarget<MediaReadinessPort>('Media preparation');
  mediaLazy.set(mediaAssets.proxy,{assets:mediaAssets,preparation:mediaPreparation,backgroundWorker:dependencies.backgroundWorker,prepare:dependencies.prepareMediaRuntime});
  return Object.freeze({mediaAssets:mediaAssets.proxy,mediaPreparation:mediaPreparation.proxy,media});
}

/** Bind the existing optional intake plugin to the one control and media owner. */
export function assembleLocalImages({plugins,mediaAssets,processing,media,usage}:{plugins:PluginCenter;mediaAssets:MediaAssets;processing:FileProcessing;media:MediaConfiguration;usage:UsageLedger}){
  const readiness=ocrAsrReadinessForAssembly(mediaAssets).port;
  const local=createLocalImageProcessing({
    desired:()=>plugins.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE)?.desired,
    modelStatus:async()=>{const value=await readiness.status('local-image');return {...mediaAssets.status('local-image'),runtimeReady:value.runtimeReady};},
    createWorker:signal=>({
      prepare(){},
      async start(){
        let value=await readiness.start('local-image',false);
        while(!value.runtimeReady){
          signal.throwIfAborted();
          if(['failed','cancelled','unsupported'].includes(value.state))throw new StoreError('Local image worker is unavailable',503);
          await delay(100,undefined,{signal});value=await readiness.status('local-image');
        }
      },
      quiesce(){},async stop(){await readiness.stop('local-image');},dispose(){},
    }),
  });
  plugins.registerBuild(local.build);
  if(!plugins.control.build(LOCAL_IMAGE_PROCESSING_INSTANCE))plugins.control.saveBuild({id:LOCAL_IMAGE_PROCESSING_INSTANCE,packageId:localImageProcessingSelection.packageId,
    installationId:randomUUID(),revision:1,desired:null,retired:false,observed:'stopped',blockers:[],operationId:'builtin-local-image'});
  imageProcessingServiceForAssembly(processing).bindLocalImages({selection:local.selection,media,usage});
  return local.port;
}

export interface ProcessingAssemblyDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Store;
  readonly media:MediaConfiguration;
  readonly configService:ConfigService;
  readonly diagnostics:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly backendContext:Context;
  readonly resources:ServerResources;
  readonly materials:MaterialStore;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly files:FileStore;
  readonly sourceContexts:SourceContextStore;
  readonly mediaAssets:MediaAssets;
  readonly archivedFiles:import('../archived-files.js').ArchivedFileStore;
  readonly evidenceReader:import('../evidence-reader.js').EvidenceReader;
  readonly indexer:import('../plugins/central-contracts.js').RetrievalIndex;
  readonly withMediaOwnerBatch:<T>(ids:readonly string[],task:()=>T)=>Promise<T>;
  readonly withMediaOwnerIntent:<T>(id:string,task:()=>Promise<T>|T)=>Promise<T>;
  readonly plugins?:readonly Plugin[];
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly modelSettings:ModelSettingsStore;
  readonly factory:ModelAgentFactory;
  readonly admittedUsage:AdmittedUsageMeter;
  readonly transcriptionProvider?:TranscriptionProvider;
}

/** ProcessingRuntime, the media work authority and FileProcessing, plus their
 * close hooks. */
export async function assembleProcessing(dependencies:ProcessingAssemblyDependencies){
  const {bootstrap,store,media,configService,diagnostics,executor,backendContext,resources,materials,sourcePipelines,files,sourceContexts,mediaAssets,archivedFiles,evidenceReader,indexer,withMediaOwnerBatch,withMediaOwnerIntent,modelAuthorization,modelAuthorizationHost,modelSettings,factory,admittedUsage}=dependencies;
  const mediaModelAuthority:ModelProcessingAuthority=async(request,signal,task)=>{
    const original=captureModelIdentity(request.captureId);
    const execute=async(authorizedSignal:AbortSignal)=>{
      const assertCurrent=()=>{
        authorizedSignal.throwIfAborted();modelAuthorization.assertCurrent(request.connection);
        if(!store.isCurrentEvidence(request.captureId))throw new StoreError('Media original is no longer available',409);
        const records=store.evidence([request.captureId]);if(!records.length)throw new StoreError('Media original is unavailable',409);
        modelAuthorization.assertDisclosure(records.map(record=>({sourceId:record.provenance?.sourceId??'device:'+record.deviceId})));
      };
      assertCurrent();const result=await task(authorizedSignal,assertCurrent);assertCurrent();return result;
    };
    if(request.ownerIntentId){modelAuthorization.assertOwnerIntent(request.ownerIntentId,original);return modelAuthorization.run(request.ownerIntentId,execute,signal);}
    // All stages of this immutable original share one admitted media work,
    // including a later summary. Retry cannot mint a new trigger.
    return modelAuthorizationHost.automatic('automatic-media:'+request.captureId,'file',[original],execute,signal);
  };
  mediaModelAuthority.ownerIntent=id=>modelAuthorization.ownerIntent(captureModelIdentity(id));
  mediaModelAuthority.deniedOriginal=id=>modelAuthorization.deniedOriginal(captureModelIdentity(id));
  const resolveFileModel:FileModelResolver=settings=>{
    const profile=modelSettings.select('file');
    let selected=profile.settings;
    const identity:ModelAgentIdentity=settings.analysisModel?{kind:'file-service',id:settings.analysisModel.id}:{kind:'profile',id:profile.id};
    if(settings.analysisModel){
      const m=settings.analysisModel;
      selected={...selected,provider:'custom',protocol:'openai-completions',baseUrl:m.endpoint,model:m.model,apiKey:m.apiKey??'',headers:{},extraBody:{},allowUnauthenticatedLocal:m.execution==='local',reasoningEffort:'auto',serviceTier:undefined};
    }
    return {settings:structuredClone(selected),identity};
  };
  const analyzeFile:FileAnalysis=async(records,prompt,settings,signal,host,validateOutput)=>{
    const currentRecords=()=>records.map(record=>({...record,...(record.provenance?{attributionContext:materials.contextForEvidence(record as CaptureRecord)}:{})}));
    const scoped:ContextReader={search:async()=>currentRecords(),timeline:async args=>{
      const offset=args.cursor===undefined?0:Number(args.cursor);if(!Number.isSafeInteger(offset)||offset<0||offset>records.length)throw new StoreError('Invalid file analysis cursor');
      const limit=Math.min(100,Math.max(1,args.limit??8)),items=currentRecords().slice(offset,offset+limit);
      return {items,nextCursor:offset+items.length<records.length?String(offset+items.length):null};
    },evidence:async args=>currentRecords().filter(r=>args.ids.includes(r.id)),activity:async()=>({}),devices:async()=>[]};
    const resolved=settings.modelSnapshot?{settings:settings.modelSnapshot,identity:settings.modelIdentity}:resolveFileModel(settings);
    if(!resolved.identity)throw new StoreError('File model snapshot identity is missing',409);
    const selected=resolved.settings,identity=resolved.identity;
    const meter=admittedUsage(selected.provider,selected.model,'file-analysis',{agentId:'file-analysis',moduleId:'files',skillId:null,...host});
    let model:QueryAgent|undefined;
    const request:QueryInput={question:prompt,language:requestLocale.getStore()??'zh-CN',signal,traceContext:host,onUsage:meter.update,validateOutput,
      onSourceContextDependencies:pins=>{
        const current=combineSourceContextDependencies([request.contextSourceContextDependencies,pins]);
        assertSourceContextDependencies(sourceContexts,current);request.contextSourceContextDependencies=current;
      },
    };
    try{model=await factory(selected,scoped,undefined,identity);const result=await meter.run(()=>model!.query(request));
      const pins=combineSourceContextDependencies([request.contextSourceContextDependencies,result.sourceContextDependencies]);
      assertSourceContextDependencies(sourceContexts,pins);
      return {...result,...(pins.length?{sourceContextDependencies:pins}:{}),usage:meter.completed()};}
    catch(error){meter.failed(error);throw error;}finally{await model?.close();}
  };
  const semanticFingerprint=()=>{const selected=modelSettings.select('memory');return modelConfiguration(selected.id,selected.settings,modelSettings.view().revision).fingerprint;};
  const mediaState=mediaLazy.get(mediaAssets);
  if(!mediaState)throw new StoreError('Media assembly state is unavailable',503);
  const mediaAssetsSelected=bootstrap.selectsFeature('mote.media')&&bootstrap.selectsPlugin(mediaAssetsServiceContribution.id);
  const readinessSelected=bootstrap.selectsFeature('mote.media')&&bootstrap.selectsPlugin(ocrAsrReadinessContribution.id);
  const processingSelected=bootstrap.selectsFeature('mote.processing')&&bootstrap.selectsPlugin(processingServicesContribution.id);
  const imageSelected=bootstrap.selectsFeature('mote.media')&&bootstrap.selectsPlugin(imageProcessingServiceContribution.id);
  if(!mediaAssetsSelected)throw new StoreError('Media assets domain is not selected',503);
  if(!readinessSelected)throw new StoreError('OCR/ASR readiness domain is not selected',503);
  if(!processingSelected)throw new StoreError('Processing domain is not selected',503);
  if(!imageSelected)throw new StoreError('Media image domain is not selected',503);
  if(!bootstrap.selectsPlugin(mediaAssetsServiceInputsContribution.id)||!bootstrap.selectsPlugin(ocrAsrReadinessInputsContribution.id)||!bootstrap.selectsPlugin(processingServicesInputsContribution.id)||!bootstrap.selectsPlugin(imageProcessingServiceInputsContribution.id))throw new StoreError('Media processing input provider is not selected',503);
  const imageRoutes=createImageProcessingRoutes({withMediaOwnerBatch,withMediaOwnerIntent});
  let mediaAssetsService:MediaAssetsService|undefined,readinessService:OcrAsrReadiness|undefined,platform:ProcessingServices|undefined,imageService:ImageProcessingService|undefined;
  // The executable descriptors stay here, next to the real input factories.
  // The pinned distribution carries the same contributions/declarations; the
  // local selected-domain loader installs only chosen owners into the same PluginHost.
  const domains=createDomainActivations(bootstrap.host,[
    {contribution:mediaAssetsServiceContribution,declaration:mediaAssetsServiceDeclaration,replacement:mediaAssetsServiceReplacement,activation:{
      featureId:'mote.media',requires:{inputs:{provider:mediaAssetsServiceInputsContribution.id,service:mediaAssetsServiceInputsContract}},
      async create(context,bindings){
        const input=await context.services.acquire(mediaAssetsServiceInputsContract,bindings.inputs!);context.scope.defer(()=>input.release());
        const service=input.value.open();mediaAssetsService=service;
        return {prepare:service.prepare.bind(service),start(){service.start();mediaState.assets.set(service.assetsForAssembly);const binding=context.provide(mediaAssetsServiceContribution.id,centralServices.mediaAssetsRead,service.assetsRead);bootstrap.registerDomainService(binding);},quiesce:reason=>service.quiesce(reason),stop:reason=>service.stop(reason),dispose:()=>service.dispose(),route:{id:'mote.media',mount(){}}};
      }}},
    {contribution:ocrAsrReadinessContribution,declaration:ocrAsrReadinessDeclaration,replacement:ocrAsrReadinessReplacement,activation:{
      featureId:'mote.media',requires:{inputs:{provider:ocrAsrReadinessInputsContribution.id,service:ocrAsrReadinessInputsContract}},
      async create(context,bindings){
        const input=await context.services.acquire(ocrAsrReadinessInputsContract,bindings.inputs!);context.scope.defer(()=>input.release());
        const service=input.value.open();readinessService=service;mediaState.preparation.set(service.port);
        registerOcrAsrReadinessForAssembly(service,mediaAssets);
        return {prepare:service.prepare.bind(service),start(){service.start();const binding=context.provide(ocrAsrReadinessContribution.id,centralServices.mediaReadiness,service.port);bootstrap.registerDomainService(binding);},quiesce:reason=>service.quiesce(reason),stop:reason=>service.stop(reason),dispose:()=>service.dispose(),route:{id:'mote.media',mount(){}}};
      }}},
    {contribution:processingServicesContribution,declaration:processingServicesDeclaration,replacement:processingServicesReplacement,activation:{
      featureId:'mote.processing',requires:{inputs:{provider:processingServicesInputsContribution.id,service:processingServicesInputsContract}},
      async create(context,bindings){
        const input=await context.services.acquire(processingServicesInputsContract,bindings.inputs!);context.scope.defer(()=>input.release());
        const service=input.value.open();platform=service;
        return {prepare:service.prepare.bind(service,context.scope),start(){service.start();context.provide(processingServicesContribution.id,centralServices.processing,service.port);},
          quiesce:reason=>service.quiesce(reason),stop:reason=>service.stop(reason),dispose:()=>service.dispose(),route:{id:'mote.processing',mount:service.routes}};
      }}},
    {contribution:imageProcessingServiceContribution,declaration:imageProcessingServiceDeclaration,replacement:imageProcessingServiceReplacement,activation:{
      featureId:'mote.media',requires:{inputs:{provider:imageProcessingServiceInputsContribution.id,service:imageProcessingServiceInputsContract}},
      async create(context,bindings){
        const input=await context.services.acquire(imageProcessingServiceInputsContract,bindings.inputs!);context.scope.defer(()=>input.release());
        const service=input.value.open();imageService=service;
        return {prepare:service.prepare.bind(service,context.scope),start(){service.start();imageRoutes.activate(service.port);context.provide(imageProcessingServiceContribution.id,centralServices.imageProcessing,service.port);},
          quiesce:reason=>service.quiesce(reason),stop:async reason=>{try{await service.stop(reason);}finally{imageRoutes.deactivate();}},
          dispose:async()=>{try{await service.dispose();}finally{imageRoutes.deactivate();}},route:{id:'mote.media',mount:imageRoutes.mount}};
      }}},
  ],bootstrap.features);
  const installInput=async <T>(id:string,declaration:{id:string;apiVersion:string},contract:ServiceContract<T>,value:T)=>{
    const handle=await bootstrap.host.install({identity:{host:bootstrap.snapshot().host,packageId:id,installationId:`build:${id}@1.0.0`,instanceId:id,activationId:randomUUID()},contributions:[declaration],restartRequired:true,
      factory(context){const binding=context.provide(id,contract,value);bootstrap.registerDomainService(binding);domains.register(binding);return {prepare(){},start(){},quiesce(){},stop(){},dispose(){}};}});
    resources.defer(()=>handle.close('shutdown'));
  };
  await installInput(mediaAssetsServiceInputsContribution.id,mediaAssetsServiceInputsDeclaration,mediaAssetsServiceInputsContract,{open:()=>createMediaAssetsService({root:media.modelDirectory})});
  await domains.installDomain(mediaAssetsServiceContribution.id);
  const assets=mediaAssetsService!.assetsForAssembly,runtimeRoot=join(dirname(configService.path),'media-runtime');
  await installInput(ocrAsrReadinessInputsContribution.id,ocrAsrReadinessInputsDeclaration,ocrAsrReadinessInputsContract,{open:()=>createOcrAsrReadiness({runtime:configService.current(serverConfigDomain).runtime,media,assets,runtimeRoot,configService,backgroundWorker:mediaState.backgroundWorker,prepare:mediaState.prepare})});
  await domains.installDomain(ocrAsrReadinessContribution.id);
  const readiness=readinessService!;
  await installInput(processingServicesInputsContribution.id,processingServicesInputsDeclaration,processingServicesInputsContract,{open:()=>createProcessingServices({
    store,files,configService,diagnostics,executor,backendContext,materials,sourcePipelines,mediaAssets:assets,mediaPreparation:readiness.port,
    ...(dependencies.transcriptionProvider?{transcriptionProvider:dependencies.transcriptionProvider}:{}),
    ...(dependencies.plugins?.length?{plugins:dependencies.plugins}:{}),
    media,modelAuthority:mediaModelAuthority,analyze:analyzeFile,analysisSnapshot:resolveFileModel,
    analysisRevision:()=>modelSettings.view().revision,semanticFingerprint,
  })});
  await domains.installDomain(processingServicesContribution.id);
  const processingServices=platform!;
  await installInput(imageProcessingServiceInputsContribution.id,imageProcessingServiceInputsDeclaration,imageProcessingServiceInputsContract,{open:()=>createImageProcessingService({
    store,processing:processingServices.processing,executor,configService,materials,mediaAssets,media,modelAuthority:mediaModelAuthority,
    modelSettings,resolveFileModel,factory,admittedUsage,diagnostics,
  })});
  await domains.installDomain(imageProcessingServiceContribution.id);
  const activated=await domains.activate();
  resources.defer(()=>activated.close());
  contributeDomainRoutes(backendContext,Object.fromEntries(activated.routes.map(route=>[route.id,Object.freeze({mount:route.mount})])));
  const {workflows,processing}=processingServices;
  const service=imageService!;
  // The vault owns content storage and its storage transport; this assembly
  // only wires the already-prepared activation into the shared route table.
  contributeDomainRoutes(backendContext,{'mote.storage':vaultStorageRoutes(()=>bootstrap.vault.contentStorage,{archivedFiles,config:{dataDir:store.directory,maxExportBytes:configService.current(storageConfigDomain).maxExportBytes},diagnostics,evidenceReader,files,indexer,store})});
  registerImageProcessingServiceForAssembly(service,processing);
  return Object.freeze({workflows,processing,resolveFileModel,mediaModelAuthority,processingServices,imageProcessingService:service});
}

export interface PerceptionAssemblyDependencies {
  readonly store:Store;
  readonly configService:ConfigService;
  readonly executor:ExecutionEngine;
  readonly resources:ServerResources;
  readonly materials:MaterialStore;
  readonly mediaAssets:MediaAssets;
  readonly processing:FileProcessing;
  readonly mediaModelAuthority:ModelProcessingAuthority;
  readonly resolveFileModel:FileModelResolver;
  readonly modelSettings:ModelSettingsStore;
  readonly factory:ModelAgentFactory;
  readonly agent:AgentRuntimeRegistry;
  readonly admittedUsage:AdmittedUsageMeter;
}

/** The image plugin owns construction and replacement. This bridge binds the
 * agent registry assembled later and returns the existing perception handle. */
export function assemblePerception(dependencies:PerceptionAssemblyDependencies){
  const service=imageProcessingServiceForAssembly(dependencies.processing);
  service.bindAgent(id=>dependencies.agent.configuredFor(id));
  const perception=service.perceptionForAssembly;
  return Object.freeze({perception});
}
