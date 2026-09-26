import { Context } from '@deepseek-ai/cordis';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { AgentNotConfiguredError,createImportAgent,skillCatalog,type AgentTraceEvent,type ContextReader,type QueryInput } from '@mote/agent';
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
import { installAgentFeatures } from './agent-feature-host.js';
import { ArchivedFileStore } from './archived-files.js';
import { codingSourcePlugin } from './coding-source-plugin.js';
import { ConcurrencyGate } from './concurrency.js';
import { repositoryRoot,type Config } from './config.js';
import { ConnectionError,Connections,type ConnectionCredential } from './connections.js';
import { registerConnectors } from './connectors/index.js';
import { ContentStorageService } from './content-storage.js';
import { Conversations } from './conversations.js';
import { ServerDiagnostics,safeError,type AgentTraceContext } from './diagnostics.js';
import { EvidenceReader } from './evidence-reader.js';
import { ExecutionEngine } from './execution-engine.js';
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
import { INGRESS_PROTOCOL_VERSION,IngressService,collectorIngressWrite } from './ingress.js';
import { InsightRuns } from './insight-runs.js';
import { insightResult,validateInsightOutput } from './insights.js';
import { recoverableMemoryJobs,registerMemoryExtensions } from './lifecycle-extensions.js';
import { MaintenanceWorker } from './maintenance.js';
import { MaterialMemoryWork } from './material-memory-work.js';
import { MaterialOrganizerRuntime } from './material-organizers.js';
import { MaterialStore } from './materials.js';
import { MediaAssets } from './media-assets.js';
import { MemoryLifecycle,type LifecycleExtension } from './memory-lifecycle.js';
import { MemoryPipeline } from './memory-pipeline.js';
import { MemoryReviewCache } from './memory-review-cache.js';
import { reviewMemory } from './memory-review.js';
import { ReloadableAgent,applyModelSettings,createModelAgent,createModelRegistry,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory } from './model-agent.js';
import { MINIMUM_MODEL_INPUT_RESERVATION_TOKENS,ModelBudgets } from './model-budgets.js';
import { ModelCatalogError } from './model-catalog.js';
import { modelConfiguration } from './model-configuration.js';
import { ModelSettingsError,ModelSettingsStore,modelProfileIdSchema } from './model-settings.js';
import { openingMemories } from './opening-memory.js';
import { linkOperationParent } from './operation-projection.js';
import { Perception } from './perception.js';
import { ProcessingRuntime } from './processing-runtime.js';
import { ProviderAdmission } from './provider-admission.js';
import { PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput } from './python-source-pack-executor.js';
import { QueryRuns } from './query-runs.js';
import { scopeFields,validRange,type QueryScope } from './query-scope.js';
import { MAX_RAW_READ_BYTES } from './raw-reader.js';
import { semanticProcessor } from './semantic-extraction.js';
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
const CAPTURE_BUNDLE_MAX_INFLATED_BYTES=32*1024*1024;
const CAPTURE_BUNDLE_MAX_RECORDS=500;
function parseCaptureBundle(body:unknown):CaptureInput[] {
  if(!Buffer.isBuffer(body))throw new StoreError('Capture bundle body must be gzip bytes');
  let inflated:Buffer;
  try{inflated=gunzipSync(body,{maxOutputLength:CAPTURE_BUNDLE_MAX_INFLATED_BYTES});}
  catch{throw new StoreError('Invalid capture bundle compression');}
  const text=inflated.toString('utf8');
  const lines=text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n');
  if(lines.length<1||lines.length>CAPTURE_BUNDLE_MAX_RECORDS||lines.some(line=>line.length===0))throw new StoreError('Capture bundle JSONL is empty or too large');
  try{return lines.map(line=>captureSchema.parse(JSON.parse(line)));}
  catch(error){if(error instanceof z.ZodError)throw error;throw new StoreError('Invalid capture bundle JSONL');}
}
const serverVersion=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
export async function buildApp(config:Config,dependencies?:{backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void}) {
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
  const runtimeSettings=new ExecutionSettings(store,config),execution=runtimeSettings.execution(),providerAdmission=new ProviderAdmission(store),modelBudgets=new ModelBudgets(store);
  const agentGate=new ConcurrencyGate(execution.agentConcurrency),llmGate=new ConcurrencyGate(execution.llmConcurrency);
  const interactiveGate=new ConcurrencyGate(execution.interactiveConcurrency),interactiveModelGate=new ConcurrencyGate(execution.interactiveConcurrency);
  const modelContext=new AsyncLocalStorage<QueryInput>();
  const budgetContext=new AsyncLocalStorage<{id:string;operationId:string;usage?:import('@mote/shared').TokenUsage;price?:import('@mote/shared').ModelPrice}>();
  const admitModelRequest=(settings:import('@mote/shared/models').ModelSettings)=>(inputBytes:number)=>{const context=budgetContext.getStore();if(!context){if(modelBudgets.enabled(settings.provider))throw new ProviderFailure({category:'blocked',code:'model_budget_unavailable'});return;}modelBudgets.reserve({id:context.id,operationId:context.operationId,provider:settings.provider,model:settings.model,inputTokens:Math.max(MINIMUM_MODEL_INPUT_RESERVATION_TOKENS,inputBytes),outputTokens:settings.maxTokens,price:context.price});};
  const runModelFor=(settings:import('@mote/shared/models').ModelSettings):NonNullable<import('@mote/agent').AgentOptions['runModel']>=>(task,signal)=>{
    signal?.throwIfAborted();providerAdmission.check(settings);if(settings.protocol==='codex-app-server')modelBudgets.requireBoundedRuntime(settings.provider);
    const queuedAt=performance.now(),input=modelContext.getStore(),gate=input?.executionLane==='interactive'?interactiveModelGate:llmGate;input?.onTrace?.({type:'model.queued',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background'}});
    input?.onProgress?.({stage:'model',message:moteText('等待模型执行名额')});
    return gate.run(async()=>{providerAdmission.check(settings);input?.onProgress?.({stage:'model',message:moteText('模型处理中')});input?.onTrace?.({type:'model.admitted',stage:'model',payload:{...gate.snapshot(),unit:'harness_session',lane:input?.executionLane??'background',queueWaitMs:performance.now()-queuedAt}});return task();},signal??input?.signal,input?.traceContext?.operationId??budgetContext.getStore()?.operationId);
  };
  const diagnostics=new ServerDiagnostics({...runtimeSettings.diagnostics(),directory:config.logDirectory??join(config.dataDir,'logs'),maxBytes:config.logMaxBytes,maxFiles:config.logMaxFiles,maxEntries:config.logMaxEntries});
  await diagnostics.init();
  const executor=new ExecutionEngine(store);
  backendContext.provide('moteExecution',executor);
  const sourcePipelines=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],backendContext,executor);await sourcePipelines.ready;
  const sources=new SourceStore(store,sourcePipelines),files=new FileStore(store,sources),ingress=new IngressService(store,sources,files);const fileEvidence=new FileEvidenceRequests(sources);
  const mediaAssets=new MediaAssets(process.env.MOTE_MEDIA_MODEL_DIR||join(store.directory,'media-models'));
  const usageLedger=new UsageLedger(store);
  const indexer=new Indexer(store,config,diagnostics,files,input=>{
    const id=randomUUID(),operationId=input.operationId??modelContext.getStore()?.traceContext?.operationId??'embedding:'+id,provider='embedding',model=config.embeddingModel,price=usageLedger.prices().find(p=>p.provider===provider&&p.model===model);
    modelBudgets.reserve({id,operationId,provider,model,inputTokens:input.bytes,outputTokens:0,price});
    const meter=usageLedger.start(provider,model,'embedding',{agentId:'embedding',moduleId:'retrieval',skillId:null,operationId});
    return {finish:(usage,failed)=>{if(usage)meter.update(usage);meter.finish(failed?'failed':'completed');modelBudgets.finish(id,usage,price);}};
  },{executor,operationId:()=>modelContext.getStore()?.traceContext?.operationId});
  const materialMemoryWork=new MaterialMemoryWork(store,materials);
  const materialOrganizer=new MaterialOrganizerRuntime(store,materials,[],executor,materialMemoryWork);
  const evidenceReader=new EvidenceReader(store,sources,files,indexer,fileEvidence,materials,sourcePipelines,materialOrganizer.sourceItemRecipes,
    ref=>materialMemoryWork.readyForMemory(ref));
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids);
  const memories=evidenceReader.memories,conversations=new Conversations(store);
  const archivedFiles=new ArchivedFileStore(store);
  const contentStorage=new ContentStorageService(store,files,archivedFiles);
  const connections=dependencies?.connections??new Connections(store,sources);await connections.init();
  const identities=new WeakMap<FastifyRequest,ConnectionCredential>();
  const credential=(req:FastifyRequest)=>identities.get(req);
  const sourceOwner=(req:FastifyRequest,id:string)=>{const c=credential(req);if(c)connections.assertOwnSource(c,id);};
  const context=(records:CaptureRecord[])=>evidenceReader.context(records);
  const agentFeatures=await installAgentFeatures(backendContext,evidenceReader.agent({diagnostics,allowQueryImages:()=>perception.settings().allowQueryImages,
    currentOperation:()=>modelContext.getStore()?.responseMode==='memory-extraction'?'memory':'query',
    currentGrantContext:()=>modelContext.getStore()}));
  const archiveReader=agentFeatures.reader;
  const directImage=(id:string)=>modelContext.getStore()?.directImages?.find(image=>image.id===id);
  const fileRawReader=new FileRawReader(store,files,archivedFiles,{
    mayReadFileVersion:(_sourceId,id)=>Boolean(directImage(id)),mayReadArchivedFile:()=>false,mayListSourceFiles:()=>false,mayListArchivedFiles:()=>false,
  });
  const reader:ContextReader={...archiveReader,
    evidence:async args=>{
      const direct=args.ids.flatMap(id=>{const image=directImage(id);return image?[{id,capturedAt:modelContext.getStore()?.contextTime??new Date().toISOString(),appName:image.name,ocrText:'',sourceType:'user_attachment',summary:'User attached image',metadata:{mimeType:image.mimeType}}]:[];});
      const regular=args.ids.filter(id=>!directImage(id));
      return [...direct,...(regular.length?await archiveReader.evidence({...args,ids:regular}):[])];
    },
    readImage:async({id})=>{
      const direct=directImage(id);
      if(!direct)return archiveReader.readImage!({id});
      const ref=fileOriginalRawRef(id,direct.hash),parts:Buffer[]=[];
      for(let offset=0;offset<direct.sizeBytes;){
        const page=await fileRawReader.read(ref,{offset,length:Math.min(MAX_RAW_READ_BYTES,direct.sizeBytes-offset)});
        if(page.status!=='available'||page.totalBytes!==direct.sizeBytes||page.mediaType!==direct.mimeType||page.bytes.length===0)throw new StoreError('Attached image is unavailable',404);
        parts.push(Buffer.from(page.bytes));offset+=page.bytes.length;
      }
      return {mimeType:direct.mimeType,data:Buffer.concat(parts).toString('base64')};
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
    input.signal?.throwIfAborted();providerAdmission.check(settings);
    input.onProgress?.({stage:'starting',phase:'started',message:moteText('等待 Agent 执行名额')});
    return (input.executionLane==='interactive'?interactiveGate:agentGate).run(async()=>{
      const id=randomUUID(),context={id,operationId:input.traceContext?.operationId??(input.traceContext?.jobId?'job:'+input.traceContext.jobId:'query:'+id),price:usageLedger.prices().find(p=>p.provider===settings.provider&&p.model===settings.model),usage:undefined as import('@mote/shared').TokenUsage|undefined};
      const observed={...input,onUsage:(usage:import('@mote/shared').TokenUsage)=>{context.usage=usage;modelBudgets.observe(id,usage,context.price);input.onUsage?.(usage);}};
      try{return await budgetContext.run(context,()=>providerAdmission.run(settings,()=>modelContext.run(observed,()=>inner.query(observed))));}finally{modelBudgets.finish(id,context.usage,context.price);}
    },input.signal,input.traceContext?.operationId);
  }});
  const factory:ModelAgentFactory=async(settings,reader)=>wrapAgent(await (dependencies?.createModelAgent?dependencies.createModelAgent(settings,reader):createModelAgent(settings,reader,codex,runModelFor(settings),admitModelRequest(settings))),settings);
  let initialAgent=dependencies?.agent?wrapAgent(dependencies.agent,modelSettingsFromConfig(config)):undefined;
  const modelSettings=new ModelSettingsStore({
    directory:config.dataDir,environment:modelSettingsFromConfig(config),codex,
    prepare:async (settings,profiles)=>{
      const candidate=await createModelRegistry([{id:'default',name:moteText("默认配置"),settings},...profiles],reader,factory,initialAgent);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings));
    },
    probe:settings=>testModelConnection(settings,factory),
  });
  try{await modelSettings.initialize();}catch(error){await agent.close();await connections.close();await indexer.close();await sourcePipelines.close();await executor.close();await backendContext.fiber.dispose();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}
  // Fastify/Pino request and Error serializers may contain raw URLs, bodies or SDK text.
  // Emit only our fixed-schema events, never serialize arbitrary request/error objects.
  const resolveFileModel=(settings:Parameters<FileAnalysis>[2],localOnly:boolean)=>{
    let selected=modelSettings.select('file').settings;
    if(settings.analysisModel){
      const m=settings.analysisModel;if(localOnly&&m.execution!=='local')throw new StoreError(moteText("本地文件不能使用远程语言模型"),409);
      selected={...selected,provider:'custom',protocol:'openai-completions',baseUrl:m.endpoint,model:m.model,apiKey:m.apiKey??'',headers:{},extraBody:{},allowUnauthenticatedLocal:m.execution==='local',reasoningEffort:'auto'};
    }else if(localOnly){
      if(!settings.localModelName||!['127.0.0.1','localhost','[::1]'].includes(new URL(settings.localModelEndpoint).hostname))throw new StoreError('Configure a local language model for this operation',409);
      selected={...selected,provider:'custom',protocol:'openai-completions',baseUrl:settings.localModelEndpoint,model:settings.localModelName,apiKey:settings.localModelApiKey??'',headers:{},extraBody:{},allowUnauthenticatedLocal:true,reasoningEffort:'auto'};
    }
    return structuredClone(selected);
  };
  const analyzeFile:FileAnalysis=async(records,prompt,settings,localOnly,signal,host)=>{
    const scoped:ContextReader={search:async()=>records,timeline:async()=>records,evidence:async args=>records.filter(r=>args.ids.includes(r.id)),activity:async()=>({}),devices:async()=>[]};
    const selected=settings.modelSnapshot??resolveFileModel(settings,localOnly);
    const meter=usageLedger.start(selected.provider,selected.model,'file-analysis',{agentId:'file-analysis',moduleId:'files',skillId:null,...host});
    let model:QueryAgent|undefined;
    try{model=await factory(selected,scoped);const result=await model.query({question:prompt,language:requestLocale.getStore()??'zh-CN',signal,traceContext:host,onUsage:meter.update});return {...result,usage:meter.finish('completed')};}
    catch(error){meter.finish('failed');throw error;}finally{await model?.close();}
  };
  const queryRuns=new QueryRuns(store,{executor,concurrency:()=>runtimeSettings.execution().interactiveConcurrency});
  const insightRuns=new InsightRuns(store,{executor});
  const workflows=new ProcessingRuntime(store,[],{},Date.now,executor,materials,backendContext);
  const processing:FileProcessing=new FileProcessing(files,dependencies?.transcriptionProvider,undefined,{executor,modules:config.fileProcessorModules,analyze:analyzeFile,analysisSnapshot:resolveFileModel,analysisRevision:()=>modelSettings.view().revision,diagnostics,contextProcessors:workflows.registry,pluginContext:backendContext,mediaAssets});
  try{await processing.runtime.ready;}catch(error){await processing.close();await workflows.close();await sourcePipelines.close();await executor.close();await backendContext.fiber.dispose();await modelSettings.close();await agent.close();await connections.close();await indexer.close();if(!dependencies?.store)store.close();await diagnostics.close();throw error;}

  const perception=new Perception(store,processing.runtime,executor,mediaAssets);
  const semanticSelection=()=>{const selected=modelSettings.select('memory');return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};};
  workflows.registry.register(semanticProcessor({store,memories,query:input=>{const selected=modelSettings.select('memory',input.modelProfileId),traceContext={...input.traceContext,traceId:randomUUID(),operation:'query' as const,moduleId:'memories',profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:input.modelOverride??selected.settings.model};return agent.query({...input,onTrace:event=>{diagnostics.agentTrace(event,traceContext);input.onTrace?.(event);}});},records:ids=>store.evidence(ids),selection:semanticSelection,usage:usageLedger}));
  const semanticArtifacts=async(ids:string[],operationId?:string)=>{
    const ready:string[]=[];
    for(const id of ids){
      const artifact=store.archive.get(id);if(!artifact)continue;
      if(artifact.kind==='semantic'){ready.push(id);continue;}
      if(artifact.kind!=='segment'||artifact.metadata.complete!==true)continue;
      const jobs=workflows.enqueue([{name:'semantic',processor:'mote.segment-understanding',inputs:[],artifactInputs:[{id,revision:artifact.revision}],config:{artifactId:id,modelFingerprint:semanticSelection().fingerprint}}]);
      if(operationId)linkOperationParent(store,operationId,executor.get(jobs.semantic)!.operationId);
      await workflows.tick();
      const row=store.db.prepare('SELECT state,json FROM processing_jobs WHERE id=?').get(jobs.semantic)!;
      if(row.state==='stale')continue;
      if(row.state!=='succeeded')throw new StoreError('Semantic processing is pending or blocked',409);
      ready.push(...JSON.parse(String(row.json)).outputs);
    }
    return [...new Set(ready)];
  };
  const app=Fastify({logger:false,genReqId:()=>randomUUID(),requestIdHeader:false,bodyLimit:12*1024*1024,requestTimeout:180000,frameworkErrors:(_error,_req,reply)=>{const requestId=randomUUID();diagnostics.record('request.failed',{requestId,route:'unknown',category:'validation',statusCode:400},'warn');(reply as FastifyReply).header('X-Request-Id',requestId).code(400).send({error:'validation',message:moteText("请求格式无效。"),requestId});}});
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
  await app.register(rateLimit,{max:180,timeWindow:'1 minute',keyGenerator:req=>validBearer(req)?'authenticated-owner':connections.authenticate(req.headers.authorization)?.id??`unauthenticated:${req.ip}`,errorResponseBuilder:(req,context)=>({statusCode:context.statusCode,error:'rate_limited',message:moteText("请求过于频繁，请稍后重试。"),requestId:req.id})});
  let playbackAuthorization:(req:FastifyRequest)=>boolean=()=>false;
  app.addHook('onRequest',async(req,reply)=>{
    const isApi=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(isApi)reply.header('Cache-Control','no-store');
    if(req.method==='OPTIONS'||req.routeOptions.url==='/api/health'||!isApi||(req.method==='POST'&&req.routeOptions.url==='/api/connections/redeem'))return;
    if(validBearer(req)||playbackAuthorization(req))return;
    const c=connections.authenticate(req.headers.authorization);
    if(!c)return reply.code(401).send({error:'unauthorized',message:moteText("请提供有效访问令牌；管理网页请重新登录"),requestId:req.id});
    identities.set(req,c);connections.assertCollectorRoute(c,req.method,req.routeOptions.url??'');
    if(collectorIngressWrite(req.method,req.routeOptions.url??'')&&req.headers['x-mote-ingress-version']!==INGRESS_PROTOCOL_VERSION)
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

  const connectors=await registerConnectors(app,{files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)});
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
    const deadline=profile.settings.agentTimeoutMs;
    const taskSignal=deadline===null?input.signal:AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(deadline)]);
    const observed={...input,signal:taskSignal,traceContext,onProgress:(event:import('@mote/agent').AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},onTrace:trace,onUsage:(tokens:import('@mote/shared').TokenUsage)=>{meter.update(tokens);input.onUsage?.(tokens);}};
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>agent.query(observed).then(result=>{
      taskSignal?.throwIfAborted();
      // A long-running review may overlap routine imports and derived-layer updates.
      // Only an original actually disclosed to this run being deleted can make
      // its answer unsafe to publish; other archive changes belong to later runs.
      if(store.deletionRevision()!==revision){
        const used=new Set([...(result.evidenceDependencies?.ids??[]),...result.citations.map(citation=>citation.id)]);
        for(const row of store.db.prepare("SELECT id FROM changes WHERE seq>? AND operation='delete'").iterate(revision)){
          if(used.has(String(row.id)))throw new StoreError('Evidence used by this answer was deleted during the run',409);
        }
      }
      trace({type:'query.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{answer:result.answer,citations:result.citations,trace:result.trace,contextUsage:(result as QueryResult & {contextUsage?:unknown}).contextUsage}});
      return {...result,configuration,usage:meter.finish('completed')};
    }).catch(error=>{meter.finish('failed');trace({type:'query.failed',status:'failed',payload:{errorName:error instanceof Error?error.name:'UnknownError',reason:typeof (error as {reason?:unknown})?.reason==='string'?(error as {reason:string}).reason:undefined}});throw error;}),result=>({citations:result.citations.length,toolCalls:result.trace.length,activeQueries:activeQueries.size}));
    activeQueries.add(promise);void promise.finally(()=>{clearInterval(heartbeat);activeQueries.delete(promise);}).catch(()=>{});return promise;
  }
  const memoryReviews=new MemoryReviewCache();
  const reviewExtraction=(input:QueryInput,result:QueryResult)=>reviewMemory(input,result,next=>queryAgent(next,'query','memories'),{
    cache:memoryReviews,snapshot:()=>{
      const ids=input.evidenceIds??[];
      if(ids.some(id=>!memories.isCurrentEvidence(id)))throw new StoreError('Memory evidence changed during review',409);
      // Include full original metadata (speaker, source, device, dates, version),
      // not just quote text. Credentials/config are hashed, never retained.
      return sha256(JSON.stringify([modelSettings.select('memory',input.modelProfileId).settings,memories.readEvidence(ids)]));
    },
  });
  const memoryPipeline=new MemoryPipeline({executor,store,memories,materialAllowedForMemory:ref=>evidenceReader.materialAllowedForMemory(ref),configuration:(id,model)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);},concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),review:reviewExtraction,query:input=>queryAgent(input,'query','memories'),model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}},skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`});
  const lifecycle=new MemoryLifecycle(store,()=>agent.configured,Date.now,config.insightIntervalHours,executor),working=new WorkingMemory(store,conversations);
  registerMemoryExtensions({semanticArtifacts,insights:insightRuns,insightTimeout:()=>modelSettings.select('insight').settings.agentTimeoutMs,lifecycle,store,files,memories,pipeline:memoryPipeline,working,query:(input,module)=>queryAgent(input,input.skill==='personal-insight'?'insight':'query',module),model:()=>modelSettings.select('memory').settings.model});
  for(const extension of dependencies?.memoryExtensions??[])lifecycle.replace(extension);

  const importAgents=new Set<ReturnType<typeof createImportAgent>>(),importTasks=new Map<string,Promise<unknown>>();
  const sourcePacks=new Map((config.importPythonPacks??[]).map(spec=>{
    const executor=new PythonSourcePackExecutor<PythonImportOutput>({...spec,outputSchema:pythonImportOutputSchema});
    return [spec.id,{revision:sha256(JSON.stringify(spec)),prepare:pythonImportPreparation(executor)}] as const;
  }));
  const imports=new ImportStore(store,archivedFiles,sources,{executor,
    sourcePacks,
    prepare:dependencies?.prepareImport??(async input=>{
      if(!agent.configured)throw new AgentNotConfiguredError();
      const selected=modelSettings.select('import');if(!agent.configuredFor(selected.id))throw new AgentNotConfiguredError();
      const settings=selected.settings,prepared=await prepareImportInput(input);
      const meter=usageLedger.start(settings.provider,settings.model,'document-import',{agentId:'document-import',moduleId:'imports',skillId:'document-import',operationId:input.operationId});
      const id=randomUUID(),context={id,operationId:input.operationId??'import:'+id,price:usageLedger.prices().find(p=>p.provider===settings.provider&&p.model===settings.model),usage:undefined as import('@mote/shared').TokenUsage|undefined};
      let runtime:ReturnType<typeof createImportAgent>|undefined;const abort=()=>{void runtime?.close();};input.signal?.addEventListener('abort',abort,{once:true});
      try{runtime=createImportAgent({...settings,codex,runModel:runModelFor(settings),admitModelRequest:admitModelRequest(settings)});importAgents.add(runtime);const {signal:_signal,operationId:_operationId,...request}=prepared;const result=await agentGate.run(()=>budgetContext.run(context,()=>providerAdmission.run(settings,()=>runtime!.prepare({...request,language:requestLocale.getStore()??'zh-CN'},dependencies?.observeImport?event=>dependencies.observeImport!(input.workspace,event):undefined,usage=>{context.usage=usage;modelBudgets.observe(id,usage,context.price);meter.update(usage);}))),input.signal,input.operationId);input.signal?.throwIfAborted();meter.finish('completed');return result;}
      catch(error){meter.finish('failed');throw error;}finally{input.signal?.removeEventListener('abort',abort);modelBudgets.finish(id,context.usage,context.price);try{await runtime?.close();}finally{if(runtime)importAgents.delete(runtime);}}
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

  const runningConversations=new Set<string>();
  async function runQuery(body:unknown,onProgress?:QueryInput['onProgress'],signal?:AbortSignal,operationId='query:'+randomUUID(),execution?:import('./run-execution.js').RunExecutionContext) {
    signal?.throwIfAborted();
    // Preserve the established configuration gate before strict body validation.
    // Once a configured query starts, provider/runtime failures are journaled below.
    if(!agent.configured)throw new AgentNotConfiguredError();
    const {conversationId,question,modelProfileId,modelOverride,attachmentIds=[],...selected}=queryWithAttachmentsSchema.parse(body);
    if(conversationId&&runningConversations.has(conversationId))throw new StoreError('An answer is already running in this conversation',409);
    const previous=conversationId?conversations.get(conversationId):undefined;
    if(previous&&previous.turnCount>=200)throw new StoreError('Conversation has reached its turn limit; start a new conversation',409);
    const scope:QueryScope={};
    for(const key of ['after','before','deviceId','timeZone'] as const) {
      const value=key==='timeZone'&&selected.timeZone===undefined?previous?.scope.timeZone:selected[key];
      if(value!==undefined&&value!==null)scope[key]=value;
    }
    insightSchema.parse(scope);
    if(conversationId)runningConversations.add(conversationId);
    try {
      const selectedProfile=modelSettings.select('chat',modelProfileId),timeout=selectedProfile.settings.agentTimeoutMs;
      signal=timeout===null?signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeout)]);
      signal?.throwIfAborted();
      const previousIds=previous?.turns.slice(-20).flatMap(turn=>turn.attachments?.map(attachment=>attachment.id)??[])??[];
      const previousAvailable=previousIds.filter(id=>{try{return Boolean(files.detail(id).hasOriginal);}catch{return false;}});
      const directImages=queryImages([...new Set([...attachmentIds,...previousAvailable.slice(-4)])]);
      const [memoryLeads,conversation]=await Promise.all([
        openingMemories(archiveReader,question,scope),
        previous?working.prepare(previous,lifecycle.settings(),question,input=>queryAgent({...input,traceContext:{...input.traceContext,operationId},executionLane:'interactive',modelProfileId,modelOverride,signal},'query','conversations'),execution):undefined,
      ]);
      const result=await queryAgent({traceContext:{operationId},executionLane:'interactive',question,...scope,modelProfileId,modelOverride,onProgress,signal,directImages,openingMemories:memoryLeads,...(conversation?{conversation}:{})});
      signal?.throwIfAborted();
      return ()=>({...result,...conversations.append(previous,{question,...scope,attachments:directImages.filter(image=>attachmentIds.includes(image.id)).map(({id,name,mimeType})=>({id,name,mimeType}))},result)});
    } catch(error) {
      // Keep the user's question visible even when no assistant answer was produced.
      // Persist only the fixed public error projection; provider details never enter the vault.
      if(!signal?.aborted) {
        try {
          const failure=safeError(error),saved=execution!.commit(()=>conversations.appendFailure(previous,{question,...scope},{code:failure.category,message:failure.message}));
          if(error&&typeof error==='object')Object.assign(error,{conversation:saved});
        } catch {
          // Preserve the original query failure if the failure journal itself cannot be written.
        }
      }
      throw error;
    }finally{if(conversationId)runningConversations.delete(conversationId);}
  }

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

  const web=join(repositoryRoot,'apps/web/dist');
  let webVersion:string|null=null;
  try {webVersion=JSON.parse(readFileSync(join(web,'build-info.json'),'utf8')).version??null;} catch {}

  if(existsSync(web)) {
    app.addHook('onRequest',async(req,reply)=>{if(!req.url.startsWith('/api/')&&webVersion!==serverVersion)return reply.code(503).type('text/plain; charset=utf-8').send('Web/server build mismatch. Run npm run build -w @mote/web and restart the server.');});
    await app.register(staticFiles,{root:web,prefix:'/'});
    app.setNotFoundHandler(async(req,reply)=>{
      if(req.url.startsWith('/api/'))return reply.code(404).send({error:'not_found',requestId:req.id});
      return reply.type('text/html').sendFile('index.html');
    });
    app.addHook('onSend',async(req,reply,payload)=>{
      if(!req.url.startsWith('/api/')&&String(reply.getHeader('Content-Type')??'').startsWith('text/html'))reply.header('Cache-Control','no-store');
      if(!req.url.startsWith('/api/'))reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return payload;
    });
  } else app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:'not_found',message:moteText("未找到所请求的资料。"),requestId:req.id}));
  const maintenanceWorker=dependencies?.backgroundWorker?new MaintenanceWorker(config):undefined;
  const actionTimer=setInterval(()=>void actions.tick().catch(()=>{}),15000);actionTimer.unref();
  const perceptionTimer=setInterval(()=>{try{if(!maintenanceWorker)store.archive.aggregate(1,Date.now()-15000);}catch{diagnostics.record('request.failed',{category:'internal'},'error');}try{perception.prepare();void executor.tick().catch(()=>{});}catch{diagnostics.record('request.failed',{category:'internal'},'error');}},5000);perceptionTimer.unref();
  const fileTimer=setInterval(()=>{try{processing.prepare();void executor.tick().catch(()=>diagnostics.record('file.failed',{category:'internal'},'error'));}catch{diagnostics.record('file.failed',{category:'internal'},'error');}},5000);fileTimer.unref();
  const indexTimer=setInterval(()=>void indexer.tick().catch(()=>{diagnostics.record('index.failed',{category:'internal'},'error');}),5000);indexTimer.unref();
  const sourcePipelineTimer=setInterval(()=>{try{
    void sourcePipelines.tick().catch(()=>diagnostics.record('request.failed',{category:'internal'},'error'));
    const enabled=agent.configured&&lifecycle.settings().extraction.enabled;
    sourcePipelines.drainMemory(memoryPipeline,enabled);
    materialMemoryWork.drain(memoryPipeline,enabled,1);
  }catch{diagnostics.record('request.failed',{category:'internal'},'error');}},5000);sourcePipelineTimer.unref();
  const materialTimer=setInterval(()=>void materialOrganizer.tick(200).catch(()=>diagnostics.record('request.failed',{category:'internal'},'error')),5000);materialTimer.unref();
  const maintenance=()=>{files.sweep();if(config.retentionDays>0)void diagnostics.run(randomUUID(),()=>diagnostics.measure('maintenance','retention',()=>store.prune(new Date(Date.now()-config.retentionDays*86400000).toISOString()),deleted=>({deleted}))).catch(()=>{});};
  maintenance();const retentionTimer=setInterval(maintenance,3600000);retentionTimer.unref();
  const lifecycleTimer=setInterval(()=>{if(!closing)void lifecycle.tick().catch(()=>diagnostics.record('agent.failed',{category:'internal'},'error'));},60000);lifecycleTimer.unref();
  const featureServices={setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},connectors,processing,agentFeatures,archiveReader,isClosing:()=>closing,actions,agent,agentGate,archivedFiles,codex,config,connectionRate,connections,contentStorage,conversations,credential,diagnosticSnapshot,diagnostics,eventLoop,evidenceReader,fileEvidence,files,importTasks,imports,indexer,ingress,insight,insightRequestSchema,insightRuns,interactiveGate,interactiveModelGate,jobId,launchImport,lifecycle,llmGate,maintenanceWorker,materialOrganizer,materials,mediaAssets,mediaRange,memories,memoryPipeline,modelBudgets,modelSettings,parseCaptureBundle,perception,providerAdmission,queryAgent,queryRuns,queryWithAttachmentsSchema,reviewExtraction,runQuery,runtimeSettings,semanticSelection,serverVersion,softwareUpdate,sourceOwner,sourcePipelines,sources,store,usageLedger,webVersion,workflows};
  const featureHost=new ServerFeatureHost(backendContext,app);
  await installServerFeatures(featureHost,featureServices);
  diagnostics.record('server.started');
  app.addHook('onReady',async()=>{
    void sourcePipelines.tick().catch(()=>diagnostics.record('request.failed',{category:'internal'},'error'));
    void materialOrganizer.tick(200).catch(()=>diagnostics.record('request.failed',{category:'internal'},'error'));
    for(const id of recoverableMemoryJobs(store,lifecycle))void memoryPipeline.run(id).catch(()=>{});
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  app.addHook('onClose',async()=>{
    clearInterval(sourcePipelineTimer);await sourcePipelines.close();
    closing=true;eventLoop.disable();await files.close();await maintenanceWorker?.close();agentGate.close();llmGate.close();interactiveGate.close();interactiveModelGate.close();clearInterval(perceptionTimer);await executor.close();const memoryClose=memoryPipeline.close();await perception.close();clearInterval(fileTimer);await processing.close();clearInterval(indexTimer);clearInterval(materialTimer);clearInterval(retentionTimer);clearInterval(lifecycleTimer);const lifecycleClose=lifecycle.close();
    clearInterval(actionTimer);const actionClose=actions.close();
    await workflows.close();
    await backendContext.fiber.dispose();
    await Promise.allSettled([...importAgents].map(runtime=>runtime.close()));
    await modelSettings.close();
    await contentStorage.close();
    try{await agent.close();}catch(error){diagnostics.record('agent.failed',{category:safeError(error).category},'error');}
    await Promise.allSettled([...activeQueries,...importTasks.values(),memoryClose,actionClose]);await lifecycleClose;await insightRuns.close();await queryRuns.close();await connectors.close();await softwareUpdate.close();await connections.close();
    memoryReviews.clear();
    try{await indexer.close();}finally{try{if(!dependencies?.store)store.close();}finally{diagnostics.record('server.stopping');await diagnostics.close();}}
  });
  return {app,featureServices,featureHost,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,memoryPipeline,indexer,agent,diagnostics,connections,modelSettings,insightRuns,lifecycle,working};
}
