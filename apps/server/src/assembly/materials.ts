import {randomUUID} from 'node:crypto';
import type {AsyncLocalStorage} from 'node:async_hooks';
import type {Context} from '@deepseek-ai/cordis';
import type {QueryInput} from '@mote/agent';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import type {Config} from '../config.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {Store} from '../store.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {UsageLedger} from '../usage.js';
import type {FileStore} from '../files.js';
import type {FileEvidence} from '../file-evidence.js';
import type {SourceStore} from '../sources.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {MemoryRecipeSettings} from '../memory-recipe-settings.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {MaterialStore} from '../materials.js';
import {MaterialMemoryWork} from '../material-memory-work.js';
import {MaterialOrganizerRuntime} from '../material-organizers.js';
import {createEvidenceContextReader} from '../plugins/evidence-context-reader.js';
import {centralServices,type CommitAuthorization} from '../plugins/central-contracts.js';
import {createMaterialRepository,createMaterialRepositoryFactory,materialRepositoryContribution,materialRepositoryDeclaration,materialRepositoryReplacement,type MaterialRepositoryBindings} from '../plugins/material-repository.js';
import {createMaterialRetrievalIndex,materialRetrievalIndexContribution,materialRetrievalIndexDeclaration,materialRetrievalIndexReplacement} from '../plugins/material-retrieval-index.js';

export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:materialRepositoryContribution,declaration:materialRepositoryDeclaration,replacement:materialRepositoryReplacement},
  {contribution:materialRetrievalIndexContribution,declaration:materialRetrievalIndexDeclaration,replacement:materialRetrievalIndexReplacement},
]);

export interface MaterialInputDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Store;
  readonly authorization:CommitAuthorization;
  readonly resources:ServerResources;
  readonly memoryRecipeSettings:MemoryRecipeSettings;
  /** New-input admission reads the live Memory binding: the trusted root
   * re-evaluates it on every call instead of pinning a startup snapshot. */
  readonly newInputAdmission:()=>boolean;
}

/** Install the repository owner, then lend its actual store to the remaining
 * trusted consumers through the host's leased port. */
export async function prepareMaterials(dependencies:MaterialInputDependencies){
  const platform=createMaterialRepository(dependencies.store,dependencies.authorization);
  let bindings:MaterialRepositoryBindings|undefined;
  const handle=await dependencies.bootstrap.host.install({
    identity:{host:dependencies.bootstrap.snapshot().host,packageId:'mote.material-repository',installationId:'build:material-repository@1.0.0',instanceId:'materials',activationId:randomUUID()},
    contributions:[materialRepositoryDeclaration],factory:createMaterialRepositoryFactory(platform,value=>{bindings=value;}),
  });
  dependencies.resources.defer(()=>handle.close('shutdown'));
  const lease=await dependencies.bootstrap.host.acquire(centralServices.materialRepository,bindings!.repository);
  dependencies.resources.defer(()=>lease.release());
  const materials=lease.value as MaterialStore;
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

/** Retrieval index, material organizers and the shared evidence-context
 * reader — the materials read tail the sources domain feeds — plus their close
 * hooks. The retrieval-index domain plugin owns the Indexer, the bound
 * material index runtime and the shared engine's embedding/index timer. */
export function assembleMaterials(dependencies:MaterialsAssemblyDependencies){
  const {store,config,diagnostics,executor,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost,materials,materialMemoryWork,backendContext,resources,sources,sourcePipelines,files,fileEvidence}=dependencies;
  const retrievalIndex=createMaterialRetrievalIndex({store,config,diagnostics,executor,usageLedger,modelContext,modelAuthorization,modelAuthorizationHost,files,materials});
  resources.defer(()=>retrievalIndex.close());
  retrievalIndex.prepare();retrievalIndex.start();
  const indexer=retrievalIndex.retrievalIndex;
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
