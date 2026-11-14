import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Context,Plugin} from '@deepseek-ai/cordis';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryAgent} from '../query-agent.js';
import type {CaptureRecord,TokenUsage,UsageReceipt} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import type {Config} from '../config.js';
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
import {createMediaAssetsService,mediaAssetsServiceContribution,mediaAssetsServiceDeclaration,mediaAssetsServiceReplacement} from '../plugins/media-assets-service.js';
import {createOcrAsrReadiness,createOcrAsrReadinessFactory,ocrAsrReadinessContribution,ocrAsrReadinessDeclaration,ocrAsrReadinessForAssembly,ocrAsrReadinessReplacement,registerOcrAsrReadinessForAssembly} from '../plugins/ocr-asr-readiness.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import {vaultStorageRoutes} from '../plugins/vault-storage-routes.js';
import {createProcessingServices,createProcessingServicesFactory,processingServicesContribution,processingServicesDeclaration,processingServicesReplacement,type ProcessingServicesStarted} from '../plugins/processing-services.js';
import {createImageProcessingRoutes,createImageProcessingService,createImageProcessingServiceFactory,imageProcessingServiceContribution,imageProcessingServiceDeclaration,imageProcessingServiceForAssembly,imageProcessingServiceReplacement,registerImageProcessingServiceForAssembly} from '../plugins/image-processing-service.js';
import type {FileAnalysis,FileProcessing,TranscriptionProvider} from '../file-processing.js';
import type {PluginCenter} from '../plugin-center.js';
import {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection} from '../plugins/local-image-processing.js';

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

/** Declared build-time domain plugins the media and processing assembly wires;
 * the distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:processingServicesContribution,declaration:processingServicesDeclaration,replacement:processingServicesReplacement},
  {contribution:mediaAssetsServiceContribution,declaration:mediaAssetsServiceDeclaration,replacement:mediaAssetsServiceReplacement},
  {contribution:ocrAsrReadinessContribution,declaration:ocrAsrReadinessDeclaration,replacement:ocrAsrReadinessReplacement},
  {contribution:imageProcessingServiceContribution,declaration:imageProcessingServiceDeclaration,replacement:imageProcessingServiceReplacement},
]);

export interface MediaAssemblyDependencies {
  readonly config:Config;
  readonly store:Store;
  readonly configService:ConfigService;
  readonly resources:ServerResources;
  readonly backgroundWorker?:boolean;
}

/** Media assets remain available to the later processing assembly. C18B is
 * constructed here but prepared, started and closed only by its host factory. */
export function assembleMedia(dependencies:MediaAssemblyDependencies){
  const {config,store,configService,resources}=dependencies;
  const mediaAssetsService=createMediaAssetsService({root:config.media?.modelDirectory??join(store.directory,'media-models')});
  resources.defer(()=>mediaAssetsService.close());
  mediaAssetsService.prepare();mediaAssetsService.start();
  const mediaAssets=mediaAssetsService.assetsForAssembly;
  const readiness=createOcrAsrReadiness({runtime:config.configuration?.runtime??'unknown',media:{modelDirectory:mediaAssets.root,python:'python3',ocrPort:9010,asrPort:9009,ocrEndpoint:'http://127.0.0.1:9010/ocr',asrEndpoint:'http://127.0.0.1:9009/transcribe',workerToken:'',...config.media},assets:mediaAssets,configService,backgroundWorker:dependencies.backgroundWorker});
  registerOcrAsrReadinessForAssembly(readiness,mediaAssets);resources.defer(()=>readiness.close());
  return Object.freeze({mediaAssets,mediaPreparation:readiness.port});
}

/** Bind the existing optional intake plugin to the one control and media owner. */
export function assembleLocalImages({plugins,mediaAssets,processing,config,usage}:{plugins:PluginCenter;mediaAssets:MediaAssets;processing:FileProcessing;config:Pick<Config,'media'>;usage:UsageLedger}){
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
  imageProcessingServiceForAssembly(processing).bindLocalImages({selection:local.selection,media:config.media,usage});
  return local.port;
}

export interface ProcessingAssemblyDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Store;
  readonly config:Config;
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
  const {bootstrap,store,config,configService,diagnostics,executor,backendContext,resources,materials,sourcePipelines,files,sourceContexts,mediaAssets,archivedFiles,evidenceReader,indexer,withMediaOwnerBatch,withMediaOwnerIntent,modelAuthorization,modelAuthorizationHost,modelSettings,factory,admittedUsage}=dependencies;
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
  const readiness=ocrAsrReadinessForAssembly(mediaAssets);
  const readinessHandle=await bootstrap.host.install({
    identity:{host:bootstrap.snapshot().host,packageId:'mote.ocr-asr-readiness',installationId:'build:ocr-asr-readiness@1.0.0',instanceId:'media-readiness',activationId:randomUUID()},
    contributions:[ocrAsrReadinessDeclaration],factory:createOcrAsrReadinessFactory(readiness),
  });
  resources.defer(()=>readinessHandle.close('shutdown'));
  const platform=createProcessingServices({
    store,files,configService,diagnostics,executor,backendContext,materials,sourcePipelines,mediaAssets,
    ...(dependencies.transcriptionProvider?{transcriptionProvider:dependencies.transcriptionProvider}:{}),
    ...(dependencies.plugins?.length?{plugins:dependencies.plugins}:{}),
    ...(config.media?{media:config.media}:{}),modelAuthority:mediaModelAuthority,analyze:analyzeFile,analysisSnapshot:resolveFileModel,
    analysisRevision:()=>modelSettings.view().revision,semanticFingerprint,
  });
  let started:ProcessingServicesStarted|undefined;
  const handle=await bootstrap.host.install({
    identity:{host:bootstrap.snapshot().host,packageId:'mote.processing-services',installationId:'build:processing-services@1.0.0',instanceId:'processing',activationId:randomUUID()},
    contributions:[processingServicesDeclaration],factory:createProcessingServicesFactory(platform,value=>{started=value;}),
  });
  resources.defer(()=>handle.close('shutdown'));
  const {workflows,processing}=started!;
  const imageRoutes=createImageProcessingRoutes({withMediaOwnerBatch,withMediaOwnerIntent});
  const imageService=createImageProcessingService({
    store,processing,executor,configService,materials,mediaAssets,media:config.media,modelAuthority:mediaModelAuthority,
    modelSettings,resolveFileModel,factory,admittedUsage,diagnostics,
  });
  const imageHandle=await bootstrap.host.install({
    identity:{host:bootstrap.snapshot().host,packageId:'mote.image-processing',installationId:'build:image-processing@1.0.0',instanceId:'image-processing',activationId:randomUUID()},
    contributions:[imageProcessingServiceDeclaration],
    factory:createImageProcessingServiceFactory(imageService,()=>{imageRoutes.activate(imageService.port);},()=>{imageRoutes.deactivate();}),
  });
  resources.defer(()=>imageHandle.close('shutdown'));
  contributeDomainRoutes(backendContext,{'mote.media':imageRoutes});
  // The vault owns content storage and its storage transport; this assembly
  // only wires the already-prepared activation into the shared route table.
  contributeDomainRoutes(backendContext,{'mote.storage':vaultStorageRoutes(()=>bootstrap.vault.contentStorage,{archivedFiles,config,diagnostics,evidenceReader,files,indexer,store})});
  registerImageProcessingServiceForAssembly(imageService,processing);
  return Object.freeze({workflows,processing,resolveFileModel,mediaModelAuthority,processingServices:platform,imageProcessingService:imageService});
}

export interface PerceptionAssemblyDependencies {
  readonly store:Store;
  readonly config:Pick<Config,'media'>;
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
