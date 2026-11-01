import {MediaPreparation} from './media-preparation.js';
import {createMemoryControl} from './memory-control.js';
import {createMemoryModelAuthorityJobReader} from './memory-model-authority.js';
import {createQueryPreparation,type SavedQuery} from './query-preparation.js';
import {createModelEvidenceAuthority,contextFailure} from './model-evidence-authority.js';
import type {QueryAgent} from './query-agent.js';
import type {FeatureServices} from './feature-services.js';
import {queryWithAttachmentsSchema,insightRequestSchema} from './query-request.js';
import {ServerResources} from './server-resources.js';
import {MemoryTopicsHost} from './memory-topics-host.js';
import {createContextTrees} from './context-trees.js';
import type {ProcessingConfiguration} from './processing-configuration.js';
import type {ModelProcessingAuthority} from './model-processing-authority.js';
import {BackgroundModelAuthorization,modelConnection,type ModelConnection,type AutomaticModelPurpose} from './background-model-authorization.js';
import {ModelAuthorizationHost,agentModelConnection,captureModelIdentity,sourceModelIdentity} from './model-authorization-host.js';
import {MODEL_FEATURES,DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import {executionObservability,type ObservationIdentity,type ObservationName} from './execution-observability.js';
import {memoryIntegrationImageInputs} from './memory-image-grants.js';
import {assertMemoryImageGrants} from './memory-image-grants.js';
import {memoryReadRanges} from './memory-read-context.js';
import {retainFailureContext} from './execution-failures.js';
import {defaultLogMaxBytes} from './log-retention-config.mjs';
import {OwnerQuestions} from './owner-questions.js';
import {CODING_DIALOGUE_SCHEMA_VERSION,formatEvidenceRef} from '@mote/shared';
import {imageOutput} from './evidence-image.js';
import {fileAttachmentAvailable} from './file-attachments.js';
import {MemoryRecipeSettings} from './memory-recipe-settings.js';
import {CAPTURE_BATCH_MAX_RECORDS,CAPTURE_BATCH_MAX_BYTES} from './capture-limits.js';
import {memoryEvidenceFingerprint} from './memory.js';
import { Context } from '@deepseek-ai/cordis';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import { AgentNotConfiguredError,AgentYieldError,originalEvidenceReceipt,createImportAgent,skillCatalog,type AgentTraceEvent,type ContextReader,type QueryInput } from '@mote/agent';
import { ProviderFailure,captureSchema,type CaptureInput,type CaptureRecord,type QueryResult } from '@mote/shared';
import { negotiateLocale } from '@mote/shared/i18n';
import Fastify,{ type FastifyInstance,type FastifyReply,type FastifyRequest } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import { existsSync,readFileSync } from 'node:fs';
import { dirname,join,relative,sep } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { Actions } from './actions.js';
import { ActivityProjection } from './activity.js';
import { Operations } from './operations.js';
import { assertCurrentDelegationSchema,DelegationRuntime } from './delegation-runtime.js';
import { DelegatedQueryRuns } from './delegated-query-runs.js';
import {runQueryQualityExperiment,type QueryQualityStrategy,type QueryQualityCheckpoint} from './query-quality-experiment.js';
import { registerMemoryDelegation } from './memory-delegation.js';
import { agentDeadline } from './agent-deadline.js';
import { installAgentFeatures } from './agent-feature-host.js';
import { ArchivedFileStore } from './archived-files.js';
import { codingSourcePlugin } from './coding-source-plugin.js';
import { ConcurrencyGate } from './concurrency.js';
import { repositoryRoot,registerBuiltinDomains,configDocumentDomains,configFromDocument,documentFromConfig,validateResolvedConfigDocument,type Config,type ConfigDocument } from './config.js';
import { ConfigService,ConfigServiceError } from './config-service.js';
import { ConnectionError,Connections,type ConnectionCredential } from './connections.js';
import { registerConnectors } from './connectors/index.js';
import { ContentStorageService } from './content-storage.js';
import { Conversations } from './conversations.js';
import { combineDependencies,resolveDependencies } from './conversation-lineage.js';
import {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from './source-context-lineage.js';
import { ServerDiagnostics,safeError,type AgentTraceContext } from './diagnostics.js';
import { EvidenceReader } from './evidence-reader.js';
import { EvidenceExposurePolicy } from './evidence-exposure.js';
import { ExecutionEngine,ExecutionFailure } from './execution-engine.js';
import { ExecutionSettings,type ExecutionSettingsValue,type DiagnosticsSettingsValue } from './execution-settings.js';
import { ServerFeatureHost } from './feature-host.js';
import { installServerFeatures } from './features/index.js';
import { FileEvidence } from './file-evidence.js';
import { FileProcessing,type FileAnalysis,type TranscriptionProvider } from './file-processing.js';
import { FileRawReader,fileOriginalRawRef } from './file-raw-reader.js';
import { registerFileRoutes } from './file-routes.js';
import { FileStore } from './files.js';
import { moteText,requestLocale } from './i18n.js';
import { prepareImportInput } from './import-runtime.js';
import { ImportStore,type ImportPreparation,type ImportPreparationResult } from './imports.js';
import { Indexer } from './indexer.js';
import { INGRESS_PROTOCOL_VERSION,IngressService,collectorIngressWrite } from './ingress.js';
import { InsightRuns } from './insight-runs.js';
import { insightResult,validateInsightOutput } from './insights.js';
import { registerMemoryExtensions } from './lifecycle-extensions.js';
import {MemoryIntegrationSettings} from './memory-integration-settings.js';
import { MaintenanceWorker } from './maintenance.js';
import { MaterialMemoryWork } from './material-memory-work.js';
import {installCaptureMemoryIntake} from './capture-memory-intake.js';
import {AutomaticActivity} from './automatic-activity.js';
import { MaterialOrganizerRuntime } from './material-organizers.js';
import { MaterialStore } from './materials.js';
import { MediaAssets } from './media-assets.js';
import { MemoryLifecycle,projectMemoryLifecycleSettings,storedMemoryLifecycleSettings,freezeSemanticContextTime,type LifecycleExtension,type LifecycleSettings } from './memory-lifecycle.js';
import {MemoryStrategies} from './memory-strategies.js';
import type {MemoryReviewStrategy} from './memory-strategy-contract.js';
import { MemoryPipeline } from './memory-pipeline.js';
import { MemoryAutomation } from './memory-automation.js';
import {PluginCenter} from './plugin-center.js';
import {GitHubPluginReleases} from './plugin-release.js';
import {MemoryBindings} from './memory-bindings.js';
import {MemoryPublication} from './memory-publication.js';
import {MemoryAdapters} from './memory-adapters.js';
import {registerPluginRoutes} from './plugin-routes.js';
import { MemoryReviewCache } from './memory-review-cache.js';
import { reviewMemory } from './memory-review.js';
import { ReloadableAgent,applyModelSettings,createModelAgent,createModelRegistry,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory,type ModelAgentIdentity } from './model-agent.js';
import { ModelCatalogError } from './model-catalog.js';
import { modelConfiguration } from './model-configuration.js';
import { ModelSettingsError,ModelSettingsStore } from './model-settings.js';
import { linkOperationParent } from './operation-projection.js';
import {ImageProcessing} from './image-processing.js';
import {imageUnderstanding} from './image-understanding.js';
import { ProcessingRuntime } from './processing-runtime.js';
import { ProviderAdmission } from './provider-admission.js';
import { PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput } from './python-source-pack-executor.js';
import type {QueryScope} from './query-scope.js';
import { MAX_RAW_READ_BYTES } from './raw-reader.js';
import { semanticProcessor } from './semantic-extraction.js';
import { conversationUnderstandingProcessor } from './conversation-understanding.js';
import { SourcePipelineRuntime } from './source-pipelines.js';
import { SourceStore } from './sources.js';
import { Store,StoreError,sha256 } from './store.js';
import { createUpdateService } from './updates.js';
import { UsageLedger } from './usage.js';
import { WorkingMemory } from './working-memory.js';

function parseCaptureBundle(body:unknown):CaptureInput[] {
  if(!Buffer.isBuffer(body))throw new StoreError('Capture bundle body must be gzip bytes');
  let inflated:Buffer;
  try{inflated=gunzipSync(body,{maxOutputLength:CAPTURE_BATCH_MAX_BYTES});}
  catch{throw new StoreError('Invalid capture bundle compression');}
  const text=inflated.toString('utf8');
  const lines=text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n');
  if(lines.length<1||lines.length>CAPTURE_BATCH_MAX_RECORDS||lines.some(line=>line.length===0))throw new StoreError('Capture bundle JSONL is empty or too large');
  try{return lines.map(line=>captureSchema.parse(JSON.parse(line)));}
  catch(error){if(error instanceof z.ZodError)throw error;throw new StoreError('Invalid capture bundle JSONL');}
}
export type {QueryAgent} from './query-agent.js';
const serverVersion=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
export async function buildApp(config:Config,dependencies?:{configService?:ConfigService;queryQualityExperiment?:QueryQualityStrategy;webRoot?:string;connectorTesting?:import('./connectors/index.js').ConnectorTestDependencies;semanticContextTime?:()=>string;backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void}) {
  const resources=new ServerResources();
  let startupApp:FastifyInstance|undefined;
  try{
  config={...config};
  const suppliedConfigService=dependencies?.configService??config.configService;
  const configService=suppliedConfigService??new ConfigService({path:config.configuration?.configFile??join(config.dataDir,'mote.yaml'),initialDocument:documentFromConfig(config)});
  resources.beforeClose(()=>configService.close());
  if(!suppliedConfigService)registerBuiltinDomains(configService,config);
  await configService.initialize();
  {
    const bootDocument={version:1,revision:configService.revision,...Object.fromEntries(configDocumentDomains().map(domain=>[domain.id,configService.current(domain.id)]))} as ConfigDocument;
    config=configFromDocument(bootDocument,configService.path,{token:config.token,tokenPath:config.tokenPath},{resolvedDocument:true});
  }
  const actualOwnerToken=config.token;
  configService.setValidator(document=>validateResolvedConfigDocument(document,actualOwnerToken));
  const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();resources.defer(()=>eventLoop.disable());
  // A foreground node must not block listen() on a full orphan-blob sweep. When
  // the background worker is enabled, let that worker perform maintenance after
  // the HTTP service is available instead of making startup scan the whole vault.
  const store=dependencies?.store??new Store(config.dataDir,{dataKey:config.dataKey,contentEncryptionEnabled:config.contentEncryptionEnabled,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:Boolean(config.embeddingModel),maintenance:Boolean(dependencies?.backgroundWorker)});
  if(!dependencies?.store)resources.defer(()=>store.close());
  assertCurrentDelegationSchema(store);
  const memoryModelAuthorityJobs=createMemoryModelAuthorityJobReader(store);
  let availableModelConnections=():ModelConnection[]=>[];
  const modelAuthorization=new BackgroundModelAuthorization(store,()=>availableModelConnections());
  resources.defer(()=>modelAuthorization.close());
  // MVP cut-over is explicit: never silently keep the old Coding event indexes live.
  if(store.db.prepare("SELECT 1 FROM captures WHERE json_extract(json,'$.provenance.document.coding') IS NOT NULL LIMIT 1").get()){throw new Error('Legacy Coding event vault: back up and use a fresh data directory for the source-pipeline architecture. No automatic migration is performed.');}
  projectMemoryLifecycleSettings(store,configService.current<LifecycleSettings>('memory'));
  const materials=new MaterialStore(store);
  resources.defer(()=>materials.index?.close());
  // One service tree owns backend plugins. Each runtime installs into its own
  // managed scope below this root, so closing one cannot dispose a sibling.
  const backendContext=new Context();
  resources.defer(()=>backendContext.fiber.dispose());
  backendContext.provide('moteMaterials',materials);
  backendContext.provide('moteConfig',configService);
  const runtimeSettings=new ExecutionSettings(configService),execution=runtimeSettings.execution(),providerAdmission=new ProviderAdmission(store);
  const agentGate=new ConcurrencyGate(execution.agentConcurrency),llmGate=new ConcurrencyGate(execution.llmConcurrency);
  const interactiveGate=new ConcurrencyGate(execution.interactiveConcurrency),interactiveModelGate=new ConcurrencyGate(execution.interactiveConcurrency);
  resources.defer(()=>{agentGate.close();llmGate.close();interactiveGate.close();interactiveModelGate.close();});
  const modelContext=new AsyncLocalStorage<QueryInput>();
  const modelOperation=new AsyncLocalStorage<string>();
  // Accounting observes trusted admission boundaries, independently of model
  // input. A host cooldown or gate cancellation can happen before any call.
  const queryAccounting=new AsyncLocalStorage<{agentStarted:()=>void;modelQueued:()=>void;modelStarted:()=>void}>();
  const assertModelPurpose=(input:QueryInput|undefined)=>{if(dependencies?.queryQualityExperiment&&!input?.traceContext?.operationId?.startsWith('query:'))throw new StoreError('Isolated Ask experiment does not authorize background model work',409);};
  const authorizeModelRequest=()=>{modelAuthorization.assertCurrent();assertModelPurpose(modelContext.getStore());assertModelEvidence(modelContext.getStore());};
  const runModelFor=(settings:import('@mote/shared/models').ModelSettings,connection?:ModelConnection):NonNullable<import('@mote/agent').AgentOptions['runModel']>=>(task,signal)=>{
    const assertAuthority=connection?modelAuthorization.capture(connection):undefined;assertAuthority?.();
    signal?.throwIfAborted();assertModelPurpose(modelContext.getStore());providerAdmission.check(settings);
    const queuedAt=performance.now(),input=modelContext.getStore(),gate=input?.executionLane==='interactive'?interactiveModelGate:llmGate;input?.onTrace?.({type:'model.queued',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background'}});
    input?.onProgress?.({stage:'model',message:moteText('等待模型执行名额')});
    queryAccounting.getStore()?.modelQueued();
    return gate.run(async()=>{assertAuthority?.();providerAdmission.check(settings);assertModelEvidence(input);input?.onProgress?.({stage:'model',message:moteText('模型处理中')});const admittedAt=performance.now(),lane=input?.executionLane??'background',queueWaitMs=admittedAt-queuedAt;input?.onTrace?.({type:'model.admitted',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane,queueWaitMs}});let status:'completed'|'failed'|'yielded'='failed';
      try{queryAccounting.getStore()?.modelStarted();const result=await task();status='completed';return result;}
      catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
      finally{diagnostics.record('agent.harness_timing',{jobId:input?.traceContext?.jobId,batchId:input?.traceContext?.batchId,lane,unit:'harness_session',queueWaitMs,durationMs:performance.now()-admittedAt,status},'info');}
    },signal??input?.signal,input?.traceContext?.operationId??modelOperation.getStore());
  };
  const diagnostics=new ServerDiagnostics({...runtimeSettings.diagnostics(),directory:config.logDirectory??join(config.dataDir,'logs'),maxBytes:config.logMaxBytes??defaultLogMaxBytes(config.profile),maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries});
  resources.defer(async()=>{diagnostics.record('server.stopping');await diagnostics.close();});
  await diagnostics.init();
  const executionObserver=executionObservability(diagnostics)!;
  resources.defer(()=>executionObserver.close());
  const observationIdentity=(input:QueryInput):ObservationIdentity=>({jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,attempt:input.traceContext?.attempt,
    phase:input.traceContext?.phase==='coding-understanding'?'coding_understanding':input.traceContext?.phase==='review'?'review':'extract'});
  const observeMemory=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>T):T=>input?.responseMode==='memory-extraction'?executionObserver.sync(name,observationIdentity(input),work):work();
  const observeMemoryAsync=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>Promise<T>):Promise<T>=>input?.responseMode==='memory-extraction'?executionObserver.async(name,observationIdentity(input),work):work();
  const executor=new ExecutionEngine(store);
  resources.beforeClose(()=>executor.close());
  executor.bindModelAuthority(modelAuthorization);
  executor.bindObserver(value=>executionObserver.lease(value),()=>executionObserver.enabled());
  backendContext.provide('moteExecution',executor);
  const memoryStrategies=new MemoryStrategies(),memoryRecipeSettings=new MemoryRecipeSettings(store,memoryStrategies);
  const memoryAutomation=new MemoryAutomation(store);
  let memoryBindings:MemoryBindings|undefined;
  backendContext.provide('moteMemoryStrategies',memoryStrategies);
  const materialMemoryWork=new MaterialMemoryWork(store,materials,Date.now,()=>true,memoryRecipeSettings,()=>memoryBindings?.accepting()??memoryAutomation.accepting());
  const sourcePipelines=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],backendContext,executor,materialMemoryWork);resources.defer(()=>sourcePipelines.close());await sourcePipelines.ready;
  const sources=new SourceStore(store,sourcePipelines),files=new FileStore(store,sources);
  resources.defer(()=>files.close());
  const ingress=new IngressService(store,sources,files),fileEvidence=new FileEvidence(sources);
  const modelAuthorizationHost=new ModelAuthorizationHost(modelAuthorization,store,materials,files);
  materialMemoryWork.inputs.onOriginalInput=(input,automatic)=>modelAuthorizationHost.source(input,automatic);
  const mediaAssets=new MediaAssets(config.media?.modelDirectory??join(store.directory,'media-models'));
  resources.defer(()=>mediaAssets.close());
  const mediaPreparation=new MediaPreparation({runtime:config.configuration?.runtime??'unknown',media:{modelDirectory:mediaAssets.root,python:'python3',ocrPort:9010,asrPort:9009,ocrEndpoint:'http://127.0.0.1:9010/ocr',asrEndpoint:'http://127.0.0.1:9009/transcribe',workerToken:'',...config.media},assets:mediaAssets});
  const mediaConfigurationIdentity=()=>{const document=configService.document();return JSON.stringify([document.media,(document.server as {runtime?:string})?.runtime]);};
  const initialMediaConfiguration=mediaConfigurationIdentity();
  const unsubscribeMedia=configService.onChange(()=>{try{if(mediaConfigurationIdentity()!==initialMediaConfiguration)mediaPreparation.invalidate();}catch{mediaPreparation.invalidate();}});
  resources.beforeClose(()=>mediaPreparation.close());resources.defer(unsubscribeMedia);
  if(dependencies?.backgroundWorker)mediaPreparation.resume();
  const usageLedger=new UsageLedger(store);
  const admittedUsage=(...args:Parameters<UsageLedger['start']>)=>{
    let agentStarted=false,modelQueued=false,meter:ReturnType<UsageLedger['start']>|undefined;
    const start=()=>meter??=usageLedger.start(...args);
    const accounting={agentStarted:()=>{agentStarted=true;},modelQueued:()=>{modelQueued=true;},modelStarted:()=>{agentStarted=true;start();}};
    return {
      run:<T>(task:()=>Promise<T>)=>queryAccounting.run(accounting,task),
      update:(tokens:import('@mote/shared').TokenUsage)=>start().update(tokens),
      completed:()=>start().finish('completed'),
      failed:(error:unknown)=>{
        const admissionWait=error instanceof ProviderFailure&&error.details.admissionWaiting===true;
        if(agentStarted&&!modelQueued&&!admissionWait)start();
        // Preserve issued calls and partial samples, but create no receipt for
        // a host refusal or queue cancellation before the first actual model
        // operation. Agents without a host model gate retain fallback accounting.
        return meter?.finish('failed');
      },
    };
  };
  const indexer=new Indexer(store,config,diagnostics,files,input=>{
    const operationId=input.operationId??modelContext.getStore()?.traceContext?.operationId??'embedding:'+randomUUID(),provider='embedding',model=config.embeddingModel;
    const meter=usageLedger.start(provider,model,'embedding',{agentId:'embedding',moduleId:'retrieval',skillId:null,operationId});
    return {finish:(usage,failed)=>{if(usage)meter.update(usage);meter.finish(failed?'failed':'completed');}};
  },{executor,operationId:()=>modelContext.getStore()?.traceContext?.operationId,
    assertModel:()=>modelAuthorization.assertCurrent(modelConnection('embedding:central',{model:config.embeddingModel,baseUrl:config.embeddingBaseUrl,apiKey:config.embeddingApiKey})),
    authorize:(id,signal,task)=>{
      const roots=modelAuthorizationHost.evidenceTriggers([id]);
      const work='automatic-embedding:'+sha256(JSON.stringify(roots));
      return modelAuthorizationHost.automatic(work,'embedding',roots,authorizedSignal=>{modelAuthorizationHost.assertEvidence([id]);return task(authorizedSignal);},signal);
    },
  });
  resources.defer(()=>indexer.close());
  const materialOrganizer=new MaterialOrganizerRuntime(store,materials,[],executor,materialMemoryWork);
  resources.defer(()=>materialOrganizer.close());
  backendContext.provide('moteMaterialOrganizers',materialOrganizer.registry);
  const evidenceReader=new EvidenceReader(store,sources,files,indexer,fileEvidence,materials,sourcePipelines,materialOrganizer.sourceItemRecipes,
    ref=>materialMemoryWork.readyForMemory(ref));
  const contextTrees=createContextTrees();
  backendContext.provide('moteContextTrees',contextTrees);
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id)));
  const memories=evidenceReader.memories,conversations=new Conversations(store);
  conversations.onTurnReceived=turnId=>modelAuthorizationHost.conversation(turnId);
  const sourceContexts=new SourceContextStore(store);
  const pluginCenter=new PluginCenter(store,executor,new GitHubPluginReleases(join(config.dataDir,'plugins','packages')));
  resources.beforeClose(()=>pluginCenter.close());
  memoryBindings=new MemoryBindings(store,memories,memoryAutomation,pluginCenter,executor);
  resources.defer(()=>memoryBindings!.close());
  evidenceReader.memoryBindings=memoryBindings;
  const ownerQuestions=new OwnerQuestions(store);
  backendContext.provide('moteOwnerQuestions',ownerQuestions);
  const archivedFiles=new ArchivedFileStore(store);
  const contentStorage=new ContentStorageService(store,files,archivedFiles,configService,enabled=>{config.contentEncryptionEnabled=enabled;maintenanceWorker?.configureContentEncryption(enabled);});
  resources.defer(()=>contentStorage.close());
  const connections=dependencies?.connections??new Connections(store,sources);resources.defer(()=>connections.close());await connections.init();
  const identities=new WeakMap<FastifyRequest,ConnectionCredential>();
  const connectionIdentity=(req:FastifyRequest)=>identities.get(req);
  // Device metadata does not narrow a human client's owner permissions.
  const credential=(req:FastifyRequest)=>{const c=connectionIdentity(req);return c&&!connections.isOwner(c)?c:undefined;};
  const assertRequestActive=(req:FastifyRequest)=>{const c=connectionIdentity(req);if(c)connections.assertActive(c);};
  const sourceOwner=(req:FastifyRequest,id:string)=>{assertRequestActive(req);const c=credential(req);if(c)connections.assertOwnSource(c,id);};
  const context=(records:CaptureRecord[])=>evidenceReader.context(records);
  const modelEvidenceAuthority=createModelEvidenceAuthority({resolveLineage:value=>resolveDependencies(store,value),
    assertImageGrants:(materialInputs,images)=>assertMemoryImageGrants(store,materialInputs,images),reader:evidenceReader,conversations,sourceContexts,
    authorization:modelAuthorization,host:modelAuthorizationHost,readEvidence:ids=>memories.readEvidence(ids)});
  const {contextDependencies,sourceContextDependencies,pinProcessingEvidence}=modelEvidenceAuthority;
  const assertModelEvidence=(input:QueryInput|undefined)=>observeMemory(input,'query_assert',()=>modelEvidenceAuthority.assert(input));
  const assertModelEvidenceAsync=(input:QueryInput)=>observeMemoryAsync(input,'query_assert',()=>modelEvidenceAuthority.assertAsync(input));
  // Owner inspection and external read-only clients do not send to our model.
  // The same reader enforces model disclosure scope inside an admitted model run.
  const readingForModel=()=>Boolean(modelContext.getStore()||modelAuthorization.currentId);
  const agentFeatures=await installAgentFeatures(backendContext,evidenceReader.agent({diagnostics,allowQueryImages:()=>perception.settings().allowQueryImages,
    exposurePolicy:new EvidenceExposurePolicy([],context=>!readingForModel()||modelAuthorization.allowsDisclosure({sourceId:context.sourceId??'device:'+context.deviceId,dataKind:context.representation==='image'?'image':'text'})),
    assertSources:(ids,kind='text')=>{if(readingForModel())modelAuthorization.assertDisclosure(ids.map(sourceId=>({sourceId,dataKind:kind})));},
    assertEvidence:(ids,kind)=>{if(readingForModel())modelAuthorizationHost.assertEvidence(ids,kind);},
    currentOperation:()=>modelContext.getStore()?.responseMode==='memory-extraction'?'memory':'query',
    currentContextTime:()=>modelContext.getStore()?.contextTime,
    currentGrantContext:()=>modelContext.getStore(),currentProcessingEvidence:()=>modelContext.getStore()?.processingEvidence,currentMaterialInputs:()=>modelContext.getStore()?.processingMaterialInputs}));
  const archiveReader=agentFeatures.reader;
  const directImage=(id:string)=>modelContext.getStore()?.directImages?.find(image=>image.id===id);
  const directImageAllowed=(id:string)=>{
    try{const image=directImage(id),version=files.version(id);
      return Boolean(image&&version.object_hash===image.hash&&store.evidence([id]).length&&fileAttachmentAvailable(store,id)&&
        !store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted);
    }catch{return false;}
  };
  const fileRawReader=new FileRawReader(store,files,archivedFiles,{
    mayReadFileVersion:(_sourceId,id)=>directImageAllowed(id),mayReadArchivedFile:()=>false,mayListSourceFiles:()=>false,mayListArchivedFiles:()=>false,
  });
  const baseReader:ContextReader={...archiveReader,
    evidence:async args=>{
      const direct=args.ids.flatMap(id=>{const image=directImage(id);return image?[{id,capturedAt:modelContext.getStore()?.contextTime??new Date().toISOString(),appName:image.name,ocrText:'',sourceType:'user_attachment',summary:'User attached image',metadata:{mimeType:image.mimeType}}]:[];});
      const regular=args.ids.filter(id=>!directImage(id));
      return [...direct,...(regular.length?await archiveReader.evidence({...args,ids:regular}):[])];
    },
    readImage:async(input)=>{
      const {id,attachmentId}=input;
      const direct=directImage(id);
      if(!direct)return archiveReader.readImage!(input);
      if(attachmentId!==undefined)throw new StoreError('Dialogue images have no nested attachments',400);
      const ref=fileOriginalRawRef(id,direct.hash),parts:Buffer[]=[];
      for(let offset=0;offset<direct.sizeBytes;){
        const page=await fileRawReader.read(ref,{offset,length:Math.min(MAX_RAW_READ_BYTES,direct.sizeBytes-offset)});
        if(page.status!=='available'||page.totalBytes!==direct.sizeBytes||page.mediaType!==direct.mimeType||page.bytes.length===0)throw new StoreError('Attached image is unavailable',404);
        parts.push(Buffer.from(page.bytes));offset+=page.bytes.length;
      }
      return imageOutput(Buffer.concat(parts),direct.mimeType,input,()=>directImageAllowed(id));
    },
  };
  // The current Memory host shares the archive reader with Ask. Observe only
  // Memory calls inside its existing async context; no new reader or grant.
  const observeRead=<Args extends unknown[],Result>(name:ObservationName,read:(...args:Args)=>Promise<Result>)=>(...args:Args)=>observeMemoryAsync(modelContext.getStore(),name,()=>read(...args));
  const reader:ContextReader={...baseReader,
    search:observeRead('reader_search',baseReader.search),timeline:observeRead('reader_timeline',baseReader.timeline),
    evidence:observeRead('reader_evidence',baseReader.evidence),activity:observeRead('reader_activity',baseReader.activity),devices:observeRead('reader_devices',baseReader.devices),
    ...(baseReader.readImage?{readImage:observeRead('reader_image',baseReader.readImage)}:{}),
    ...(baseReader.memories?{memories:observeRead('reader_memories',baseReader.memories)}:{}),
  };
  const agent=new ReloadableAgent(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  resources.defer(()=>agent.close());
  const codex={executable:config.codexBin,home:config.codexHome};
  // Order admitted preparation starts across event-loop turns, without waiting
  // for a query to finish or changing either lane's in-flight concurrency.
  let preparationTurn=Promise.resolve();
  const yieldPreparationTurn=()=>{const turn=preparationTurn.then(()=>yieldEventLoop());preparationTurn=turn.catch(()=>{});return turn;};
  const wrapAgent=(inner:QueryAgent,settings:import('@mote/shared/models').ModelSettings,identity:ModelAgentIdentity):QueryAgent=>({get configured(){return inner.configured;},close:()=>inner.close(),query:async input=>{
    const connection=agentModelConnection(identity,settings);modelAuthorization.assertCurrent(connection);
    assertModelPurpose(input);
    await assertModelEvidenceAsync(input);
    input=pinProcessingEvidence(input);
    input.signal?.throwIfAborted();providerAdmission.check(settings);
    input.onProgress?.({stage:'starting',phase:'started',message:moteText('等待 Agent 执行名额')});
    const queuedAt=performance.now(),lane=input.executionLane==='interactive'?'interactive':'background';
    return (lane==='interactive'?interactiveGate:agentGate).run(async()=>{
      await yieldPreparationTurn();input.signal?.throwIfAborted();
      // Keep the live request identity: disclosure callbacks update its source pins.
      input.archiveImagesEnabled=perception.settings().allowQueryImages;
      const operationId=input.traceContext?.operationId??(input.traceContext?.jobId?'job:'+input.traceContext.jobId:'query:'+randomUUID());
      const admittedAt=performance.now(),queueWaitMs=admittedAt-queuedAt;let status:'completed'|'failed'|'yielded'='failed';
      try{observeMemory(input,'catalog_snapshot',()=>evidenceReader.retainMemorySnapshot(input));const result=await modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>{modelAuthorization.assertCurrent(connection);assertModelEvidence(input);queryAccounting.getStore()?.agentStarted();return modelContext.run(input,()=>inner.query(input));}));modelAuthorization.assertCurrent(connection);status='completed';return result;}
      catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
      finally{evidenceReader.releaseMemorySnapshot(input);diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,lane,unit:'agent_fragment',queueWaitMs,durationMs:performance.now()-admittedAt,status},'info');}
    },input.signal,input.traceContext?.operationId);
  }});
  const factory:ModelAgentFactory=async(settings,reader,_hooks,identity)=>{
    if(!identity)throw new StoreError('Model host identity is missing',409);
    const connection=agentModelConnection(identity,settings);
    const host={runModel:runModelFor(settings,connection),authorizeModelRequest:()=>{modelAuthorization.assertCurrent(connection);authorizeModelRequest();}};
    return wrapAgent(await (dependencies?.createModelAgent?dependencies.createModelAgent(settings,reader,host,identity):createModelAgent(settings,reader,codex,host.runModel,host.authorizeModelRequest)),settings,identity);
  };
  let initialAgent=dependencies?.agent?wrapAgent(dependencies.agent,modelSettingsFromConfig(config),{kind:'profile',id:DEPLOYMENT_MODEL_PROFILE_ID}):undefined;
  const modelSettings=new ModelSettingsStore({
    configService,codex,
    prepare:async (settings,profiles,defaultProfileId,previousSettings)=>{
      const candidate=await createModelRegistry(profiles,reader,factory,initialAgent,defaultProfileId);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings),()=>applyModelSettings(config,previousSettings??settings));
    },
    probe:settings=>testModelConnection(settings,async(selected,reader)=>{
      const id=randomUUID(),identity:ModelAgentIdentity={kind:'probe',id},candidate=await factory(selected,reader,undefined,identity),connection=agentModelConnection(identity,selected);
      return {...candidate,query:input=>modelAuthorizationHost.manual('model-probe:'+id,[connection],signal=>candidate.query({...input,signal}),input.signal,'probe')};
    }),
  });
  resources.defer(()=>modelSettings.close());
  await modelSettings.initialize();
  let additionalModelConnections=():ModelConnection[]=>[];
  availableModelConnections=()=>{
    const models=[...modelSettings.profiles(),...MODEL_FEATURES.map(feature=>modelSettings.select(feature))].map(profile=>agentModelConnection({kind:'profile',id:profile.id},profile.settings));
    if(config.embeddingModel&&config.embeddingBaseUrl)models.push(modelConnection('embedding:central',{model:config.embeddingModel,baseUrl:config.embeddingBaseUrl,apiKey:config.embeddingApiKey}));
    return [...new Map([...models,...additionalModelConnections()].map(connection=>[connection.id+'@'+connection.fingerprint,connection])).values()];
  };
  const hindsightMeters=new Map<string,ReturnType<UsageLedger['start']>>();
  const hindsightAuthorities=new Map<string,(settings:import('@mote/shared/models').ModelSettings)=>void>();
  const memoryAdapters=new MemoryAdapters(join(config.dataDir,'plugins','instances'),pluginCenter,modelSettings,{codex,runModelFor,
    assertModelAuthority:(settings,request)=>{if(request.purpose==='startup'||request.purpose==='capability_probe')return;const assert=request.opId&&hindsightAuthorities.get(request.opId);if(!assert)throw new StoreError('Native Memory operation authority expired',409);assert(settings);},
    onRequestStarted:(settings,request)=>hindsightMeters.set(request.requestId,usageLedger.start(settings.provider,settings.model,'hindsight-engine',{agentId:'hindsight-engine',moduleId:'memories',skillId:null,operationId:request.opId,requestId:request.requestId})),
    onUsage:(_settings,usage,request)=>hindsightMeters.get(request.requestId)?.update(usage),
    onRequestFinished:request=>{hindsightMeters.get(request.requestId)?.finish(request.status);hindsightMeters.delete(request.requestId);},
  });
  resources.beforeClose(()=>memoryAdapters.close());
  memoryBindings.providerFactory=(id,namespace)=>memoryAdapters.provider(id,namespace);
  pluginCenter.probe=(id,signal)=>memoryAdapters.probe(id,signal);
  pluginCenter.configurationAllowed=(field,value)=>memoryAdapters.configurationAllowed(field.type,value);
  pluginCenter.retired=id=>{void memoryAdapters.retire(id);};
  // Fastify/Pino request and Error serializers may contain raw URLs, bodies or SDK text.
  // Emit only our fixed-schema events, never serialize arbitrary request/error objects.
  const resolveFileModel=(settings:Parameters<FileAnalysis>[2])=>{
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
  let queryRuns:DelegatedQueryRuns;
  const insightRuns=new InsightRuns(store,{executor,evidenceReader});
  resources.defer(()=>insightRuns.close());
  const workflows=new ProcessingRuntime(store,[],{},Date.now,executor,materials,backendContext,configService);
  resources.defer(()=>workflows.close());
  sourcePipelines.setProductConsumer(workflows);workflows.consumerAllowed=(sourceId,bindingId)=>sourcePipelines.options(sourceId).consumers.includes(bindingId);
  const memoryConfiguration=(id?:string,model?:string)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);};
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
  const withMediaOwnerIntent=<T>(id:string,task:()=>Promise<T>|T)=>modelAuthorizationHost.manual('owner-media:'+randomUUID(),availableModelConnections(),async()=>task(),undefined,'manual',[captureModelIdentity(id)]);
  const processing:FileProcessing=new FileProcessing(files,dependencies?.transcriptionProvider,undefined,{modelAuthority:mediaModelAuthority,configService,executor,modules:[...new Set([...(config.backendPluginModules??[]),...(config.fileProcessorModules??[])])],analyze:analyzeFile,analysisSnapshot:resolveFileModel,analysisRevision:()=>modelSettings.view().revision,diagnostics,contextProcessors:workflows.registry,pluginContext:backendContext,mediaAssets,media:config.media,contextForEvidence:record=>materials.contextForEvidence(record)});
  const previousSourceContextChanged=materials.onSourceContextChanged;
  materials.onSourceContextChanged=id=>{previousSourceContextChanged?.(id);processing.invalidateSourceContext(id);};
  resources.defer(()=>processing.settle());
  resources.defer(()=>processing.close());
  await processing.initializeConfiguration();

  const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,materialMemoryWork,input=>modelAuthorizationHost.capture(input));
  resources.defer(disposeCaptureMemoryIntake);
  const perception=new ImageProcessing(store,processing,executor,{modelAuthority:mediaModelAuthority,configService,materials,mediaAssets,media:config.media,understanding:imageUnderstanding({factory,metered:async(settings,attribution,task)=>{
    const meter=admittedUsage(settings.provider,settings.model,'image-understanding',{agentId:'image-understanding',moduleId:'images',skillId:null,...attribution});
    return meter.run(async()=>{try{const output=await task(meter.update);meter.completed();return output;}catch(error){meter.failed(error);throw error;}});
  },selection:service=>{
    const selected=modelSettings.select('file'),resolved=resolveFileModel({...processing.currentSettings(),analysisModel:service}),settings=resolved.settings,configuration=modelConfiguration(service?.id??selected.id,settings,modelSettings.view().revision);
    return {identity:resolved.identity,fingerprint:configuration.fingerprint,configured:service?Boolean(service.apiKey||service.execution==='local'):agent.configuredFor(selected.id),settings,receipt:{profileId:service?.id??selected.id,provider:settings.provider,model:settings.model,revision:modelSettings.view().revision}};
  }})});
  resources.defer(()=>perception.close());
  additionalModelConnections=()=>[...processing.modelConnections(),...configService.current<ProcessingConfiguration>('processing').policy.services.filter(service=>service.kind==='model').map(service=>{const resolved=resolveFileModel({...processing.currentSettings(),analysisModel:service});return agentModelConnection(resolved.identity,resolved.settings);})];
  const semanticSelection=()=>{const selected=modelSettings.select('memory');return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};};
  workflows.registry.register(semanticProcessor({store,memories,query:input=>{const selected=modelSettings.select('memory',input.modelProfileId),traceContext={...input.traceContext,traceId:randomUUID(),operation:'query' as const,moduleId:'memories',profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:input.modelOverride??selected.settings.model};return withQueryModelAuthority(input,'semantic',signal=>agent.query({...input,signal,onTrace:event=>{diagnostics.agentTrace(event,traceContext);input.onTrace?.(event);}}));},records:ids=>store.evidence(ids),selection:semanticSelection,usage:usageLedger}));
  workflows.registry.register(conversationUnderstandingProcessor({memories,usage:usageLedger,
    resolveMemoryPreparation:contract=>memoryPipeline.conversationPreparation(contract),
    selection:config=>{const selected=modelSettings.select('memory',typeof config?.profileId==='string'?config.profileId:undefined);
      return {...modelConfiguration(selected.id,{...selected.settings,...(typeof config?.modelOverride==='string'?{model:config.modelOverride}:{})},modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},
    resolveEvidence:page=>({records:materials.evidence([...new Set(page.spans.flatMap(span=>span.evidenceId?[span.evidenceId]:[]))]),
      ranges:page.spans.map(span=>({id:span.evidenceId!,offset:span.evidenceOffset!,length:span.pageRange.end-span.pageRange.start}))}),
    // The processor owns one receipt through model, parsing and publication.
    // Keep queryAgent admission/diagnostics without metering the same run twice.
    query:input=>queryAgent(input,'query','memories','caller'),
  }));
  const semanticArtifacts=async(ids:string[],operationId?:string,mode?:'lifecycle')=>{
    const ready:string[]=[];
    for(const id of ids){
      const artifact=store.archive.get(id);if(!artifact)continue;
      if(artifact.kind==='semantic'){ready.push(id);continue;}
      if(artifact.kind!=='segment'||artifact.metadata.complete!==true)continue;
      const jobs=workflows.enqueue([{name:'semantic',processor:'mote.segment-understanding',inputs:[],artifactInputs:[{id,revision:artifact.revision}],config:{artifactId:id,modelFingerprint:semanticSelection().fingerprint}}]);
      if(operationId)linkOperationParent(store,operationId,executor.get(jobs.semantic)!.operationId);
      await workflows.tick();
      const row=store.db.prepare('SELECT state,json,error,available_at FROM processing_jobs WHERE id=?').get(jobs.semantic)!;
      if(row.state==='stale')continue;
      if(mode==='lifecycle'&&(row.state==='waiting'||row.state==='running'))throw new ExecutionFailure('waiting',String(row.error??'semantic_processing_pending'),Number(row.available_at)>Date.now()?Math.max(1000,Number(row.available_at)-Date.now()):5000);
      if(mode==='lifecycle'&&(row.state==='failed'||row.state==='blocked'))throw new ExecutionFailure('blocked',row.state==='failed'?'semantic_processing_failed':'semantic_processing_blocked');
      if(row.state!=='succeeded')throw new StoreError('Semantic processing is pending or blocked',409);
      ready.push(...JSON.parse(String(row.json)).outputs);
    }
    return [...new Set(ready)];
  };
  const app=Fastify({logger:false,genReqId:()=>randomUUID(),requestIdHeader:false,bodyLimit:12*1024*1024,requestTimeout:180000,
    routerOptions:{
      // Source IDs allow 128 characters; composite activity IDs allow 512.
      // Keep a finite routing bound above those per-endpoint business limits.
      maxParamLength:1024,
      onMaxParamLength:(_path,req,res)=>{
        const requestId=randomUUID(),locale=negotiateLocale(req.headers['accept-language'],'zh-CN');
        diagnostics.record('request.failed',{requestId,route:'unknown',category:'validation',statusCode:414},'warn');
        res.writeHead(414,{'Content-Type':'application/json; charset=utf-8','Content-Language':locale,'Vary':'Accept-Language','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Request-Id':requestId});
        requestLocale.run(locale,()=>res.end(JSON.stringify({error:'request_path_too_long',message:moteText("请求路径过长，请检查链接。"),requestId})));
      },
    },
    frameworkErrors:(_error,_req,reply)=>{const requestId=randomUUID();diagnostics.record('request.failed',{requestId,route:'unknown',category:'validation',statusCode:400},'warn');(reply as FastifyReply).header('X-Request-Id',requestId).code(400).send({error:'validation',message:moteText("请求格式无效。"),requestId});}});
  startupApp=app;
  app.addContentTypeParser(['application/gzip','application/x-ndjson+gzip'],{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  const routeName=(url:string|undefined)=>{
    if(!url)return 'unknown';if(!url.startsWith('/api/'))return 'web';if(url.endsWith('/image'))return 'image';
    const root=url.split('/')[2];return ({health:'health',status:'status',configuration:'configuration','model-settings':'configuration','execution-settings':'configuration','diagnostics-settings':'configuration',captures:'captures',notes:'notes',devices:'devices',connections:'connections',sources:'sources',materials:'materials',memories:'memories','memory-jobs':'memories',layers:'layers',connectors:'connectors',updates:'updates',activity:'activity',query:'query','query-runs':'query',usage:'configuration',conversations:'conversations',files:'files','archived-files':'files','file-sync':'file-sync','file-processing':'file-processing',insights:'insights','insight-runs':'insights',index:'index',export:'export',import:'import',imports:'import',diagnostics:'diagnostics','support-bundle':'support'} as Record<string,string>)[root]??'unknown';
  };
  app.addHook('onRequest', (req, reply, done) => {
    const locale = negotiateLocale(req.headers['accept-language'], 'zh-CN');
    reply.header('Content-Language', locale).header('Vary', 'Accept-Language');
    requestLocale.run(locale, done);
  });
  app.addHook('onRequest',(req,reply,done)=>diagnostics.run(req.id,()=>{reply.header('X-Request-Id',req.id);diagnostics.record('request.started',{requestId:req.id,method:req.method as import('./diagnostics.js').EventFields['method'],route:routeName(req.routeOptions.url)},'debug');done();}));
  app.addHook('onResponse',async(req,reply)=>{diagnostics.record('request.completed',{requestId:req.id,method:req.method as import('./diagnostics.js').EventFields['method'],route:routeName(req.routeOptions.url),statusCode:reply.statusCode,durationMs:reply.elapsedTime},reply.statusCode>=500?'error':reply.statusCode>=400?'warn':'info');});
  await app.register(cors,{origin:config.allowedOrigins,credentials:false});
  const expectedBearer=Buffer.from(`Bearer ${config.token}`);
  const validBearer=(req:{headers:{authorization?:string}})=>{if(typeof req.headers.authorization!=='string')return false;const supplied=Buffer.from(req.headers.authorization);return supplied.length===expectedBearer.length&&timingSafeEqual(supplied,expectedBearer);};
  let playbackAuthorization:(req:FastifyRequest)=>boolean=()=>false;
  app.addHook('onRequest',async(req,reply)=>{
    const isApi=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(isApi)reply.header('Cache-Control','no-store');
    if(req.method==='OPTIONS'||req.routeOptions.url==='/api/health'||!isApi||(req.method==='POST'&&['/api/connections/redeem','/api/login/exchange','/api/login/requests','/api/login/poll','/api/login/ack'].includes(req.routeOptions.url??'')))return;
    if(validBearer(req)||playbackAuthorization(req))return;
    const c=connections.authenticate(req.headers.authorization);
    if(!c)return reply.code(401).send({error:'unauthorized',message:moteText("请提供有效访问令牌；管理网页请重新登录"),requestId:req.id});
    identities.set(req,c);connections.assertCollectorRoute(c,req.method,req.routeOptions.url??'');
    if(!connections.isOwner(c)&&collectorIngressWrite(req.method,req.routeOptions.url??'')&&req.headers['x-mote-ingress-version']!==INGRESS_PROTOCOL_VERSION)
      return reply.code(426).send({error:'ingress_protocol_upgrade_required',requiredVersion:INGRESS_PROTOCOL_VERSION,requestId:req.id});
  });
  app.setErrorHandler((error,req,reply)=>{
    const failure=safeError(error);
    diagnostics.record('request.failed',{requestId:req.id,method:req.method as import('./diagnostics.js').EventFields['method'],route:routeName(req.routeOptions.url),category:failure.category,reason:failure.reason,statusCode:failure.status},failure.status>=500?'error':'warn');
    if(error instanceof ProviderFailure){if(error.details.retryAfterMs!==undefined)reply.header('Retry-After',String(Math.ceil(error.details.retryAfterMs/1000)));return reply.code(failure.status).send({error:failure.category,message:failure.message,reason:failure.reason,recovery:error.details.category==='blocked'?'needs_action':error.details.category==='transient'?'auto_retry':'permanent',retryAfterMs:error.details.retryAfterMs,requestId:req.id});}
    if(error instanceof ConnectionError)return reply.code(error.statusCode).send({error:error.code,message:error.publicMessage,requestId:req.id});
    if(error instanceof ModelCatalogError)return reply.code(error.statusCode).send({error:'model_catalog_unavailable',message:error.message,requestId:req.id});
    if(error instanceof ModelSettingsError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});
    if(error instanceof ConfigServiceError)return reply.code(error.statusCode).send({error:error.code,message:error.code==='config_conflict'?moteText('配置已发生变化，请刷新后重试。'):moteText('配置未能应用，请检查配置状态后重试。'),requestId:req.id});
    reply.code(failure.status).send({error:failure.category,message:failure.message,...(failure.reason?{reason:failure.reason}:{}),requestId:req.id});
  });
  const actions=new Actions(store,files,input=>queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),()=>agent.configured,{semanticArtifacts,executor,configService});

  resources.defer(()=>actions.close());
  const connectors=await registerConnectors(app,{memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,ownerAuthorization:header=>{if(validBearer({headers:{authorization:header}}))return true;const c=connections.authenticate(header);return !!c&&connections.isOwner(c);},mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)},dependencies?.connectorTesting);

  resources.defer(()=>connectors.close());
  const softwareUpdate=createUpdateService({currentVersion:serverVersion,profile:config.profile,runtime:config.configuration?.runtime,profileHome:config.configuration?.hostConfigFile?dirname(dirname(config.configuration.hostConfigFile)):undefined,repository:config.updateRepository,channel:config.updateChannel});

  resources.defer(()=>softwareUpdate.close());
  // Bounded transport batch with independent durable acknowledgements. Validate the
  // entire envelope and credential scope before writing any member of the batch.

  // Notes share capture IDs, indexing, archive export and deletion tombstones.
  // The convenience route does not rewrite the author's text or infer their mood.

  const mediaRange=z.object({
    after:z.string().max(64).datetime({offset:true}).optional(),before:z.string().max(64).datetime({offset:true}).optional(),
    deviceId:z.string().min(1).max(128).optional(),appId:z.string().min(1).max(300).optional(),collection:z.enum(['content','activity']).optional(),
    appVisibility:z.enum(['foreground','background','unknown']).optional(),
    screenLocked:z.enum(['true','false']).transform(value=>value==='true').optional(),playbackType:z.enum(['local','remote','unknown']).optional(),
  }).strict().refine(value=>!value.after||!value.before||Date.parse(value.after)<Date.parse(value.before),{message:'Invalid time range'});

  let closing=false;
  const activeQueries=new Set<Promise<QueryResult>>();
  resources.defer(async()=>{closing=true;await Promise.allSettled([...activeQueries]);});
  function withQueryModelAuthority<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>){
    const job=input.traceContext?.jobId?memoryModelAuthorityJobs.modelAuthorityJob(input.traceContext.jobId):undefined;
    const grants=job?.automaticGrants??[];
    const candidates=()=>grants.length?grants.map(grant=>sourceModelIdentity(grant.sourceId,grant.inputKey)):job?modelAuthorizationHost.evidenceTriggers(job.evidenceIds):modelAuthorizationHost.queryTriggers(input);
    // Each owner-selected recipe is an independent prospective consumer. Its
    // immutable input grant scope prevents one sibling from consuming another's
    // trigger, without letting retries mint a new purpose from their job ID.
    const memoryScope=grants[0]?.scope;
    if(memoryScope&&grants.some(grant=>grant.scope!==memoryScope))throw new StoreError('Memory job mixes recipe authorization scopes',409);
    const purpose:AutomaticModelPurpose=moduleId==='memories'&&memoryScope?`memory:${memoryScope}`:moduleId==='activity'?'activity':moduleId==='actions'?'actions':moduleId==='insights'?'insight':moduleId==='memories'?'memory':moduleId==='semantic'?'semantic':'working';
    const id=job?'automatic-memory:'+job.id:'automatic-'+moduleId+':'+(input.traceContext?.operationId??randomUUID());
    return modelAuthorizationHost.automatic(id,purpose,candidates,signal=>{
      const batch=input.traceContext?.batchId?executor.get(input.traceContext.batchId):undefined;
      if(job&&batch?.kind==='memory.batch'&&batch.input.jobId===job.id)modelAuthorization.bindCurrentStep(batch);
      return task(signal);
    },input.signal);
  }
  function queryAgent(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations',usageOwner:'query'|'caller'='query') {
    return withQueryModelAuthority(input,moduleId,signal=>queryAgentAuthorized({...input,signal},operation,moduleId,usageOwner));
  }
  function queryAgentAuthorized(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations',usageOwner:'query'|'caller'='query') {
    if(closing)throw new StoreError('Central node is shutting down',503);
    input=pinProcessingEvidence(input);
    if(input.skill==='personal-insight'&&!input.validateOutput)input={...input,validateOutput:validateInsightOutput};
    const profile=modelSettings.select(input.responseMode==='memory-extraction'||input.skill==='memory-extraction'||input.skill==='coding-memory'||moduleId==='memories'?'memory':input.skill==='personal-insight'?'insight':'chat',input.modelProfileId);
    input={...input,language:input.language??requestLocale.getStore()??'zh-CN',modelProfileId:profile.id,modelOverride:input.modelOverride??profile.settings.model};
    if(input.contextEvidenceDependencies)input={...input,contextEvidenceDependencies:resolveDependencies(store,input.contextEvidenceDependencies)};
    const configuration=modelConfiguration(profile.id,{...profile.settings,model:input.modelOverride!},modelSettings.view().revision);
    const traceContext:AgentTraceContext={...input.traceContext,traceId:randomUUID(),requestId:diagnostics.requestId(),operation,moduleId,profileId:profile.id,provider:profile.settings.provider,protocol:profile.settings.protocol,model:input.modelOverride??profile.settings.model};
    const startedAt=Date.now();let lastActivity=startedAt,failureRunId:string|undefined;
    const trace=(event:AgentTraceEvent)=>{
      if(event.runId)failureRunId=event.runId;
      lastActivity=Date.now();diagnostics.agentTrace(event,traceContext);
      if(event.type==='tool.rejected'){
        const payload=(event.payload??{}) as Record<string,unknown>;
        diagnostics.record('agent.tool_rejected',{requestId:traceContext.requestId,jobId:traceContext.jobId,batchId:traceContext.batchId,batchIndex:traceContext.batchIndex,attempt:traceContext.attempt,runId:event.runId,
          toolErrorCode:typeof payload.code==='string'?payload.code:undefined,
          remainingCalls:typeof payload.remainingCalls==='number'?payload.remainingCalls:undefined,
          remainingCharacters:typeof payload.remainingCharacters==='number'?payload.remainingCharacters:undefined,
          repeatCount:typeof payload.repeatCount==='number'?payload.repeatCount:undefined},'warn');
      }
      input.onTrace?.(event);
    };
    trace({type:'query.started',stage:'starting',payload:{question:input.question,taskContext:input.taskContext??null,conversation:input.conversation??null,evidenceIds:input.evidenceIds??null,evidenceRanges:input.evidenceRanges??null,evidenceReadRanges:input.evidenceReadRanges??null,scope:{after:input.after??null,before:input.before??null,deviceId:input.deviceId??null,timeZone:input.timeZone??null},skill:input.skill??null,responseMode:input.responseMode??'answer'}});
    const revision=store.deletionRevision();
    const meter=usageOwner==='query'?admittedUsage(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,{agentId:'context-query',moduleId,skillId:input.skill??null,operationId:input.traceContext?.operationId,jobId:input.traceContext?.jobId,requestId:diagnostics.requestId()}):undefined;
    // Agent implementations account admitted model/tool/repair work. A second
    // wall-clock deadline here would charge host resource-gate waiting again.
    const deadline=agentDeadline(input.signal,null),taskSignal=deadline.signal;
    let disclosedSourcePins=sourceContextDependencies(input);
    const disclosedProcessingIds:string[]=[],processingIds=new Set<string>();
    const observed:QueryInput&{processingDisclosedEvidenceIds?:string[]}={...input,contextSourceContextDependencies:disclosedSourcePins,signal:taskSignal,traceContext,
      ...(input.responseMode==='memory-extraction'&&input.evidenceIds!==undefined?{processingDisclosedEvidenceIds:disclosedProcessingIds,onEvidence:(records:readonly import('@mote/agent').ContextRecord[])=>{
        for(const record of records)if(!processingIds.has(record.id)){processingIds.add(record.id);disclosedProcessingIds.push(record.id);}
        input.onEvidence?.(records);
      }}:{}),
      onSourceContextDependencies:pins=>{
        const next=combineSourceContextDependencies([disclosedSourcePins,pins]);
        assertSourceContextDependencies(sourceContexts,next);
        disclosedSourcePins=next;observed.contextSourceContextDependencies=next;
        input.onSourceContextDependencies?.(pins);
      },
      onProgress:(event:import('@mote/agent').AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},onTrace:trace,onUsage:(tokens:import('@mote/shared').TokenUsage)=>{meter?.update(tokens);input.onUsage?.(tokens);}};
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>(meter?meter.run(()=>agent.query(observed)):agent.query(observed)).then(result=>{
      taskSignal?.throwIfAborted();
      assertModelEvidence(observed);
      if(observed.executionLane==='interactive'&&observed.evidenceIds&&result.citations.some(citation=>![...observed.evidenceIds!,...(observed.directImages?.map(image=>image.id)??[])].includes(citation.id)))throw contextFailure('context_evidence_restricted');
      const selectedDependencies=observed.executionLane==='interactive'&&observed.evidenceIds?{version:1 as const,complete:true,ids:[...observed.evidenceIds,...(observed.directImages?.map(image=>image.id)??[])]}:undefined;
      const evidenceDependencies=resolveDependencies(store,combineDependencies([contextDependencies(input),result.evidenceDependencies??selectedDependencies]));
      // Metadata/declaration reads also pin their original Material lineage.
      // They need correction fences even when no original quote was expanded.
      if(evidenceDependencies){
        const historicalIds=new Set([...(input.conversation?.historyContext?input.conversation.evidenceDependencies?.ids??[]:[]),...(input.historyContext?input.contextEvidenceDependencies?.ids??[]:[])]);
        assertModelEvidence({question:'',contextEvidenceDependencies:{...evidenceDependencies,ids:evidenceDependencies.ids.filter(id=>!historicalIds.has(id))}});
      }
      const sourcePins=combineSourceContextDependencies([disclosedSourcePins,result.sourceContextDependencies]);
      assertSourceContextDependencies(sourceContexts,sourcePins);
      // A long-running review may overlap routine imports and derived-layer updates.
      // Only an original actually disclosed to this run being deleted can make
      // its answer unsafe to publish; other archive changes belong to later runs.
      if(store.deletionRevision()!==revision){
        const used=new Set([...(input.derivedContextEvidenceIds??[]),...(contextDependencies(input)?.ids??[]),...(evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        for(const row of store.db.prepare("SELECT id FROM changes WHERE seq>? AND operation='delete'").iterate(revision)){
          if(!evidenceDependencies?.complete||used.has(String(row.id)))throw new StoreError('Evidence used by this answer was deleted during the run',409);
        }
      }
      trace({type:'query.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{answer:result.answer,citations:result.citations,trace:result.trace,contextUsage:(result as QueryResult & {contextUsage?:unknown}).contextUsage}});
      const completedUsage=meter?.completed();
      return {...result,...(evidenceDependencies?{evidenceDependencies}:{}),...(sourcePins.length?{sourceContextDependencies:sourcePins}:{}),configuration,...(completedUsage?{usage:completedUsage}:{})};
    }).catch(error=>{
      if(error instanceof AgentYieldError){meter?.completed();trace({type:'query.yielded',status:'waiting'});throw error;}
      const wait=error instanceof ProviderFailure&&(error.details.admissionWaiting===true||error.details.category==='transient'&&error.details.code==='rate_limited')?{code:error.details.code,retryAfterMs:error.details.retryAfterMs}:error instanceof ExecutionFailure&&error.category==='waiting'?{code:error.code,retryAfterMs:error.retryAfterMs}:undefined;
      meter?.failed(error);
      retainFailureContext(error,{runId:failureRunId,phase:input.traceContext?.phase,jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId});
      trace(wait?{type:'query.waiting',status:'waiting',payload:wait}:{type:'query.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:typeof (error as {reason?:unknown})?.reason==='string'?(error as {reason:string}).reason:undefined}});throw error;
    }),result=>({citations:result.citations.length,toolCalls:result.trace.length,activeQueries:activeQueries.size}));
    activeQueries.add(promise);void promise.finally(()=>{deadline.dispose();clearInterval(heartbeat);activeQueries.delete(promise);}).catch(()=>{});return promise;
  }
  const memoryReviews=new MemoryReviewCache();resources.defer(()=>memoryReviews.clear());
  const reviewExtraction=(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:import('./memory-review.js').MemoryDraftOrigin)=>reviewMemory(input,result,next=>queryAgent(next,'query','memories'),{
    draftOrigin,strategy,deletions:memories.deletions,authorizeDeletionEvidence:ids=>memoryPipeline.inputs.assertDeletion(ids,input.modelProfileId),cache:memoryReviews,snapshot:()=>{
      const ids=input.evidenceReadRanges?[...new Set([...(input.evidenceIds??[]),...memoryReadRanges(result,input.evidenceRanges??[],input.evidenceReadRanges).map(range=>range.id)])]:input.evidenceIds??[];
      if(ids.some(id=>!memories.isCurrentEvidence(id)))throw new StoreError('Memory evidence changed during review',409);
      // Include full original metadata (speaker, source, device, dates, version),
      // not just quote text. Credentials/config are hashed, never retained.
      return sha256(JSON.stringify([modelSettings.select('memory',input.modelProfileId).settings,memories.readEvidence(ids)]));
    },
  });
  const understandConversation:NonNullable<import('./memory-pipeline.js').MemoryPhasePorts['understand']>=async input=>{
    const refs=[...new Set(input.ranges.map(range=>input.materialRefs[range.id]))];
    if(refs.length!==1||!refs[0])return;
    const material=materials.get(refs[0]);
    if(!material||material.kind!=='mote.coding-session')return;
    if(material.schemaVersion<CODING_DIALOGUE_SCHEMA_VERSION)throw new ExecutionFailure('blocked','coding_dialogue_not_clean');
    const pages=materials.conversationInputs(material.ref,input.ranges);
    const configuration=input.job.configuration!;
    return withQueryModelAuthority({question:'',traceContext:{jobId:input.job.id,batchId:input.parentGrant.stepId},signal:input.signal},'memories',async signal=>{
    const jobs=workflows.enqueue([{name:'conversation',processor:'mote.coding-conversation-understanding',materialInputs:pages,
      config:{memoryPreparation:true,modelFingerprint:configuration.fingerprint,profileId:configuration.profileId,modelOverride:configuration.model,
        contextTime:input.job.contextTime,timeZone:input.job.timeZone,language:input.job.language,generationContract:input.generationContract,processingMaterialInputs:input.materialInputs.map(pin=>({materialId:pin.materialId,required:pin.required,fingerprint:pin.fingerprint,evidenceIds:pin.evidenceIds.filter(id=>input.ranges.some(range=>range.id===id))}))}}],input.parentGrant);
    linkOperationParent(store,'memory:'+input.job.id,executor.get(jobs.conversation)!.operationId);
    const abort=()=>executor.abortLocal(jobs.conversation);signal.addEventListener('abort',abort,{once:true});
    try{await executor.drain([jobs.conversation]);signal.throwIfAborted();}
    finally{signal.removeEventListener('abort',abort);}
    const step=executor.get(jobs.conversation)!;
    if(step.state==='waiting'||step.state==='running')throw new ExecutionFailure('waiting',step.error??'semantic_processing_pending',step.availableAt>Date.now()?Math.max(1000,step.availableAt-Date.now()):5000);
    if(step.state!=='succeeded')throw new ExecutionFailure(step.state==='stale'?'stale':step.state==='failed'?'permanent':'blocked',step.state==='blocked'?'semantic_processing_blocked':step.error??'semantic_processing_failed');
    const row=store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(jobs.conversation)!;
    return (JSON.parse(String(row.json)).outputs as string[]).map(id=>({id,revision:String(store.archive.revision(id)!)}));
    });
  };
  const memoryPublication=new MemoryPublication(store,memories,memoryBindings,executor);
  resources.defer(()=>memoryPublication.close());
  memoryPublication.revokeEvidence=ids=>memoryAdapters.erasePreparedEvidence(ids);
  let memoryTopics:MemoryTopicsHost|undefined;
  const memoryPipeline=new MemoryPipeline({onPublished:(step,items,job)=>memoryTopics?.enqueue(step,items,job.configuration?.profileId??job.modelProfileId,job.configuration?.model??job.modelOverride),assertIntegrationAuthority:()=>modelAuthorization.assertCurrent(),withIntegrationAuthority:(id,manual,evidenceIds,task)=>manual?modelAuthorization.run('owner-integration:'+id,task):modelAuthorizationHost.automatic('automatic-integration:'+id,'integration',modelAuthorizationHost.evidenceTriggers(evidenceIds),task),integrationReadInput:cards=>memoryIntegrationImageInputs(store,materials,cards.flatMap(card=>card.evidence)),assertIntegrationReadable:cards=>evidenceReader.assertMemoryReadable(cards),publication:memoryPublication,assertNewManualWork:()=>memoryBindings.assertNewManualWork(),nativeStages:{settle:async context=>{if(!context.provider)throw new StoreError('Native Memory cleanup has no pinned provider configuration',503);await memoryAdapters.discardPrepared({...context.provider,opId:context.opId,phase:context.phase});},prepare:async(input,context)=>withQueryModelAuthority(input,'memories',async signal=>{input={...input,signal};const binding=memoryBindings.binding();if(memoryBindings.view().mode!=='engine')return;const namespace=binding.namespace!;context.provider={instanceId:namespace.instanceId,namespace,configurationIdentity:memoryAdapters.configurationIdentity(namespace.instanceId,namespace)};input.signal?.throwIfAborted();const originals=memories.readEvidence(context.evidenceIds);if(originals.length!==new Set(context.evidenceIds).size)throw new StoreError('Engine originals are unavailable',409);const evidence=input.evidenceRanges?.map(range=>{const record=originals.find(record=>record.id===range.id);if(!record)throw new StoreError('Engine original range is unavailable',409);return {record,offset:range.offset,length:range.length};})??originals;
    const engineProfile=pluginCenter.instanceView(namespace.instanceId).configuration.modelProfileId;if(typeof engineProfile!=='string')throw new StoreError('Native Memory model profile is missing',409);
    const engineConnection=agentModelConnection({kind:'profile',id:engineProfile},modelSettings.select('memory',engineProfile).settings),assertAuthority=modelAuthorization.capture(engineConnection);
    const bindingIdentity=JSON.stringify(binding),pins=new Map(originals.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const assert=()=>{assertAuthority();input.signal?.throwIfAborted();context.assertAuthority?.();assertModelEvidence(input);if(JSON.stringify(memoryBindings.binding())!==bindingIdentity)throw new StoreError('Native Memory binding changed',409);for(const [id,fingerprint] of pins){const current=memories.readEvidence([id])[0];if(!current||!memories.isCurrentEvidence(id)||memoryEvidenceFingerprint(current)!==fingerprint||!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()))throw new StoreError('Native Memory originals were changed or revoked',409);}};
    assert();const transportAssert=(settings:import('@mote/shared/models').ModelSettings)=>{if(agentModelConnection({kind:'profile',id:engineProfile},settings).fingerprint!==engineConnection.fingerprint)throw new StoreError('Native Memory model snapshot changed',409);assert();};hindsightAuthorities.set(context.opId,transportAssert);
    try{const result=await memoryAdapters.engine(namespace.instanceId,namespace).prepare({namespace,opId:context.opId,phase:context.phase,evidence,relatedMemories:context.relatedMemories,signal:input.signal});assert();input.onEvidence?.(originals);if(context.relatedMemories?.length)input.onMemoryBodies?.(context.relatedMemories);return result;}finally{if(hindsightAuthorities.get(context.opId)===transportAssert)hindsightAuthorities.delete(context.opId);}})},batchCharacters:()=>storedMemoryLifecycleSettings(store).batchCharacters,strategies:memoryStrategies,executor,store,memories,concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,admission:{materialSourceCurrent:(pin,id)=>evidenceReader.materialSourceCurrent(pin,id),materialPlanAllowed:id=>evidenceReader.materialPlanAllowed(id,new EvidenceExposurePolicy()),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:ref=>materialMemoryWork.sourceRequirements(ref),automaticAllowed:job=>materialMemoryWork.authorized(job)&&[...(job.automaticGrants??[]),...(job.automaticGrant?[job.automaticGrant]:[])].every(grant=>sourcePipelines.memoryAllowed(grant.sourceId)),deletionEvidenceAllowedForMemory:id=>evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()),materialAllowedForMemory:(ref,profileId,required)=>evidenceReader.materialAllowedForMemory(ref,new EvidenceExposurePolicy(),required)},models:{configuration:memoryConfiguration,model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}}},phases:{understand:understandConversation,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),review:reviewExtraction,query:input=>queryAgent(input,'query','memories'),skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`}});
  resources.defer(()=>memoryPipeline.close());
  memoryRecipeSettings.onChange=()=>materialMemoryWork.inputs.revokeDisabled();
  memoryRecipeSettings.onApplied=()=>materialMemoryWork.reconcile(memoryPipeline);
  materialMemoryWork.reconcile(memoryPipeline);
  const lifecycle=new MemoryLifecycle(store,()=>agent.configured,Date.now,executor,dependencies?.semanticContextTime,configService);
  resources.defer(()=>lifecycle.close());
  const working=new WorkingMemory(store,conversations);
  lifecycle.automaticAdmission=id=>!['extraction','consolidation'].includes(id)||memoryBindings!.accepting();
  memoryBindings.onReleased=()=>lifecycle.skipAutomaticBacklog();
  pluginCenter.admissionChanged=(id,enabled)=>{if(memoryBindings!.binding().namespace?.instanceId===id){if(enabled)lifecycle.skipAutomaticBacklog();memoryAutomation.touch();}};
  const memoryControl=createMemoryControl({store,pipeline:memoryPipeline,lifecycle,executor,publication:memoryPublication});
  memoryBindings.pendingTail=memoryControl.pendingTail;
  memoryAutomation.onResume=memoryControl.resume;
  memoryAutomation.onStop=memoryControl.stop;
  memoryAutomation.counts=memoryControl.counts;
  const memoryIntegrationSettings=new MemoryIntegrationSettings(store,memoryStrategies);
  registerMemoryExtensions({integrationSettings:memoryIntegrationSettings,semanticArtifacts,providerCooldownCheck:()=>providerAdmission.check(modelSettings.select('memory').settings),insights:insightRuns,insightTimeout:()=>modelSettings.select('insight').settings.agentTimeoutMs,lifecycle,store,files,memories,pipeline:memoryPipeline,working,query:(input,module)=>queryAgent(input,input.skill==='personal-insight'?'insight':'query',module),model:()=>modelSettings.select('memory').settings.model});
  for(const extension of dependencies?.memoryExtensions??[])lifecycle.replace(extension);

  const importAgents=new Set<ReturnType<typeof createImportAgent>>(),importTasks=new Map<string,Promise<unknown>>();
  resources.defer(async()=>{await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));await Promise.allSettled([...importTasks.values()]);});
  const sourcePacks=new Map((config.importPythonPacks??[]).map(spec=>{
    const executor=new PythonSourcePackExecutor<PythonImportOutput>({...spec,outputSchema:pythonImportOutputSchema});
    return [spec.id,{revision:sha256(JSON.stringify(spec)),prepare:pythonImportPreparation(executor)}] as const;
  }));
  const imports=new ImportStore(store,archivedFiles,sources,{executor,intake:processing.runtime.intake,fileStore:files,
    sourcePacks,
    bindPhaseAuthority:step=>{
      // Only this import's explicit owner action may fill a missing binding.
      // An already-bound step keeps its original durable authority on retries.
      if(modelAuthorization.ownerIntent(step.operationId)&&!modelAuthorization.stepAuthority(step.id))modelAuthorization.bindCurrentStep(step);
    },
    prepare:dependencies?.prepareImport??(async input=>{
      if(!agent.configured)throw new AgentNotConfiguredError();
      const selected=modelSettings.select('import');if(!agent.configuredFor(selected.id))throw new AgentNotConfiguredError();
      const settings=selected.settings,connection=agentModelConnection({kind:'profile',id:selected.id},settings),prepared=await prepareImportInput(input);modelAuthorization.assertCurrent(connection);
      const meter=admittedUsage(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId:input.operationId});
      const operationId=input.operationId??'import:'+randomUUID();
      let runtime:ReturnType<typeof createImportAgent>|undefined;const abort=()=>{void runtime?.close();};input.signal?.addEventListener('abort',abort,{once:true});
      try{runtime=createImportAgent({...settings,codex,runModel:runModelFor(settings,connection),authorizeModelRequest:()=>{modelAuthorization.assertCurrent(connection);authorizeModelRequest();}});importAgents.add(runtime);const {signal:_signal,operationId:_operationId,...request}=prepared;const result=await meter.run(()=>agentGate.run(()=>modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},dependencies?.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>meter.update(usage)))),input.signal,input.operationId));input.signal?.throwIfAborted();modelAuthorization.assertCurrent(connection);meter.completed();return result;}
      catch(error){meter.failed(error);throw error;}finally{input.signal?.removeEventListener('abort',abort);try{await runtime?.close();}finally{if(runtime)importAgents.delete(runtime);}}
    }),
    // Each original receipt owns its automatic authorization. Ready materials
    // enter the shared rolling queue; import completion must not create a second job.
    onImported:async()=>({}),
  });
  resources.defer(()=>imports.stop());
  const launchOwnerImport=(id:string,task:()=>Promise<unknown>)=>{const work='owner-import:'+randomUUID();modelAuthorization.manual(work,'manual',['import:'+id],availableModelConnections());launchImport(id,()=>modelAuthorization.run(work,task));};
  const withMediaOwnerBatch=async<T>(ids:readonly string[],task:()=>T)=>modelAuthorization.manualCommand('owner-media-batch:'+randomUUID(),ids.map(captureModelIdentity),availableModelConnections(),task);
  function launchImport(id:string,task:()=>Promise<unknown>){
    if(closing)throw new StoreError('Central node is shutting down',503);
    if(importTasks.has(id))return;
    const promise=Promise.resolve().then(()=>closing?undefined:task());
    importTasks.set(id,promise);
    void promise.finally(()=>importTasks.delete(id)).catch(()=>{diagnostics.record('agent.failed',{category:'internal'},'error');});
  }
  const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;

  const delegation=new DelegationRuntime(store,executor,{observePump:()=>executionObserver.hostTick(),concurrency:()=>runtimeSettings.execution().agentConcurrency,interactiveConcurrency:()=>runtimeSettings.execution().interactiveConcurrency,
    validateDependencies:ids=>assertModelEvidence({question:'',contextEvidenceDependencies:{version:1,complete:true,ids:[...ids]}}),
    validateSourceContextDependencies:pins=>assertSourceContextDependencies(sourceContexts,pins),
    revalidateEvidence:async receipts=>{
      const ids=[...new Set(receipts.map(receipt=>receipt.id))],policy=new EvidenceExposurePolicy();
      if(ids.some(id=>!evidenceReader.deletionContextAllowed(id,policy)))throw contextFailure('context_evidence_restricted');
      const originals=evidenceReader.context(evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id))));
      if(originals.length!==ids.length)throw contextFailure('context_evidence_restricted');
      return originals;
    },
  });
  resources.defer(()=>delegation.close());
  const {prepare:prepareDelegatedQuery}=createQueryPreparation({store,files,conversations,delegation,executor,modelSettings,working,
    lifecycleSettings:()=>lifecycle.settings(),archiveReader,configured:()=>agent.configured,authority:modelEvidenceAuthority,
    query:input=>queryAgent(input,'query','conversations'),qualityStrategy:dependencies?.queryQualityExperiment});
  function qualityCheckpoint(input:QueryInput):QueryQualityCheckpoint|undefined{
    if(!dependencies?.queryQualityExperiment||!input.hostControlChannel)return;
    const work=delegation.get(input.traceContext!.operationId!),stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const assertCurrent=()=>{
      input.signal?.throwIfAborted();
      if(!fence||!executor.isCurrentInputGrant(stepId,fence))throw new StoreError('Query stage grant expired',409);
      const saved=delegation.journal.payload<SavedQuery>(work.id);
      if(saved.qualityStrategy!==dependencies.queryQualityExperiment)throw new StoreError('Query experiment strategy changed',409);
      const selected=modelSettings.select('chat',saved.prepared!.modelProfileId),current=modelConfiguration(selected.id,{...selected.settings,model:saved.prepared!.modelOverride??selected.settings.model},modelSettings.view().revision);
      if(saved.configurationFingerprint!==current.fingerprint)throw new StoreError('Query model configuration changed',409);
      assertModelEvidence(saved.prepared);
    };
    const assertResult=(result:QueryResult)=>{assertModelEvidence({...delegation.journal.payload<SavedQuery>(work.id).prepared!,contextEvidenceDependencies:result.evidenceDependencies});assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);};
    return {assertCurrent,read:stage=>{
      assertCurrent();const result=delegation.journal.payload<SavedQuery>(work.id).qualityStages?.[stage];if(result)assertResult(result);return result;
    },write:(stage,result)=>{
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        assertCurrent();assertResult(result);
        delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        delegation.recordSourceContextDependencies(work.id,result.sourceContextDependencies??[]);
        const saved=delegation.journal.payload<SavedQuery>(work.id);saved.qualityStages={...saved.qualityStages,[stage]:result};delegation.journal.savePayload(work.id,saved);
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }};
  }
  queryRuns=new DelegatedQueryRuns(store,delegation,{
    contextTime:()=>freezeSemanticContextTime(dependencies?.semanticContextTime),
    resolveInput:raw=>{
      const input=queryWithAttachmentsSchema.parse(raw);
      const previous=input.conversationId?conversations.get(input.conversationId).scope:undefined;
      // Freeze resolved selection in the accepted run, before asynchronous preparation.
      const selected=input.evidenceIds?{...input,anchorEvidenceIds:null,anchorMaterialRef:null}:
        input.anchorEvidenceIds?{...input,evidenceIds:null,anchorMaterialRef:null}:
        input.anchorMaterialRef?{...input,evidenceIds:null,anchorEvidenceIds:null}:
        {...input,...(input.evidenceIds===undefined&&previous?.evidenceIds?{evidenceIds:[...previous.evidenceIds]}:{}),...(input.anchorEvidenceIds===undefined&&previous?.anchorEvidenceIds?{anchorEvidenceIds:[...previous.anchorEvidenceIds]}:{}),...(input.anchorMaterialRef===undefined&&previous?.anchorMaterialRef?{anchorMaterialRef:previous.anchorMaterialRef}:{})};
      if(selected.anchorMaterialRef&&!evidenceReader.queryMaterialReference(selected.anchorMaterialRef,{
        ...(selected.after?{after:selected.after}:{}),...(selected.before?{before:selected.before}:{}),...(selected.deviceId?{deviceId:selected.deviceId}:{})
      }))throw Object.assign(new StoreError(moteText('参考原件暂不可用，请清除参考后继续。'),409),{code:'context_evidence_restricted'});
      return selected;
    },
    prepare:prepareDelegatedQuery,
    query:input=>runQueryQualityExperiment(input,dependencies?.queryQualityExperiment??'base',(next,stage)=>queryAgent({...next,traceContext:{...next.traceContext,phase:'quality.'+stage}},'query',stage==='base'?'conversations':'query.'+stage),qualityCheckpoint(input)),
    operationUsage:(operationId,createdAt,finishedAt)=>usageLedger.operation(operationId,createdAt,finishedAt),
    commit:(body,result,work)=>{
      const {conversationId,question,attachmentIds=[]}=queryWithAttachmentsSchema.parse(body),saved=delegation.journal.payload<SavedQuery>(work.id),prepared=saved.prepared!;
      assertModelEvidence(prepared);
      assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);
      delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
      const previous=conversationId?conversations.get(conversationId):undefined,scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds','anchorMaterialRef'] as const)if(prepared[key]!==undefined)Object.assign(scope,{[key]:prepared[key]});
      if(prepared.historicalSelection)Object.assign(scope,prepared.historicalSelection);
      return conversations.append(previous,{question,...scope,attachments:prepared.directImages?.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result);
    },
    failure:(body,error)=>{
      const {conversationId,question,evidenceIds,anchorEvidenceIds,anchorMaterialRef,...selected}=queryWithAttachmentsSchema.parse(body),scope:QueryScope={...(evidenceIds?{evidenceIds}:{}),...(anchorEvidenceIds?{anchorEvidenceIds}:{}),...(anchorMaterialRef?{anchorMaterialRef}:{})};for(const key of ['after','before','deviceId','timeZone'] as const)if(selected[key]!==undefined&&selected[key]!==null)scope[key]=selected[key]!;
      const failure=safeError(error);return conversations.appendFailure(conversationId?conversations.get(conversationId):undefined,{question,...scope},{code:failure.category,message:failure.message});
    },
  });
  resources.defer(()=>queryRuns.close());
  const memoryDelegation=registerMemoryDelegation({runtime:delegation,pipeline:memoryPipeline,work:materialMemoryWork,sourcePipelines,configuration:()=>memoryConfiguration(),allowCandidate:(candidate,input)=>evidenceReader.materialAllowedForMemory(candidate.ref,new EvidenceExposurePolicy(),input.required),query:input=>queryAgent(input,'query','memories'),sample:async(candidate,offset,length)=>{
    const input=materialMemoryWork.planningInput(candidate);
    if(!input?.ready||input.fingerprint!==candidate.fingerprint||!materialMemoryWork.inputs.available(candidate.sourceId,candidate.inputKey,undefined,candidate.scope)||!sourcePipelines.memoryAllowed(candidate.sourceId))throw new StoreError('Memory sample authorization changed',409);
    const records=await archiveReader.evidence({ids:input.evidenceIds.slice(0,8)});return records.flatMap(record=>offset<record.ocrText.length?[originalEvidenceReceipt(record,offset,Math.min(length,record.ocrText.length-offset))]:[]);
  }});

  resources.defer(()=>memoryDelegation.close());

  async function insight(range:QueryScope&{prompt?:string;modelProfileId?:string},onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId='insight:'+randomUUID(),snapshot?:import('@mote/shared').InsightSnapshot) {
    if(!agent.configured)throw new AgentNotConfiguredError();
    const {prompt,...scope}=range;
    const result=insightResult(await queryAgent({question:prompt||moteText("请回顾这段时间的个人上下文，选择有证据支撑的发现。区分事实、推断与信息缺口，保留来源引用，用 personal-insight Skill 生成完整文字报告和静态 HTML 展示。"),skill:'personal-insight',...scope,...(snapshot?{...snapshot.scope,contextTime:snapshot.asOf,insightSnapshot:snapshot}:{}),onProgress,signal,traceContext:{operationId}},'insight','insights'));
    signal?.throwIfAborted();return {...result,...(snapshot?{snapshot}:{})};
  }

  function diagnosticSnapshot() {
    const counts=store.indexCounts(),devices=store.devices(),storage=store.stats();
    return {version:1,scope:'central-safe-diagnostics',...diagnostics.snapshot(),execution:{failureReceipts:executor.failureDiagnostics(),agents:agentGate.snapshot(),llm:llmGate.snapshot(),interactive:interactiveGate.snapshot(),interactiveHarness:interactiveModelGate.snapshot(),delegated:executor.poolSnapshot('delegated-agents')},services:{agentConfigured:agent.configured,embeddingConfigured:indexer.configured,activeQueries:activeQueries.size,closing},queue:{index:counts,devices:devices.length,reportedPending:devices.reduce((n,d)=>n+d.queueDepth,0)},storage:{captures:storage.captures,imageCaptures:storage.imageCaptures,blobs:storage.blobs,bytes:storage.bytes,logicalBytes:storage.logicalBytes,maxBytes:storage.maxBytes,imagesEncrypted:storage.imagesEncrypted}};
  }

  const web=dependencies?.webRoot??join(repositoryRoot,'apps/web/dist');
  let webVersion:string|null=null;
  try {webVersion=JSON.parse(readFileSync(join(web,'build-info.json'),'utf8')).version??null;} catch {}

  if(existsSync(web)) {
    app.addHook('onRequest',async(req,reply)=>{if(!req.url.startsWith('/api/')&&webVersion!==serverVersion)return reply.code(503).type('text/plain; charset=utf-8').send('Web/server build mismatch. Run npm run build -w @mote/web and restart the server.');});
    // A catch-all static route masks rejected API parameters as missing files.
    await app.register(staticFiles,{root:web,prefix:'/',wildcard:false,preCompressed:true,
      setHeaders:(reply,path)=>{if(relative(web,path).startsWith(`assets${sep}`))reply.header('Cache-Control','public, max-age=31536000, immutable');}});
    app.setNotFoundHandler(async(req,reply)=>{
      if(req.url.startsWith('/api/'))return reply.code(404).send({error:'not_found',requestId:req.id});
      // A removed hashed bundle must not receive the SPA HTML fallback. Open
      // tabs can still request the previous build's lazy pages after upgrades.
      if(req.url.startsWith('/assets/'))return reply.header('Cache-Control','no-store').code(404).send({error:'not_found',requestId:req.id});
      return reply.type('text/html').sendFile('index.html');
    });
    app.addHook('onSend',async(req,reply,payload)=>{
      if(!req.url.startsWith('/api/')&&String(reply.getHeader('Content-Type')??'').startsWith('text/html'))reply.header('Cache-Control','no-store');
      if(!req.url.startsWith('/api/'))reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return payload;
    });
  } else app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'not_found',message:moteText("未找到所请求的资料。"),requestId:req.id}));
  const maintenanceWorker=dependencies?.backgroundWorker?new MaintenanceWorker(config):undefined;
  resources.defer(()=>maintenanceWorker?.close());
  const activity=new ActivityProjection(store,new Operations(store),{delegation});
  const applyExecution=(value:ExecutionSettingsValue)=>{
    interactiveGate.configure(value.interactiveConcurrency);interactiveModelGate.configure(value.interactiveConcurrency);
    agentGate.configure(value.agentConcurrency);llmGate.configure(value.llmConcurrency);
  };
  configService.setHandler<ExecutionSettingsValue>('execution',(next,previous)=>({apply:()=>{},publish:()=>applyExecution(next),rollback:()=>{applyExecution(previous);memoryPipeline.wake();},complete:()=>memoryPipeline.wake()}));
  configService.setHandler<DiagnosticsSettingsValue>('diagnostics',next=>diagnostics.prepareConfiguration(next));
  configService.setHandler<{syncIntervalMs:number}>('connectors',(next,previous)=>({apply:()=>{},publish:()=>connectors.configureSyncInterval(next.syncIntervalMs),rollback:()=>connectors.configureSyncInterval(previous.syncIntervalMs)}));
  const automaticActivity=new AutomaticActivity(store,materials,executor,configService,{query:input=>queryAgent(input,'query','activity'),selection:profileId=>{const selected=modelSettings.select('chat',profileId);return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},lane:()=>workflows.settings().semantic});
  resources.defer(()=>automaticActivity.close());
  const featureServices={pluginCenter,withMediaOwnerBatch,launchOwnerImport,withMediaOwnerIntent,modelAuthorization,modelAuthorizationHost,availableModelConnections:()=>availableModelConnections(),contextTrees,automaticActivity,configService,memoryBindings,memoryPublication,ownerQuestions,automaticMemoryScheduling:dependencies?.backgroundWorker!==false,activity,delegation,memoryDelegation,connectionIdentity,assertRequestActive,memoryIntegrationSettings,memoryRecipeSettings,setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},connectors,processing,executor,agentFeatures,archiveReader,isClosing:()=>closing,actions,agent,agentGate,archivedFiles,codex,config,connections,contentStorage,conversations,credential,diagnosticSnapshot,diagnostics,eventLoop,evidenceReader,fileEvidence,files,importTasks,imports,indexer,ingress,insight,insightRequestSchema,insightRuns,interactiveGate,interactiveModelGate,jobId,launchImport,lifecycle,llmGate,maintenanceWorker,materialOrganizer,materialMemoryWork,materials,mediaAssets,mediaPreparation,mediaRange,memories,memoryPipeline,modelSettings,parseCaptureBundle,perception,providerAdmission,queryAgent,queryRuns,queryWithAttachmentsSchema,reviewExtraction,runtimeSettings,semanticSelection,serverVersion,softwareUpdate,sourceOwner,sourcePipelines,sources,store,usageLedger,webVersion,workflows} satisfies FeatureServices;
  const featureHost=new ServerFeatureHost(backendContext,app,()=>diagnostics.record('request.failed',{category:'internal'},'error'));
  resources.defer(()=>featureHost.close());
  registerPluginRoutes(app,{plugins:pluginCenter,bindings:memoryBindings,automation:memoryAutomation,owner:request=>{assertRequestActive(request);if(credential(request))throw new StoreError('Owner authorization is required for plugin control',403);}});
  await installServerFeatures(featureHost,featureServices);
  memoryTopics=new MemoryTopicsHost({store,memories,executor,control:modelAuthorization,host:modelAuthorizationHost,topics:contextTrees.initializeAutomatic(store,evidenceReader),assertReadable:cards=>evidenceReader.assertMemoryReadable(cards),select:(profileId,model)=>{const selected=modelSettings.select('memory',profileId),settings={...selected.settings,...(model?{model}:{})};return {profileId:selected.id,model:settings.model,connection:agentModelConnection({kind:'profile',id:selected.id},settings)};},query:input=>queryAgent(input,'query','memories')});
  resources.defer(()=>memoryTopics?.close());
  await configService.startWatching();
  diagnostics.record('server.started');
  app.addHook('onReady',async()=>{
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  app.addHook('preClose',async()=>{
    closing=true;executionObserver.close();executor.bindObserver(undefined);eventLoop.disable();queryRuns.interrupt();
    featureHost.stop();automaticActivity.stop();memoryPublication.stop();
    // Interrupt transports while handlers, checkpoints and storage remain live.
    await resources.stop();
    agentGate.close();llmGate.close();interactiveGate.close();interactiveModelGate.close();
  });
  app.addHook('onClose',async()=>resources.close());
  return {app,modelAuthorization,modelAuthorizationHost,automaticActivity,configService,featureServices,featureHost,pluginCenter,memoryBindings,memoryAdapters,memoryPublication,memoryAutomation,memoryIntegrationSettings,memoryRecipeSettings,memoryStrategies,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,memoryPipeline,indexer,agent,diagnostics,connections,modelSettings,insightRuns,lifecycle,working};
  }catch(error){
    const failures:unknown[]=[];
    await resources.stop();
    if(startupApp)try{await startupApp.close();}catch(cleanup){failures.push(cleanup);}
    try{await resources.close();}catch(cleanup){failures.push(cleanup);}
    if(failures.length)throw new AggregateError([error,...failures],'Server initialization and disposal failed',{cause:error});
    throw error;
  }
}
