import {CODING_DIALOGUE_SCHEMA_VERSION,formatEvidenceRef} from '@mote/shared';
import {imageOutput} from './evidence-image.js';
import {fileAttachmentAvailable} from './file-attachments.js';
import {MemoryRecipeSettings} from './memory-recipe-settings.js';
import {CAPTURE_BATCH_MAX_RECORDS,CAPTURE_BATCH_MAX_BYTES} from './capture-limits.js';
import {memoryEvidenceFingerprint} from './memory.js';
import { Context } from '@deepseek-ai/cordis';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { AgentNotConfiguredError,AgentYieldError,originalEvidenceReceipt,createImportAgent,skillCatalog,type AgentTraceEvent,type ContextReader,type QueryInput } from '@mote/agent';
import { ProviderFailure,captureSchema,type CaptureInput,type CaptureRecord,type QueryResult } from '@mote/shared';
import { negotiateLocale } from '@mote/shared/i18n';
import Fastify,{ type FastifyReply,type FastifyRequest } from 'fastify';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID,timingSafeEqual } from 'node:crypto';
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
import { registerMemoryDelegation } from './memory-delegation.js';
import { agentDeadline } from './agent-deadline.js';
import { installAgentFeatures } from './agent-feature-host.js';
import { ArchivedFileStore } from './archived-files.js';
import { codingSourcePlugin } from './coding-source-plugin.js';
import { ConcurrencyGate } from './concurrency.js';
import { repositoryRoot,type Config } from './config.js';
import { ConnectionError,Connections,type ConnectionCredential } from './connections.js';
import { registerConnectors } from './connectors/index.js';
import { ContentStorageService } from './content-storage.js';
import { Conversations } from './conversations.js';
import { combineDependencies,resolveDependencies } from './conversation-lineage.js';
import { ServerDiagnostics,safeError,type AgentTraceContext } from './diagnostics.js';
import { EvidenceReader } from './evidence-reader.js';
import { EvidenceExposurePolicy } from './evidence-exposure.js';
import { ExecutionEngine,ExecutionFailure } from './execution-engine.js';
import { ExecutionSettings } from './execution-settings.js';
import { ServerFeatureHost } from './feature-host.js';
import { installServerFeatures } from './features/index.js';
import { FileEvidenceRequests } from './file-evidence.js';
import { FileProcessing,type FileAnalysis,type TranscriptionProvider } from './file-processing.js';
import { FileRawReader,fileOriginalRawRef } from './file-raw-reader.js';
import { registerFileRoutes } from './file-routes.js';
import { FileStore } from './files.js';
import { moteText,requestLocale } from './i18n.js';
import { prepareImportInput } from './import-runtime.js';
import { ImportStore,type ImportPreparation,type ImportPreparationResult } from './imports.js';
import { Indexer } from './indexer.js';
import { INGRESS_PROTOCOL_VERSION,IngressService,collectorIngressWrite,collectorTransportRequest } from './ingress.js';
import { InsightRuns } from './insight-runs.js';
import { insightResult,validateInsightOutput } from './insights.js';
import { registerMemoryExtensions } from './lifecycle-extensions.js';
import {MemoryIntegrationSettings} from './memory-integration-settings.js';
import { MaintenanceWorker } from './maintenance.js';
import { MaterialMemoryWork } from './material-memory-work.js';
import { MaterialOrganizerRuntime } from './material-organizers.js';
import { MaterialStore } from './materials.js';
import { MediaAssets } from './media-assets.js';
import { MemoryLifecycle,storedMemoryLifecycleSettings,freezeSemanticContextTime,type LifecycleExtension } from './memory-lifecycle.js';
import {MemoryStrategies} from './memory-strategies.js';
import type {MemoryReviewStrategy} from './memory-strategy-contract.js';
import { MemoryPipeline } from './memory-pipeline.js';
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
const querySchema=z.object({modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),question:z.string().trim().min(1).max(8000),conversationId:z.string().uuid().optional(),after:scopeFields.after.nullable(),before:scopeFields.before.nullable(),deviceId:scopeFields.deviceId.nullable(),timeZone:scopeFields.timeZone.nullable()}).strict();
const queryWithAttachmentsSchema=querySchema.extend({attachmentIds:z.array(z.string().uuid()).max(4).refine(ids=>new Set(ids).size===ids.length).optional()});
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
export async function buildApp(config:Config,dependencies?:{webRoot?:string;connectorTesting?:import('./connectors/index.js').ConnectorTestDependencies;semanticContextTime?:()=>string;backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void}) {
  config={...config};
  const eventLoop=monitorEventLoopDelay({resolution:20});eventLoop.enable();
  // A foreground node must not block listen() on a full orphan-blob sweep. When
  // the background worker is enabled, let that worker perform maintenance after
  // the HTTP service is available instead of making startup scan the whole vault.
  const store=dependencies?.store??new Store(config.dataDir,{dataKey:config.dataKey,contentEncryptionEnabled:config.contentEncryptionEnabled,maxStorageBytes:config.maxStorageBytes,embeddingEnabled:Boolean(config.embeddingModel),maintenance:Boolean(dependencies?.backgroundWorker)});
  // MVP cut-over is explicit: never silently keep the old Coding event indexes live.
  if(store.db.prepare("SELECT 1 FROM captures WHERE json_extract(json,'$.provenance.document.coding') IS NOT NULL LIMIT 1").get()){eventLoop.disable();if(!dependencies?.store)store.close();throw new Error('Legacy Coding event vault: back up and use a fresh data directory for the source-pipeline architecture. No automatic migration is performed.');}
  const materials=new MaterialStore(store);
  // One service tree owns backend plugins. Each runtime installs into its own
  // managed scope below this root, so closing one cannot dispose a sibling.
  const backendContext=new Context();
  backendContext.provide('moteMaterials',materials);
  const runtimeSettings=new ExecutionSettings(store,config),execution=runtimeSettings.execution(),providerAdmission=new ProviderAdmission(store);
  const agentGate=new ConcurrencyGate(execution.agentConcurrency),llmGate=new ConcurrencyGate(execution.llmConcurrency);
  const interactiveGate=new ConcurrencyGate(execution.interactiveConcurrency),interactiveModelGate=new ConcurrencyGate(execution.interactiveConcurrency);
  const modelContext=new AsyncLocalStorage<QueryInput>();
  const modelOperation=new AsyncLocalStorage<string>();
  const authorizeModelRequest=()=>assertModelEvidence(modelContext.getStore());
  const runModelFor=(settings:import('@mote/shared/models').ModelSettings):NonNullable<import('@mote/agent').AgentOptions['runModel']>=>(task,signal)=>{
    signal?.throwIfAborted();providerAdmission.check(settings);
    const queuedAt=performance.now(),input=modelContext.getStore(),gate=input?.executionLane==='interactive'?interactiveModelGate:llmGate;input?.onTrace?.({type:'model.queued',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background'}});
    input?.onProgress?.({stage:'model',message:moteText('等待模型执行名额')});
    return gate.run(async()=>{providerAdmission.check(settings);assertModelEvidence(input);input?.onProgress?.({stage:'model',message:moteText('模型处理中')});input?.onTrace?.({type:'model.admitted',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background',queueWaitMs:performance.now()-queuedAt}});return task();},signal??input?.signal,input?.traceContext?.operationId??modelOperation.getStore());
  };
  const diagnostics=new ServerDiagnostics({...runtimeSettings.diagnostics(),directory:config.logDirectory??join(config.dataDir,'logs'),maxBytes:config.logMaxBytes,maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries});
  await diagnostics.init();
  const executor=new ExecutionEngine(store);
  backendContext.provide('moteExecution',executor);
  const memoryStrategies=new MemoryStrategies(),memoryRecipeSettings=new MemoryRecipeSettings(store,memoryStrategies);
  backendContext.provide('moteMemoryStrategies',memoryStrategies);
  const materialMemoryWork=new MaterialMemoryWork(store,materials,Date.now,()=>true,memoryRecipeSettings);
  const sourcePipelines=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],backendContext,executor,materialMemoryWork);await sourcePipelines.ready;
  const sources=new SourceStore(store,sourcePipelines),files=new FileStore(store,sources),ingress=new IngressService(store,sources,files);const fileEvidence=new FileEvidenceRequests(sources);
  const mediaAssets=new MediaAssets(process.env.MOTE_MEDIA_MODEL_DIR||join(store.directory,'media-models'));
  const usageLedger=new UsageLedger(store);
  const indexer=new Indexer(store,config,diagnostics,files,input=>{
    const operationId=input.operationId??modelContext.getStore()?.traceContext?.operationId??'embedding:'+randomUUID(),provider='embedding',model=config.embeddingModel;
    const meter=usageLedger.start(provider,model,'embedding',{agentId:'embedding',moduleId:'retrieval',skillId:null,operationId});
    return {finish:(usage,failed)=>{if(usage)meter.update(usage);meter.finish(failed?'failed':'completed');}};
  },{executor,operationId:()=>modelContext.getStore()?.traceContext?.operationId});
  const materialOrganizer=new MaterialOrganizerRuntime(store,materials,[],executor,materialMemoryWork);
  backendContext.provide('moteMaterialOrganizers',materialOrganizer.registry);
  const evidenceReader=new EvidenceReader(store,sources,files,indexer,fileEvidence,materials,sourcePipelines,materialOrganizer.sourceItemRecipes,
    ref=>materialMemoryWork.readyForMemory(ref));
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id)));
  const memories=evidenceReader.memories,conversations=new Conversations(store);
  const archivedFiles=new ArchivedFileStore(store);
  const contentStorage=new ContentStorageService(store,files,archivedFiles);
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
  const assertModelEvidence=(input:QueryInput|undefined)=>{
    if(input?.derivedContextEvidenceIds?.some(id=>!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy())))throw new StoreError('Derived context evidence is no longer permitted for this model',409);
    const conversationText=Boolean(input?.conversation?.workingMemory?.text||input?.conversation?.turns.some(turn=>!turn.evidenceDeleted&&turn.answer));
    const taskText=Boolean(input?.taskContext?.previousSummary||input?.taskContext?.turns?.length);
    if((conversationText&&input?.conversation?.evidenceDependencies?.complete!==true)||((taskText||input?.openingMemories?.length)&&input?.contextEvidenceDependencies?.complete!==true)||input?.openingMemories?.length&&!input?.contextEvidenceDependencies?.ids.length)throw contextFailure('context_lineage_incomplete');
    const dependencies=contextDependencies(input),policy=new EvidenceExposurePolicy();
    for(const id of dependencies?.ids??[]){
      // Derived nodes are retained in the fence alongside their resolved original
      // ancestors. They never grant a raw read; current originals carry policy.
      const original=memories.readEvidence([id])[0];
      if(original){if(!evidenceReader.deletionContextAllowed(id,policy))throw contextFailure('context_evidence_restricted');}
      else if(!store.db.prepare('SELECT 1 FROM memories WHERE id=? UNION SELECT 1 FROM context_artifacts WHERE id=? UNION SELECT 1 FROM file_artifacts WHERE id=?').get(id,id,id))throw contextFailure('context_evidence_restricted');
    }
  };
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
  const reader:ContextReader={...archiveReader,
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
  const queryImages=(ids:string[])=>ids.map(id=>{
    const detail=files.detail(id),version=files.version(id),mimeType=detail.item.mimeType;
    if(!detail.hasOriginal||!version.object_hash||!['image/png','image/jpeg','image/webp'].includes(mimeType??'')||detail.sizeBytes<1||detail.sizeBytes>8*1024*1024)throw new StoreError('Query attachment must be an archived image up to 8 MiB',400);
    return {id,name:detail.item.title||'Attached image',mimeType:mimeType!,hash:version.object_hash,sizeBytes:detail.sizeBytes};
  });
  const agent=new ReloadableAgent(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));
  const codex={executable:config.codexBin,home:config.codexHome};
  const wrapAgent=(inner:QueryAgent,settings:import('@mote/shared/models').ModelSettings):QueryAgent=>({get configured(){return inner.configured;},close:()=>inner.close(),query:async input=>{
    assertModelEvidence(input);
    if(input.evidenceIds&&input.executionLane!=='interactive')input={...input,processingEvidence:Object.fromEntries(memories.readEvidence(input.evidenceIds).map(record=>[record.id,memoryEvidenceFingerprint(record)]))};
    input.signal?.throwIfAborted();providerAdmission.check(settings);
    input.onProgress?.({stage:'starting',phase:'started',message:moteText('等待 Agent 执行名额')});
    return (input.executionLane==='interactive'?interactiveGate:agentGate).run(async()=>{
      const operationId=input.traceContext?.operationId??(input.traceContext?.jobId?'job:'+input.traceContext.jobId:'query:'+randomUUID());
      return modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>{assertModelEvidence(input);return modelContext.run(input,()=>inner.query(input));}));
    },input.signal,input.traceContext?.operationId);
  }});
  const factory:ModelAgentFactory=async(settings,reader)=>wrapAgent(await (dependencies?.createModelAgent?dependencies.createModelAgent(settings,reader):createModelAgent(settings,reader,codex,runModelFor(settings),authorizeModelRequest)),settings);
  let initialAgent=dependencies?.agent?wrapAgent(dependencies.agent,modelSettingsFromConfig(config)):undefined;
  const modelSettings=new ModelSettingsStore({
    directory:config.dataDir,environment:modelSettingsFromConfig(config),codex,
    prepare:async (settings,profiles,defaultProfileId)=>{
      const candidate=await createModelRegistry(profiles,reader,factory,initialAgent,defaultProfileId);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings));
    },
    probe:settings=>testModelConnection(settings,factory),
  });
  try{await modelSettings.initialize();}catch(error){await executor.close();await agent.close();await connections.close();await indexer.close();await sourcePipelines.close();await backendContext.fiber.dispose();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}
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
  const analyzeFile:FileAnalysis=async(records,prompt,settings,signal,host)=>{
    const scoped:ContextReader={search:async()=>records,timeline:async()=>({items:records,nextCursor:null}),evidence:async args=>records.filter(r=>args.ids.includes(r.id)),activity:async()=>({}),devices:async()=>[]};
    const selected=settings.modelSnapshot??resolveFileModel(settings);
    const meter=usageLedger.start(selected.provider,selected.model,'file-analysis',{agentId:'file-analysis',moduleId:'files',skillId:null,...host});
    let model:QueryAgent|undefined;
    try{model=await factory(selected,scoped);const result=await model.query({question:prompt,language:requestLocale.getStore()??'zh-CN',signal,traceContext:host,onUsage:meter.update});return {...result,usage:meter.finish('completed')};}
    catch(error){meter.finish('failed');throw error;}finally{await model?.close();}
  };
  let queryRuns:DelegatedQueryRuns;
  const insightRuns=new InsightRuns(store,{executor,evidenceReader});
  const workflows=new ProcessingRuntime(store,[],{},Date.now,executor,materials,backendContext);
  sourcePipelines.setProductConsumer(workflows);workflows.consumerAllowed=(sourceId,bindingId)=>sourcePipelines.options(sourceId).consumers.includes(bindingId);
  const memoryConfiguration=(id?:string,model?:string)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);};
  const processing:FileProcessing=new FileProcessing(files,dependencies?.transcriptionProvider,undefined,{executor,modules:[...new Set([...(config.backendPluginModules??[]),...(config.fileProcessorModules??[])])],analyze:analyzeFile,analysisSnapshot:resolveFileModel,analysisRevision:()=>modelSettings.view().revision,diagnostics,contextProcessors:workflows.registry,pluginContext:backendContext,mediaAssets});
  try{await processing.runtime.ready;}catch(error){await executor.close();await processing.close();await workflows.close();await sourcePipelines.close();await backendContext.fiber.dispose();await modelSettings.close();await agent.close();await connections.close();await indexer.close();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}

  const perception=new ImageProcessing(store,processing,executor,{materials,mediaAssets,memoryWork:materialMemoryWork,understanding:imageUnderstanding({factory,usage:usageLedger,selection:service=>{
    const selected=modelSettings.select('file'),settings=resolveFileModel({...processing.currentSettings(),analysisModel:service}),configuration=modelConfiguration(service?.id??selected.id,settings,modelSettings.view().revision);
    return {fingerprint:configuration.fingerprint,configured:service?Boolean(service.apiKey||service.execution==='local'):agent.configuredFor(selected.id),settings,receipt:{profileId:service?.id??selected.id,provider:settings.provider,model:settings.model,revision:modelSettings.view().revision}};
  }})});
  const semanticSelection=()=>{const selected=modelSettings.select('memory');return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};};
  workflows.registry.register(semanticProcessor({store,memories,query:input=>{const selected=modelSettings.select('memory',input.modelProfileId),traceContext={...input.traceContext,traceId:randomUUID(),operation:'query' as const,moduleId:'memories',profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:input.modelOverride??selected.settings.model};return agent.query({...input,onTrace:event=>{diagnostics.agentTrace(event,traceContext);input.onTrace?.(event);}});},records:ids=>store.evidence(ids),selection:semanticSelection,usage:usageLedger}));
  workflows.registry.register(conversationUnderstandingProcessor({memories,usage:usageLedger,
    selection:config=>{const selected=modelSettings.select('memory',typeof config?.profileId==='string'?config.profileId:undefined);
      return {...modelConfiguration(selected.id,{...selected.settings,...(typeof config?.modelOverride==='string'?{model:config.modelOverride}:{})},modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},
    resolveEvidence:page=>({records:materials.evidence([...new Set(page.spans.flatMap(span=>span.evidenceId?[span.evidenceId]:[]))]),
      ranges:page.spans.map(span=>({id:span.evidenceId!,offset:span.evidenceOffset!,length:span.pageRange.end-span.pageRange.start}))}),
    query:input=>queryAgent(input,'query','memories'),
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
  await app.register(rateLimit,{max:180,timeWindow:'1 minute',keyGenerator:req=>{const identity=validBearer(req)?'authenticated-owner':connections.authenticate(req.headers.authorization)?.id;return identity?`${identity}:${collectorTransportRequest(req.method,req.routeOptions.url??'')?'transport':'foreground'}`:`unauthenticated:${req.ip}`;},errorResponseBuilder:(req,context)=>({statusCode:context.statusCode,error:'api_rate_limited',message:moteText("请求过于频繁，请稍后重试。"),requestId:req.id})});
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
    reply.code(failure.status).send({error:failure.category,message:failure.message,...(failure.reason?{reason:failure.reason}:{}),requestId:req.id});
  });
  const actions=new Actions(store,files,input=>queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),()=>agent.configured,{semanticArtifacts,executor});

  const connectors=await registerConnectors(app,{memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,ownerAuthorization:header=>{if(validBearer({headers:{authorization:header}}))return true;const c=connections.authenticate(header);return !!c&&connections.isOwner(c);},mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)},dependencies?.connectorTesting);
  const connectionRate={rateLimit:{max:20,timeWindow:'1 minute'}};

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
  function queryAgent(input:QueryInput,operation:'query'|'insight'='query',moduleId='conversations') {
    if(closing)throw new StoreError('Central node is shutting down',503);
    if(input.skill==='personal-insight'&&!input.validateOutput)input={...input,validateOutput:validateInsightOutput};
    if(activeQueries.size>=1000)throw new StoreError('Agent queue is full; retry shortly',429);
    const profile=modelSettings.select(input.responseMode==='memory-extraction'||input.skill==='memory-extraction'||input.skill==='coding-memory'||moduleId==='memories'?'memory':input.skill==='personal-insight'?'insight':'chat',input.modelProfileId);
    input={...input,language:input.language??requestLocale.getStore()??'zh-CN',modelProfileId:profile.id,modelOverride:input.modelOverride??profile.settings.model};
    if(input.contextEvidenceDependencies)input={...input,contextEvidenceDependencies:resolveDependencies(store,input.contextEvidenceDependencies)};
    const configuration=modelConfiguration(profile.id,{...profile.settings,model:input.modelOverride!},modelSettings.view().revision);
    const traceContext:AgentTraceContext={...input.traceContext,traceId:randomUUID(),requestId:diagnostics.requestId(),operation,moduleId,profileId:profile.id,provider:profile.settings.provider,protocol:profile.settings.protocol,model:input.modelOverride??profile.settings.model};
    const startedAt=Date.now();let lastActivity=startedAt;
    const trace=(event:AgentTraceEvent)=>{
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
    trace({type:'query.started',stage:'starting',payload:{question:input.question,taskContext:input.taskContext??null,conversation:input.conversation??null,evidenceIds:input.evidenceIds??null,evidenceRanges:input.evidenceRanges??null,scope:{after:input.after??null,before:input.before??null,deviceId:input.deviceId??null,timeZone:input.timeZone??null},skill:input.skill??null,responseMode:input.responseMode??'answer'}});
    const revision=store.deletionRevision();
    const meter=usageLedger.start(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,{agentId:'context-query',moduleId,skillId:input.skill??null,operationId:input.traceContext?.operationId,jobId:input.traceContext?.jobId,requestId:diagnostics.requestId()});
    const deadline=agentDeadline(input.signal,profile.settings.agentTimeoutMs),taskSignal=deadline.signal;
    const observed={...input,signal:taskSignal,traceContext,onProgress:(event:import('@mote/agent').AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},onTrace:trace,onUsage:(tokens:import('@mote/shared').TokenUsage)=>{meter.update(tokens);input.onUsage?.(tokens);}};
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>agent.query(observed).then(result=>{
      taskSignal?.throwIfAborted();
      assertModelEvidence(input);
      const evidenceDependencies=resolveDependencies(store,combineDependencies([contextDependencies(input),result.evidenceDependencies]));
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
      return {...result,...(evidenceDependencies?{evidenceDependencies}:{}),configuration,usage:meter.finish('completed')};
    }).catch(error=>{if(error instanceof AgentYieldError){meter.finish('completed');trace({type:'query.yielded',status:'waiting'});throw error;}meter.finish('failed');trace({type:'query.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:typeof (error as {reason?:unknown})?.reason==='string'?(error as {reason:string}).reason:undefined}});throw error;}),result=>({citations:result.citations.length,toolCalls:result.trace.length,activeQueries:activeQueries.size}));
    activeQueries.add(promise);void promise.finally(()=>{deadline.dispose();clearInterval(heartbeat);activeQueries.delete(promise);}).catch(()=>{});return promise;
  }
  const memoryReviews=new MemoryReviewCache();
  const reviewExtraction=(input:QueryInput,result:QueryResult,strategy?:MemoryReviewStrategy)=>reviewMemory(input,result,next=>queryAgent(next,'query','memories'),{
    strategy,deletions:memories.deletions,authorizeDeletionEvidence:ids=>memoryPipeline.assertDeletionEvidenceAllowed(ids,input.modelProfileId),cache:memoryReviews,snapshot:()=>{
      const ids=input.evidenceIds??[];
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
      config:{candidatePolicy:input.candidatePolicy,modelFingerprint:configuration.fingerprint,profileId:configuration.profileId,modelOverride:configuration.model,
        contextTime:input.job.contextTime,timeZone:input.job.timeZone,language:input.job.language,processingMaterialInputs:input.materialInputs.map(pin=>({materialId:pin.materialId,required:pin.required,fingerprint:pin.fingerprint,evidenceIds:pin.evidenceIds.filter(id=>input.ranges.some(range=>range.id===id))}))}}],input.parentGrant);
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
  const memoryPipeline=new MemoryPipeline({understand:understandConversation,materialSourceCurrent:(pin,id)=>evidenceReader.materialSourceCurrent(pin,id),materialPlanAllowed:id=>evidenceReader.materialPlanAllowed(id,new EvidenceExposurePolicy()),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:ref=>materialMemoryWork.sourceRequirements(ref),batchCharacters:()=>storedMemoryLifecycleSettings(store).batchCharacters,automaticAllowed:job=>materialMemoryWork.authorized(job)&&[...(job.automaticGrants??[]),...(job.automaticGrant?[job.automaticGrant]:[])].every(grant=>sourcePipelines.memoryAllowed(grant.sourceId)),strategies:memoryStrategies,executor,store,memories,deletionEvidenceAllowedForMemory:id=>evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()),materialAllowedForMemory:(ref,profileId,required)=>evidenceReader.materialAllowedForMemory(ref,new EvidenceExposurePolicy(),required),configuration:memoryConfiguration,concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),review:reviewExtraction,query:input=>queryAgent(input,'query','memories'),model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}},skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`});
  memoryRecipeSettings.onChange=()=>materialMemoryWork.inputs.revokeDisabled();
  memoryRecipeSettings.onApplied=()=>materialMemoryWork.reconcile(memoryPipeline);
  materialMemoryWork.reconcile(memoryPipeline);
  const lifecycle=new MemoryLifecycle(store,()=>agent.configured,Date.now,executor,dependencies?.semanticContextTime),working=new WorkingMemory(store,conversations);
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
      const meter=usageLedger.start(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId:input.operationId});
      const operationId=input.operationId??'import:'+randomUUID();
      let runtime:ReturnType<typeof createImportAgent>|undefined;const abort=()=>{void runtime?.close();};input.signal?.addEventListener('abort',abort,{once:true});
      try{runtime=createImportAgent({...settings,codex,runModel:runModelFor(settings),authorizeModelRequest:authorizeModelRequest});importAgents.add(runtime);const {signal:_signal,operationId:_operationId,...request}=prepared;const result=await agentGate.run(()=>modelOperation.run(operationId,()=>providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},dependencies?.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>meter.update(usage)))),input.signal,input.operationId);input.signal?.throwIfAborted();meter.finish('completed');return result;}
      catch(error){meter.finish('failed');throw error;}finally{input.signal?.removeEventListener('abort',abort);try{await runtime?.close();}finally{if(runtime)importAgents.delete(runtime);}}
    }),
    // Capture/file journals are durable. Import completion only queues increments;
    // the lifecycle applies the owner's change threshold or maximum wait.
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

  const delegation=new DelegationRuntime(store,executor,{concurrency:()=>runtimeSettings.execution().agentConcurrency,
    validateDependencies:ids=>assertModelEvidence({question:'',contextEvidenceDependencies:{version:1,complete:true,ids:[...ids]}}),
    revalidateEvidence:async receipts=>{
      const ids=[...new Set(receipts.map(receipt=>receipt.id))],policy=new EvidenceExposurePolicy();
      if(ids.some(id=>!evidenceReader.deletionContextAllowed(id,policy)))throw contextFailure('context_evidence_restricted');
      const originals=evidenceReader.context(evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id))));
      if(originals.length!==ids.length)throw contextFailure('context_evidence_restricted');
      return originals;
    },
  });
  type SavedQuery={hostRequest:unknown;language?:QueryInput['language'];prepared?:QueryInput;configurationFingerprint?:string};
  async function prepareDelegatedQuery(body:unknown,work:DelegationWork,signal:AbortSignal,onProgress:QueryInput['onProgress']):Promise<QueryInput>{
    signal.throwIfAborted();if(!agent.configured)throw new AgentNotConfiguredError();
    const saved=delegation.journal.payload<SavedQuery>(work.id);
    if(saved.prepared){
      const selected=modelSettings.select('chat',saved.prepared.modelProfileId),current=modelConfiguration(selected.id,{...selected.settings,model:saved.prepared.modelOverride??selected.settings.model},modelSettings.view().revision);
      if(saved.configurationFingerprint!==current.fingerprint)throw new StoreError('Query model configuration changed',409);
      assertModelEvidence(saved.prepared);return {...saved.prepared,signal,onProgress};
    }
    const {conversationId,question,modelProfileId,modelOverride,attachmentIds=[],...selected}=queryWithAttachmentsSchema.parse(body);
    const previous=conversationId?conversations.get(conversationId):undefined;
    if(previous&&previous.turnCount>=200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
    const scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const){const value=key==='timeZone'&&selected.timeZone===undefined?previous?.scope.timeZone:selected[key];if(value!==undefined&&value!==null)scope[key]=value;}
    insightSchema.parse(scope);
    const profile=modelSettings.select('chat',modelProfileId),model=modelOverride??profile.settings.model,contextTime=work.scope.contextTime!;
    const previousIds=previous?.turns.slice(-20).flatMap(turn=>turn.attachments?.map(attachment=>attachment.id)??[])??[],previousAvailable=previousIds.filter(id=>{try{return Boolean(files.detail(id).hasOriginal);}catch{return false;}});
    const directImages=queryImages([...new Set([...attachmentIds,...previousAvailable.slice(-4)])]);
    const stepId=work.id+':coordinator:'+work.revision,fence=String(store.db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(stepId)?.fence??'');
    const commit=<T>(write:()=>T):T=>{signal.throwIfAborted();const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');try{if(!fence||!executor.isCurrentGrant(stepId,fence))throw new StoreError('Query preparation grant expired',409);const result=write();if(own)store.db.exec('COMMIT');return result;}catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}};
    const [opening,conversation]=await Promise.all([
      openingMemoryContext(archiveReader,question,{...scope,contextTime}),
      previous?working.prepare(previous,lifecycle.settings(),question,input=>queryAgent({...input,contextTime,traceContext:{...input.traceContext,operationId:work.operationId},executionLane:'interactive',modelProfileId:profile.id,modelOverride:model,signal},'query','conversations'),{signal,commit}):undefined,
    ]);
    const prepared:QueryInput={traceContext:{operationId:work.operationId},language:saved.language??'zh-CN',executionLane:'interactive',question,...scope,contextTime,modelProfileId:profile.id,modelOverride:model,directImages,openingMemories:opening.leads,contextEvidenceDependencies:opening.evidenceDependencies,...(conversation?{conversation}:{})};
    commit(()=>{
      assertModelEvidence(prepared);
      const freshImages=queryImages(directImages.map(image=>image.id));
      if(freshImages.some((image,index)=>image.hash!==directImages[index].hash||image.mimeType!==directImages[index].mimeType||image.sizeBytes!==directImages[index].sizeBytes))throw new StoreError('Query attachment changed during preparation',409);
      for(const image of directImages){const version=files.version(image.id);if(!store.evidence([image.id]).length||!fileAttachmentAvailable(store,image.id)||store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted)throw new StoreError('Query attachment is no longer available',409);}
      delegation.recordEvidence(work.id,[...(contextDependencies(prepared)?.ids??[]),...directImages.map(image=>image.id)]);
      delegation.journal.savePayload(work.id,{...saved,prepared,configurationFingerprint:modelConfiguration(profile.id,{...profile.settings,model},modelSettings.view().revision).fingerprint});
    });
    return {...prepared,signal,onProgress};
  }
  queryRuns=new DelegatedQueryRuns(store,delegation,{
    contextTime:()=>freezeSemanticContextTime(dependencies?.semanticContextTime),
    prepare:prepareDelegatedQuery,query:input=>queryAgent(input),
    commit:(body,result,work)=>{
      const {conversationId,question,attachmentIds=[]}=queryWithAttachmentsSchema.parse(body),saved=delegation.journal.payload<SavedQuery>(work.id),prepared=saved.prepared!;
      assertModelEvidence(prepared);
      delegation.recordEvidence(work.id,[...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
      const previous=conversationId?conversations.get(conversationId):undefined,scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const)if(prepared[key]!==undefined)scope[key]=prepared[key];
      return conversations.append(previous,{question,...scope,attachments:prepared.directImages?.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result);
    },
    failure:(body,error)=>{
      const {conversationId,question,...selected}=queryWithAttachmentsSchema.parse(body),scope:QueryScope={};for(const key of ['after','before','deviceId','timeZone'] as const)if(selected[key]!==undefined&&selected[key]!==null)scope[key]=selected[key]!;
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
    return {version:1,scope:'central-safe-diagnostics',...diagnostics.snapshot(),execution:{agents:agentGate.snapshot(),llm:llmGate.snapshot()},services:{agentConfigured:agent.configured,embeddingConfigured:indexer.configured,activeQueries:activeQueries.size,closing},queue:{index:counts,devices:devices.length,reportedPending:devices.reduce((n,d)=>n+d.queueDepth,0)},storage:{captures:storage.captures,imageCaptures:storage.imageCaptures,blobs:storage.blobs,bytes:storage.bytes,logicalBytes:storage.logicalBytes,maxBytes:storage.maxBytes,imagesEncrypted:storage.imagesEncrypted}};
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
  const featureServices={automaticMemoryScheduling:dependencies?.backgroundWorker!==false,activity,delegation,memoryDelegation,connectionIdentity,assertRequestActive,memoryIntegrationSettings,memoryRecipeSettings,setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},connectors,processing,executor,agentFeatures,archiveReader,isClosing:()=>closing,actions,agent,agentGate,archivedFiles,codex,config,connectionRate,connections,contentStorage,conversations,credential,diagnosticSnapshot,diagnostics,eventLoop,evidenceReader,fileEvidence,files,importTasks,imports,indexer,ingress,insight,insightRequestSchema,insightRuns,interactiveGate,interactiveModelGate,jobId,launchImport,lifecycle,llmGate,maintenanceWorker,materialOrganizer,materialMemoryWork,materials,mediaAssets,mediaRange,memories,memoryPipeline,modelSettings,parseCaptureBundle,perception,providerAdmission,queryAgent,queryRuns,queryWithAttachmentsSchema,reviewExtraction,runtimeSettings,semanticSelection,serverVersion,softwareUpdate,sourceOwner,sourcePipelines,sources,store,usageLedger,webVersion,workflows};
  const featureHost=new ServerFeatureHost(backendContext,app,()=>diagnostics.record('request.failed',{category:'internal'},'error'));
  await installServerFeatures(featureHost,featureServices);
  diagnostics.record('server.started');
  app.addHook('onReady',async()=>{
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  app.addHook('preClose',async()=>{
    closing=true;eventLoop.disable();queryRuns.interrupt();
    featureHost.stop();
    // Interrupt execution while its handlers, checkpoints and storage remain
    // available. Fastify then drains HTTP requests before resource disposal.
    await executor.close();
    agentGate.close();llmGate.close();interactiveGate.close();interactiveModelGate.close();
  });
  app.addHook('onClose',async()=>{
    await featureHost.close();await delegation.close();
    await backendContext.fiber.dispose();
    await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));
    await modelSettings.close();
    await contentStorage.close();
    try{await agent.close();}catch(error){diagnostics.record('agent.failed',{category:safeError(error).category},'error');}
    await Promise.allSettled([...activeQueries,...importTasks.values()]);await insightRuns.close();await queryRuns.close();await connectors.close();await softwareUpdate.close();await connections.close();
    memoryReviews.clear();
    try{if(!dependencies?.store)store.close();}finally{diagnostics.record('server.stopping');await diagnostics.close();}
  });
  return {app,featureServices,featureHost,memoryIntegrationSettings,memoryRecipeSettings,memoryStrategies,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,memoryPipeline,indexer,agent,diagnostics,connections,modelSettings,insightRuns,lifecycle,working};
}
