import {join} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
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
import type {ModelAgentFactory,ModelAgentIdentity,ReloadableAgent} from '../model-agent.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import {captureModelIdentity,type ModelAuthorizationHost} from '../model-authorization-host.js';
import {modelConfiguration} from '../model-configuration.js';
import {requestLocale} from '../i18n.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from '../source-context-lineage.js';
import type {ModelProcessingAuthority} from '../model-processing-authority.js';
import type {MediaAssets} from '../media-assets.js';
import {MediaPreparation} from '../media-preparation.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import {createMediaAssetsService,mediaAssetsServiceContribution,mediaAssetsServiceDeclaration,mediaAssetsServiceReplacement} from '../plugins/media-assets-service.js';
import {ProcessingRuntime} from '../processing-runtime.js';
import {FileProcessing,type FileAnalysis,type TranscriptionProvider} from '../file-processing.js';
import {ImageProcessing} from '../image-processing.js';
import {imageUnderstanding} from '../image-understanding.js';

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

/** Declared build-time domain plugins the media assembly wires; the
 * distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:mediaAssetsServiceContribution,declaration:mediaAssetsServiceDeclaration,replacement:mediaAssetsServiceReplacement},
]);

export interface MediaAssemblyDependencies {
  readonly config:Config;
  readonly store:Store;
  readonly configService:ConfigService;
  readonly resources:ServerResources;
  readonly backgroundWorker?:boolean;
}

/** Media model storage and the managed media-preparation runtime, including
 * the configuration-change listener and close hooks. */
export function assembleMedia(dependencies:MediaAssemblyDependencies){
  const {config,store,configService,resources}=dependencies;
  const mediaAssetsService=createMediaAssetsService({root:config.media?.modelDirectory??join(store.directory,'media-models')});
  resources.defer(()=>mediaAssetsService.close());
  mediaAssetsService.prepare();mediaAssetsService.start();
  const mediaAssets=mediaAssetsService.assetsForAssembly;
  const mediaPreparation=new MediaPreparation({runtime:config.configuration?.runtime??'unknown',media:{modelDirectory:mediaAssets.root,python:'python3',ocrPort:9010,asrPort:9009,ocrEndpoint:'http://127.0.0.1:9010/ocr',asrEndpoint:'http://127.0.0.1:9009/transcribe',workerToken:'',...config.media},assets:mediaAssets});
  const mediaConfigurationIdentity=()=>{const document=configService.document();return JSON.stringify([document.media,(document.server as {runtime?:string})?.runtime]);};
  const initialMediaConfiguration=mediaConfigurationIdentity();
  const unsubscribeMedia=configService.onChange(()=>{try{if(mediaConfigurationIdentity()!==initialMediaConfiguration)mediaPreparation.invalidate();}catch{mediaPreparation.invalidate();}});
  resources.beforeClose(()=>mediaPreparation.close());resources.defer(unsubscribeMedia);
  if(dependencies.backgroundWorker)mediaPreparation.resume();
  return Object.freeze({mediaAssets,mediaPreparation});
}

export interface ProcessingAssemblyDependencies {
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
  const {store,config,configService,diagnostics,executor,backendContext,resources,materials,sourcePipelines,files,sourceContexts,mediaAssets,modelAuthorization,modelAuthorizationHost,modelSettings,factory,admittedUsage}=dependencies;
  const workflows=new ProcessingRuntime(store,[],{},Date.now,executor,materials,backendContext,configService);
  resources.defer(()=>workflows.close());
  sourcePipelines.setProductConsumer(workflows);workflows.consumerAllowed=(sourceId,bindingId)=>sourcePipelines.options(sourceId).consumers.includes(bindingId);
  const mediaModelAuthority:ModelProcessingAuthority=async(request,signal,task)=>{
    const original=captureModelIdentity(request.captureId);
    const execute=async(authorizedSignal:AbortSignal)=>{
      const assertCurrent=()=>{
        authorizedSignal.throwIfAborted();modelAuthorization.assertCurrent(request.connection);
        if(!store.isCurrentEvidence(request.captureId))throw new StoreError('Media original is no longer available',409);
        const records=store.evidence([request.captureId]);if(!records.length)throw new StoreError('Media original is unavailable',409);
        modelAuthorization.assertDisclosure(records.map(record=>({sourceId:record.provenance?.sourceId??'device:'+record.deviceId,dataKind:request.dataKind})));
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
  const processing:FileProcessing=new FileProcessing(files,dependencies.transcriptionProvider,undefined,{modelAuthority:mediaModelAuthority,configService,executor,modules:[...new Set([...(config.backendPluginModules??[]),...(config.fileProcessorModules??[])])],analyze:analyzeFile,analysisSnapshot:resolveFileModel,analysisRevision:()=>modelSettings.view().revision,diagnostics,contextProcessors:workflows.registry,pluginContext:backendContext,mediaAssets,media:config.media,contextForEvidence:record=>materials.contextForEvidence(record)});
  const previousSourceContextChanged=materials.onSourceContextChanged;
  materials.onSourceContextChanged=id=>{previousSourceContextChanged?.(id);processing.invalidateSourceContext(id);};
  resources.defer(()=>processing.settle());
  resources.defer(()=>processing.close());
  await processing.initializeConfiguration();
  return Object.freeze({workflows,processing,resolveFileModel,mediaModelAuthority});
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
  readonly agent:ReloadableAgent;
  readonly admittedUsage:AdmittedUsageMeter;
}

/** ImageProcessing and its understanding wiring, plus the close hook. */
export function assemblePerception(dependencies:PerceptionAssemblyDependencies){
  const {store,config,configService,executor,resources,materials,mediaAssets,processing,mediaModelAuthority,resolveFileModel,modelSettings,factory,agent,admittedUsage}=dependencies;
  const perception=new ImageProcessing(store,processing,executor,{modelAuthority:mediaModelAuthority,configService,materials,mediaAssets,media:config.media,understanding:imageUnderstanding({factory,metered:async(settings,attribution,task)=>{
    const meter=admittedUsage(settings.provider,settings.model,'image-understanding',{agentId:'image-understanding',moduleId:'images',skillId:null,...attribution});
    return meter.run(async()=>{try{const output=await task(meter.update);meter.completed();return output;}catch(error){meter.failed(error);throw error;}});
  },selection:service=>{
    const selected=modelSettings.select('file'),resolved=resolveFileModel({...processing.currentSettings(),analysisModel:service}),settings=resolved.settings,configuration=modelConfiguration(service?.id??selected.id,settings,modelSettings.view().revision);
    return {identity:resolved.identity,fingerprint:configuration.fingerprint,configured:service?Boolean(service.apiKey||service.execution==='local'):agent.configuredFor(selected.id),settings,receipt:{profileId:service?.id??selected.id,provider:settings.provider,model:settings.model,revision:modelSettings.view().revision}};
  }})});
  resources.defer(()=>perception.close());
  return Object.freeze({perception});
}
