import {AssistantMatters} from './assistant-matters.js';
import {AssistantCards} from './assistant-cards.js';
import {AssistantFollowup} from './assistant-followup.js';
import {AssistantCommitments} from './assistant-commitments.js';
import {assertSourceContextDependencies} from './source-context-lineage.js';
import {BatchProcessing} from './batch-processing.js';
import {AssistantChangeFeed} from './assistant-change-feed.js';
import {createModelEvidenceAuthority} from './model-evidence-authority.js';
import {conversationHistoryReader} from './conversation-history.js';
import type {QueryAgent} from './query-agent.js';
import {AssistantDrafts} from './assistant-drafts.js';
import {AssistantTasks} from './assistant-tasks.js';
import {insightRequestSchema} from './query-request.js';
import {ServerResources} from './server-resources.js';
import {bootstrapCentral,type CentralDistribution} from './bootstrap.js';
import {assemblePlatform} from './assembly/platform.js';
import {assembleSources} from './assembly/sources.js';
import {assembleMaterials,prepareMaterials} from './assembly/materials.js';
import {assembleMedia,assemblePerception,assembleProcessing} from './assembly/processing.js';
import {memoryInputs,memoryRuntime} from './assembly/memory.js';
import {assembleAgent} from './assembly/agent.js';
import {prepareConversations,prepareQueryRuntime,prepareQueryRuns} from './assembly/query.js';
import {workInputs,assembleInsightRuns,assembleActions,assembleActivity} from './assembly/work.js';
import {assembleImports} from './assembly/imports.js';
import {assembleConnectors} from './assembly/connectors.js';
import type {ConnectorManifest} from './connectors/registry.js';
import {createServerLifecycle,installServerLifecycleHooks} from './assembly/lifecycle.js';
import {createC10Integration,createC10IntegrationFactory} from './plugins/c10-integration.js';
import type {ProcessingConfiguration} from './processing-configuration.js';
import {modelConnection,type ModelConnection} from './background-model-authorization.js';
import {agentModelConnection,captureModelIdentity} from './model-authorization-host.js';
import {MODEL_FEATURES,DEFAULT_MODEL_MAX_TOKENS,modelProvider} from '@mote/shared/models';
import type {ObservationName} from './execution-observability.js';
import {assertMemoryImageGrants} from './memory-image-grants.js';
import {CODING_DIALOGUE_SCHEMA_VERSION,formatEvidenceRef} from '@mote/shared';
import {imageOutput} from './evidence-image.js';
import {fileAttachmentAvailable} from './file-attachments.js';
import { Context,type Plugin } from '@deepseek-ai/cordis';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import { originalEvidenceReceipt,type ContextReader,type QueryInput } from '@mote/agent';
import { ProviderFailure,type CaptureRecord,type QueryResult } from '@mote/shared';
import { negotiateLocale } from '@mote/shared/i18n';
import Fastify,{ type FastifyInstance,type FastifyReply,type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { join,relative,sep } from 'node:path';
import { z } from 'zod';
import {installAgentReadTools} from './plugins/agent-read-tools.js';
import { repositoryRoot,type Config } from './config.js';
import {contributeDomainRoutes} from './plugins/domain-routes.js';
import { ConfigService,ConfigServiceError } from './config-service.js';
import { ConnectionError,Connections,type ConnectionCredential } from './connections.js';
import type {RequestAuthority} from './plugins/central-contracts.js';
import { resolveDependencies } from './conversation-lineage.js';
import { safeError } from './diagnostics.js';
import { EvidenceExposurePolicy } from './evidence-exposure.js';
import { ExecutionFailure } from './execution-engine.js';
import {executionSettingsSchema,diagnosticsSettingsSchema,type ExecutionSettingsValue,type DiagnosticsSettingsValue} from './execution-settings.js';
import {FeatureRoutes,installFeatureRoutes,type FeatureRoute} from './features/index.js';
import type { TranscriptionProvider } from './file-processing.js';
import {fileOriginalRawRef } from './file-raw-reader.js';
import { registerFileRoutes } from './file-routes.js';
import { moteText,requestLocale } from './i18n.js';
import type { ImportPreparation,ImportPreparationResult } from './imports.js';
import { INGRESS_PROTOCOL_VERSION,collectorIngressWrite } from './ingress.js';
import {installCaptureMemoryIntake} from './capture-memory-intake.js';
import type {LifecycleExtension,LifecycleSettings } from './memory-lifecycle.js';
import type {WorkingMemory} from './working-memory.js';
import {openPluginControlRoot} from './plugin-center.js';
import {OutboundExportHost} from './plugins/outbound-export-host.js';
import {DeveloperAccessError,DeveloperAccessHost} from './developer-access.js';
import {developerAccessFeature} from './features/developer-access.js';
import {registerPluginControlHttp} from './plugins/plugin-control-http.js';
import type { ModelAgentFactory } from './model-agent.js';
import { ModelCatalogError } from './model-catalog.js';
import { modelConfiguration } from './model-configuration.js';
import { ModelSettingsError } from './model-settings.js';
import { linkOperationParent } from './operation-projection.js';
import { MAX_RAW_READ_BYTES } from './raw-reader.js';
import { semanticProcessor } from './semantic-extraction.js';
import { conversationUnderstandingProcessor } from './conversation-understanding.js';
import { Store,StoreError } from './store.js';
import {captureFeature} from './features/capture.js';
import {notesFeature,type NotesCapture} from './features/notes.js';
import {devicesFeature} from './features/devices.js';
import {filesFeature} from './features/files.js';
import {sourcesFeature} from './features/sources.js';
import {healthFeature} from './features/system.js';
import {connectionsFeature} from './features/connections.js';
import {mediaModelsFeature,mediaPreparationFeature} from './features/media.js';
import {inventoryFeature} from './features/features.js';
import {insightFeature} from './features/insights.js';
import {AssistantNotifications} from './assistant-notifications.js';
import type {NotificationSettings} from './notification-configuration.js';
import {parseCaptureBundle} from './plugins/capture-intake.js';
import { UsageLedger } from './usage.js';

export type {QueryAgent} from './query-agent.js';
const serverVersion=(JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
export type HostDependencies={distribution?:CentralDistribution;configService?:ConfigService;webRoot?:string;connectorTesting?:import('./connectors/index.js').ConnectorTestDependencies;connectorManifests?:readonly ConnectorManifest[];processingPlugins?:readonly Plugin[];semanticContextTime?:()=>string;backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void};
export async function buildHost(config:Config,dependencies?:HostDependencies) {
  const resources=new ServerResources();
  let startupApp:FastifyInstance|undefined;
  try{
  const bootstrap=await bootstrapCentral({config:{...config},...(dependencies?.configService?{configService:dependencies.configService}:{}),...(dependencies?.store?{store:dependencies.store}:{}),...(dependencies?.backgroundWorker!==undefined?{backgroundWorker:dependencies.backgroundWorker}:{})},dependencies?.distribution);
  resources.defer(()=>bootstrap.close());
  config=bootstrap.config;
  const configService=bootstrap.configService,configurationPlatform=bootstrap.configurationPlatform,store=bootstrap.store;
  let availableModelConnections=():ModelConnection[]=>[];
  const {authorizationPlatform,modelAuthorization,runtimeSettings,observabilityPlatform,observabilityScope,observabilityAssembly,diagnostics,executionObserver,eventLoop,usageLedger,softwareUpdate,executionPlatform,executor,providerAdmission,agentGate,llmGate,interactiveGate,interactiveModelGate,modelContext,modelOperation,queryAccounting,assertModelPurpose,authorizeModelRequest,runModelFor,observeMemory,observeMemoryAsync}=await assemblePlatform({
    bootstrap,config,store,resources,serverVersion,
    availableModelConnections:()=>availableModelConnections(),connections:dependencies?.connections,
    assertModelEvidence:input=>assertModelEvidence(input)});
  const {memoryStrategies,memoryRecipeSettings,memoryStrategySettings,memoryAutomation,memoryBindingControl,topics}=memoryInputs({store,configService});
  const {materials,materialMemoryWork}=await prepareMaterials({bootstrap,store,authorization:authorizationPlatform.commits,resources,memoryRecipeSettings,newInputAdmission:()=>memoryBindingControl.accepting()});
  // One service tree owns backend plugins. Each runtime installs into its own
  // managed scope below this root, so closing one cannot dispose a sibling.
  const backendContext=new Context();
  resources.defer(()=>backendContext.fiber.dispose());
  backendContext.provide('moteMaterials',materials);
  backendContext.provide('moteConfig',configService);
  backendContext.provide('moteExecution',executor);
  backendContext.provide('moteMemoryStrategies',memoryStrategies);
  const {sourceRuntime,sourcePipelines,sources,filesPlatform,files,fileEvidence,fileRawReader,captureIntake,ingress,notesSource,modelAuthorizationHost,filesPlayback,codingFeature}=await assembleSources({bootstrap,store,materials,materialMemoryWork,executionPlatform,authorizationPlatform,diagnostics,resources});
  const {mediaAssets,mediaPreparation}=assembleMedia({config,store,configService,resources,backgroundWorker:dependencies?.backgroundWorker});
  const admittedUsage=(...args:Parameters<UsageLedger['start']>)=>{
    let agentStarted=false,modelQueued=false,meter:ReturnType<typeof observabilityAssembly.admittedUsage>|undefined;
    const start=()=>meter??=observabilityAssembly.admittedUsage(...args);
    const accounting={agentStarted:()=>{agentStarted=true;},modelQueued:()=>{modelQueued=true;},modelStarted:()=>{
      agentStarted=true;
      start().modelStarted();
    }};
    return {
      run:<T>(task:()=>Promise<T>)=>queryAccounting.run(accounting,task),
      update:(tokens:import('@mote/shared').TokenUsage)=>{const current=start();current.modelStarted();current.update(tokens);},
      completed:()=>{const current=start();current.modelStarted();return current.complete();},
      failed:(error:unknown)=>{
        const admissionWait=error instanceof ProviderFailure&&error.details.admissionWaiting===true;
        if(agentStarted&&!modelQueued&&!admissionWait){const current=start();current.modelStarted();}
        // Preserve issued calls and partial samples, but create no receipt for
        // a host refusal or queue cancellation before the first actual model
        // operation. Agents without a host model gate retain fallback accounting.
        return meter?.fail();
      },
    };
  };
  let catalogChangesEnabled=false;
  const {indexer,materialOrganizer,evidenceContext,contextTrees,evidenceReader,sourceContexts,materialContext,setMaterialConsumerTick}=assembleMaterials({store,config,diagnostics,executor,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost,materials,materialMemoryWork,backendContext,resources,sources,sourcePipelines,files,fileEvidence,disableCatalogChanges:()=>{catalogChangesEnabled=false;}});
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id)));
  const memories=evidenceReader.memories,{conversations}=await prepareConversations({bootstrap,store,resources,backendContext,modelAuthorizationHost});
  const assistantDrafts=new AssistantDrafts(conversations);
  const assistantMatters=new AssistantMatters(store);
  const assistantCards=new AssistantCards(store,evidenceReader);
  const assistantCommitments=new AssistantCommitments(store,evidenceReader);
  const {pluginCenter,close:closePluginCenter}=openPluginControlRoot({store,executor,directory:join(config.dataDir,'plugins','packages')});
  // Outbound packages never write through their own code. This host owns the
  // cursor, sandbox, sensitive-source filter and hand-edit conflict ledger.
  pluginCenter.outboundHost=new OutboundExportHost({store,materials,repoRoot:repositoryRoot,dataDir:config.dataDir,
    sourceKind:sourceId=>{try{return sources.getSource(sourceId).kind;}catch{return undefined;}}});
  pluginCenter.resumeOutboundInstances();
  resources.beforeClose(closePluginCenter);
  // Binding control is prepared by memoryRuntime below, but its disposer keeps
  // its original slot: released after active queries, connectors and the agent.
  resources.defer(()=>memoryBindingControl.close());
  const archivedFiles=bootstrap.vault.archivedFiles;
  const connections=authorizationPlatform.assembly.connections!;
  // Host surface for AI access, not an installable package. Material publication
  // writes the stable event journal inside its transaction; delivery is separate.
  const developerAccess=new DeveloperAccessHost({store,connections});
  await developerAccess.init();
  materials.onPublished=event=>developerAccess.recordPublication(event);
  resources.defer(()=>developerAccess.close());
  const pins=new WeakMap<FastifyRequest,RequestAuthority>();
  let liveRequestPins=0;
  const bindRequestPin=(req:FastifyRequest)=>authorizationPlatform.bindRequest({authorization:req.headers.authorization,method:req.method,route:req.routeOptions.url??'unknown',params:req.params as {id?:string},origin:req.headers.origin});
  // A client that disconnects before the response finishes never reaches
  // onResponse, and its C04 pin is a strong entry. Release idempotently from
  // response completion and from a premature socket close.
  const releaseRequestPin=(req:FastifyRequest)=>{const pin=pins.get(req);if(!pin)return;pins.delete(req);liveRequestPins--;authorizationPlatform.releaseRequest(pin);};
  const assignRequestPin=(req:FastifyRequest,reply:FastifyReply)=>{pins.set(req,bindRequestPin(req));liveRequestPins++;reply.raw.once('close',()=>releaseRequestPin(req));};
  const identities=new WeakMap<FastifyRequest,ConnectionCredential>();
  const connectionIdentity=(req:FastifyRequest)=>identities.get(req);
  // Device metadata does not narrow a human client's owner permissions.
  const credential=(req:FastifyRequest)=>{const c=connectionIdentity(req);return c&&!connections.isOwner(c)?c:undefined;};
  const assertRequestActive=(req:FastifyRequest)=>{const c=connectionIdentity(req);if(c)connections.assertActive(c);};
  const sourceOwner=(req:FastifyRequest,id:string)=>{assertRequestActive(req);const c=credential(req);if(c)connections.assertOwnSource(c,id);};
  const {ownerQuestionServices,ownerQuestions}=workInputs({store,backendContext,resources,credential,modelAuthorization:modelAuthorizationHost,availableModelConnections:()=>availableModelConnections()});
  // The authorization platform's mote.models table; the feature bridge mounts
  // it once and each handler dispatches against the platform's current activation.
  contributeDomainRoutes(backendContext,{'mote.models':Object.freeze({mount:(app:FastifyInstance)=>authorizationPlatform.modelAuthorizationRoutes(app,{credential})})});
  const context=(records:CaptureRecord[])=>evidenceReader.context(records);
  const modelEvidenceAuthority=createModelEvidenceAuthority({resolveLineage:value=>resolveDependencies(store,value),
    assertImageGrants:(materialInputs,images)=>assertMemoryImageGrants(store,materialInputs,images),reader:evidenceReader,conversations,sourceContexts,
    authorization:modelAuthorization,host:modelAuthorizationHost,readEvidence:ids=>memories.readEvidence(ids)});
  const {pinProcessingEvidence}=modelEvidenceAuthority;
  const assertModelEvidence=(input:QueryInput|undefined)=>observeMemory(input,'query_assert',()=>modelEvidenceAuthority.assert(input));
  const assertModelEvidenceAsync=(input:QueryInput)=>observeMemoryAsync(input,'query_assert',()=>modelEvidenceAuthority.assertAsync(input));
  // Owner inspection and external read-only clients do not send to our model.
  // The same reader enforces model disclosure scope inside an admitted model run.
  const readingForModel=()=>Boolean(modelContext.getStore()||modelAuthorization.currentId);
  const evidenceAgentReader=evidenceContext.agent({diagnostics,allowQueryImages:()=>perception.settings().allowQueryImages,
    exposurePolicy:new EvidenceExposurePolicy([],context=>!readingForModel()||modelAuthorization.allowsDisclosure({sourceId:context.sourceId??'device:'+context.deviceId})),
    assertSources:ids=>{if(readingForModel())modelAuthorization.assertDisclosure(ids.map(sourceId=>({sourceId})));},
    assertEvidence:ids=>{if(readingForModel())modelAuthorizationHost.assertEvidence(ids);},
    currentOperation:()=>modelContext.getStore()?.responseMode==='memory-extraction'?'memory':'query',
    currentContextTime:()=>modelContext.getStore()?.contextTime,
    currentGrantContext:()=>modelContext.getStore(),currentProcessingEvidence:()=>modelContext.getStore()?.processingEvidence,currentMaterialInputs:()=>modelContext.getStore()?.processingMaterialInputs});
  let historyBeforeSeq:((workId:string)=>number|undefined)|undefined;
  const historyRead=conversationHistoryReader({store,conversations,current:()=>modelContext.getStore(),assert:assertModelEvidence,cursorSecret:config.token,historyBeforeSeq:workId=>historyBeforeSeq?.(workId)});
  const agentFeatures=await installAgentReadTools(backendContext,{...evidenceAgentReader,catalog:async args=>historyRead(args)??evidenceAgentReader.catalog?.(args)});
  const archiveReader=agentFeatures.reader;
  const directImage=(id:string)=>modelContext.getStore()?.directImages?.find(image=>image.id===id);
  const directImageAllowed=(id:string)=>{
    try{const image=directImage(id),version=files.version(id);
      return Boolean(image&&version.object_hash===image.hash&&store.evidence([id]).length&&fileAttachmentAvailable(store,id)&&
        !store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted);
    }catch{return false;}
  };
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
  const {agent,factory,codex}=await assembleAgent({
    config,resources,diagnostics,backendContext,configurationPlatform,configService,runtimeSettings,reader,modelAuthorizationHost,
    createModelAgent:dependencies?.createModelAgent,authorization:modelAuthorization,admission:providerAdmission,
    runModelFor,authorizeModelRequest,assertPurpose:assertModelPurpose,assertEvidence:assertModelEvidence,assertEvidenceAsync:assertModelEvidenceAsync,pinEvidence:pinProcessingEvidence,
    agentGate,llmGate,interactiveGate,interactiveModelGate,modelContext,modelOperation,queryAccounting,providerAdmission,
    insightSettings:()=>lifecycle.settings().insights,maintenanceSnapshot:()=>maintenanceWorker?.snapshot()??null,delegatedSnapshot:()=>executor.poolSnapshot('delegated-agents'),wakeMemory:()=>memoryPipeline.wake(),
    allowQueryImages:()=>perception.settings().allowQueryImages,observeMemory,evidenceReader,agent:dependencies?.agent,
  });
  const modelSettings=configurationPlatform.modelSettings;
  let additionalModelConnections=():ModelConnection[]=>[];
  availableModelConnections=()=>{
    const models=[...modelSettings.profiles(),...MODEL_FEATURES.map(feature=>modelSettings.select(feature))].map(profile=>agentModelConnection({kind:'profile',id:profile.id},profile.settings));
    if(config.embeddingModel&&config.embeddingBaseUrl)models.push(modelConnection('embedding:central',{model:config.embeddingModel,baseUrl:config.embeddingBaseUrl,apiKey:config.embeddingApiKey}));
    return [...new Map([...models,...additionalModelConnections()].map(connection=>[connection.id+'@'+connection.fingerprint,connection])).values()];
  };
  const withMediaOwnerIntent=<T>(id:string,task:()=>Promise<T>|T)=>modelAuthorizationHost.manual('owner-media:'+randomUUID(),availableModelConnections(),async()=>task(),undefined,'manual',[captureModelIdentity(id)]);
  const withMediaOwnerBatch=async<T>(ids:readonly string[],task:()=>T)=>modelAuthorization.manualCommand('owner-media-batch:'+randomUUID(),ids.map(captureModelIdentity),availableModelConnections(),task);
  // Memory runtime is assembled after the query activation and lends its
  // prepared working context through stable late-bound handles.
  let memoryWorkingHost:Pick<WorkingMemory,'prepare'>|undefined;
  let memoryLifecycleHost:{settings():LifecycleSettings}|undefined;
  const queryWorking:Pick<WorkingMemory,'prepare'>={prepare:(...args)=>memoryWorkingHost!.prepare(...args)};
  const queryLifecycleSettings=()=>memoryLifecycleHost!.settings();
  const serverLifecycle=createServerLifecycle();
  const {queryServices:queryRuntimeServices,query}=await prepareQueryRuntime({
    bootstrap,resources,store,lifecycle:serverLifecycle,diagnostics,modelAuthorization,modelAuthorizationHost,
    executor,agentGate,modelSettings,agent,observabilityAssembly,modelEvidenceAuthority,assertModelEvidence,sourceContexts,assistantDrafts,conversations,
  });
  // The existing query provider does not yet expose the configured model
  // window or validate complete requests. Do not send a batch model request
  // using its hard-coded 128k assumption; C1/C5 must connect that budget check.
  let assistantTasks:AssistantTasks|undefined;
  const batchProcessing=new BatchProcessing(store,executor,modelAuthorization,input=>query.queryAgent(input,'query','conversations'),ids=>{
    if(!evidenceReader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw new StoreError('Batch evidence is no longer permitted',409);
  },ids=>modelAuthorizationHost.assertEvidence(ids),result=>assertSourceContextDependencies(sourceContexts,result.sourceContextDependencies??[]),
    ()=>new ExecutionFailure('blocked','model_context_budget_unavailable'),()=>1,true,evidenceReader.memories,{
      valid:step=>assistantTasks?.valid(step)??true,project:step=>assistantTasks?.project(step),commit:(step,result)=>assistantTasks?.commit(step,result),
    });
  assistantTasks=new AssistantTasks(store,assistantCards,assistantMatters,evidenceReader,materials,conversations,sourceContexts,()=>batchProcessing,()=>availableModelConnections());
  assistantDrafts.setVersionValidator(context=>assistantTasks!.validateDraftVersion(context));
  assistantDrafts.register('assistant.task.start',context=>assistantTasks!.start(context));
  resources.defer(()=>batchProcessing.close());
  const assistantChanges=new AssistantChangeFeed(store,materials,modelAuthorization,ids=>{
    if(!evidenceReader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw new StoreError('Assistant input is no longer permitted',409);
  });
  setMaterialConsumerTick(()=>assistantChanges.tick());
  resources.beforeClose(()=>setMaterialConsumerTick(undefined));
  // Fastify/Pino request and Error serializers may contain raw URLs, bodies or SDK text.
  // Emit only our fixed-schema events, never serialize arbitrary request/error objects.
  const {insightRuns,insightServices}=assembleInsightRuns({store,resources,executor,evidenceReader,query:query.insight,modelAuthorization:modelAuthorizationHost,availableModelConnections:()=>availableModelConnections(),agent,modelSettings,isClosing:()=>serverLifecycle.isClosing(),diagnostics});
  const {workflows,processing,resolveFileModel,mediaModelAuthority,processingServices}=await assembleProcessing({bootstrap,store,config,configService,diagnostics,executor,backendContext,resources,materials,sourcePipelines,files,sourceContexts,mediaAssets,archivedFiles,evidenceReader,indexer,plugins:dependencies?.processingPlugins,modelAuthorization,modelAuthorizationHost,modelSettings,factory,admittedUsage,transcriptionProvider:dependencies?.transcriptionProvider,withMediaOwnerBatch,withMediaOwnerIntent});
  const memoryConfiguration=(id?:string,model?:string)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);};
  const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,materialMemoryWork,input=>modelAuthorizationHost.capture(input));
  resources.defer(disposeCaptureMemoryIntake);
  const {perception}=assemblePerception({store,config,configService,executor,resources,materials,mediaAssets,processing,mediaModelAuthority,resolveFileModel,modelSettings,factory,agent,admittedUsage});
  additionalModelConnections=()=>[...processing.modelConnections(),...configService.current<ProcessingConfiguration>('processing').policy.services.filter(service=>service.kind==='model').map(service=>{const resolved=resolveFileModel({...processing.currentSettings(),analysisModel:service});return agentModelConnection(resolved.identity,resolved.settings);})];
  const semanticSelection=()=>{const selected=modelSettings.select('memory');return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};};
  workflows.registry.register(semanticProcessor({store,memories,query:input=>{const selected=modelSettings.select('memory',input.modelProfileId),traceContext={...input.traceContext,traceId:randomUUID(),operation:'query' as const,moduleId:'memories',profileId:selected.id,provider:selected.settings.provider,protocol:selected.settings.protocol,model:input.modelOverride??selected.settings.model};return query.withQueryModelAuthority(input,'semantic',signal=>agent.query({...input,signal,onTrace:event=>{diagnostics.agentTrace(event,traceContext);input.onTrace?.(event);}}));},records:ids=>store.evidence(ids),selection:semanticSelection,usage:usageLedger}));
  workflows.registry.register(conversationUnderstandingProcessor({memories,usage:usageLedger,
    resolveMemoryPreparation:contract=>memoryPipeline.conversationPreparation(contract),
    selection:config=>{const selected=modelSettings.select('memory',typeof config?.profileId==='string'?config.profileId:undefined);
      return {...modelConfiguration(selected.id,{...selected.settings,...(typeof config?.modelOverride==='string'?{model:config.modelOverride}:{})},modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},
    resolveEvidence:page=>({records:materials.evidence([...new Set(page.spans.flatMap(span=>span.evidenceId?[span.evidenceId]:[]))]),
      ranges:page.spans.map(span=>({id:span.evidenceId!,offset:span.evidenceOffset!,length:span.pageRange.end-span.pageRange.start}))}),
    // The processor owns one receipt through model, parsing and publication.
    // Keep queryAgent admission/diagnostics without metering the same run twice.
    query:input=>query.queryAgent(input,'query','memories','caller'),
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
  app.addHook('onReady',async()=>{batchProcessing.start();});
  app.addHook('onReady',async()=>{assistantChanges.tick();});
  app.addHook('onReady',async()=>{void sourcePipelines.tick().catch(()=>{});void materialOrganizer.tick(200).catch(()=>{});});
  const sourceIntegrationFactory=createC10IntegrationFactory(()=>{
    const platform=createC10Integration({store,runtime:sourcePipelines,memoryWork:materialMemoryWork,sources});
    platform.bindRoutes({authorization:authorizationPlatform,capture:captureIntake,files,evidenceReader,memories:evidenceReader.memories});return platform;
  },mount=>mount(app));
  const startSourceIntegration=()=>bootstrap.installSourceIntegration(sourceIntegrationFactory);
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
  const validBearer=(req:{headers:{authorization?:string}})=>bootstrap.authorization.validOwnerBearer(req.headers.authorization);
  let playbackAuthorization:(req:FastifyRequest)=>boolean=()=>false;
  app.addHook('onRequest',async(req,reply)=>{
    const isApi=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    if(isApi)reply.header('Cache-Control','no-store');
    if(req.method==='OPTIONS'||req.routeOptions.url==='/api/health'||!isApi||(req.method==='POST'&&['/api/connections/redeem','/api/login/exchange','/api/login/requests','/api/login/poll','/api/login/ack'].includes(req.routeOptions.url??'')))return;
    const playback=playbackAuthorization(req);
    if(validBearer(req)||playback){
      if(!playback)assignRequestPin(req,reply);
      return;
    }
    const c=connections.authenticate(req.headers.authorization);
    if(!c)return reply.code(401).send({error:'unauthorized',message:moteText("请提供有效访问令牌；管理网页请重新登录"),requestId:req.id});
    identities.set(req,c);connections.assertCollectorRoute(c,req.method,req.routeOptions.url??'');assignRequestPin(req,reply);
    if(!connections.isOwner(c)&&collectorIngressWrite(req.method,req.routeOptions.url??'')&&req.headers['x-mote-ingress-version']!==INGRESS_PROTOCOL_VERSION)
      return reply.code(426).send({error:'ingress_protocol_upgrade_required',requiredVersion:INGRESS_PROTOCOL_VERSION,requestId:req.id});
  });
  app.addHook('onResponse',async req=>{releaseRequestPin(req);});
  // The client can close the connection before the response is finished; that
  // path emits onRequestAbort instead of onResponse.
  app.addHook('onRequestAbort',async req=>{releaseRequestPin(req);});
  app.setErrorHandler((error,req,reply)=>{
    const failure=safeError(error);
    diagnostics.record('request.failed',{requestId:req.id,method:req.method as import('./diagnostics.js').EventFields['method'],route:routeName(req.routeOptions.url),category:failure.category,reason:failure.reason,statusCode:failure.status},failure.status>=500?'error':'warn');
    if(error instanceof ProviderFailure){if(error.details.retryAfterMs!==undefined)reply.header('Retry-After',String(Math.ceil(error.details.retryAfterMs/1000)));return reply.code(failure.status).send({error:failure.category,message:failure.message,reason:failure.reason,recovery:error.details.category==='blocked'?'needs_action':error.details.category==='transient'?'auto_retry':'permanent',retryAfterMs:error.details.retryAfterMs,requestId:req.id});}
    if(error instanceof ConnectionError)return reply.code(error.statusCode).send({error:error.code,message:error.publicMessage,requestId:req.id});
    if(error instanceof DeveloperAccessError)return reply.code(error.statusCode).send({error:error.code,message:error.publicMessage,requestId:req.id});
    if(error instanceof ModelCatalogError)return reply.code(error.statusCode).send({error:'model_catalog_unavailable',message:error.message,requestId:req.id});
    if(error instanceof ModelSettingsError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});
    if(error instanceof ConfigServiceError)return reply.code(error.statusCode).send({error:error.code,message:error.code==='config_conflict'?moteText('配置已发生变化，请刷新后重试。'):moteText('配置未能应用，请检查配置状态后重试。'),requestId:req.id});
    reply.code(failure.status).send({error:failure.category,message:failure.message,...(failure.reason?{reason:failure.reason}:{}),requestId:req.id});
  });
  // Source routes mount after the root error handler so their encapsulated
  // child app inherits owner-facing validation/conflict mapping (not Fastify's
  // default 500 serializer).
  const sourceIntegration=await startSourceIntegration();
  const {actions}=await assembleActions({store,files,resources,backendContext,agent,executor,configService,semanticArtifacts,sources,connections,pluginCenter,credential,connectionIdentity,queryAgent:(input,operation,moduleId,usageOwner)=>query.queryAgent(input,operation,moduleId,usageOwner)});
  const {connectors}=await assembleConnectors({app,resources,memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,validOwnerBearer:header=>validBearer({headers:{authorization:header}}),connections,connectorTesting:dependencies?.connectorTesting,additionalManifests:dependencies?.connectorManifests});
  // Official connector packages install through Plugin Center into this live host.
  pluginCenter.connectorHost=connectors;
  // Built-in Google/Lark calendar writes stay deployment connectors: they reuse
  // the same Central target, host dispatch and receipt path, and never appear in
  // the installable official catalog.
  pluginCenter.builtinActions={providers:()=>connectors.actionProviders(),execute:({connectorId,request})=>connectors.executeAction(connectorId,request)};
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

  const queryAgent=query.queryAgent,insight=query.insight,withQueryModelAuthority=query.withQueryModelAuthority;
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
  const {memoryBindings,memoryAdapters,memoryPublication,memoryPipeline,memoryPhasePipeline,reviewExtraction,lifecycle,working,memoryIntegrationSettings,memoryTopics,memoryPublicationService}=memoryRuntime({store,resources,backendContext,configService,diagnostics,executor,usageLedger,memories,conversations,files,materials,materialMemoryWork,sourcePipelines,evidenceReader,contextTrees,memoryStrategies,memoryRecipeSettings,memoryStrategySettings,memoryAutomation,ownerQuestions:ownerQuestionServices.port,pluginCenter,modelAuthorization,modelAuthorizationHost,modelSettings,agent,runtimeSettings,codex,instancesDirectory:join(config.dataDir,'plugins','instances'),runModelFor,memoryConfiguration,semanticContextTime:dependencies?.semanticContextTime,memoryBindingControl,topics,topicsCanPublish:()=>catalogChangesEnabled&&!serverLifecycle.isClosing(),lifecycle:{automatic:dependencies?.backgroundWorker!==false,whenReady:task=>{app.addHook('onReady',async()=>{task();});},semanticArtifacts,providerCooldownCheck:()=>providerAdmission.check(modelSettings.select('memory').settings),insights:insightRuns,insightTimeout:()=>modelSettings.select('insight').settings.agentTimeoutMs,query:(input,module)=>queryAgent(input,input.skill==='personal-insight'?'insight':'query',module),replacements:dependencies?.memoryExtensions},availableModelConnections:()=>availableModelConnections(),queryAgent,understand:understandConversation,assertModelEvidence,withQueryModelAuthority,query:input=>queryAgent(input,'query','memories')});
  memoryWorkingHost=working;memoryLifecycleHost=lifecycle;

  const {imports,importServices}=assembleImports({store,resources,backendContext,diagnostics,lifecycle:serverLifecycle,archivedFiles,sources,executor,processing,files,config,agent,modelSettings,modelAuthorization,authorizeModelRequest,runModelFor,codex,admittedUsage,agentGate,modelOperation,providerAdmission,availableModelConnections:()=>availableModelConnections(),evidenceReader,prepareImport:dependencies?.prepareImport,observeImport:dependencies?.observeImport});
  const jobId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;

  const {delegation,queryRuns,queryRunServices}=await prepareQueryRuns({bootstrap,backendContext,resources,store,executor,executionObserver,runtimeSettings,evidenceReader,sourceContexts,assertModelEvidence,files,conversations,working:queryWorking,
    lifecycleSettings:queryLifecycleSettings,archiveReader,agent,modelEvidenceAuthority,modelSettings,queryRuntime:()=>queryRuntimeServices.runtime,
    semanticContextTime:dependencies?.semanticContextTime,usageLedger,
    modelAuthorizationHost,availableModelConnections:()=>availableModelConnections(),assistantDrafts,assistantTasks,
    assistantOwner:req=>{assertRequestActive(req);if(credential(req))throw new StoreError('Owner access required',403);}});
  historyBeforeSeq=workId=>queryRunServices.delegation.journal.payload<import('./plugins/query-preparation.js').SavedQuery>(workId).historyBeforeSeq;
  memoryPhasePipeline.attachDelegation({runtime:delegation,work:materialMemoryWork,sourcePipelines,configuration:()=>memoryConfiguration(),allowCandidate:(candidate,input)=>evidenceReader.materialAllowedForMemory(candidate.ref,new EvidenceExposurePolicy(),input.required),query:input=>queryAgent(input,'query','memories'),sample:async(candidate,offset,length)=>{
    const input=materialMemoryWork.planningInput(candidate);
    if(!input?.ready||input.fingerprint!==candidate.fingerprint||!materialMemoryWork.inputs.available(candidate.sourceId,candidate.inputKey,undefined,candidate.scope)||!sourcePipelines.memoryAllowed(candidate.sourceId))throw new StoreError('Memory sample authorization changed',409);
    const records=await archiveReader.evidence({ids:input.evidenceIds.slice(0,8)});return records.flatMap(record=>offset<record.ocrText.length?[originalEvidenceReceipt(record,offset,Math.min(length,record.ocrText.length-offset))]:[]);
  }});

  function diagnosticProjection() {
    const counts=store.indexCounts(),devices=store.devices(),storage=store.stats();
    return {execution:{failureReceipts:executor.failureDiagnostics(),agents:agentGate.snapshot(),llm:llmGate.snapshot(),interactive:interactiveGate.snapshot(),interactiveHarness:interactiveModelGate.snapshot(),delegated:executor.poolSnapshot('delegated-agents')},services:{agentConfigured:agent.configured,embeddingConfigured:indexer.configured,activeQueries:query.activeQueries(),closing:serverLifecycle.isClosing()},queue:{index:counts,devices:devices.length,reportedPending:devices.reduce((n,d)=>n+d.queueDepth,0)},storage:{captures:storage.captures,imageCaptures:storage.imageCaptures,blobs:storage.blobs,bytes:storage.bytes,logicalBytes:storage.logicalBytes,maxBytes:storage.maxBytes,imagesEncrypted:storage.imagesEncrypted}};
  }
  function systemStatus() {
    const profiles=modelSettings.profiles(),current=modelSettings.current(),unbounded=profiles.some(p=>p.settings.agentTimeoutMs===null),agentTimeouts=profiles.map(p=>p.settings.agentTimeoutMs).filter((value):value is number=>value!==null);
    return {runtime:{eventLoopP95Ms:eventLoop.percentile(95)/1e6,maintenance:maintenanceWorker?.snapshot()??null},profile:config.profile??'default',agent:{configured:agent.configured,provider:modelProvider(config.modelProvider??'deepseek')?.name??config.modelProvider,runtime:config.modelProtocol==='codex-app-server'?'Codex App Server':'DeepSeek Harness',protocol:config.modelProtocol,model:config.model||null,reasoningEffort:config.modelReasoningEffort??'high',maxTokens:config.modelMaxTokens??DEFAULT_MODEL_MAX_TOKENS,modelRequestTimeoutMs:current.modelRequestTimeoutMs,agentTimeoutMs:unbounded?null:agentTimeouts.length?Math.max(...agentTimeouts):null},storage:store.stats(),index:{mode:indexer.configured?'hybrid':'text',model:config.embeddingModel||null},diagnostics:diagnostics.snapshot(),retentionDays:config.retentionDays,insightIntervalHours:lifecycle.settings().insights.enabled?lifecycle.settings().insights.intervalHours:0,serverTime:new Date().toISOString()};
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
  const maintenanceWorker=bootstrap.vault.startMaintenance();
  resources.defer(()=>maintenanceWorker?.close());

  observabilityPlatform.routes(app,observabilityScope,{
    system:{
      status:systemStatus,
      updates:(cursor,limit)=>store.updates(cursor,limit),
      buildInfo:()=>({serverVersion,webVersion,consistent:webVersion===serverVersion}),
    },
    diagnostics:diagnosticProjection,
  });

  // C02 stops the worker before content accessors; DB remains alive until every
  // other root consumer has closed and bootstrap releases the vault last.
  resources.defer(()=>bootstrap.vault.stopAccessors());
  const {activity,automaticActivity,activityServices}=assembleActivity({store,resources,operations:executionPlatform.assembly.operations,delegation,materials,executor,configService,modelSettings,agent,workflows,queryAgent,backendContext,isCollector:request=>Boolean(credential(request)),archiveReader,diagnostics,evidenceReader});
  const applyExecution=(value:ExecutionSettingsValue)=>executionPlatform.refreshSettings(executionSettingsSchema.strip().parse(value));
  configService.setHandler<ExecutionSettingsValue>('execution',(next,previous)=>({apply:()=>{},publish:()=>applyExecution(next),rollback:()=>{applyExecution(previous);memoryPipeline.wake();},complete:()=>memoryPipeline.wake()}));
  configService.setHandler<DiagnosticsSettingsValue>('diagnostics',next=>diagnostics.prepareConfiguration(diagnosticsSettingsSchema.strip().parse(next)));
  configService.setHandler<{syncIntervalMs:number}>('connectors',(next,previous)=>({apply:()=>{},publish:()=>connectors.configureSyncInterval(next.syncIntervalMs),rollback:()=>connectors.configureSyncInterval(previous.syncIntervalMs)}));
  const assistantNotifications=new AssistantNotifications(assistantCards,()=>configService.current<NotificationSettings>('notifications'));
  const assistantFollowup=new AssistantFollowup(store,materials,evidenceReader,assistantCards,assistantCommitments,assistantMatters,batchProcessing,ids=>{
    if(!evidenceReader.contextDependenciesAllowed(ids,new EvidenceExposurePolicy()))throw new StoreError('Assistant evidence is no longer permitted',409);
  });
  const featureServices=Object.freeze({
    assistantCards,assistantNotifications,assistantCommitments,assistantFollowup,
    configService,runtimeSettings,config,availableModelConnections:()=>availableModelConnections(),assistantMatters,
    executor,providerAdmission,agentGate,llmGate,interactiveGate,interactiveModelGate,diagnostics,serverVersion,
    sourcePipelines,sources,ingress,notesSource:notesSource.assemblyForRoutes(),files,fileEvidence,filesSource:{playback:filesPlayback},
    mediaAssets,materials,materialOrganizer,materialMemoryWork,indexer,evidenceReader,contextTrees,
    ownerQuestions,agent,isClosing:serverLifecycle.isClosing,featureInventory:bootstrap.featureInventory,
    insight,insightRuns,insightRequestSchema,
    processing,workflows,semanticSelection,
    actions,connectors,imports,
    queryAgent,pluginCenter,withMediaOwnerBatch,withMediaOwnerIntent,
    connectionIdentity,credential,assertRequestActive,sourceOwner,setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},
    notesCapture:{authority:authorizationPlatform,route:{request:(request:FastifyRequest)=>pins.get(request)},intake:captureIntake.ports.captureIntake},
    agentFeatures,archiveReader,
    archivedFiles,maintenanceWorker,store,modelSettings,connections,developerAccess,modelAuthorizationHost,
    jobId,mediaRange,
  });
  const featureRoutes=new FeatureRoutes(backendContext,app,()=>diagnostics.record('request.failed',{category:'internal'},'error'));
  resources.defer(()=>featureRoutes.close());
  registerPluginControlHttp(app,{plugins:pluginCenter,bindings:memoryBindings,automation:memoryAutomation,owner:request=>{assertRequestActive(request);if(credential(request))throw new StoreError('Owner authorization is required for plugin control',403);}});
  const domainRoutes=backendContext.get('moteDomainRoutes')??{};
  const selected=(id:string)=>bootstrap.selectsFeature(id);
  const routes:FeatureRoute[]=[];
  const withAgentTools=(route:FeatureRoute):FeatureRoute=>({...route,mount:(app,scope)=>{route.mount(app,scope);scope.defer(()=>agentFeatures.dispose(route.id));}});
  const domain=(id:string,extra?:(app:FastifyInstance,scope:import('./features/index.js').FeatureScope)=>void):FeatureRoute=>withAgentTools({id,mount:(app,scope)=>{domainRoutes[id]?.mount(app,scope);extra?.(app,scope);}});
  const notesCapture:NotesCapture={authority:authorizationPlatform,route:{request:(request:FastifyRequest)=>pins.get(request)},intake:captureIntake.ports.captureIntake};
  if(selected('mote.activity'))routes.push(domain('mote.activity'));
  if(selected('mote.files'))routes.push(withAgentTools(filesFeature({withMediaOwnerBatch,withMediaOwnerIntent,processing,ingress,sourceOwner,credential,evidenceReader,diagnostics,setPlaybackAuthorization:authorize=>{playbackAuthorization=authorize;},filesSource:{playback:filesPlayback}})));
  if(selected('mote.actions'))routes.push(domain('mote.actions'));
  if(selected('mote.connections'))routes.push(withAgentTools(connectionsFeature({config,connections,connectionIdentity,serverVersion})));
  if(selected('mote.connections'))routes.push(developerAccessFeature({host:developerAccess,credential,connectionIdentity}));
  if(selected('mote.system'))routes.push(healthFeature(serverVersion));
  if(selected('mote.storage'))routes.push(domain('mote.storage'));
  if(selected('mote.capture'))routes.push(withAgentTools(captureFeature({store,connections,credential,assertRequestActive,diagnostics,evidenceReader,files,ingress,executor,maintenanceWorker})));
  if(selected('mote.context'))routes.push(domain('mote.context'));
  if(selected('mote.materials'))routes.push(domain('mote.materials'));
  if(selected('mote.coding'))routes.push(codingFeature);
  if(selected('mote.sources'))routes.push(withAgentTools(sourcesFeature({credential,evidenceReader,sources,store,materials,sourcePipelines})));
  if(selected('mote.models'))routes.push(domain('mote.models'));
  if(selected('mote.processing'))routes.push(domain('mote.processing'));
  if(selected('mote.notes')&&bootstrap.selectsPlugin('notes-source'))routes.push(withAgentTools(notesFeature({assertRequestActive,connections,credential,diagnostics,files,ingress,notesSource:notesSource.assemblyForRoutes(),notesCapture})));
  if(selected('mote.devices'))routes.push(withAgentTools(devicesFeature({diagnostics,store,files,evidenceReader,notesCapture,request:request=>pins.get(request)})));
  if(selected('mote.media'))routes.push(domain('mote.media',(app,scope)=>{mediaPreparationFeature({connections,credential,mediaRange,store,mediaPreparation:()=>mediaPreparation}).mount(app,scope);mediaModelsFeature({mediaAssets,media:config.media}).mount(app,scope);}));
  if(selected('mote.owner-questions'))routes.push(domain('mote.owner-questions'));
  if(selected('mote.memory'))routes.push(domain('mote.memory'));
  if(selected('mote.imports'))routes.push(domain('mote.imports'));
  if(selected('mote.ask'))routes.push(domain('mote.ask'));
  if(selected('mote.insights'))routes.push(withAgentTools(insightFeature(insightServices,{store:assistantCards,notifications:assistantNotifications,credential,assertRequestActive})));
  if(selected('mote.agent-view'))routes.push(domain('mote.agent-view'));
  if(selected('mote.features'))routes.push(inventoryFeature(()=>bootstrap.featureInventory([...featureRoutes.contributions(),...agentFeatures.contributions(),...connectors.contributions()])));
  await installFeatureRoutes(featureRoutes,routes);
  resources.defer(()=>memoryTopics.close());
  await configurationPlatform.start();
  diagnostics.record('server.started');
  installServerLifecycleHooks(app,{lifecycle:serverLifecycle,configurationPlatform,sourcePipelines,executionPlatform,executor,eventLoop,queryRuns,activityServices,memoryPublication,resources,diagnostics});
  // Rebuilding built-in registrations before readers exist is not a change.
  // Shutdown disables notifications before any registration is disposed.
  catalogChangesEnabled=true;
  return {app,bootstrap,batchProcessing,assistantTasks,assistantChanges,sourceIntegration,startSourceIntegration,configurationPlatform,observabilityPlatform,observabilityScope,observabilityAssembly,executionPlatform,authorizationPlatform,captureIntake,liveRequestPins:()=>liveRequestPins,filesPlatform,sourceRuntime,notesSource,evidenceContext,modelAuthorization,modelAuthorizationHost,automaticActivity,configService,featureServices,featureRoutes,insightServices,materialContext,pluginCenter,memoryBindings,memoryAdapters,memoryPublication,memoryPublicationService,memoryAutomation,memoryIntegrationSettings,memoryRecipeSettings,memoryStrategies,memoryStrategySettings,processingServices,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,importServices,memoryPipeline,indexer,agent,diagnostics,connections,developerAccess,modelSettings,insightRuns,lifecycle,working,activity,activityServices,conversations,assistantDrafts,delegation,queryRuns,queryRunServices,queryServices:queryRuntimeServices,query};
  }catch(error){
    const failures:unknown[]=[];
    await resources.stop();
    if(startupApp)try{await startupApp.close();}catch(cleanup){failures.push(cleanup);}
    try{await resources.close();}catch(cleanup){failures.push(cleanup);}
    if(failures.length){
      // A failing subsystem may already report the [cause, ...cleanup] aggregate
      // shape. Extend that list so startup cleanup never hides the original cause.
      const startup=error instanceof AggregateError&&error.cause!==undefined?error:undefined;
      throw new AggregateError([...(startup?startup.errors:[error]),...failures],'Server initialization and disposal failed',{cause:startup?startup.cause:error});
    }
    throw error;
  }
}
