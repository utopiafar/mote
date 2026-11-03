import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {Context} from '@deepseek-ai/cordis';
import type {QueryInput} from '@mote/agent';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import {sha256,type Store} from '../store.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {FileStore} from '../files.js';
import type {FileEvidence} from '../file-evidence.js';
import type {SourceStore} from '../sources.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import {modelConnection} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import {MaterialStore} from '../materials.js';
import {MaterialMemoryWork} from '../material-memory-work.js';
import {Indexer} from '../indexer.js';
import {MaterialOrganizerRuntime} from '../material-organizers.js';
import {createEvidenceContextReader} from '../plugins/evidence-context-reader.js';

export interface MaterialInputDependencies {
  readonly store:Store;
  readonly resources:ServerResources;
  readonly memoryRecipeSettings:MemoryRecipeSettings;
  /** New-input admission reads the live Memory binding: the trusted root
   * re-evaluates it on every call instead of pinning a startup snapshot. */
  readonly newInputAdmission:()=>boolean;
}

/** MaterialStore and the Memory-work admission inputs the sources domain
 * consumes; close order still follows acquisition order at the root. */
export function prepareMaterials(dependencies:MaterialInputDependencies){
  const materials=new MaterialStore(dependencies.store);
  dependencies.resources.defer(()=>materials.index?.close());
  const materialMemoryWork=new MaterialMemoryWork(dependencies.store,materials,Date.now,()=>true,dependencies.memoryRecipeSettings,dependencies.newInputAdmission);
  return Object.freeze({materials,materialMemoryWork});
}

export interface MaterialsAssemblyDependencies {
  readonly store:Store;
  readonly config:Pick<Config,'embeddingModel'|'embeddingBaseUrl'|'embeddingApiKey'>;
  readonly diagnostics:ServerDiagnostics;
  readonly executor:ExecutionEngine;
  readonly usageLedger:UsageLedger;
  readonly modelContext:AsyncLocalStorage<QueryInput>;
  readonly modelAuthorization:BackgroundModelAuthorization;
  readonly modelAuthorizationHost:ModelAuthorizationHost;
  readonly materials:MaterialStore;
  readonly materialMemoryWork:MaterialMemoryWork;
  readonly backendContext:Context;
  readonly resources:ServerResources;
  readonly sources:SourceStore;
  readonly sourcePipelines:SourcePipelineRuntime;
  readonly files:FileStore;
  readonly fileEvidence:FileEvidence;
  /** The root owns the catalog-publish latch; shutdown must turn it off before
   * the readers below are disposed. */
  readonly disableCatalogChanges:()=>void;
}

/** Indexer, material organizers and the shared evidence-context reader — the
 * materials read tail the sources domain feeds — plus their close hooks. */
export function assembleMaterials(dependencies:MaterialsAssemblyDependencies){
  const {store,config,diagnostics,executor,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost,materials,materialMemoryWork,backendContext,resources,sources,sourcePipelines,files,fileEvidence}=dependencies;
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
  // One EvidenceReader and one context registry own every read surface. The
  // factory borrows the roots repositories; it never constructs a second
  // Store/Source/File/Material/Indexer or a second reader.
  const sourceContexts=sources.contexts;
  const evidenceContext=createEvidenceContextReader({store,sources,files,indexer,fileEvidence,materials,sourcePipelines,
    sourceItemRecipes:materialOrganizer.sourceItemRecipes,materialMemoryReady:ref=>materialMemoryWork.readyForMemory(ref),sourceContexts});
  resources.defer(()=>evidenceContext.dispose());
  const contextTrees=evidenceContext.assembly.contextTrees,evidenceReader=evidenceContext.assembly.reader;
  resources.beforeClose(()=>dependencies.disableCatalogChanges());
  backendContext.provide('moteContextTrees',contextTrees);
  return Object.freeze({indexer,materialOrganizer,evidenceContext,contextTrees,evidenceReader,sourceContexts});
}
