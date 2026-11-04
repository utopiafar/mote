import {randomUUID} from 'node:crypto';
import type {Store} from '../store.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {FileStore} from '../files.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {ServerResources} from '../server-resources.js';
import type {bootstrapCentral,CentralDomainPlugin} from '../bootstrap.js';
import type {AuthorizationPlatform} from '../plugins/authorization-platform.js';
import type {ExecutionPlatform} from '../plugins/execution-platform.js';
import type {FeatureServices} from '../feature-services.js';
import {SourceStore} from '../sources.js';
import {fileAttachmentAvailable} from '../file-attachments.js';
import {MaterialNoteDeletion} from '../material-note-deletion.js';
import {closeSourcePlatforms} from '../platform-close-order.js';
import {registerFileRoutes} from '../file-routes.js';
import {createSourceRuntime,createSourceRuntimeFactory,sourceRuntimeContribution,sourceRuntimeDeclaration,sourceRuntimeReplacement} from '../plugins/source-runtime.js';
import {createFilesSource,filesSourceContribution,filesSourceDeclaration,filesSourceReplacement} from '../plugins/files-source.js';
import {createCaptureIntake,captureIntakeContribution,captureIntakeDeclaration,captureIntakeReplacement} from '../plugins/capture-intake.js';
import {createNotesSource,notesSourceContribution,notesSourceDeclaration,notesSourceReplacement} from '../plugins/notes-source.js';
import {c10IntegrationContribution,c10IntegrationDeclaration,c10IntegrationReplacement} from '../plugins/c10-integration.js';
import {devicesSourceContribution,devicesSourceDeclaration,devicesSourceReplacement} from '../plugins/devices-source.js';

/** Declared build-time domain plugins the sources assembly wires; the
 * distribution concatenates each domain's list into one selected table. */
export const plugins:readonly CentralDomainPlugin[]=Object.freeze([
  {contribution:sourceRuntimeContribution,declaration:sourceRuntimeDeclaration,replacement:sourceRuntimeReplacement},
  {contribution:filesSourceContribution,declaration:filesSourceDeclaration,replacement:filesSourceReplacement},
  {contribution:captureIntakeContribution,declaration:captureIntakeDeclaration,replacement:captureIntakeReplacement},
  {contribution:c10IntegrationContribution,declaration:c10IntegrationDeclaration,replacement:c10IntegrationReplacement},
  {contribution:notesSourceContribution,declaration:notesSourceDeclaration,replacement:notesSourceReplacement},
  {contribution:devicesSourceContribution,declaration:devicesSourceDeclaration,replacement:devicesSourceReplacement},
]);

export interface SourcesAssemblyDependencies {
  readonly bootstrap:Awaited<ReturnType<typeof bootstrapCentral>>;
  readonly store:Store;
  readonly materials:MaterialStore;
  readonly materialMemoryWork:MaterialMemoryWork;
  readonly executionPlatform:ExecutionPlatform;
  readonly authorizationPlatform:AuthorizationPlatform;
  readonly diagnostics:Pick<ServerDiagnostics,'measure'>;
  readonly resources:ServerResources;
}

/** SourceRuntime, SourceStore, Files, Capture and Notes construction plus the
 * source-facing platform close order app.ts previously held inline. */
export async function assembleSources(dependencies:SourcesAssemblyDependencies){
  const {bootstrap,store,materials,materialMemoryWork,executionPlatform,authorizationPlatform,diagnostics,resources}=dependencies;
  const sourceRuntime=createSourceRuntime({},{store,materials,execution:executionPlatform,memoryWork:materialMemoryWork});
  const sourceRuntimeOwner=await bootstrap.host.install({identity:{packageId:'mote.source-runtime',installationId:'build:source-runtime@1.0.0',instanceId:'source-runtime',activationId:randomUUID(),host:bootstrap.snapshot().host},
    contributions:[sourceRuntimeDeclaration],factory:createSourceRuntimeFactory(sourceRuntime)});
  resources.defer(()=>sourceRuntimeOwner.close('disabled'));
  const sourcePipelines=sourceRuntime.runtimeForAssembly;
  const sources=new SourceStore(store,sourcePipelines);
  let filesForAccess:FileStore|undefined;
  const filesPlatform=createFilesSource({store,sources,archivedFiles:bootstrap.vault.archivedFiles,registerRoutes:registerFileRoutes,rawAccess:{
    mayReadFileVersion:(_sourceId,id)=>{try{const current=filesForAccess;if(!current)return false;const version=current.version(id);return Boolean(version.object_hash&&store.evidence([id]).length&&fileAttachmentAvailable(store,id)&&!store.db.prepare('SELECT deleted FROM source_heads WHERE source_id=? AND external_id=?').get(version.source_id,version.external_id)?.deleted);}catch{return false;}},
    mayReadArchivedFile:()=>false,mayListSourceFiles:()=>false,mayListArchivedFiles:()=>false,
  }});
  resources.defer(()=>filesPlatform.close());
  await filesPlatform.prepare();filesPlatform.start();
  const filesAssembly=filesPlatform.assemblyForRoutes(),files=filesAssembly.files,fileEvidence=filesAssembly.evidence,fileRawReader=filesAssembly.originalRead;
  filesForAccess=files;
  const captureIntake=createCaptureIntake({diagnostics},{store,sources,files,materials});
  resources.defer(()=>captureIntake.close());
  await captureIntake.prepare();
  await authorizationPlatform.bindRepositories({sources,files,materials,ingress:captureIntake.ingress,memoryInputs:materialMemoryWork.inputs,memoryWork:materialMemoryWork});
  await authorizationPlatform.start();
  captureIntake.bindAuthorization(authorizationPlatform);captureIntake.start();
  const ingress=captureIntake.ingress,modelAuthorizationHost=authorizationPlatform.assembly.modelAuthorizationHost!;
  resources.beforeClose(()=>closeSourcePlatforms({authorization:authorizationPlatform,capture:captureIntake,files:filesPlatform,source:sourceRuntime,execution:executionPlatform}));
  const notesSource=createNotesSource({page:args=>store.list({...args,source:'note'}),attribution:record=>materials.contextForEvidence(record),evidence:ids=>store.evidence(ids),deleteNote:id=>store.delete(id),noteDeletion:new MaterialNoteDeletion(store,materials)});
  await notesSource.prepare();notesSource.start();resources.defer(()=>notesSource.close());
  materialMemoryWork.inputs.onOriginalInput=(input,automatic)=>modelAuthorizationHost.source(input,automatic);
  // sourceRuntime, capture and files slices.
  const featureServices=Object.freeze({
    sourcePipelines,sources,ingress,notesSource:notesSource.assemblyForRoutes(),files,fileEvidence,
    filesSource:{playback:filesAssembly.playback},
  }) satisfies Partial<FeatureServices>;
  return Object.freeze({sourceRuntime,sourcePipelines,sources,filesPlatform,files,fileEvidence,fileRawReader,captureIntake,ingress,notesSource,modelAuthorizationHost,featureServices});
}
