import type {AgentOptions,QueryInput} from '@mote/agent';
import {skillCatalog} from '@mote/agent';
import type {CentralDomainPlugin} from '../bootstrap.js';
import type {QueryResult} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {StoreError,type Store} from '../store.js';
import type {ConfigService} from '../config-service.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {PluginCenter} from '../plugin-center.js';
import type {ModelSettingsStore} from '../model-settings.js';
import type {ReloadableAgent} from '../model-agent.js';
import type {BackgroundModelAuthorization,ModelConnection} from '../background-model-authorization.js';
import {agentModelConnection,type ModelAuthorizationHost} from '../model-authorization-host.js';
import type {ExecutionSettings} from '../execution-settings.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ContextTreeRegistry} from '../context-trees.js';
import {memoryEvidenceFingerprint,type MemoryStore} from '../memory.js';
import type {Conversations} from '../conversations.js';
import {EvidenceExposurePolicy} from '../evidence-exposure.js';
import {memoryIntegrationImageInputs} from '../memory-image-grants.js';
import {MemoryStrategies} from '../memory-strategies.js';
import {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {MemoryAutomation} from '../memory-automation.js';
import {createMemoryAutomationAdmission,memoryAutomationAdmissionContribution,memoryAutomationAdmissionDeclaration,memoryAutomationAdmissionReplacement} from '../plugins/memory-automation-admission.js';
import {MemoryIntegrationSettings} from '../memory-integration-settings.js';
import {MemoryBindings} from '../memory-bindings.js';
import {MemoryAdapters} from '../memory-adapters.js';
import {MemoryPublication} from '../memory-publication.js';
import {MemoryPipeline,type MemoryModelSelection,type MemoryPhasePorts} from '../memory-pipeline.js';
import {MemoryReviewCache} from '../memory-review-cache.js';
import {WorkingMemory} from '../working-memory.js';
import {MemoryTopicsHost} from '../memory-topics-host.js';
import {createMemoryControl} from '../memory-control.js';
import {projectMemoryLifecycleSettings,storedMemoryLifecycleSettings,MemoryLifecycle,type LifecycleSettings} from '../memory-lifecycle.js';
import type {CentralDomainPlugin} from '../bootstrap.js';
import {memoryRecordRepositoryContribution,memoryRecordRepositoryDeclaration,memoryRecordRepositoryReplacement} from '../plugins/memory-record-repository.js';

/** Declared build-time domain plugins the memory assembly wires; the
 * distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:memoryRecordRepositoryContribution,declaration:memoryRecordRepositoryDeclaration,replacement:memoryRecordRepositoryReplacement},
]);

/** C21C's trusted build registration. Its host installation lands with K04;
 * this descriptor keeps the default distribution's ownership inventory exact. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:memoryAutomationAdmissionContribution,declaration:memoryAutomationAdmissionDeclaration,replacement:memoryAutomationAdmissionReplacement},
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

/** Memory strategies, recipe settings and automation inputs other domains
 * consume during their own assembly, plus the slots for objects earlier
 * callbacks reference before they exist: bindings and topics are filled by
 * the runtime stage, and integrationSettings is filled there too because its
 * constructor reads the `memory_events` table that `MemoryLifecycle` creates.
 * Installed callbacks dereference the slots at call time. */
export function memoryInputs(dependencies:MemoryInputStageDependencies){
  const {store,configService}=dependencies;
  projectMemoryLifecycleSettings(store,configService.current<LifecycleSettings>('memory'));
  const memoryStrategies=new MemoryStrategies(),memoryRecipeSettings=new MemoryRecipeSettings(store,memoryStrategies);
  // MemoryAutomation is only constructed inside the C21C plugin factory. The
  // borrowed Store has no independent disposal here; the vault owns it.
  const automationAdmission=createMemoryAutomationAdmission(store);
  automationAdmission.prepare();automationAdmission.start();
  const memoryAutomation=automationAdmission.automationForAssembly;
  return Object.freeze({memoryStrategies,memoryRecipeSettings,memoryAutomation,automationAdmission,
    bindings:lateBinding<MemoryBindings>(),topics:lateBinding<MemoryTopicsHost>(),integrationSettings:lateBinding<MemoryIntegrationSettings>()});
}

export interface MemoryRuntimeDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly configService:ConfigService;
  readonly diagnostics:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly usageLedger:UsageLedger;
  readonly memories:MemoryStore;
  readonly conversations:Conversations;
  readonly materials:MaterialStore;
  readonly materialMemoryWork:MaterialMemoryWork;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly evidenceReader:EvidenceReader;
  readonly contextTrees:ContextTreeRegistry;
  readonly memoryStrategies:MemoryStrategies;
  readonly memoryRecipeSettings:MemoryRecipeSettings;
  readonly memoryAutomation:MemoryAutomation;
  readonly pluginCenter:PluginCenter;
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly modelSettings:ModelSettingsStore;
  readonly agent:ReloadableAgent;
  readonly runtimeSettings:ExecutionSettings;
  readonly codex:{executable?:string;home?:string};
  readonly instancesDirectory:string;
  readonly runModelFor:(settings:ModelSettings,connection?:ModelConnection)=>NonNullable<AgentOptions['runModel']>;
  readonly memoryConfiguration:NonNullable<MemoryModelSelection['configuration']>;
  readonly semanticContextTime?:()=>string;
  /** Slots minted by the inputs stage; this stage assigns their current object. */
  readonly bindings:LateBinding<MemoryBindings>;
  readonly topics:LateBinding<MemoryTopicsHost>;
  readonly integrationSettings:LateBinding<MemoryIntegrationSettings>;
  /** Publishes catalog changes only during the active lifecycle. */
  readonly topicsCanPublish:()=>boolean;
  readonly review:NonNullable<MemoryPhasePorts['review']>;
  readonly understand:NonNullable<MemoryPhasePorts['understand']>;
  readonly query:(input:QueryInput)=>Promise<QueryResult>;
  readonly withQueryModelAuthority:<T>(input:QueryInput,moduleId:string,task:(signal:AbortSignal)=>Promise<T>)=>Promise<T>;
  readonly assertModelEvidence:(input:QueryInput|undefined)=>void;
}

/** Bindings, provider adapters, publication, pipeline, lifecycle, control and
 * the automatic topics host — the Memory runtime app.ts previously wired
 * inline. Memory objects keep their relative defer/beforeClose order. */
export function memoryRuntime(dependencies:MemoryRuntimeDependencies){
  const {store,resources,configService,diagnostics,executor,usageLedger,memories,conversations,materials,materialMemoryWork,sourcePipelines,evidenceReader,contextTrees,memoryStrategies,memoryRecipeSettings,memoryAutomation,pluginCenter,modelAuthorization,modelAuthorizationHost,modelSettings,agent,runtimeSettings,codex,instancesDirectory,runModelFor,memoryConfiguration,bindings,topics,review,understand,query,withQueryModelAuthority,assertModelEvidence}=dependencies;
  const memoryBindings=bindings.current=new MemoryBindings(store,memories,memoryAutomation,pluginCenter,executor);
  // Its disposer is registered by app.ts at the original shutdown slot.
  evidenceReader.memoryBindings=memoryBindings;
  const hindsightMeters=new Map<string,ReturnType<UsageLedger['start']>>();
  const hindsightAuthorities=new Map<string,(settings:ModelSettings)=>void>();
  const memoryAdapters=new MemoryAdapters(instancesDirectory,pluginCenter,modelSettings,{codex,runModelFor,
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
  const memoryReviews=new MemoryReviewCache();resources.defer(()=>memoryReviews.clear());
  const memoryPublication=new MemoryPublication(store,memories,memoryBindings,executor);
  resources.defer(()=>memoryPublication.close());
  memoryPublication.revokeEvidence=ids=>memoryAdapters.erasePreparedEvidence(ids);
  const memoryPipeline=new MemoryPipeline({onPublished:(step,items,job)=>topics.current?.enqueue(step,items,job.configuration?.profileId??job.modelProfileId,job.configuration?.model??job.modelOverride),assertIntegrationAuthority:()=>modelAuthorization.assertCurrent(),withIntegrationAuthority:(id,manual,evidenceIds,task)=>manual?modelAuthorization.run('owner-integration:'+id,task):modelAuthorizationHost.automatic('automatic-integration:'+id,'integration',modelAuthorizationHost.evidenceTriggers(evidenceIds),task),integrationReadInput:cards=>memoryIntegrationImageInputs(store,materials,cards.flatMap(card=>card.evidence)),assertIntegrationReadable:cards=>evidenceReader.assertMemoryReadable(cards),publication:memoryPublication,assertNewManualWork:()=>memoryBindings.assertNewManualWork(),nativeStages:{settle:async context=>{if(!context.provider)throw new StoreError('Native Memory cleanup has no pinned provider configuration',503);await memoryAdapters.discardPrepared({...context.provider,opId:context.opId,phase:context.phase});},prepare:async(input,context)=>withQueryModelAuthority(input,'memories',async signal=>{input={...input,signal};const binding=memoryBindings.binding();if(memoryBindings.view().mode!=='engine')return;const namespace=binding.namespace!;context.provider={instanceId:namespace.instanceId,namespace,configurationIdentity:memoryAdapters.configurationIdentity(namespace.instanceId,namespace)};input.signal?.throwIfAborted();const originals=memories.readEvidence(context.evidenceIds);if(originals.length!==new Set(context.evidenceIds).size)throw new StoreError('Engine originals are unavailable',409);const evidence=input.evidenceRanges?.map(range=>{const record=originals.find(record=>record.id===range.id);if(!record)throw new StoreError('Engine original range is unavailable',409);return {record,offset:range.offset,length:range.length};})??originals;
    const engineProfile=pluginCenter.instanceView(namespace.instanceId).configuration.modelProfileId;if(typeof engineProfile!=='string')throw new StoreError('Native Memory model profile is missing',409);
    const engineConnection=agentModelConnection({kind:'profile',id:engineProfile},modelSettings.select('memory',engineProfile).settings),assertAuthority=modelAuthorization.capture(engineConnection);
    const bindingIdentity=JSON.stringify(binding),pins=new Map(originals.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
    const assert=()=>{assertAuthority();input.signal?.throwIfAborted();context.assertAuthority?.();assertModelEvidence(input);if(JSON.stringify(memoryBindings.binding())!==bindingIdentity)throw new StoreError('Native Memory binding changed',409);for(const [id,fingerprint] of pins){const current=memories.readEvidence([id])[0];if(!current||!memories.isCurrentEvidence(id)||memoryEvidenceFingerprint(current)!==fingerprint||!evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()))throw new StoreError('Native Memory originals were changed or revoked',409);}};
    assert();const transportAssert=(settings:import('@mote/shared/models').ModelSettings)=>{if(agentModelConnection({kind:'profile',id:engineProfile},settings).fingerprint!==engineConnection.fingerprint)throw new StoreError('Native Memory model snapshot changed',409);assert();};hindsightAuthorities.set(context.opId,transportAssert);
    try{const result=await memoryAdapters.engine(namespace.instanceId,namespace).prepare({namespace,opId:context.opId,phase:context.phase,evidence,relatedMemories:context.relatedMemories,signal:input.signal});assert();input.onEvidence?.(originals);if(context.relatedMemories?.length)input.onMemoryBodies?.(context.relatedMemories);return result;}finally{if(hindsightAuthorities.get(context.opId)===transportAssert)hindsightAuthorities.delete(context.opId);}})},batchCharacters:()=>storedMemoryLifecycleSettings(store).batchCharacters,strategies:memoryStrategies,executor,store,memories,concurrency:()=>runtimeSettings.execution().memoryConcurrency,requireAdmission:true,admission:{materialSourceCurrent:(pin,id)=>evidenceReader.materialSourceCurrent(pin,id),materialPlanAllowed:id=>evidenceReader.materialPlanAllowed(id,new EvidenceExposurePolicy()),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:ref=>materialMemoryWork.sourceRequirements(ref),automaticAllowed:job=>materialMemoryWork.authorized(job)&&[...(job.automaticGrants??[]),...(job.automaticGrant?[job.automaticGrant]:[])].every(grant=>sourcePipelines.memoryAllowed(grant.sourceId)),deletionEvidenceAllowedForMemory:id=>evidenceReader.deletionContextAllowed(id,new EvidenceExposurePolicy()),materialAllowedForMemory:(ref,profileId,required)=>evidenceReader.materialAllowedForMemory(ref,new EvidenceExposurePolicy(),required)},models:{configuration:memoryConfiguration,model:id=>modelSettings.select('memory',id).settings.model,configured:id=>{try{return agent.configuredFor(modelSettings.select('memory',id).id);}catch{return false;}}},phases:{understand,onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,attempt:event.attempt,runId:event.runId,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),review,query,skillVersion:`memory-extraction@${skillCatalog().find(s=>s.id==='memory-extraction')!.version}`}});
  resources.defer(()=>memoryPipeline.close());
  memoryRecipeSettings.onChange=()=>materialMemoryWork.inputs.revokeDisabled();
  memoryRecipeSettings.onApplied=()=>materialMemoryWork.reconcile(memoryPipeline);
  materialMemoryWork.reconcile(memoryPipeline);
  const lifecycle=new MemoryLifecycle(store,()=>agent.configured,Date.now,executor,dependencies.semanticContextTime,configService);
  resources.defer(()=>lifecycle.close());
  const working=new WorkingMemory(store,conversations);
  lifecycle.automaticAdmission=id=>!['extraction','consolidation'].includes(id)||memoryBindings.accepting();
  memoryBindings.onReleased=()=>lifecycle.skipAutomaticBacklog();
  pluginCenter.admissionChanged=(id,enabled)=>{if(memoryBindings.binding().namespace?.instanceId===id){if(enabled)lifecycle.skipAutomaticBacklog();memoryAutomation.touch();}};
  const memoryControl=createMemoryControl({store,pipeline:memoryPipeline,lifecycle,executor,publication:memoryPublication});
  memoryBindings.pendingTail=memoryControl.pendingTail;
  memoryAutomation.onResume=memoryControl.resume;
  memoryAutomation.onStop=memoryControl.stop;
  memoryAutomation.counts=memoryControl.counts;
  const memoryIntegrationSettings=dependencies.integrationSettings.current=new MemoryIntegrationSettings(store,memoryStrategies);
  const memoryTopics=topics.current=new MemoryTopicsHost({store,memories,executor,control:modelAuthorization,host:modelAuthorizationHost,topics:contextTrees.initializeAutomatic(store,evidenceReader,dependencies.topicsCanPublish),assertReadable:cards=>evidenceReader.assertMemoryReadable(cards),select:(profileId,model)=>{const selected=modelSettings.select('memory',profileId),settings={...selected.settings,...(model?{model}:{})};return {profileId:selected.id,model:settings.model,connection:agentModelConnection({kind:'profile',id:selected.id},settings)};},query});
  return Object.freeze({memoryBindings,memoryAdapters,memoryReviews,memoryPublication,memoryPipeline,lifecycle,working,memoryControl,memoryIntegrationSettings,memoryTopics});
}
