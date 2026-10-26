import {createContextTrees} from './context-trees.js';
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
import Fastify,{ type FastifyReply,type FastifyRequest } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import { existsSync,readFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { Actions } from './actions.js';
import { ActivityProjection } from './activity.js';
import { Operations } from './operations.js';
import { DelegationRuntime,type DelegationWork } from './delegation-runtime.js';
import { DelegatedQueryRuns } from './delegated-query-runs.js';
import {runQueryQualityExperiment,type QueryQualityStrategy,type QueryQualityStage,type QueryQualityCheckpoint} from './query-quality-experiment.js';
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
import { EvidenceReader,type MemoryCatalogMetadataReceipt } from './evidence-reader.js';
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
import { ReloadableAgent,applyModelSettings,createModelAgent,createModelRegistry,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory } from './model-agent.js';
import { ModelCatalogError } from './model-catalog.js';
import { modelConfiguration } from './model-configuration.js';
import { ModelSettingsError,ModelSettingsStore,modelProfileIdSchema } from './model-settings.js';
import { openingMemoryContext } from './opening-memory.js';
import { linkOperationParent } from './operation-projection.js';
import {ImageProcessing} from './image-processing.js';
import {imageUnderstanding} from './image-understanding.js';
import { ProcessingRuntime } from './processing-runtime.js';
import { ProviderAdmission } from './provider-admission.js';
import { PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput } from './python-source-pack-executor.js';
import { scopeFields,validRange,type QueryScope } from './query-scope.js';
import { MAX_RAW_READ_BYTES } from './raw-reader.js';
import { semanticProcessor } from './semantic-extraction.js';
import { conversationUnderstandingProcessor } from './conversation-understanding.js';
import { SourcePipelineRuntime } from './source-pipelines.js';
import { SourceStore } from './sources.js';
import { Store,StoreError,sha256 } from './store.js';
import { createUpdateService } from './updates.js';
import { UsageLedger } from './usage.js';
import { WorkingMemory } from './working-memory.js';

export interface QueryAgent {configured:boolean;configuredFor?(id:string):boolean;query(args:QueryInput):Promise<QueryResult>;close():Promise<void>}
const querySchema=z.object({modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),question:z.string().trim().min(1).max(8000),conversationId:z.string().uuid().optional(),anchorEvidenceIds:z.array(z.string().uuid()).min(1).max(30).refine(ids=>new Set(ids).size===ids.length).nullable().optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(30).refine(ids=>new Set(ids).size===ids.length).nullable().optional(),after:scopeFields.after.nullable(),before:scopeFields.before.nullable(),deviceId:scopeFields.deviceId.nullable(),timeZone:scopeFields.timeZone.nullable()}).strict();
const queryWithAttachmentsSchema=querySchema.extend({attachmentIds:z.array(z.string().uuid()).max(4).refine(ids=>new Set(ids).size===ids.length).optional()}).refine(input=>!input.evidenceIds||!input.anchorEvidenceIds,{message:"Choose reference records or a strict evidence selection"});
const insightSchema=z.object(scopeFields).strict().refine(validRange,{message:'Invalid time range'});
const insightRequestSchema=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional(),prompt:z.string().trim().max(8000).optional()}).strict().refine(validRange,{message:'Invalid time range'});
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
const serverVersion=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
export async function buildApp(config:Config,dependencies?:{configService?:ConfigService;queryQualityExperiment?:QueryQualityStrategy;webRoot?:string;connectorTesting?:import('./connectors/index.js').ConnectorTestDependencies;semanticContextTime?:()=>string;backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void}) {
  config={...config};
  const suppliedConfigService=dependencies?.configService??config.configService;
  const configService=suppliedConfigService??new ConfigService({path:config.configuration?.configFile??join(config.dataDir,'mote.yaml'),initialDocument:documentFromConfig(config)});
  if(!suppliedConfigService)registerBuiltinDomains(configService,config);
  await configService.initialize();
  {
    const bootDocument={version:1,revision:configService.revision,...Object.fromEntries(configDocumentDomains().map(domain=>[domain.id,configService.current(domain.id)]))} as ConfigDocument;
    config=configFromDocument(bootDocument,configService.path,{token:config.token,tokenPath:config.tokenPath},{resolvedDocument:true});
  }
  const actualOwnerToken=config.token;
  configService.setValidator(document=>validateResolvedConfigDocument(document,actualOwnerToken));
  const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();
  // A foreground node must not block listen() on a full orphan-blob sweep. When
  // the background worker is enabled, let that worker perform maintenance after
  // the HTTP service is available instead of making startup scan the whole vault.
  const store=dependencies?.store??new Store(config.dataDir,{dataKey:config.dataKey,contentEncryptionEnabled:config.contentEncryptionEnabled,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:Boolean(config.embeddingModel),maintenance:Boolean(dependencies?.backgroundWorker)});
  // MVP cut-over is explicit: never silently keep the old Coding event indexes live.
  if(store.db.prepare("SELECT 1 FROM captures WHERE json_extract(json,'$.provenance.document.coding') IS NOT NULL LIMIT 1").get()){eventLoop.disable();if(!dependencies?.store)store.close();throw new Error('Legacy Coding event vault: back up and use a fresh data directory for the source-pipeline architecture. No automatic migration is performed.');}
  projectMemoryLifecycleSettings(store,configService.current<LifecycleSettings>('memory'));
  const materials=new MaterialStore(store);
  // One service tree owns backend plugins. Each runtime installs into its own
  // managed scope below this root, so closing one cannot dispose a sibling.
  const backendContext=new Context();
  backendContext.provide('moteMaterials',materials);
  backendContext.provide('moteConfig',configService);
  const runtimeSettings=new ExecutionSettings(configService),execution=runtimeSettings.execution(),providerAdmission=new ProviderAdmission(store);
  const agentGate=new ConcurrencyGate(execution.agentConcurrency),llmGate=new ConcurrencyGate(execution.llmConcurrency);
  const interactiveGate=new ConcurrencyGate(execution.interactiveConcurrency),interactiveModelGate=new ConcurrencyGate(execution.interactiveConcurrency);
  const modelContext=new AsyncLocalStorage<QueryInput>();
  const modelOperation=new AsyncLocalStorage<string>();
  // Accounting observes trusted admission boundaries, independently of model
  // input. A host cooldown or gate cancellation can happen before any call.
  const queryAccounting=new AsyncLocalStorage<{agentStarted:()=>void;modelQueued:()=>void;modelStarted:()=>void}>();
  const assertModelPurpose=(input:QueryInput|undefined)=>{if(dependencies?.queryQualityExperiment&&!input?.traceContext?.operationId?.startsWith('query:'))throw new StoreError('Isolated Ask experiment does not authorize background model work',409);};
  const authorizeModelRequest=()=>{assertModelPurpose(modelContext.getStore());assertModelEvidence(modelContext.getStore());};
  const runModelFor=(settings:import('@mote/shared/models').ModelSettings):NonNullable<import('@mote/agent').AgentOptions['runModel']>=>(task,signal)=>{
    signal?.throwIfAborted();assertModelPurpose(modelContext.getStore());providerAdmission.check(settings);
    const queuedAt=performance.now(),input=modelContext.getStore(),gate=input?.executionLane==='interactive'?interactiveModelGate:llmGate;input?.onTrace?.({type:'model.queued',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background'}});
    input?.onProgress?.({stage:'model',message:moteText('等待模型执行名额')});
    queryAccounting.getStore()?.modelQueued();
    return gate.run(async()=>{providerAdmission.check(settings);assertModelEvidence(input);input?.onProgress?.({stage:'model',message:moteText('模型处理中')});const admittedAt=performance.now(),lane=input?.executionLane??'background',queueWaitMs=admittedAt-queuedAt;input?.onTrace?.({type:'model.admitted',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane,queueWaitMs}});let status:'completed'|'failed'|'yielded'='failed';
      try{queryAccounting.getStore()?.modelStarted();const result=await task();status='completed';return result;}
      catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
      finally{diagnostics.record('agent.harness_timing',{jobId:input?.traceContext?.jobId,batchId:input?.traceContext?.batchId,lane,unit:'harness_session',queueWaitMs,durationMs:performance.now()-admittedAt,status},'info');}
    },signal??input?.signal,input?.traceContext?.operationId??modelOperation.getStore());
  };
  const diagnostics=new ServerDiagnostics({...runtimeSettings.diagnostics(),directory:config.logDirectory??join(config.dataDir,'logs'),maxBytes:config.logMaxBytes??defaultLogMaxBytes(config.profile),maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries});
  await diagnostics.init();
  const executionObserver=executionObservability(diagnostics)!;
  const observationIdentity=(input:QueryInput):ObservationIdentity=>({jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,attempt:input.traceContext?.attempt,
    phase:input.traceContext?.phase==='coding-understanding'?'coding_understanding':input.traceContext?.phase==='review'?'review':'extract'});
  const observeMemory=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>T):T=>input?.responseMode==='memory-extraction'?executionObserver.sync(name,observationIdentity(input),work):work();
  const observeMemoryAsync=<T>(input:QueryInput|undefined,name:ObservationName,work:()=>Promise<T>):Promise<T>=>input?.responseMode==='memory-extraction'?executionObserver.async(name,observationIdentity(input),work):work();
  const executor=new ExecutionEngine(store);
  executor.bindObserver(value=>executionObserver.lease(value),()=>executionObserver.enabled());
  backendContext.provide('moteExecution',executor);
  const memoryStrategies=new MemoryStrategies(),memoryRecipeSettings=new MemoryRecipeSettings(store,memoryStrategies);
  const memoryAutomation=new MemoryAutomation(store);
  let memoryBindings:MemoryBindings|undefined;
  backendContext.provide('moteMemoryStrategies',memoryStrategies);
  const materialMemoryWork=new MaterialMemoryWork(store,materials,Date.now,()=>true,memoryRecipeSettings,()=>memoryBindings?.accepting()??memoryAutomation.accepting());
  const sourcePipelines=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],backendContext,executor,materialMemoryWork);await sourcePipelines.ready;
  const sources=new SourceStore(store,sourcePipelines),files=new FileStore(store,sources),ingress=new IngressService(store,sources,files);const fileEvidence=new FileEvidence(sources);
  const mediaAssets=new MediaAssets(config.media?.modelDirectory??join(store.directory,'media-models'));
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
  },{executor,operationId:()=>modelContext.getStore()?.traceContext?.operationId});
  const materialOrganizer=new MaterialOrganizerRuntime(store,materials,[],executor,materialMemoryWork);
  backendContext.provide('moteMaterialOrganizers',materialOrganizer.registry);
  const evidenceReader=new EvidenceReader(store,sources,files,indexer,fileEvidence,materials,sourcePipelines,materialOrganizer.sourceItemRecipes,
    ref=>materialMemoryWork.readyForMemory(ref));
  const contextTrees=createContextTrees();
  backendContext.provide('moteContextTrees',contextTrees);
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id)));
  const memories=evidenceReader.memories,conversations=new Conversations(store);
  const sourceContexts=new SourceContextStore(store);
  const pluginCenter=new PluginCenter(store,executor,new GitHubPluginReleases(join(config.dataDir,'plugins','packages')));
  memoryBindings=new MemoryBindings(store,memories,memoryAutomation,pluginCenter,executor);
  evidenceReader.memoryBindings=memoryBindings;
  const ownerQuestions=new OwnerQuestions(store);
  backendContext.provide('moteOwnerQuestions',ownerQuestions);
  const archivedFiles=new ArchivedFileStore(store);
  const contentStorage=new ContentStorageService(store,files,archivedFiles,configService,enabled=>{config.contentEncryptionEnabled=enabled;maintenanceWorker?.configureContentEncryption(enabled);});
  const connections=dependencies?.connections??new Connections(store,sources);await connections.init();
  const identities=new WeakMap<FastifyRequest,ConnectionCredential>();
  const connectionIdentity=(req:FastifyRequest)=>identities.get(req);
  // Device metadata does not narrow a human client's owner permissions.
  const credential=(req:FastifyRequest)=>{const c=connectionIdentity(req);return c&&!connections.isOwner(c)?c:undefined;};
  const assertRequestActive=(req:FastifyRequest)=>{const c=connectionIdentity(req);if(c)connections.assertActive(c);};
  const sourceOwner=(req:FastifyRequest,id:string)=>{assertRequestActive(req);const c=credential(req);if(c)connections.assertOwnSource(c,id);};
  const context=(records:CaptureRecord[])=>evidenceReader.context(records);
  const contextDependencies=(input:QueryInput|undefined)=>resolveDependencies(store,combineDependencies([
    ...(input?.conversation?[input.conversation.evidenceDependencies??{version:1 as const,complete:false,ids:[]}]:[]),
    ...(input?.contextEvidenceDependencies?[input.contextEvidenceDependencies]:[]),
    ...(input?.derivedContextEvidenceIds?[{version:1 as const,complete:true,ids:[...input.derivedContextEvidenceIds]}]:[]),
  ]));
  const contextFailure=(code:'context_lineage_incomplete'|'context_evidence_restricted')=>Object.assign(new StoreError(code,409),{code});
  const sourceContextDependencies=(input:QueryInput|undefined)=>combineSourceContextDependencies([input?.conversation?.sourceContextDependencies,input?.contextSourceContextDependencies]);
  const modelContextGroups=(input:QueryInput|undefined)=>{
    const historicalIds=new Set(input?.conversation?.historyContext?input.conversation.evidenceDependencies?.ids:[]);
    return [
    ...(input?.conversation?[{ids:(input.conversation.historyContext?.evidenceDependencies??input.conversation.evidenceDependencies)?.ids??[],historical:Boolean(input.conversation.historyContext)}]:[]),
    ...(input?.contextEvidenceDependencies?[{ids:input.historyContext?input.historyContext.evidenceDependencies.ids:input.contextEvidenceDependencies.ids.filter(id=>!historicalIds.has(id)),historical:Boolean(input.historyContext)}]:[]),
    ...(input?.derivedContextEvidenceIds?[{ids:input.derivedContextEvidenceIds,historical:false}]:[]),
    ].map(group=>({...group,ids:resolveDependencies(store,{version:1,complete:true,ids:[...group.ids]})!.ids}));
  };
  const assertModelContext=(input:QueryInput|undefined)=>{
    for(const snapshot of [input?.historyContext,input?.conversation?.historyContext])if(snapshot){conversations.assertHistoryContext(snapshot);if(!snapshot.evidenceDependencies.complete)throw contextFailure('context_lineage_incomplete');}
    assertSourceContextDependencies(sourceContexts,sourceContextDependencies(input));
    if(input?.derivedContextEvidenceIds?.some(id=>!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy())))throw new StoreError('Derived context evidence is no longer permitted for this model',409);
    const conversationText=Boolean(input?.conversation?.workingMemory?.text||input?.conversation?.turns.some(turn=>!turn.evidenceDeleted&&turn.answer));
    const taskText=Boolean(input?.taskContext?.previousSummary||input?.taskContext?.turns?.length);
    if((conversationText&&input?.conversation?.evidenceDependencies?.complete!==true)||((taskText||input?.openingMemories?.length)&&input?.contextEvidenceDependencies?.complete!==true)||input?.openingMemories?.length&&!input?.contextEvidenceDependencies?.ids.length)throw contextFailure('context_lineage_incomplete');
  };
  // Exact public selections use the normal current-original exposure policy and
  // retain a content pin across preparation, outbound calls and publication.
  const selectedQueryEvidence=(input:QueryInput)=>{
    const ids=input.evidenceIds??input.anchorEvidenceIds;
    if(input.executionLane!=='interactive'||ids===undefined||input.responseMode==='memory-extraction')return [];
    if(!evidenceReader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw contextFailure('context_evidence_restricted');
    const records=evidenceReader.evidence(ids.map(id=>'capture:'+id),input);
    if(records.length!==ids.length||input.processingEvidence&&records.some(record=>input.processingEvidence![record.id]!==memoryEvidenceFingerprint(record)))throw contextFailure('context_evidence_restricted');
    return records;
  };
  const assertModelEvidence=(input:QueryInput|undefined)=>observeMemory(input,'query_assert',()=>{
    if(input)selectedQueryEvidence(input);
    input?.assertContextAuthority?.();
    const catalog=(input as (QueryInput&{memoryCatalogMetadata?:MemoryCatalogMetadataReceipt})|undefined)?.memoryCatalogMetadata;
    if(catalog&&!evidenceReader.memoryCatalogMetadataAllowed(catalog,new EvidenceExposurePolicy()))throw Object.assign(new ProviderFailure({category:'permanent',code:'context_evidence_restricted'}),{statusCode:409,code:'context_evidence_restricted'});
    assertModelContext(input);
    if(input?.processingImages?.length){
      assertMemoryImageGrants(store,input.processingMaterialInputs??[],input.processingImages);
      if(!evidenceReader.processingEvidenceAllowed(input.processingImages.map(image=>image.id),input.processingEvidence,input.processingMaterialInputs,new EvidenceExposurePolicy()))throw contextFailure('context_evidence_restricted');
    }
    // Derived nodes remain in the fence alongside every original ancestor.
    // Private metadata checks never disclose bodies or grant raw reads.
    for(const group of modelContextGroups(input))if(!evidenceReader.contextDependenciesAllowed(group.ids,new EvidenceExposurePolicy(),group.historical))throw contextFailure('context_evidence_restricted');
    // The bridge may already hold restricted originals while deletion or a
    // Formal input/owner declaration changes. Check the frozen Memory grant at
    // every outbound request as well as before entering the agent; publication
    // validation alone cannot recall a seed already sent to the provider.
    if(input?.responseMode==='memory-extraction'&&input.evidenceIds!==undefined&&!evidenceReader.processingEvidenceAllowed(
      [...input.evidenceIds,...((input as QueryInput&{processingDisclosedEvidenceIds?:string[]}).processingDisclosedEvidenceIds??[])],input.processingEvidence,input.processingMaterialInputs,new EvidenceExposurePolicy(),
    ))throw Object.assign(new ProviderFailure({category:'permanent',code:'context_evidence_restricted'}),{statusCode:409,code:'context_evidence_restricted'});
  });
  const assertModelEvidenceAsync=(input:QueryInput)=>observeMemoryAsync(input,'query_assert',async()=>{
    selectedQueryEvidence(input);
    input.assertContextAuthority?.();
    assertModelContext(input);
    const policy=new EvidenceExposurePolicy();
    // This is scheduling granularity, not a scope or processing limit. Inspect
    // every dependency while allowing lease renewal, cancellation and intake.
    for(const group of modelContextGroups(input))for(let offset=0;offset<group.ids.length;offset+=256){
      input.signal?.throwIfAborted();
      if(!evidenceReader.contextDependenciesAllowed(group.ids.slice(offset,offset+256),policy,group.historical))throw contextFailure('context_evidence_restricted');
      await yieldEventLoop();
    }
    input.signal?.throwIfAborted();
  });
  const agentFeatures=await installAgentFeatures(backendContext,evidenceReader.agent({diagnostics,allowQueryImages:()=>perception.settings().allowQueryImages,
    exposurePolicy:new EvidenceExposurePolicy(),
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
  const queryImages=(ids:string[])=>ids.map(id=>{
    const detail=files.detail(id),version=files.version(id),mimeType=detail.item.mimeType;
    if(!detail.hasOriginal||!version.object_hash||!['image/png','image/jpeg','image/webp'].includes(mimeType??'')||detail.sizeBytes<1||detail.sizeBytes>8*1024*1024)throw new StoreError('Query attachment must be an archived image up to 8 MiB',400);
    return {id,name:detail.item.title||'Attached image',mimeType:mimeType!,hash:version.object_hash,sizeBytes:detail.sizeBytes};
  });
  const agent=new ReloadableAgent(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  const codex={executable:config.codexBin,home:config.codexHome};
  const pinProcessingEvidence=(input:QueryInput):QueryInput=>{
    const supplied=input as QueryInput&{memoryCatalogMetadata?:MemoryCatalogMetadataReceipt};
    if(!supplied.memoryCatalogMetadata){const receipt=evidenceReader.memoryCatalogMetadata(input.taskContext);if(receipt)input={...input,memoryCatalogMetadata:receipt,contextSourceContextDependencies:combineSourceContextDependencies([input.contextSourceContextDependencies,receipt.sourceContextDependencies])} as QueryInput;}
    if(!input.evidenceIds||input.executionLane==='interactive')return input;
    const missing=input.evidenceIds.filter(id=>!input.processingEvidence?.[id]);
    return missing.length?{...input,processingEvidence:{...Object.fromEntries(memories.readEvidence(missing).map(record=>[record.id,memoryEvidenceFingerprint(record)])),...input.processingEvidence}}:input;
  };
  // Order admitted preparation starts across event-loop turns, without waiting
  // for a query to finish or changing either lane's in-flight concurrency.
  let preparationTurn=Promise.resolve();
  const yieldPreparationTurn=()=>{const turn=preparationTurn.then(()=>yieldEventLoop());preparationTurn=turn.catch(()=>{});return turn;};
  const wrapAgent=(inner:QueryAgent,settings:import('@mote/shared/models').ModelSettings):QueryAgent=>({get configured(){return inner.configured;},close:()=>inner.close(),query:async input=>{
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
      try{observeMemory(input,'catalog_snapshot',()=>evidenceReader.retainMemorySnapshot(input));const result=await modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>{assertModelEvidence(input);queryAccounting.getStore()?.agentStarted();return modelContext.run(input,()=>inner.query(input));}));status='completed';return result;}
      catch(error){if(error instanceof AgentYieldError)status='yielded';throw error;}
      finally{evidenceReader.releaseMemorySnapshot(input);diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,lane,unit:'agent_fragment',queueWaitMs,durationMs:performance.now()-admittedAt,status},'info');}
    },input.signal,input.traceContext?.operationId);
  }});
  const factory:ModelAgentFactory=async(settings,reader)=>{
    const host={runModel:runModelFor(settings),authorizeModelRequest};
    return wrapAgent(await (dependencies?.createModelAgent?dependencies.createModelAgent(settings,reader,host):createModelAgent(settings,reader,codex,host.runModel,host.authorizeModelRequest)),settings);
  };
  let initialAgent=dependencies?.agent?wrapAgent(dependencies.agent,modelSettingsFromConfig(config)):undefined;
  const modelSettings=new ModelSettingsStore({
    configService,codex,
    prepare:async (settings,profiles,defaultProfileId,previousSettings)=>{
      const candidate=await createModelRegistry(profiles,reader,factory,initialAgent,defaultProfileId);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings),()=>applyModelSettings(config,previousSettings??settings));
    },
    probe:settings=>testModelConnection(settings,factory),
  });
  try{await modelSettings.initialize();}catch(error){await configService.close();await executor.close();await agent.close();await connections.close();await indexer.close();await sourcePipelines.close();await backendContext.fiber.dispose();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}
  const hindsightMeters=new Map<string,ReturnType<UsageLedger['start']>>();
  const hindsightAuthorities=new Map<string,()=>void>();
  const memoryAdapters=new MemoryAdapters(join(config.dataDir,'plugins','instances'),pluginCenter,modelSettings,{codex,runModelFor,
    assertModelAuthority:(_settings,request)=>{if(request.purpose==='startup'||request.purpose==='capability_probe')return;const assert=request.opId&&hindsightAuthorities.get(request.opId);if(!assert)throw new StoreError('Native Memory operation authority expired',409);assert();},
    onRequestStarted:(settings,request)=>hindsightMeters.set(request.requestId,usageLedger.start(settings.provider,settings.model,'hindsight-engine',{agentId:'hindsight-engine',moduleId:'memories',skillId:null,operationId:request.opId,requestId:request.requestId})),
    onUsage:(_settings,usage,request)=>hindsightMeters.get(request.requestId)?.update(usage),
    onRequestFinished:request=>{hindsightMeters.get(request.requestId)?.finish(request.status);hindsightMeters.delete(request.requestId);},
  });
  memoryBindings.providerFactory=(id,namespace)=>memoryAdapters.provider(id,namespace);
  pluginCenter.probe=(id,signal)=>memoryAdapters.probe(id,signal);
  pluginCenter.configurationAllowed=(field,value)=>memoryAdapters.configurationAllowed(field.type,value);
  pluginCenter.retired=id=>{void memoryAdapters.retire(id);};
  // Fastify/Pino request and Error serializers may contain raw URLs, bodies or SDK text.
  // Emit only our fixed-schema events, never serialize arbitrary request/error objects.
  const resolveFileModel=(settings:Parameters<FileAnalysis>[2])=>{
    let selected=modelSettings.select('file').settings;
    if(settings.analysisModel){
      const m=settings.analysisModel;
      selected={...selected,provider:'custom',protocol:'openai-completions',baseUrl:m.endpoint,model:m.model,apiKey:m.apiKey??'',headers:{},extraBody:{},allowUnauthenticatedLocal:m.execution==='local',reasoningEffort:'auto',serviceTier:undefined};
    }
    return structuredClone(selected);
  };
  const analyzeFile:FileAnalysis=async(records,prompt,settings,signal,host,validateOutput)=>{
    const currentRecords=()=>records.map(record=>({...record,...(record.provenance?{attributionContext:materials.contextForEvidence(record as CaptureRecord)}:{})}));
    const scoped:ContextReader={search:async()=>currentRecords(),timeline:async args=>{
      const offset=args.cursor===undefined?0:Number(args.cursor);if(!Number.isSafeInteger(offset)||offset<0||offset>records.length)throw new StoreError('Invalid file analysis cursor');
      const limit=Math.min(100,Math.max(1,args.limit??8)),items=currentRecords().slice(offset,offset+limit);
      return {items,nextCursor:offset+items.length<records.length?String(offset+items.length):null};
    },evidence:async args=>currentRecords().filter(r=>args.ids.includes(r.id)),activity:async()=>({}),devices:async()=>[]};
    const selected=settings.modelSnapshot??resolveFileModel(settings);
    const meter=admittedUsage(selected.provider,selected.model,'file-analysis',{agentId:'file-analysis',moduleId:'files',skillId:null,...host});
    let model:QueryAgent|undefined;
    const request:QueryInput={question:prompt,language:requestLocale.getStore()??'zh-CN',signal,traceContext:host,onUsage:meter.update,validateOutput,
      onSourceContextDependencies:pins=>{
        const current=combineSourceContextDependencies([request.contextSourceContextDependencies,pins]);
        assertSourceContextDependencies(sourceContexts,current);request.contextSourceContextDependencies=current;
      },
    };
    try{model=await factory(selected,scoped);const result=await meter.run(()=>model!.query(request));
      const pins=combineSourceContextDependencies([request.contextSourceContextDependencies,result.sourceContextDependencies]);
      assertSourceContextDependencies(sourceContexts,pins);
      return {...result,...(pins.length?{sourceContextDependencies:pins}:{}),usage:meter.completed()};}
    catch(error){meter.failed(error);throw error;}finally{await model?.close();}
  };
  let queryRuns:DelegatedQueryRuns;
  const insightRuns=new InsightRuns(store,{executor,evidenceReader});
  const workflows=new ProcessingRuntime(store,[],{},Date.now,executor,materials,backendContext,configService);
  sourcePipelines.setProductConsumer(workflows);workflows.consumerAllowed=(sourceId,bindingId)=>sourcePipelines.options(sourceId).consumers.includes(bindingId);
  const memoryConfiguration=(id?:string,model?:string)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);};
  const processing:FileProcessing=new FileProcessing(files,dependencies?.transcriptionProvider,undefined,{configService,executor,modules:[...new Set([...(config.backendPluginModules??[]),...(config.fileProcessorModules??[])])],analyze:analyzeFile,analysisSnapshot:resolveFileModel,analysisRevision:()=>modelSettings.view().revision,diagnostics,contextProcessors:workflows.registry,pluginContext:backendContext,mediaAssets,media:config.media,contextForEvidence:record=>materials.contextForEvidence(record)});
  const previousSourceContextChanged=materials.onSourceContextChanged;
  materials.onSourceContextChanged=id=>{previousSourceContextChanged?.(id);processing.invalidateSourceContext(id);};
  try{await processing.initializeConfiguration();}catch(error){await configService.close();await executor.close();await processing.close();await workflows.close();await sourcePipelines.close();await backendContext.fiber.dispose();await modelSettings.close();await agent.close();await connections.close();await indexer.close();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}

  const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,materialMemoryWork);
  const perception=new ImageProcessing(store,processing,executor,{configService,materials,mediaAssets,media:config.media,understanding:imageUnderstanding({factory,metered:async(settings,attribution,task)=>{
    const meter=admittedUsage(settings.provider,settings.model,'image-understanding',{agentId:'image-understanding',moduleId:'images',skillId:null,...attribution});
    return meter.run(async()=>{try{const output=await task(meter.update);meter.completed();return output;}catch(error){meter.failed(error);throw error;}});
  },selection:service=>{
    const selected=modelSettings.select('file'),settings=resolveFileModel({...processing.currentSettings(),analysisModel:service}),configuration=modelConfiguration(service?.id??selected.id,settings,modelSettings.view().revision);
    return {fingerprint:configuration.fingerprint,configured:service?Boolean(service.apiKey||service.execution==='local'):agent.configuredFor(selected.id),settings,receipt:{profileId:service?.id??selected.id,provider:settings.provider,model:settings.model,revision:modelSettings.view().revision}};
  }})});
  const semanticSelection=()=>{const selected=modelSettings.select('memory');return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};};
  workflows.registry.register(semanticProcessor({store,memories,query:input=>{const selected=modelSettings.select('memory',input.modelProfileId),traceContext={...input.traceContext,traceId:randomUUID(),operation:'query' as const,moduleId:'memories',profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:input.modelOverride??selected.settings.model};return agent.query({...input,onTrace:event=>{diagnostics.agentTrace(event,traceContext);input.onTrace?.(event);}});},records:ids=>store.evidence(ids),selection:semanticSelection,usage:usageLedger}));
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

  const connectors=await registerConnectors(app,{memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,ownerAuthorization:header=>{if(validBearer({headers:{authorization:header}}))return true;const c=connections.authenticate(header);return !!c&&connections.isOwner(c);},mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)},dependencies?.connectorTesting);

  const softwareUpdate=createUpdateService({currentVersion:serverVersion,profile:config.profile,runtime:config.configuration?.runtime,profileHome:config.configuration?.hostConfigFile?dirname(dirname(config.configuration.hostConfigFile)):undefined,repository:config.updateRepository,channel:config.updateChannel});

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
  function queryAgent(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations',usageOwner:'query'|'caller'='query') {
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
  const memoryReviews=new MemoryReviewCache();
  const reviewExtraction=(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy,draftOrigin?:import('./memory-review.js').MemoryDraftOrigin)=>reviewMemory(input,result,next=>queryAgent(next,'query','memories'),{
    draftOrigin,strategy,deletions:memories.deletions,authorizeDeletionEvidence:ids=>memoryPipeline.assertDeletionEvidenceAllowed(ids,input.modelProfileId),cache:memoryReviews,snapshot:()=>{
      const ids=input.evidenceReadRanges?[...new Set([...(input.evidenceIds??[]),...memoryReadRanges(result,input.evidenceRanges??[],input.evidenceReadRanges).map(range=>range.id)])]:input.evidenceIds??[];
      if(ids.some(id=>!memories.isCurrentEvidence(id)))throw new StoreError('Memory evidence changed during review',409);
      // Include full original metadata (speaker, source, device, dates, version),
      // not just quote text. Credentials/config are hashed, never retained.
      return sha256(JSON.stringify([modelSettings.select('memory',input.modelProfileId).settings,memories.readEvidence(ids)]));
    },
  });
  const understandConversation:NonNullable<import('./memory-pipeline.js').MemoryPipelineOptions['understand']>=async input=>{
    const refs=[...new Set(input.ranges.map(range=>input.materialRefs[range.id]))];
    if(refs.length!==1||!refs[0])return;
    const material=materials.get(refs[0]);
    if(!material||material.kind!=='mote.coding-session')return;
    if(material.schemaVersion<CODING_DIALOGUE_SCHEMA_VERSION)throw new ExecutionFailure('blocked','coding_dialogue_not_clean');
    const pages=materials.conversationInputs(material.ref,input.ranges);
    const configuration=input.job.configuration!;
    const jobs=workflows.enqueue([{name:'conversation',processor:'mote.coding-conversation-understanding',materialInputs:pages,
      config:{memoryPreparation:true,modelFingerprint:configuration.fingerprint,profileId:configuration.profileId,modelOverride:configuration.model,
        contextTime:input.job.contextTime,timeZone:input.job.timeZone,language:input.job.language,generationContract:input.generationContract,processingMaterialInputs:input.materialInputs.map(pin=>({materialId:pin.materialId,required:pin.required,fingerprint:pin.fingerprint,evidenceIds:pin.evidenceIds.filter(id=>input.ranges.some(range=>range.id===id))}))}}],input.parentGrant);
    linkOperationParent(store,'memory:'+input.job.id,executor.get(jobs.conversation)!.operationId);
    const abort=()=>executor.abortLocal(jobs.conversation);input.signal.addEventListener('abort',abort,{once:true});
    try{await executor.drain([jobs.conversation]);input.signal.throwIfAborted();}
    finally{input.signal.removeEventListener('abort',abort);}
    const step=executor.get(jobs.conversation)!;
    if(step.state==='waiting'||step.state==='running')throw new ExecutionFailure('waiting',step.error??'semantic_processing_pending',step.availableAt>Date.now()?Math.max(1000,step.availableAt-Date.now()):5000);
    if(step.state!=='succeeded')throw new ExecutionFailure(step.state==='stale'?'stale':step.state==='failed'?'permanent':'blocked',step.state==='blocked'?'semantic_processing_blocked':step.error??'semantic_processing_failed');
    const row=store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(jobs.conversation)!;
    return (JSON.parse(String(row.json)).outputs as string[]).map(id=>({id,revision:String(store.archive.revision(id)!)}));
  };
  const memoryPublication=new MemoryPublication(store,memories,memoryBindings,executor);
  memoryPublication.revokeEvidence=ids=>memoryAdapters.erasePreparedEvidence(ids);
  const memoryPipeline=new MemoryPipeline({integrationReadInput:cards=>memoryIntegrationImageInputs(store,materials,cards.flatMap(card=>card.evidence)),assertIntegrationReadable:cards=>evidenceReader.assertMemoryReadable(cards),publication:memoryPublication,settleEngineDraft:async context=>{if(!context.provider)throw new StoreError('Native Memory cleanup has no pinned provider configuration',503);await memoryAdapters.discardPrepared({...context.provider,opId:context.opId,phase:context.phase});},assertNewManualWork:()=>memoryBindings.assertNewManualWork(),engineDraft:async(input,context)=>{const binding=memoryBindings.binding();if(memoryBindings.view().mode!=='engine')return;const namespace=binding.namespace!;context.provider={instanceId:namespace.instanceId,namespace,configurationIdentity:memoryAdapters.configurationIdentity(namespace.instanceId,namespace)};input.signal?.throwIfAborted();const originals=memories.readEvidence(context.evidenceIds);if(originals.length!==new Set(context.evidenceIds).size)throw new StoreError('Engine originals are unavailable',409);const evidence=input.evidenceRanges?.map(range=>{const record=originals.find(record=>record.id===range.id);if(!record)throw new StoreError('Engine original range is unavailable',409);return {record,offset:range.offset,length:range.length};})??originals;
    const bindingIdentity=JSON.stringify(binding),pins=new Map(originals.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const assert=()=>{input.signal?.throwIfAborted();context.assertAuthority?.();assertModelEvidence(input);if(JSON.stringify(memoryBindings.binding())!==bindingIdentity)throw new StoreError('Native Memory binding changed',409);for(const [id,fingerprint] of pins){const current=memories.readEvidence([id])[0];if(!current||!memories.isCurrentEvidence(id)||memoryEvidenceFingerprint(current)!==fingerprint||!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()))throw new StoreError('Native Memory originals were changed or revoked',409);}};
    assert();hindsightAuthorities.set(context.opId,assert);
    try{const result=await memoryAdapters.engine(namespace.instanceId,namespace).prepare({namespace,opId:context.opId,phase:context.phase,evidence,relatedMemories:context.relatedMemories,signal:input.signal});assert();input.onEvidence?.(originals);if(context.relatedMemories?.length)input.onMemoryBodies?.(context.relatedMemories);return result;}finally{if(hindsightAuthorities.get(context.opId)===assert)hindsightAuthorities.delete(context.opId);}},understand:understandConversation,materialSourceCurrent:(pin,id)=>evidenceReader.materialSourceCurrent(pin,id),materialPlanAllowed:id=>evidenceReader.materialPlanAllowed(id,new EvidenceExposurePolicy()),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:ref=>materialMemoryWork.sourceRequirements(ref),batchCharacters:()=>storedMemoryLifecycleSettings(store).batchCharacters,automaticAllowed:job=>materialMemoryWork.authorized(job)&&[...(job.automaticGrants??[]),...(job.automaticGrant?[job.automaticGrant]:[])].every(grant=>sourcePipelines.memoryAllowed(grant.sourceId)),strategies:memoryStrategies,executor,store,memories,deletionEvidenceAllowedForMemory:id=>evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()),materialAllowedForMemory:(ref,profileId,required)=>evidenceReader.materialAllowedForMemory(ref,new EvidenceExposurePolicy(),required),configuration:memoryConfiguration,concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),review:reviewExtraction,query:input=>queryAgent(input,'query','memories'),model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}},skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`});
  memoryRecipeSettings.onChange=()=>materialMemoryWork.inputs.revokeDisabled();
  memoryRecipeSettings.onApplied=()=>materialMemoryWork.reconcile(memoryPipeline);
  materialMemoryWork.reconcile(memoryPipeline);
  const lifecycle=new MemoryLifecycle(store,()=>agent.configured,Date.now,executor,dependencies?.semanticContextTime,configService),working=new WorkingMemory(store,conversations);
  lifecycle.automaticAdmission=id=>!['extraction','consolidation'].includes(id)||memoryBindings!.accepting();
  memoryBindings.onReleased=()=>lifecycle.skipAutomaticBacklog();
  pluginCenter.admissionChanged=(id,enabled)=>{if(memoryBindings!.binding().namespace?.instanceId===id){if(enabled)lifecycle.skipAutomaticBacklog();memoryAutomation.touch();}};
  const cancelledMemoryWork=(automaticOnly=false)=>{
    let active=0;
    const automaticParents=new Set(lifecycle.view().extensions.filter(extension=>['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual).map(extension=>'lifecycle:'+extension.active!.id));
    for(const row of store.db.prepare("SELECT b.id,j.json FROM memory_batches b JOIN memory_jobs j ON j.id=b.job_id WHERE json_extract(j.json,'$.status')='cancelled'").all()){
      const job=JSON.parse(String(row.json));if(executor.isActiveStep(String(row.id))&&(!automaticOnly||job.automaticGrant||job.automaticGrants?.length||automaticParents.has(job.importJobId)))active++;
    }
    for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&extension.status==='cancelled'&&(!automaticOnly||!extension.active.manual)&&executor.isActiveStep('lifecycle:'+extension.active.id))active++;
    return active;
  };
  memoryBindings.pendingTail=()=>{
    const jobs=Number(store.db.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') NOT IN ('completed','cancelled')").get()!.n);
    const windows=lifecycle.view().extensions.filter(extension=>['extraction','consolidation'].includes(extension.id)&&extension.active&&extension.status!=='cancelled').length;return jobs+windows+memoryPublication.pending()+cancelledMemoryWork();
  };
  memoryAutomation.onResume=()=>lifecycle.skipAutomaticBacklog();
  memoryAutomation.onStop=()=>{
    store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=? WHERE authorized=1 AND revoked_at IS NULL').run(Date.now());
    for(const row of store.db.prepare("SELECT id FROM memory_jobs WHERE (json_extract(json,'$.automaticGrant') IS NOT NULL OR json_array_length(json_extract(json,'$.automaticGrants'))>0) AND json_extract(json,'$.status') NOT IN ('completed','cancelled')").all())memoryPipeline.cancel(String(row.id),{cause:'authority'});
    for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual)lifecycle.cancel(extension.id,extension.active.id,{cause:'authority'});
  };
  memoryAutomation.counts=()=>{
    const counts={queued:0,running:0,checkpointed:0,resultUnknown:0};
    const jobs=new Set<string>();
    for(const row of store.db.prepare('SELECT job_id FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL').all()){
      if(!row.job_id){counts.queued++;continue;}jobs.add(String(row.job_id));
    }
    for(const id of jobs){const job=memoryPipeline.get(id);if(['completed','cancelled'].includes(job.status))continue;
      if(job.status==='running')counts.running++;else if(job.batches.some(batch=>batch.status==='completed'))counts.checkpointed++;else counts.queued++;
    }
    for(const extension of lifecycle.view().extensions)if(['extraction','consolidation'].includes(extension.id)&&extension.active&&!extension.active.manual&&extension.status!=='cancelled'){
      if(extension.status==='running')counts.running++;else if(extension.active.checkpoint)counts.checkpointed++;else counts.queued++;
    }
    counts.running+=cancelledMemoryWork(true);counts.resultUnknown=memoryPublication.pending(true);return counts;
  };
  const memoryIntegrationSettings=new MemoryIntegrationSettings(store,memoryStrategies);
  registerMemoryExtensions({integrationSettings:memoryIntegrationSettings,semanticArtifacts,providerCooldownCheck:()=>providerAdmission.check(modelSettings.select('memory').settings),insights:insightRuns,insightTimeout:()=>modelSettings.select('insight').settings.agentTimeoutMs,lifecycle,store,files,memories,pipeline:memoryPipeline,working,query:(input,module)=>queryAgent(input,input.skill==='personal-insight'?'insight':'query',module),model:()=>modelSettings.select('memory').settings.model});
  for(const extension of dependencies?.memoryExtensions??[])lifecycle.replace(extension);

  const importAgents=new Set<ReturnType<typeof createImportAgent>>(),importTasks=new Map<string,Promise<unknown>>();
  const sourcePacks=new Map((config.importPythonPacks??[]).map(spec=>{
    const executor=new PythonSourcePackExecutor<PythonImportOutput>({...spec,outputSchema:pythonImportOutputSchema});
    return [spec.id,{revision:sha256(JSON.stringify(spec)),prepare:pythonImportPreparation(executor)}] as const;
  }));
  const imports=new ImportStore(store,archivedFiles,sources,{executor,intake:processing.runtime.intake,fileStore:files,
    sourcePacks,
    prepare:dependencies?.prepareImport??(async input=>{
      if(!agent.configured)throw new AgentNotConfiguredError();
      const selected=modelSettings.select('import');if(!agent.configuredFor(selected.id))throw new AgentNotConfiguredError();
      const settings=selected.settings,prepared=await prepareImportInput(input);
      const meter=admittedUsage(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId:input.operationId});
      const operationId=input.operationId??'import:'+randomUUID();
      let runtime:ReturnType<typeof createImportAgent>|undefined;const abort=()=>{void runtime?.close();};input.signal?.addEventListener('abort',abort,{once:true});
      try{runtime=createImportAgent({...settings,codex,runModel:runModelFor(settings),authorizeModelRequest:authorizeModelRequest});importAgents.add(runtime);const {signal:_signal,operationId:_operationId,...request}=prepared;const result=await meter.run(()=>agentGate.run(()=>modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},dependencies?.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>meter.update(usage)))),input.signal,input.operationId));input.signal?.throwIfAborted();meter.completed();return result;}
      catch(error){meter.failed(error);throw error;}finally{input.signal?.removeEventListener('abort',abort);try{await runtime?.close();}finally{if(runtime)importAgents.delete(runtime);}}
    }),
    // Each original receipt owns its automatic authorization. Ready materials
    // enter the shared rolling queue; import completion must not create a second job.
    onImported:async()=>({}),
  });
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
  type SavedQuery={hostRequest:unknown;language?:QueryInput['language'];prepared?:QueryInput;configurationFingerprint?:string;qualityStrategy?:QueryQualityStrategy;qualityStages?:Partial<Record<QueryQualityStage,QueryResult>>};
  async function prepareDelegatedQuery(body:unknown,work:DelegationWork,signal:AbortSignal,onProgress:QueryInput['onProgress']):Promise<QueryInput>{
    signal.throwIfAborted();if(!agent.configured)throw new AgentNotConfiguredError();
    const saved=delegation.journal.payload<SavedQuery>(work.id);
    if(saved.prepared){
      const selected=modelSettings.select('chat',saved.prepared.modelProfileId),current=modelConfiguration(selected.id,{...selected.settings,model:saved.prepared.modelOverride??selected.settings.model},modelSettings.view().revision);
      if(saved.configurationFingerprint!==current.fingerprint)throw new StoreError('Query model configuration changed',409);
      assertModelEvidence(saved.prepared);return {...saved.prepared,signal,onProgress};
    }
    const {conversationId,question,modelProfileId,modelOverride,evidenceIds:selectedIds,anchorEvidenceIds:anchorIds,attachmentIds=[],...selected}=queryWithAttachmentsSchema.parse(body);
    const previous=conversationId?conversations.get(conversationId):undefined;
    if(previous&&previous.turnCount>=200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
    const scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const){const value=key==='timeZone'&&selected.timeZone===undefined?previous?.scope.timeZone:selected[key];if(value!==undefined&&value!==null)scope[key]=value;}
    insightSchema.parse(scope);
    if(selectedIds)scope.evidenceIds=selectedIds;
    if(anchorIds)scope.anchorEvidenceIds=anchorIds;
    const selectedRecords=selectedQueryEvidence({question,...scope,executionLane:'interactive'});
    const profile=modelSettings.select('chat',modelProfileId),model=modelOverride??profile.settings.model,contextTime=work.scope.contextTime!;
    const previousIds=scope.evidenceIds?[]:previous?.turns.slice(-20).flatMap(turn=>turn.attachments?.map(attachment=>attachment.id)??[])??[],previousAvailable=previousIds.filter(id=>{try{return Boolean(files.detail(id).hasOriginal);}catch{return false;}});
    const directImages=queryImages([...new Set([...attachmentIds,...previousAvailable.slice(-4)])]);
    const stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(stepId,fence))throw new StoreError('Query preparation grant expired',409);const result=write();if(own)store.db.exec('COMMIT');return result;}catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}};
    const allowedHistoryIds=new Set([...(scope.evidenceIds??[]),...attachmentIds]);
    const selectedScope=JSON.stringify([...(scope.evidenceIds??[])].sort());
    const scopedPrevious=previous&&scope.evidenceIds?{...previous,turns:previous.turns.filter(turn=>
      JSON.stringify([...(turn.scope.evidenceIds??[])].sort())===selectedScope&&
      (turn.attachments??[]).every(attachment=>allowedHistoryIds.has(attachment.id))&&
      turn.result?.evidenceDependencies?.complete===true&&turn.result.evidenceDependencies.ids.every(id=>allowedHistoryIds.has(id))&&
      turn.historyEvidenceDependencies?.complete===true&&turn.historyEvidenceDependencies.ids.every(id=>allowedHistoryIds.has(id))
    )}:undefined;
    const [opening,conversation]=await Promise.all([
      scope.evidenceIds?Promise.resolve({leads:[],evidenceDependencies:{version:1 as const,complete:true,ids:scope.evidenceIds}}):openingMemoryContext(archiveReader,question,{...scope,contextTime}),
      scopedPrevious?Promise.resolve(conversations.context(scopedPrevious,20,Math.max(1000,lifecycle.settings().contextCharacters-question.length))):previous?working.prepare(previous,lifecycle.settings(),question,input=>queryAgent({...input,contextTime,traceContext:{...input.traceContext,operationId:work.operationId},executionLane:'interactive',modelProfileId:profile.id,modelOverride:model,signal},'query','conversations'),{signal,commit}):undefined,
    ]);
    const prepared:QueryInput={traceContext:{operationId:work.operationId},language:saved.language??'zh-CN',executionLane:'interactive',question,...scope,...(selectedRecords.length?{processingEvidence:Object.fromEntries(selectedRecords.map(record=>[record.id,memoryEvidenceFingerprint(record)]))}:{}),contextTime,modelProfileId:profile.id,modelOverride:model,directImages,openingMemories:opening.leads,contextEvidenceDependencies:{...opening.evidenceDependencies,ids:[...new Set([...opening.evidenceDependencies.ids,...(scope.anchorEvidenceIds??[])])]},...(conversation?{conversation}:{})};
    commit(()=>{
      assertModelEvidence(prepared);
      const freshImages=queryImages(directImages.map(image=>image.id));
      if(freshImages.some((image,index)=>image.hash!==directImages[index].hash||image.mimeType!==directImages[index].mimeType||image.sizeBytes!==directImages[index].sizeBytes))throw new StoreError('Query attachment changed during preparation',409);
      for(const image of directImages){const version=files.version(image.id);if(!store.evidence([image.id]).length||!fileAttachmentAvailable(store,image.id)||store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted)throw new StoreError('Query attachment is no longer available',409);}
      delegation.recordEvidence(work.id,[...(contextDependencies(prepared)?.ids??[]),...directImages.map(image=>image.id)]);
      delegation.journal.savePayload(work.id,{...saved,prepared,configurationFingerprint:modelConfiguration(profile.id,{...profile.settings,model},modelSettings.view().revision).fingerprint,...(dependencies?.queryQualityExperiment?{qualityStrategy:dependencies.queryQualityExperiment}:{})});
    });
    return {...prepared,signal,onProgress};
  }
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
      const input=queryWithAttachmentsSchema.parse(raw);if(!input.conversationId)return input;
      const previous=conversations.get(input.conversationId).scope;
      // Freeze resolved selection in the accepted run, before asynchronous preparation.
      if(input.evidenceIds)return {...input,anchorEvidenceIds:null};
      if(input.anchorEvidenceIds)return {...input,evidenceIds:null};
      return {...input,...(input.evidenceIds===undefined&&previous.evidenceIds?{evidenceIds:[...previous.evidenceIds]}:{}),...(input.anchorEvidenceIds===undefined&&previous.anchorEvidenceIds?{anchorEvidenceIds:[...previous.anchorEvidenceIds]}:{})};
    },
    prepare:prepareDelegatedQuery,
    query:input=>runQueryQualityExperiment(input,dependencies?.queryQualityExperiment??'base',(next,stage)=>queryAgent({...next,traceContext:{...next.traceContext,phase:'quality.'+stage}},'query',stage==='base'?'conversations':'query.'+stage),qualityCheckpoint(input)),
    operationUsage:(operationId,createdAt,finishedAt)=>usageLedger.operation(operationId,createdAt,finishedAt),
    commit:(body,result,work)=>{
      const {conversationId,question,attachmentIds=[]}=queryWithAttachmentsSchema.parse(body),saved=delegation.journal.payload<SavedQuery>(work.id),prepared=saved.prepared!;
      assertModelEvidence(prepared);
      assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies);
      delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
      const previous=conversationId?conversations.get(conversationId):undefined,scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone','evidenceIds','anchorEvidenceIds'] as const)if(prepared[key]!==undefined)Object.assign(scope,{[key]:prepared[key]});
      return conversations.append(previous,{question,...scope,attachments:prepared.directImages?.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result);
    },
    failure:(body,error)=>{
      const {conversationId,question,evidenceIds,anchorEvidenceIds,...selected}=queryWithAttachmentsSchema.parse(body),scope:QueryScope={...(evidenceIds?{evidenceIds}:{}),...(anchorEvidenceIds?{anchorEvidenceIds}:{})};for(const key of ['after','before','deviceId','timeZone'] as const)if(selected[key]!==undefined&&selected[key]!==null)scope[key]=selected[key]!;
      const failure=safeError(error);return conversations.appendFailure(conversationId?conversations.get(conversationId):undefined,{question,...scope},{code:failure.category,message:failure.message});
    },
  });
  const memoryDelegation=registerMemoryDelegation({runtime:delegation,pipeline:memoryPipeline,work:materialMemoryWork,sourcePipelines,configuration:()=>memoryConfiguration(),allowCandidate:(candidate,input)=>evidenceReader.materialAllowedForMemory(candidate.ref,new EvidenceExposurePolicy(),input.required),query:input=>queryAgent(input,'query','memories'),sample:async(candidate,offset,length)=>{
    const input=materialMemoryWork.planningInput(candidate);
    if(!input?.ready||input.fingerprint!==candidate.fingerprint||!materialMemoryWork.inputs.available(candidate.sourceId,candidate.inputKey,undefined,candidate.scope)||!sourcePipelines.memoryAllowed(candidate.sourceId))throw new StoreError('Memory sample authorization changed',409);
    const records=await archiveReader.evidence({ids:input.evidenceIds.slice(0,8)});return records.flatMap(record=>offset<record.ocrText.length?[originalEvidenceReceipt(record,offset,Math.min(length,record.ocrText.length-offset))]:[]);
  }});

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
    await app.register(staticFiles,{root:web,prefix:'/',wildcard:false});
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
  const activity=new ActivityProjection(store,new Operations(store),{delegation});
  const applyExecution=(value:ExecutionSettingsValue)=>{
    interactiveGate.configure(value.interactiveConcurrency);interactiveModelGate.configure(value.interactiveConcurrency);
    agentGate.configure(value.agentConcurrency);llmGate.configure(value.llmConcurrency);
  };
  configService.setHandler<ExecutionSettingsValue>('execution',(next,previous)=>({apply:()=>{},publish:()=>applyExecution(next),rollback:()=>{applyExecution(previous);memoryPipeline.wake();},complete:()=>memoryPipeline.wake()}));
  configService.setHandler<DiagnosticsSettingsValue>('diagnostics',next=>diagnostics.prepareConfiguration(next));
  configService.setHandler<{syncIntervalMs:number}>('connectors',(next,previous)=>({apply:()=>{},publish:()=>connectors.configureSyncInterval(next.syncIntervalMs),rollback:()=>connectors.configureSyncInterval(previous.syncIntervalMs)}));
  const automaticActivity=new AutomaticActivity(store,materials,executor,configService,{query:input=>queryAgent(input,'query','activity'),selection:profileId=>{const selected=modelSettings.select('chat',profileId);return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},lane:()=>workflows.settings().semantic});
  const featureServices={pluginCenter,contextTrees,automaticActivity,configService,memoryBindings,memoryPublication,ownerQuestions,automaticMemoryScheduling:dependencies?.backgroundWorker!==false,activity,delegation,memoryDelegation,connectionIdentity,assertRequestActive,memoryIntegrationSettings,memoryRecipeSettings,setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},connectors,processing,executor,agentFeatures,archiveReader,isClosing:()=>closing,actions,agent,agentGate,archivedFiles,codex,config,connections,contentStorage,conversations,credential,diagnosticSnapshot,diagnostics,eventLoop,evidenceReader,fileEvidence,files,importTasks,imports,indexer,ingress,insight,insightRequestSchema,insightRuns,interactiveGate,interactiveModelGate,jobId,launchImport,lifecycle,llmGate,maintenanceWorker,materialOrganizer,materialMemoryWork,materials,mediaAssets,mediaRange,memories,memoryPipeline,modelSettings,parseCaptureBundle,perception,providerAdmission,queryAgent,queryRuns,queryWithAttachmentsSchema,reviewExtraction,runtimeSettings,semanticSelection,serverVersion,softwareUpdate,sourceOwner,sourcePipelines,sources,store,usageLedger,webVersion,workflows};
  const featureHost=new ServerFeatureHost(backendContext,app,()=>diagnostics.record('request.failed',{category:'internal'},'error'));
  registerPluginRoutes(app,{plugins:pluginCenter,bindings:memoryBindings,automation:memoryAutomation,owner:request=>{assertRequestActive(request);if(credential(request))throw new StoreError('Owner authorization is required for plugin control',403);}});
  await installServerFeatures(featureHost,featureServices);
  await configService.startWatching();
  diagnostics.record('server.started');
  app.addHook('onReady',async()=>{
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  app.addHook('preClose',async()=>{
    await configService.close();
    closing=true;executionObserver.close();executor.bindObserver(undefined);eventLoop.disable();queryRuns.interrupt();
    featureHost.stop();automaticActivity.stop();
    memoryPublication.stop();
    // Interrupt execution while its handlers, checkpoints and storage remain
    // available. Fastify then drains HTTP requests before resource disposal.
    // Provider transports must be interrupted while the executor drains. A
    // blocked SDK request cannot wait for onClose to reach its own close method.
    await Promise.allSettled([executor.close(),memoryAdapters.close(),pluginCenter.close()]);
    agentGate.close();llmGate.close();interactiveGate.close();interactiveModelGate.close();
  });
  app.addHook('onClose',async()=>{
    disposeCaptureMemoryIntake();
    await featureHost.close();await delegation.close();
    await backendContext.fiber.dispose();
    await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));
    await modelSettings.close();
    await contentStorage.close();
    try{await agent.close();}catch(error){diagnostics.record('agent.failed',{category:safeError(error).category},'error');}
    await Promise.allSettled([...activeQueries,...importTasks.values()]);await insightRuns.close();await queryRuns.close();await connectors.close();await softwareUpdate.close();await connections.close();
    await memoryPublication.close();await memoryBindings!.close();await pluginCenter.close();await memoryAdapters.close();
    memoryReviews.clear();
    try{if(!dependencies?.store)store.close();}finally{diagnostics.record('server.stopping');await diagnostics.close();}
  });
  return {app,automaticActivity,configService,featureServices,featureHost,pluginCenter,memoryBindings,memoryAdapters,memoryPublication,memoryAutomation,memoryIntegrationSettings,memoryRecipeSettings,memoryStrategies,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,memoryPipeline,indexer,agent,diagnostics,connections,modelSettings,insightRuns,lifecycle,working};
}
