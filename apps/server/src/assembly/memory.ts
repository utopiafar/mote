import type {AgentOptions,QueryInput} from '@mote/agent';
import {skillCatalog,codexContextCapacity} from '@mote/agent';
import {assertMemoryRequestFits,httpMemoryRequestCapacity,memoryRequestUsage,type MemoryRequestCapacity} from '../memory-request-budget.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import type {QueryResult} from '@mote/shared';
import {OPENCODE_GO_PROVIDER,type ModelSettings} from '@mote/shared/models';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import {sha256,StoreError,type EvidenceStore as Store} from '../evidence-store.js';
import type {ConnectionCredential} from '../connections.js';
import type {AssistantCommitments} from '../assistant-commitments.js';
import {registerMemoryAssociationRoutes} from '../features/memory/associations.js';
import {memoryConfigDomain,perceptionConfigDomain} from '../config.js';
import type {ConfigService} from '../config-service.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {PluginCenter} from '../plugin-center.js';
import {modelsConfigDomain,type ModelSettingsStore} from '../model-settings.js';
import type {AgentRuntimeRegistry} from '../agent-runtime-registry.js';
import type {BackgroundModelAuthorization,ModelConnection} from '../background-model-authorization.js';
import {agentModelConnection,type ModelAuthorizationHost} from '../model-authorization-host.js';
import type {ExecutionSettings} from '../execution-settings.js';
import type {MaterialStore} from '../materials.js';
import type {FileStore} from '../files.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ContextTreeRegistry} from '../context-trees.js';
import {memoryEvidenceFingerprint,queryWithMemoryValidationFeedback,type MemoryStore} from '../memory.js';
import type {ConversationRepository as Conversations,OwnerQuestionsPort} from '../plugins/central-contracts.js';
import {EvidenceExposurePolicy} from '../evidence-exposure.js';
import {memoryIntegrationImageInputs} from '../memory-image-grants.js';
import type {MemoryStrategies} from '../memory-strategies.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {MemoryAutomation} from '../memory-automation.js';
import {createMemoryAutomationAdmission,memoryAutomationAdmissionContribution,memoryAutomationAdmissionDeclaration,memoryAutomationAdmissionReplacement} from '../plugins/memory-automation-admission.js';
import {createMemoryProviderAdapters,memoryProviderAdaptersContribution,memoryProviderAdaptersDeclaration,memoryProviderAdaptersReplacement} from '../plugins/memory-provider-adapters.js';
import {createMemoryStrategySettings,memoryStrategySettingsContribution,memoryStrategySettingsDeclaration,memoryStrategySettingsReplacement,type MemoryStrategySettingsPlatform} from '../plugins/memory-strategy-settings.js';
import {createMemoryPublication,memoryPublicationContribution,memoryPublicationDeclaration,memoryPublicationReplacement} from '../plugins/memory-publication.js';
import {registerEvidenceDeletionForAssembly} from '../plugins/evidence-deletion.js';
import {openMaterialNoteDeletion} from '../plugins/material-repository.js';
import type {MemoryPipeline,MemoryModelSelection,MemoryPhasePorts} from '../memory-pipeline.js';
import {memoryReadRanges} from '../memory-read-context.js';
import {createMemoryPhasePipeline,memoryPhasePipelineContribution,memoryPhasePipelineDeclaration,memoryPhasePipelineReplacement,type MemoryPhasePipelineOptions,type MemoryPhasePipelinePlatform} from '../plugins/memory-phase-pipeline.js';
import {projectMemoryLifecycleSettings,storedMemoryLifecycleSettings,type LifecycleExtension} from '../memory-lifecycle.js';
import {createMemoryLifecycleService,memoryLifecycleServiceContribution,memoryLifecycleServiceDeclaration,memoryLifecycleServiceReplacement} from '../plugins/memory-lifecycle-service.js';
import type {InsightRuns} from '../insight-runs.js';
import {memoryRecordRepositoryContribution,memoryRecordRepositoryDeclaration,memoryRecordRepositoryReplacement} from '../plugins/memory-record-repository.js';
import {createMemoryTopicsService,memoryTopicsServiceContribution,memoryTopicsServiceDeclaration,memoryTopicsServiceReplacement} from '../plugins/memory-topics-service.js';
import {createMemoryBindingControl,memoryBindingControlContribution,memoryBindingControlDeclaration,memoryBindingControlReplacement,type MemoryBindingControlPlatform} from '../plugins/memory-binding-control.js';
import type {MemoryTopics} from '../plugins/central-contracts.js';
import type {OwnerQuestions} from '../owner-questions.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';

/** Declared build-time domain plugins the memory assembly wires; the
 * distribution concatenates each domain's list into one selected table.
 * The list covers strategy settings, the memory record repository,
 * automation admission, the topics host, binding control, the
 * phase/review pipeline, lifecycle and working extensions, provider
 * adapters and publication. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:memoryStrategySettingsContribution,declaration:memoryStrategySettingsDeclaration,replacement:memoryStrategySettingsReplacement},
  {contribution:memoryRecordRepositoryContribution,declaration:memoryRecordRepositoryDeclaration,replacement:memoryRecordRepositoryReplacement},
  {contribution:memoryAutomationAdmissionContribution,declaration:memoryAutomationAdmissionDeclaration,replacement:memoryAutomationAdmissionReplacement},
  {contribution:memoryTopicsServiceContribution,declaration:memoryTopicsServiceDeclaration,replacement:memoryTopicsServiceReplacement},
  {contribution:memoryBindingControlContribution,declaration:memoryBindingControlDeclaration,replacement:memoryBindingControlReplacement},
  {contribution:memoryPhasePipelineContribution,declaration:memoryPhasePipelineDeclaration,replacement:memoryPhasePipelineReplacement},
  {contribution:memoryLifecycleServiceContribution,declaration:memoryLifecycleServiceDeclaration,replacement:memoryLifecycleServiceReplacement},
  {contribution:memoryProviderAdaptersContribution,declaration:memoryProviderAdaptersDeclaration,replacement:memoryProviderAdaptersReplacement},
  {contribution:memoryPublicationContribution,declaration:memoryPublicationDeclaration,replacement:memoryPublicationReplacement},
]);

/** A slot a later assembly stage fills once the object exists; callbacks
 * installed earlier dereference it at call time instead of capturing a `let`
 * forward reference. */
export interface LateBinding<T>{current:T|undefined;}
export function lateBinding<T>():LateBinding<T>{return {current:undefined};}

export interface MemoryInputStageDependencies {
  readonly store:Store;
  readonly configService:ConfigService;
}

/** Execution/model hooks owned by the app shell but consumed only inside the
 * Memory lifecycle service. */
export interface MemoryLifecycleRuntimeDependencies {
  readonly automatic:boolean;
  readonly whenReady?:(task:()=>void)=>void;
  readonly semanticArtifacts?:(ids:string[],operationId?:string,mode?:'lifecycle')=>Promise<string[]>;
  readonly providerCooldownCheck?:()=>void;
  readonly insights?:InsightRuns|false;
  readonly insightTimeout?:()=>number|null;
  readonly query:(input:QueryInput,module:'memories'|'insights'|'conversations')=>Promise<QueryResult>;
  readonly replacements?:readonly LifecycleExtension[];
}

/** Memory strategies, recipe settings, automation and binding control inputs
 * other domains consume during their own assembly. The binding control object
 * is created here but attaches runtime collaborators and constructs its binding
 * in the runtime prepare stage; callbacks installed earlier ask the live object
 * instead of a `let` forward reference. Topics are still filled by the runtime
 * stage. */
export function memoryInputs(dependencies:MemoryInputStageDependencies){
  const {store,configService}=dependencies;
  projectMemoryLifecycleSettings(store,configService.current(memoryConfigDomain));
  // The strategy-settings plugin constructs the catalog and both selections
  // only inside its module; the borrowed Store has no independent disposal here.
  const memoryStrategySettings=createMemoryStrategySettings({store});
  memoryStrategySettings.prepare();
  const memoryStrategies=memoryStrategySettings.strategies,memoryRecipeSettings=memoryStrategySettings.recipes,memoryIntegrationSettings=memoryStrategySettings.integration;
  // The automation-admission plugin is the only construction path for MemoryAutomation.
  const automationAdmission=createMemoryAutomationAdmission(store);
  automationAdmission.prepare();automationAdmission.start();
  const memoryAutomation=automationAdmission.automationForAssembly;
  const memoryBindingControl=createMemoryBindingControl({store,automation:memoryAutomation});
  return Object.freeze({memoryStrategies,memoryRecipeSettings,memoryIntegrationSettings,memoryStrategySettings,memoryAutomation,automationAdmission,memoryBindingControl,
    topics:lateBinding<MemoryTopics>()});
}

export interface MemoryRuntimeDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly backendContext:Context;
  readonly configService:ConfigService;
  readonly diagnostics:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly usageLedger:UsageLedger;
  readonly memories:MemoryStore;
  readonly conversations:Conversations;
  readonly files:FileStore;
  readonly materials:MaterialStore;
  readonly materialMemoryWork:MaterialMemoryWork;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly evidenceReader:EvidenceReader;
  readonly contextTrees:ContextTreeRegistry;
  readonly memoryStrategies:MemoryStrategies;
  readonly memoryRecipeSettings:MemoryRecipeSettings;
  readonly memoryStrategySettings:MemoryStrategySettingsPlatform;
  readonly memoryAutomation:MemoryAutomation;
  /** Shared owner-question ledger; the phase plugin owns the Memory provider. */
  readonly ownerQuestions:OwnerQuestionsPort;
  /** The Memory browser reads the existing commitment projection; its owner
   * guard is the ordinary request authority, not a second Memory permission. */
  readonly assistantCommitments:Pick<AssistantCommitments,'page'>;
  readonly assertRequestActive:(request:FastifyRequest)=>void;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly pluginCenter:PluginCenter;
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly modelSettings:ModelSettingsStore;
  readonly availableModelConnections:()=>ModelConnection[];
  readonly queryAgent:(input:QueryInput,operation?:'query'|'insight',moduleId?:string,usageOwner?:'query'|'caller')=>Promise<QueryResult>;
  readonly agent:AgentRuntimeRegistry;
  readonly runtimeSettings:ExecutionSettings;
  readonly codex:{executable?:string;home?:string};
  readonly instancesDirectory:string;
  readonly runModelFor:(settings:ModelSettings,connection?:ModelConnection)=>NonNullable<AgentOptions['runModel']>;
  readonly memoryConfiguration:NonNullable<MemoryModelSelection['configuration']>;
  readonly semanticContextTime?:()=>string;
  /** Extension inputs and optional test replacements registered with the lifecycle service. */
  readonly lifecycle:MemoryLifecycleRuntimeDependencies;
  /** Binding control minted by the inputs stage; this stage prepares and starts it. */
  readonly memoryBindingControl:MemoryBindingControlPlatform;
  /** The topics slot is assigned by this stage. */
  readonly topics:LateBinding<MemoryTopics>;
  /** Publishes catalog changes only during the active lifecycle. */
  readonly topicsCanPublish:()=>boolean;
  readonly understand:NonNullable<MemoryPhasePorts['understand']>;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
  readonly withQueryModelAuthority:<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>)=>Promise<T>;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
}

/** Bindings, provider adapters, publication, pipeline, lifecycle, control and
 * the automatic topics host — the Memory runtime app.ts previously wired
 * inline. Memory objects keep their relative defer/beforeClose order. */
export function memoryRuntime(dependencies:MemoryRuntimeDependencies){
  const {store,resources,backendContext,configService,diagnostics,executor,usageLedger,memories,conversations,files,materials,materialMemoryWork,sourcePipelines,evidenceReader,contextTrees,memoryStrategies,memoryRecipeSettings,memoryStrategySettings,memoryAutomation,ownerQuestions,assistantCommitments,assertRequestActive,credential,pluginCenter,modelAuthorization,modelAuthorizationHost,modelSettings,availableModelConnections,queryAgent,agent,runtimeSettings,codex,instancesDirectory,runModelFor,memoryConfiguration,memoryBindingControl,topics,lifecycle:lifecycleRuntime,understand,query,withQueryModelAuthority,assertModelEvidence}=dependencies;
  memoryStrategySettings.start();
  // The plugin constructs the binding; its disposer is registered by app.ts at
  // the original shutdown slot. Runtime collaborators are resolved when the
  // binding and later control projections actually run.
  memoryBindingControl.attach({memories,plugins:pluginCenter,executor,pipeline:()=>memoryPipeline,lifecycle:()=>lifecycle,publication:()=>memoryPublication});
  memoryBindingControl.prepare();
  const memoryBindings=memoryBindingControl.bindings;
  evidenceReader.memoryBindings=memoryBindings;
  const memoryProviderAdapters=createMemoryProviderAdapters({directory:instancesDirectory,plugins:pluginCenter,models:modelSettings});
  resources.beforeClose(()=>memoryProviderAdapters.close());
  memoryProviderAdapters.prepare();memoryProviderAdapters.start();
  const memoryAdapters=memoryProviderAdapters.adapters;
  memoryBindings.providerFactory=(id,namespace)=>memoryProviderAdapters.port.provider(id,namespace);
  const memoryPublicationPlatform=createMemoryPublication({store,memories,bindings:memoryBindings,executor,revokeEvidence:ids=>memoryProviderAdapters.port.erasePreparedEvidence(ids),
    evidenceDeletion:evidenceReader.files?{captures:store,files:evidenceReader.files,aliases:openMaterialNoteDeletion(store,materials)}:undefined});
  resources.defer(()=>memoryPublicationPlatform.close());
  memoryPublicationPlatform.prepare();memoryPublicationPlatform.start();
  registerEvidenceDeletionForAssembly(store,()=>memoryPublicationPlatform.evidenceDeletion);
  const memoryPublication=memoryPublicationPlatform.publication;
  const nativeRequestCapacity=(settings:ModelSettings,modelOverride?:string):MemoryRequestCapacity|undefined=>{
    const capacity=codexContextCapacity(modelOverride??settings.model);
    return capacity?{...capacity,draftTokens:settings.maxTokens}:undefined;
  };
  const requestCapacity=(profileId?:string,modelOverride?:string):MemoryRequestCapacity|undefined=>{
    const settings=modelSettings.select('memory',profileId).settings;
    if(settings.protocol==='codex-app-server')return nativeRequestCapacity(settings,modelOverride);
    if(settings.provider===OPENCODE_GO_PROVIDER.id){
      const requested={...settings,model:modelOverride??settings.model};
      return httpMemoryRequestCapacity({...requested,...modelSettings.memoryRequestBudget(requested)});
    }
  };
  const nativeCapacityForRequest=(input:QueryInput):MemoryRequestCapacity|undefined=>{
    const settings=modelSettings.select('memory',input.modelProfileId).settings;
    if(settings.protocol!=='codex-app-server')return;
    const capacity=nativeRequestCapacity(settings,input.modelOverride);
    return capacity&&input.traceContext?.phase==='review'&&input.modelBudget?.contextWindowSource==='configured'
      ?{...capacity,contextWindow:input.modelBudget.contextWindow}:capacity;
  };
  const boundedQuery:typeof query=async input=>{
    const capacity=nativeCapacityForRequest(input);
    if(capacity){
      assertMemoryRequestFits(input,memories.readEvidence(input.evidenceIds??[]),capacity);
      if(input.traceContext?.phase==='review'&&input.modelBudget?.contextWindowSource==='configured'){
        diagnostics.agentTrace({type:'memory.review_budget',stage:'starting',payload:{
          contextWindow:capacity.contextWindow,outputReserve:capacity.maxOutputTokens,
        }},input.traceContext);
      }
    }
    return queryWithMemoryValidationFeedback(input,query);
  };
  const memoryPipelineOptions:MemoryPhasePipelineOptions={allowQueryImages:()=>configService.current(perceptionConfigDomain).allowQueryImages,onPublished:(step,items,job)=>topics.current?.enqueue(step,items,job.configuration?.profileId??job.modelProfileId,job.configuration?.model??job.modelOverride),assertIntegrationAuthority:()=>modelAuthorization.assertCurrent(),withIntegrationAuthority:(id,manual,evidenceIds,task)=>manual?modelAuthorization.run('owner-integration:'+id,task):modelAuthorizationHost.automatic('automatic-integration:'+id,'integration',modelAuthorizationHost.evidenceTriggers(evidenceIds),task),integrationReadInput:cards=>memoryIntegrationImageInputs(store,materials,cards.flatMap(card=>card.evidence)),assertIntegrationReadable:cards=>evidenceReader.assertMemoryReadable(cards),publication:memoryPublicationPlatform.port.stage,ownerPublication:memoryPublicationPlatform.port.owner,assertNewManualWork:()=>memoryBindings.assertNewManualWork(),nativeStages:{settle:async context=>{if(!context.provider)throw new StoreError('Native Memory cleanup has no pinned provider configuration',503);await memoryProviderAdapters.port.discardPrepared({...context.provider,opId:context.opId,phase:context.phase});},prepare:async(input,context)=>withQueryModelAuthority(input,'memories',async signal=>{input={...input,signal};const binding=memoryBindings.binding();if(memoryBindings.bindingMode(binding)!=='engine')return;const namespace=binding.namespace!;context.provider={instanceId:namespace.instanceId,namespace,configurationIdentity:memoryProviderAdapters.port.configurationIdentity(namespace.instanceId,namespace)};input.signal?.throwIfAborted();const originals=memories.readEvidence(context.evidenceIds);if(originals.length!==new Set(context.evidenceIds).size)throw new StoreError('Engine originals are unavailable',409);const evidence=input.evidenceRanges?.map(range=>{const record=originals.find(record=>record.id===range.id);if(!record)throw new StoreError('Engine original range is unavailable',409);return {record,offset:range.offset,length:range.length};})??originals;
    const engineProfile=pluginCenter.instanceView(namespace.instanceId).configuration.modelProfileId;if(typeof engineProfile!=='string')throw new StoreError('Native Memory model profile is missing',409);
    const engineConnection=agentModelConnection({kind:'profile',id:engineProfile},modelSettings.select('memory',engineProfile).settings),assertAuthority=modelAuthorization.capture(engineConnection);
    const bindingIdentity=JSON.stringify(binding),pins=new Map(originals.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const assert=()=>{assertAuthority();input.signal?.throwIfAborted();context.assertAuthority?.();assertModelEvidence(input);if(JSON.stringify(memoryBindings.binding())!==bindingIdentity)throw new StoreError('Native Memory binding changed',409);for(const [id,fingerprint] of pins){const current=memories.readEvidence([id])[0];if(!current||!memories.isCurrentEvidence(id)||memoryEvidenceFingerprint(current)!==fingerprint||!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()))throw new StoreError('Native Memory originals were changed or revoked',409);}};
    assert();
    const result=await memoryProviderAdapters.port.engine(namespace.instanceId,namespace).prepare({namespace,opId:context.opId,phase:context.phase,evidence,relatedMemories:context.relatedMemories,signal:input.signal});assert();input.onEvidence?.(originals);if(context.relatedMemories?.length)input.onMemoryBodies?.(context.relatedMemories);return result;})},batchCharacters:()=>storedMemoryLifecycleSettings(store).batchCharacters,strategies:memoryStrategies,executor,store,memories,concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,admission:{materialSourceCurrent:(pin,id)=>evidenceReader.materialSourceCurrent(pin,id),materialPlanAllowed:id=>evidenceReader.materialPlanAllowed(id,new EvidenceExposurePolicy()),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:ref=>materialMemoryWork.sourceRequirements(ref),automaticAllowed:job=>materialMemoryWork.authorized(job)&&[...(job.automaticGrants??[]),...(job.automaticGrant?[job.automaticGrant]:[])].every(grant=>sourcePipelines.memoryAllowed(grant.sourceId)),deletionEvidenceAllowedForMemory:id=>evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()),materialAllowedForMemory:(ref,profileId,required,selectionReady)=>evidenceReader.materialAllowedForMemory(ref,new EvidenceExposurePolicy(),required,selectionReady)},models:{capacity:requestCapacity,configuration:memoryConfiguration,model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}}},phases:{understand,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),query:boundedQuery,skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`}};
  let memoryPhasePipeline!:MemoryPhasePipelinePlatform;
  memoryPhasePipeline=createMemoryPhasePipeline({pipeline:memoryPipelineOptions,review:{query:boundedQuery,deletions:memories.deletions,
    prepareReviewRequest:(input,{resumedFromExtraction,withExtractionContext})=>{
      const configuredWindow=configService.current(modelsConfigDomain).codex.memoryReviewContextWindow;
      if(!resumedFromExtraction&&(configuredWindow===undefined||!withExtractionContext))return input;
      const settings=modelSettings.select('memory',input.modelProfileId).settings;
      if(settings.protocol!=='codex-app-server')return input;
      const capacity=nativeRequestCapacity(settings,input.modelOverride);
      if(!capacity)return input;
      // The request owns this budget. The native gate intersects it with its
      // actual catalog and still reserves the full model output ceiling.
      const modelBudget:QueryInput['modelBudget']=configuredWindow===undefined?input.modelBudget:{
        contextWindow:Math.min(configuredWindow,settings.contextWindow??configuredWindow,input.modelBudget?.contextWindow??configuredWindow),
        maxTokens:capacity.maxOutputTokens,historyRatio:0,lowWatermarkRatio:0.5,tokenCounting:'estimated',contextWindowSource:'configured',
      };
      if(withExtractionContext){
        const candidate=modelBudget?{...withExtractionContext,modelBudget}:withExtractionContext;
        const reviewCapacity=nativeCapacityForRequest(candidate);
        if(reviewCapacity&&memoryRequestUsage(candidate,memories.readEvidence(candidate.evidenceIds??[]),reviewCapacity).fits)return candidate;
      }
      return resumedFromExtraction&&modelBudget?{...input,modelBudget}:input;
    },
    authorizeDeletionEvidence:(input,ids)=>memoryPhasePipeline.pipeline.inputs.assertDeletion(ids,input.modelProfileId),
    snapshot:(input,result)=>{
      const ids=input.evidenceReadRanges?[...new Set([...(input.evidenceIds??[]),...memoryReadRanges(result,input.evidenceRanges??[],input.evidenceReadRanges).map(range=>range.id)])]:input.evidenceIds??[];
      if(ids.some(id=>!memories.isCurrentEvidence(id)))throw new StoreError('Memory evidence changed during review',409);
      // Include full original metadata (speaker, source, device, dates, version),
      // not just quote text. Credentials/config are hashed, never retained.
      return sha256(JSON.stringify([modelSettings.select('memory',input.modelProfileId).settings,memories.readEvidence(ids)]));
    }},ownerQuestions,materials,
    scheduling:{automatic:lifecycleRuntime.automatic,drain:async()=>{await sourcePipelines.drainMemory(memoryPipeline,agent.configured);await memoryPipeline.tickInputs();}}});
  memoryPhasePipeline.prepare();memoryPhasePipeline.start();
  resources.defer(()=>memoryPhasePipeline.close());
  const memoryPipeline=memoryPhasePipeline.pipeline,reviewExtraction=memoryPhasePipeline.review;
  memoryRecipeSettings.onChange=()=>materialMemoryWork.inputs.revokeDisabled();
  memoryRecipeSettings.onApplied=()=>materialMemoryWork.reconcile(memoryPipeline);
  materialMemoryWork.reconcile(memoryPipeline);
  const memoryLifecycleService=createMemoryLifecycleService({
    store,configService,executor,semanticContextTime:dependencies.semanticContextTime,configured:()=>agent.configured,conversations,
    files,memories,pipeline:memoryPipeline,integrationSettings:memoryStrategySettings.integration,
    semanticArtifacts:lifecycleRuntime.semanticArtifacts,providerCooldownCheck:lifecycleRuntime.providerCooldownCheck,
    insights:lifecycleRuntime.insights,insightTimeout:lifecycleRuntime.insightTimeout,query:lifecycleRuntime.query,
    model:()=>modelSettings.select('memory').settings.model,extensions:lifecycleRuntime.replacements,
    automatic:lifecycleRuntime.automatic,whenReady:lifecycleRuntime.whenReady,
  });
  memoryLifecycleService.prepare();memoryLifecycleService.start();
  resources.defer(()=>memoryLifecycleService.close());
  const lifecycle=memoryLifecycleService.lifecycle,working=memoryLifecycleService.working;
  memoryBindingControl.start();
  const memoryControl=memoryBindingControl.control;
  const memoryIntegrationSettings=memoryStrategySettings.integration;
  const memoryTopicsService=createMemoryTopicsService({store,memories,executor,control:modelAuthorization,host:modelAuthorizationHost,contextTrees,reader:evidenceReader,canPublish:dependencies.topicsCanPublish,
    assertReadable:cards=>evidenceReader.assertMemoryReadable(cards),select:(profileId,model)=>{const selected=modelSettings.select('memory',profileId),settings={...selected.settings,...(model?{model}:{})};return {profileId:selected.id,model:settings.model,connection:agentModelConnection({kind:'profile',id:selected.id},settings)};},query});
  resources.defer(()=>memoryTopicsService.close());
  memoryTopicsService.prepare();
  const memoryTopics=memoryTopicsService.host;
  topics.current=memoryTopicsService.topics;
  memoryTopicsService.start();
  contributeDomainRoutes(backendContext,{'mote.memory':Object.freeze({
    mount:(app:FastifyInstance)=>{
      memoryStrategySettings.routes(app);
      memoryPhasePipeline.routes(app,{
        lifecycle:()=>memoryLifecycleService.lifecycle,
        store,files,evidenceReader,memories,
        retryTopics:operationId=>memoryTopics.retry(operationId),
        modelSettings,
        modelAuthorizationHost,
        availableModelConnections,
      });
      memoryPublicationPlatform.routes(app,{
        pipeline:()=>memoryPhasePipeline.pipeline,
        files,evidenceReader,memories,
        modelSettings,
        query:input=>queryAgent(input,'query','memories'),
        reviewExtraction:(input,result,strategy,draftOrigin)=>memoryPhasePipeline.review(input,result,strategy,draftOrigin),
        modelAuthorizationHost,
        availableModelConnections,
      });
      registerMemoryAssociationRoutes(app,assistantCommitments,request=>{assertRequestActive(request);if(credential(request))throw new StoreError('Owner access required',403);});
    },
  })});
  return Object.freeze({memoryBindings,memoryBindingControl,memoryAdapters,memoryProviderAdapters,memoryPublication,memoryPipeline,memoryPhasePipeline,reviewExtraction,lifecycle,working,memoryControl,memoryIntegrationSettings,memoryStrategySettings,memoryTopics,memoryTopicsService,memoryLifecycleService,memoryPublicationService:memoryPublicationPlatform});
}
