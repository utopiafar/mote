import {createMemoryControl} from './memory-control.js';
import {createMemoryModelAuthorityJobReader} from './memory-model-authority.js';
import {createQueryPreparation,type SavedQuery} from './query-preparation.js';
import {createModelEvidenceAuthority,contextFailure} from './model-evidence-authority.js';
import type {QueryAgent,AgentRunFinalizer,QueryRunLease} from './query-agent.js';
import {createHostRunUsageObserver} from './agent-runtime-events.js';
import {AgentRuntimeHost} from './agent-runtime-host.js';
import type {FeatureServices} from './feature-services.js';
import {queryWithAttachmentsSchema,insightRequestSchema} from './query-request.js';
import {ServerResources} from './server-resources.js';
import {bootstrapCentral,type CentralDistribution} from './bootstrap.js';
import {assemblePlatform} from './assembly/platform.js';
import {assembleSources} from './assembly/sources.js';
import {assembleMaterials,prepareMaterials} from './assembly/materials.js';
import {assembleMedia,assemblePerception,assembleProcessing} from './assembly/processing.js';
import {MemoryTopicsHost} from './memory-topics-host.js';
import type {ProcessingConfiguration} from './processing-configuration.js';
import {modelConnection,type ModelConnection,type AutomaticModelPurpose} from './background-model-authorization.js';
import {agentModelConnection,captureModelIdentity,sourceModelIdentity} from './model-authorization-host.js';
import {MODEL_FEATURES,DEPLOYMENT_MODEL_PROFILE_ID} from '@mote/shared/models';
import type {ObservationName} from './execution-observability.js';
import {memoryIntegrationImageInputs} from './memory-image-grants.js';
import {assertMemoryImageGrants} from './memory-image-grants.js';
import {memoryReadRanges} from './memory-read-context.js';
import {retainFailureContext} from './execution-failures.js';
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
import { randomUUID } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { join,relative,sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { Actions } from './actions.js';
import { ActivityProjection } from './activity.js';
import { assertCurrentDelegationSchema,DelegationRuntime } from './delegation-runtime.js';
import { DelegatedQueryRuns } from './delegated-query-runs.js';
import {runQueryQualityExperiment,type QueryQualityStrategy,type QueryQualityCheckpoint} from './query-quality-experiment.js';
import { registerMemoryDelegation } from './memory-delegation.js';
import { agentDeadline } from './agent-deadline.js';
import { installAgentFeatures } from './agent-feature-host.js';
import { repositoryRoot,type Config } from './config.js';
import { ConfigService,ConfigServiceError } from './config-service.js';
import { ConnectionError,Connections,type ConnectionCredential } from './connections.js';
import type {RequestAuthority} from './plugins/central-contracts.js';
import { registerConnectors } from './connectors/index.js';
import { Conversations } from './conversations.js';
import { combineDependencies,resolveDependencies } from './conversation-lineage.js';
import {assertSourceContextDependencies,combineSourceContextDependencies} from './source-context-lineage.js';
import { safeError,type AgentTraceContext } from './diagnostics.js';
import { EvidenceExposurePolicy } from './evidence-exposure.js';
import { ExecutionFailure } from './execution-engine.js';
import {executionSettingsSchema,diagnosticsSettingsSchema,type ExecutionSettingsValue,type DiagnosticsSettingsValue} from './execution-settings.js';
import { ServerFeatureHost } from './feature-host.js';
import { installServerFeatures } from './features/index.js';
import type { TranscriptionProvider } from './file-processing.js';
import {fileOriginalRawRef } from './file-raw-reader.js';
import { registerFileRoutes } from './file-routes.js';
import { moteText,requestLocale } from './i18n.js';
import { prepareImportInput } from './import-runtime.js';
import { ImportStore,type ImportPreparation,type ImportPreparationResult } from './imports.js';
import { INGRESS_PROTOCOL_VERSION,collectorIngressWrite } from './ingress.js';
import { InsightRuns } from './insight-runs.js';
import { insightResult,validateInsightOutput } from './insights.js';
import { registerMemoryExtensions } from './lifecycle-extensions.js';
import {MemoryIntegrationSettings} from './memory-integration-settings.js';
import {installCaptureMemoryIntake} from './capture-memory-intake.js';
import {AutomaticActivity} from './automatic-activity.js';
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
import { ReloadableAgent,applyModelSettings,createModelRegistry,modelSettingsFromConfig,testModelConnection,type ModelAgentFactory,type ModelAgentIdentity } from './model-agent.js';
import { ModelCatalogError } from './model-catalog.js';
import { modelConfiguration } from './model-configuration.js';
import { ModelSettingsError } from './model-settings.js';
import { linkOperationParent } from './operation-projection.js';
import { PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation,type PythonImportOutput } from './python-source-pack-executor.js';
import type {QueryScope} from './query-scope.js';
import { MAX_RAW_READ_BYTES } from './raw-reader.js';
import { semanticProcessor } from './semantic-extraction.js';
import { conversationUnderstandingProcessor } from './conversation-understanding.js';
import { Store,StoreError,sha256 } from './store.js';
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
export async function buildApp(config:Config,dependencies?:{distribution?:CentralDistribution;configService?:ConfigService;queryQualityExperiment?:QueryQualityStrategy;webRoot?:string;connectorTesting?:import('./connectors/index.js').ConnectorTestDependencies;semanticContextTime?:()=>string;backgroundWorker?:boolean;memoryExtensions?:LifecycleExtension[];store?:Store;agent?:QueryAgent;connections?:Connections;createModelAgent?:ModelAgentFactory;transcriptionProvider?:TranscriptionProvider;prepareImport?:(input:ImportPreparation)=>Promise<ImportPreparationResult>;observeImport?:(workspace:string,event:unknown)=>void}) {
  const resources=new ServerResources();
  let startupApp:FastifyInstance|undefined;
  try{
  const bootstrap=await bootstrapCentral({config:{...config},...(dependencies?.configService?{configService:dependencies.configService}:{}),...(dependencies?.store?{store:dependencies.store}:{}),...(dependencies?.backgroundWorker!==undefined?{backgroundWorker:dependencies.backgroundWorker}:{})},dependencies?.distribution);
  resources.defer(()=>bootstrap.close());
  config=bootstrap.config;
  const configService=bootstrap.configService,configurationPlatform=bootstrap.configurationPlatform,store=bootstrap.store;
  assertCurrentDelegationSchema(store);
  const memoryModelAuthorityJobs=createMemoryModelAuthorityJobReader(store);
  let availableModelConnections=():ModelConnection[]=>[];
  const {authorizationPlatform,modelAuthorization,runtimeSettings,observabilityPlatform,observabilityScope,observabilityAssembly,diagnostics,executionObserver,eventLoop,usageLedger,softwareUpdate,executionPlatform,executor,providerAdmission,agentGate,llmGate,interactiveGate,interactiveModelGate,modelContext,modelOperation,queryAccounting,assertModelPurpose,authorizeModelRequest,runModelFor,observeMemory,observeMemoryAsync}=await assemblePlatform({
    bootstrap,config,store,resources,serverVersion,
    availableModelConnections:()=>availableModelConnections(),connections:dependencies?.connections,
    queryQualityExperiment:dependencies?.queryQualityExperiment,
    assertModelEvidence:input=>assertModelEvidence(input)});
  projectMemoryLifecycleSettings(store,configService.current<LifecycleSettings>('memory'));
  const memoryStrategies=new MemoryStrategies(),memoryRecipeSettings=new MemoryRecipeSettings(store,memoryStrategies);
  const memoryAutomation=new MemoryAutomation(store);
  let memoryBindings:MemoryBindings|undefined;
  const {materials,materialMemoryWork}=prepareMaterials({store,resources,memoryRecipeSettings,newInputAdmission:()=>memoryBindings?.accepting()??memoryAutomation.accepting()});
  // One service tree owns backend plugins. Each runtime installs into its own
  // managed scope below this root, so closing one cannot dispose a sibling.
  const backendContext=new Context();
  resources.defer(()=>backendContext.fiber.dispose());
  backendContext.provide('moteMaterials',materials);
  backendContext.provide('moteConfig',configService);
  backendContext.provide('moteExecution',executor);
  backendContext.provide('moteMemoryStrategies',memoryStrategies);
  const {sourceRuntime,sourcePipelines,sources,filesPlatform,files,fileEvidence,fileRawReader,captureIntake,ingress,notesSource,modelAuthorizationHost}=await assembleSources({bootstrap,store,materials,materialMemoryWork,executionPlatform,authorizationPlatform,diagnostics,backendContext,resources});
  const {mediaAssets,mediaPreparation}=assembleMedia({config,store,configService,resources,backgroundWorker:dependencies?.backgroundWorker});
  const admittedUsageFactory=(route?:{mode:()=>AgentRunFinalizer|undefined;host?:()=>ReturnType<typeof observabilityAssembly.admittedUsage>|undefined})=>(...args:Parameters<UsageLedger['start']>)=>{
    let agentStarted=false,modelQueued=false,meter:ReturnType<typeof observabilityAssembly.admittedUsage>|undefined;
    const start=()=>meter??=observabilityAssembly.admittedUsage(...args);
    const accounting={agentStarted:()=>{agentStarted=true;},modelQueued:()=>{modelQueued=true;},modelStarted:()=>{
      agentStarted=true;
      // Admission for a declared Host run belongs to the Host meter. Starting
      // the legacy receipt here would leave a second, permanently running row.
      if(route?.mode()==='host'){route.host?.()?.modelStarted();return;}
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
  const admittedUsage=admittedUsageFactory();
  let catalogChangesEnabled=false;
  const {indexer,materialOrganizer,evidenceContext,contextTrees,evidenceReader,sourceContexts}=assembleMaterials({store,config,diagnostics,executor,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost,materials,materialMemoryWork,backendContext,resources,sources,sourcePipelines,files,fileEvidence,disableCatalogChanges:()=>{catalogChangesEnabled=false;}});
  const allEvidence=(ids:string[])=>evidenceReader.evidence(ids.map(id=>formatEvidenceRef('capture',id)));
  const memories=evidenceReader.memories,conversations=new Conversations(store);
  conversations.onTurnReceived=turnId=>modelAuthorizationHost.conversation(turnId);
  const pluginCenter=new PluginCenter(store,executor,new GitHubPluginReleases(join(config.dataDir,'plugins','packages')));
  resources.beforeClose(()=>pluginCenter.close());
  memoryBindings=new MemoryBindings(store,memories,memoryAutomation,pluginCenter,executor);
  resources.defer(()=>memoryBindings!.close());
  evidenceReader.memoryBindings=memoryBindings;
  const ownerQuestions=new OwnerQuestions(store);
  backendContext.provide('moteOwnerQuestions',ownerQuestions);
  const archivedFiles=bootstrap.vault.archivedFiles;
  const contentStorage=bootstrap.vault.attachContent(files,configService,enabled=>{config.contentEncryptionEnabled=enabled;});
  const connections=authorizationPlatform.assembly.connections!;
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
  const agentFeatures=await installAgentFeatures(backendContext,evidenceContext.agent({diagnostics,allowQueryImages:()=>perception.settings().allowQueryImages,
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
  const runtimeHost:AgentRuntimeHost=new AgentRuntimeHost({
    codex,createModelAgent:dependencies?.createModelAgent,authorization:modelAuthorization,admission:providerAdmission,
    runModelFor,authorizeModelRequest,assertPurpose:assertModelPurpose,assertEvidence:assertModelEvidence,assertEvidenceAsync:assertModelEvidenceAsync,pinEvidence:pinProcessingEvidence,
    agentGate,interactiveGate,modelContext,modelOperation,archiveImagesEnabled:()=>perception.settings().allowQueryImages,
    retainSnapshot:input=>observeMemory(input,'catalog_snapshot',()=>evidenceReader.retainMemorySnapshot(input)),
    releaseSnapshot:input=>evidenceReader.releaseMemorySnapshot(input),agentStarted:()=>queryAccounting.getStore()?.agentStarted(),
    recordTiming:(input,timing)=>diagnostics.record('agent.fragment_timing',{jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,unit:'agent_fragment',...timing},'info'),
  });
  resources.defer(()=>runtimeHost.close());
  const factory:ModelAgentFactory=runtimeHost.factory;
  let initialAgent=dependencies?.agent?runtimeHost.wrap(dependencies.agent,modelSettingsFromConfig(config),{kind:'profile',id:DEPLOYMENT_MODEL_PROFILE_ID}):undefined;
  await configurationPlatform.bindModels({
    codex,
    prepare:async (settings,profiles,defaultProfileId,previousSettings)=>{
      const candidate=await createModelRegistry(profiles,reader,factory,initialAgent,defaultProfileId);initialAgent=undefined;
      return agent.prepare(candidate,()=>applyModelSettings(config,settings),()=>applyModelSettings(config,previousSettings??settings));
    },
    probe:settings=>testModelConnection(settings,async(selected,reader)=>{
      const id=randomUUID(),identity:ModelAgentIdentity={kind:'probe',id},candidate=await factory(selected,reader,undefined,identity),connection=agentModelConnection(identity,selected);
      return {...candidate,query:input=>modelAuthorizationHost.manual('model-probe:'+id,[connection],signal=>candidate.query({...input,signal}),input.signal,'probe')};
    }),
  });
  const modelSettings=configurationPlatform.modelSettings;
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
  let queryRuns:DelegatedQueryRuns;
  const insightRuns=new InsightRuns(store,{executor,evidenceReader});
  resources.defer(()=>insightRuns.close());
  const {workflows,processing,resolveFileModel,mediaModelAuthority}=await assembleProcessing({store,config,configService,diagnostics,executor,backendContext,resources,materials,sourcePipelines,files,sourceContexts,mediaAssets,modelAuthorization,modelAuthorizationHost,modelSettings,factory,admittedUsage,transcriptionProvider:dependencies?.transcriptionProvider});
  const memoryConfiguration=(id?:string,model?:string)=>{const selected=modelSettings.select('memory',id);return modelConfiguration(selected.id,{...selected.settings,...(model?{model}:{})},modelSettings.view().revision);};
  const withMediaOwnerIntent=<T>(id:string,task:()=>Promise<T>|T)=>modelAuthorizationHost.manual('owner-media:'+randomUUID(),availableModelConnections(),async()=>task(),undefined,'manual',[captureModelIdentity(id)]);
  const disposeCaptureMemoryIntake=installCaptureMemoryIntake(store,materialMemoryWork,input=>modelAuthorizationHost.capture(input));
  resources.defer(disposeCaptureMemoryIntake);
  const {perception}=assemblePerception({store,config,configService,executor,resources,materials,mediaAssets,processing,mediaModelAuthority,resolveFileModel,modelSettings,factory,agent,admittedUsage});
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
    if(error instanceof ModelCatalogError)return reply.code(error.statusCode).send({error:'model_catalog_unavailable',message:error.message,requestId:req.id});
    if(error instanceof ModelSettingsError)return reply.code(error.statusCode).send({error:error.code,message:error.message,requestId:req.id});
    if(error instanceof ConfigServiceError)return reply.code(error.statusCode).send({error:error.code,message:error.code==='config_conflict'?moteText('配置已发生变化，请刷新后重试。'):moteText('配置未能应用，请检查配置状态后重试。'),requestId:req.id});
    reply.code(failure.status).send({error:failure.category,message:failure.message,...(failure.reason?{reason:failure.reason}:{}),requestId:req.id});
  });
  const actions=new Actions(store,files,input=>queryAgent({...input,language:requestLocale.getStore()??'zh-CN'},'query','actions'),()=>agent.configured,{semanticArtifacts,executor,configService});

  resources.defer(()=>actions.close());
  const connectors=await registerConnectors(app,{memoryRecipeSettings,diagnostics,memoryStrategies,files,sources,store,evidenceReader,materials,sourcePipelines,materialOrganizers:materialOrganizer,processing:workflows,config,ownerAuthorization:header=>{if(validBearer({headers:{authorization:header}}))return true;const c=connections.authenticate(header);return !!c&&connections.isOwner(c);},mcpAuthorization:header=>connections.mcpAuthorization(header,config.connectors)},dependencies?.connectorTesting);

  resources.defer(()=>connectors.close());
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
    const usageAttribution={agentId:'context-query',moduleId,skillId:input.skill??null,operationId:input.traceContext?.operationId,jobId:input.traceContext?.jobId,requestId:diagnostics.requestId()};
    // Trusted per-query run accounting. Only app callbacks mutate this state and
    // none of them throw: observation isolation must not govern execution.
    const runState:{mode?:AgentRunFinalizer;runId?:string;hostEvents:boolean;hostTerminal:boolean;violation?:string}={hostEvents:false,hostTerminal:false};
    // The Host path owns usage through one C06 receipt; capture its terminal
    // receipt so the response reports the finalized sample without a second
    // finalize. Constructing this meter writes nothing until a model starts.
    const hostMeterBase=usageOwner==='query'?observabilityAssembly.admittedUsage(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,usageAttribution):undefined;
    let hostReceipt:import('@mote/shared').UsageReceipt|undefined;
    const hostMeter=hostMeterBase&&{...hostMeterBase,complete:()=>hostReceipt=hostMeterBase.complete(),fail:()=>hostReceipt=hostMeterBase.fail()};
    const meter=usageOwner==='query'?admittedUsageFactory({mode:()=>runState.mode,host:()=>hostMeterBase})(profile.settings.provider,input.modelOverride??profile.settings.model,input.skill??operation,usageAttribution):undefined;
    let hostObserver:ReturnType<typeof createHostRunUsageObserver>|undefined;
    // Latch violations always reject. A missing Host terminal is only a success
    // gap: the leaf reports host before any Host session exists, so an early
    // failure or pre-cancel must keep its original error instead of being
    // rewritten into a terminal gap.
    const runViolation=()=>runState.violation?new StoreError('Agent run accounting contradiction',409):undefined;
    const runSuccessGap=()=>runState.mode==='host'&&!runState.hostTerminal?new StoreError('Agent run terminal is missing',409):undefined;
    const runLease:QueryRunLease={onFinalizer:mode=>{
      if(runState.mode!==undefined&&runState.mode!==mode){runState.violation??='finalizer_mode_contradiction';return;}
      runState.mode=mode;
    }};
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
      onProgress:(event:import('@mote/agent').AgentProgress)=>{trace({type:'progress',stage:event.stage,phase:event.phase,step:event.step,tool:event.tool,payload:event});input.onProgress?.(event);},onTrace:trace,
      onUsage:(tokens:import('@mote/shared').TokenUsage)=>{if(runState.mode!=='host')meter?.update(tokens);input.onUsage?.(tokens);},
      onHostRunEvent:(envelope)=>{
        // Bind only after the chosen leaf declared host and only from the first
        // trusted Host identity; never infer the mode from an event.
        if(runState.mode!=='host'){runState.violation??='host_event_without_host_mode';return;}
        const identity=envelope?.identity;
        const runId=identity&&typeof identity==='object'&&typeof identity.runId==='string'?identity.runId:undefined;
        if(!runId){runState.violation??='invalid_host_identity';return;}
        if(runState.runId===undefined)runState.runId=runId;
        else if(runState.runId!==runId){runState.violation??='run_identity_contradiction';return;}
        runState.hostEvents=true;
        if(envelope.event.type==='run.terminal')runState.hostTerminal=true;
        if(hostMeter)(hostObserver??=createHostRunUsageObserver({runId,meter:hostMeter,diagnostics}))(envelope);
      }};
    const heartbeat=setInterval(()=>diagnostics.record('agent.heartbeat',{jobId:input.traceContext?.jobId,elapsedMs:Date.now()-startedAt,idleMs:Date.now()-lastActivity,activeQueries:agentGate.snapshot().active},'info'),30000);heartbeat.unref();
    const promise=diagnostics.measure('agent',operation,()=>(meter?meter.run(()=>agent.query(observed,runLease)):agent.query(observed,runLease)).then(result=>{
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
      // A contradiction or a Host success without its terminal latches before
      // any success finalize or product commit.
      const accounting=runViolation()??runSuccessGap();
      if(accounting){if(runState.mode!=='host')meter?.failed(accounting);throw accounting;}
      trace({type:'query.completed',stage:'validating',phase:'completed',status:'succeeded',payload:{answer:result.answer,citations:result.citations,trace:result.trace,contextUsage:(result as QueryResult & {contextUsage?:unknown}).contextUsage}});
      const completedUsage=runState.mode==='host'?hostReceipt:meter?.completed();
      return {...result,...(evidenceDependencies?{evidenceDependencies}:{}),...(sourcePins.length?{sourceContextDependencies:sourcePins}:{}),configuration,...(completedUsage?{usage:completedUsage}:{})};
    }).catch(error=>{
      // The Host path finalizes only through its observer's run terminal; the
      // legacy path keeps its existing finalizers. A latched contradiction
      // replaces the outcome after the legacy finalizer has settled its row.
      if(error instanceof AgentYieldError){
        // Accounting is decided before the yield finalizer: a contradiction
        // must fail the started legacy receipt rather than complete it.
        const accounting=runViolation();
        if(accounting){if(runState.mode!=='host')meter?.failed(accounting);throw accounting;}
        const gap=runSuccessGap();
        if(gap){if(runState.mode!=='host')meter?.failed(gap);throw gap;}
        if(runState.mode!=='host')meter?.completed();
        trace({type:'query.yielded',status:'waiting'});throw error;
      }
      const wait=error instanceof ProviderFailure&&(error.details.admissionWaiting===true||error.details.category==='transient'&&error.details.code==='rate_limited')?{code:error.details.code,retryAfterMs:error.details.retryAfterMs}:error instanceof ExecutionFailure&&error.category==='waiting'?{code:error.code,retryAfterMs:error.retryAfterMs}:undefined;
      if(runState.mode!=='host')meter?.failed(error);
      const accounting=runViolation();
      if(accounting)throw accounting;
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
  const maintenanceWorker=bootstrap.vault.startMaintenance();
  // C02 stops the worker before content accessors; DB remains alive until every
  // other root consumer has closed and bootstrap releases the vault last.
  resources.defer(()=>bootstrap.vault.stopAccessors());
  const activity=new ActivityProjection(store,executionPlatform.assembly.operations,{delegation});
  const applyExecution=(value:ExecutionSettingsValue)=>executionPlatform.refreshSettings(executionSettingsSchema.strip().parse(value));
  configService.setHandler<ExecutionSettingsValue>('execution',(next,previous)=>({apply:()=>{},publish:()=>applyExecution(next),rollback:()=>{applyExecution(previous);memoryPipeline.wake();},complete:()=>memoryPipeline.wake()}));
  configService.setHandler<DiagnosticsSettingsValue>('diagnostics',next=>diagnostics.prepareConfiguration(diagnosticsSettingsSchema.strip().parse(next)));
  configService.setHandler<{syncIntervalMs:number}>('connectors',(next,previous)=>({apply:()=>{},publish:()=>connectors.configureSyncInterval(next.syncIntervalMs),rollback:()=>connectors.configureSyncInterval(previous.syncIntervalMs)}));
  const automaticActivity=new AutomaticActivity(store,materials,executor,configService,{query:input=>queryAgent(input,'query','activity'),selection:profileId=>{const selected=modelSettings.select('chat',profileId);return {...modelConfiguration(selected.id,selected.settings,modelSettings.view().revision),configured:agent.configuredFor(selected.id)};},lane:()=>workflows.settings().semantic});
  resources.defer(()=>automaticActivity.close());
  const featureServices={pluginCenter,withMediaOwnerBatch,launchOwnerImport,withMediaOwnerIntent,modelAuthorization,modelAuthorizationHost,availableModelConnections:()=>availableModelConnections(),contextTrees,automaticActivity,configService,memoryBindings,memoryPublication,ownerQuestions,automaticMemoryScheduling:dependencies?.backgroundWorker!==false,activity,delegation,memoryDelegation,connectionIdentity,assertRequestActive,memoryIntegrationSettings,memoryRecipeSettings,setPlaybackAuthorization:(authorize:ReturnType<typeof registerFileRoutes>)=>{playbackAuthorization=authorize;},filesSource:{playback:filesPlatform.assemblyForRoutes().playback},notesSource:notesSource.assemblyForRoutes(),notesCapture:{authority:authorizationPlatform,route:{request:request=>pins.get(request)},intake:captureIntake.ports.captureIntake},connectors,processing,executor,agentFeatures,archiveReader,isClosing:()=>closing,actions,agent,agentGate,archivedFiles,codex,config,connections,contentStorage,conversations,credential,diagnosticSnapshot,diagnostics,eventLoop,evidenceReader,fileEvidence,files,importTasks,imports,indexer,ingress,insight,insightRequestSchema,insightRuns,interactiveGate,interactiveModelGate,jobId,launchImport,lifecycle,llmGate,maintenanceWorker,materialOrganizer,materialMemoryWork,materials,mediaAssets,mediaPreparation,mediaRange,memories,memoryPipeline,modelSettings,parseCaptureBundle,perception,providerAdmission,queryAgent,queryRuns,queryWithAttachmentsSchema,reviewExtraction,runtimeSettings,semanticSelection,serverVersion,softwareUpdate,sourceOwner,sourcePipelines,sources,store,usageLedger,webVersion,workflows} satisfies FeatureServices;
  const featureHost=new ServerFeatureHost(backendContext,app,()=>diagnostics.record('request.failed',{category:'internal'},'error'));
  resources.defer(()=>featureHost.close());
  registerPluginRoutes(app,{plugins:pluginCenter,bindings:memoryBindings,automation:memoryAutomation,owner:request=>{assertRequestActive(request);if(credential(request))throw new StoreError('Owner authorization is required for plugin control',403);}});
  await installServerFeatures(featureHost,featureServices,bootstrap.features);
  memoryTopics=new MemoryTopicsHost({store,memories,executor,control:modelAuthorization,host:modelAuthorizationHost,topics:contextTrees.initializeAutomatic(store,evidenceReader,()=>catalogChangesEnabled&&!closing),assertReadable:cards=>evidenceReader.assertMemoryReadable(cards),select:(profileId,model)=>{const selected=modelSettings.select('memory',profileId),settings={...selected.settings,...(model?{model}:{})};return {profileId:selected.id,model:settings.model,connection:agentModelConnection({kind:'profile',id:selected.id},settings)};},query:input=>queryAgent(input,'query','memories')});
  resources.defer(()=>memoryTopics?.close());
  await configurationPlatform.start();
  diagnostics.record('server.started');
  app.addHook('onReady',async()=>{
    for(const row of store.db.prepare("SELECT id FROM import_jobs WHERE json_extract(json,'$.status')='queued'").all() as {id:string}[])launchImport(row.id,()=>imports.prepare(row.id));
  });
  app.addHook('preClose',async()=>{
    closing=true;
    // Stop watcher/subscriptions and join accepted configuration transactions
    // while execution/model consumers are still alive; a config-service failure
    // must not abort the remaining cleanup. Bootstrap retains final close.
    let configDrainFailure:unknown;
    try{await configurationPlatform.quiesce('shutdown');}catch(error){configDrainFailure=error;}
    try{featureHost.stop();
    // Polling/admission stops without retiring the runtime's Memory authority;
    // the runtime closes only after accepted engine work is interrupted/drained.
    sourcePipelines.quiesce();
    executionPlatform.quiesce('shutdown');
    executor.bindObserver(undefined);eventLoop.disable();queryRuns.interrupt();
    automaticActivity.stop();memoryPublication.stop();
    // Interrupt transports while handlers, checkpoints and storage remain live.
    await resources.stop();
    }finally{if(configDrainFailure)try{diagnostics.record('config.shutdown_drain_failed',{category:'internal'},'error');}catch{/* cleanup continues */}}
  });
  app.addHook('onClose',async()=>resources.close());
  // Rebuilding built-in registrations before readers exist is not a change.
  // Shutdown disables notifications before any registration is disposed.
  catalogChangesEnabled=true;
  return {app,bootstrap,configurationPlatform,observabilityPlatform,observabilityScope,observabilityAssembly,executionPlatform,authorizationPlatform,captureIntake,liveRequestPins:()=>liveRequestPins,filesPlatform,sourceRuntime,notesSource,evidenceContext,modelAuthorization,modelAuthorizationHost,automaticActivity,configService,featureServices,featureHost,pluginCenter,memoryBindings,memoryAdapters,memoryPublication,memoryAutomation,memoryIntegrationSettings,memoryRecipeSettings,memoryStrategies,sourcePipelines,executor,workflows,perception,actions,store,sources,files,processing,materials,materialMemoryWork,materialOrganizer,memories,archivedFiles,imports,memoryPipeline,indexer,agent,diagnostics,connections,modelSettings,insightRuns,lifecycle,working};
  }catch(error){
    const failures:unknown[]=[];
    await resources.stop();
    if(startupApp)try{await startupApp.close();}catch(cleanup){failures.push(cleanup);}
    try{await resources.close();}catch(cleanup){failures.push(cleanup);}
    if(failures.length)throw new AggregateError([error,...failures],'Server initialization and disposal failed',{cause:error});
    throw error;
  }
}
