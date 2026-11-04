import {
  serviceContract, serviceRefSchema, serviceBindingSchema, contributionIdentitySchema,
  type ServiceRef, type ServiceBinding, type ContributionIdentity, type PluginErrorCode,
  type ReplacementPolicy,
} from '@mote/plugin-api/contracts';
import type {CaptureInput} from '@mote/shared';
import type {CaptureRead, CaptureContextRead, MaterialRead, MemoryRead, MemoryReadSnapshots, MemoryInputSelection, MemoryRecordRead, MemoryRecordSnapshots} from '../evidence-read-ports.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {ContextQuery} from '../context-query.js';
import type {ContextTreeRegistry} from '../context-trees.js';
import type {registerEvidenceRoutes} from '../evidence-routes.js';
import type {IngressService} from '../ingress.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialIndexRuntime} from '../material-index.js';
import type {Indexer} from '../indexer.js';
import type {SourceStore} from '../sources.js';
import type {SourcePipelineRuntime} from '../source-pipelines.js';
import type {ExecutionEngine} from '../execution-engine.js';
import type {BackgroundModelAuthorization} from '../background-model-authorization.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {FileRawReader} from '../file-raw-reader.js';
import type {UsageLedger} from '../usage.js';
import type {PluginCenter} from '../plugin-center.js';
import type {ProcessingRuntime} from '../processing-runtime.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {MediaAssets} from '../media-assets.js';
import type {MemoryStagePublication, MemoryOwnerPublication} from '../memory-publication-contract.js';

/** Central-local capabilities. These handles/callbacks are never serialized to Web/Kotlin.
 * C02-C27 implement their providers; H owns loading, selection and lifecycle. This file
 * neither constructs current services nor registers a second host or Manifest. */

declare const commitAuthorityBrand: unique symbol;
/** An opaque C04-issued reference, never a constructor, callback, serialized grant or proof
 * of permission. Its private brand prevents accidental structural substitution only. */
export interface CommitAuthority { readonly [commitAuthorityBrand]: true }
/** Trusted assembly fixes this C04 service in each writer; consumers cannot supply or
 * select a verifier/issuer with a write call. C04 owns issuance/provenance storage.
 * No issuer registry or runtime authorization implementation is introduced by C01. */
export interface CommitAuthorization {
  /** Capture the already admitted request/job's domain grant, never a caller validator. */
  capture(): CommitAuthority;
  /** Synchronously reject unknown, forged, cross-issuer and invalidated references and
   * revalidate the admitted domain grant/fence in trusted context. Writers must also keep
   * resource/action/owner checks against the actual write input in that same transaction;
   * reference validity is not their substitute. Never invoke a consumer-carried validator. */
  assertCurrent(authority: CommitAuthority): void;
}

/** C02 owns SQLite/locks. Repository implementations close over their private SQL;
 * callers receive typed repositories separately, never a database argument or service bag.
 * The writer checks authority via its fixed C04 CommitAuthorization, not a method on
 * the handle. No asynchronous work may run between that domain/fence check and commit. */
export interface VaultTransactions {
  transaction<T>(authority: CommitAuthority, work: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T;
}
export type ArchivedContentRead = Pick<ArchivedFileStore, 'get' | 'read' | 'listForCapture'>;
/** Exact originals, browsing, navigation and tree reads remain independently grantable.
 * The inventory projection contains only the actual ContextQuery's archive/source summaries
 * and latest-Memory timestamp callback, not their underlying repositories or database. */
export type CaptureImageRead = Parameters<typeof registerEvidenceRoutes>[1]['store'];
export type ContextNavigationRead = Pick<EvidenceReader, 'segments' | 'catalogAsync'>;
export type ContextInventoryRead = ConstructorParameters<typeof ContextQuery>[2];
export type ContextTreesRead = Pick<ContextTreeRegistry, 'catalog' | 'page'>;

declare const requestAuthorityBrand: unique symbol;
/** C04-issued request reference. The host rejects disallowed routes before dispatch;
 * source content cannot mint a reference and a callback is never its verifier. */
export interface RequestAuthority extends CommitAuthority { readonly [requestAuthorityBrand]: true }
export interface RequestAuthorization {
  authenticate(authorization: string | undefined): RequestAuthority | undefined;
  assertCurrent(authority: RequestAuthority): void;
  assertCapture(authority: RequestAuthority, input: CaptureInput): void;
  assertOwnSource(authority: RequestAuthority, sourceId: string): void;
  assertOwnDevice(authority: RequestAuthority, input: {deviceId: string}): void;
  /** Existing collector platform identity check; this does not admit a write. */
  assertOwnPlatform(authority: RequestAuthority, platform: unknown): void;
}
export type ModelAuthority = Pick<BackgroundModelAuthorization, 'capture' | 'assertCurrent' | 'run'>;
export type ModelAdmission = Pick<ModelAuthorizationHost, 'manual' | 'automatic' | 'assertEvidence' | 'evidenceTriggers'>;

/** The returned v2 receipt means recoverable intake, not processing/Material/Memory readiness.
 * Preserve RecordContext binding in the same transaction as the capture and final C04
 * domain/fence verification. A consumer callback or consumer-selected issuer is not used. */
export interface CaptureIntake {
  capture(input: CaptureInput, authority: CommitAuthority): ReturnType<IngressService['capture']>;
  captureSettled(inputs: CaptureInput[], authority: CommitAuthority): ReturnType<IngressService['captureSettled']>;
}
export interface SourceIntake {
  sourceItem(sourceId: string, input: Parameters<IngressService['sourceItem']>[1], authority: CommitAuthority): ReturnType<IngressService['sourceItem']>;
  sourceBatch(sourceId: string, input: Parameters<IngressService['sourceBatch']>[1], authority: CommitAuthority): ReturnType<IngressService['sourceBatch']>;
}
export type SourceRepository = Pick<SourceStore, 'register' | 'getSource' | 'listSources' | 'getItem' | 'listItems' | 'history'>;
export type SourceBindings = Pick<SourcePipelineRuntime, 'options' | 'configure' | 'memoryAllowed'>;

export type MaterialRepositoryRead = Pick<MaterialStore, 'get' | 'read' | 'members' | 'input' | 'isCurrentEvidence' | 'contextForEvidence'>;
/** C19C retrieval/index surface: hybrid search status and reads plus the
 * new-work submission points. Embedding construction and close stay with the
 * retrieval-index owner; consumers receive this port, never the engine. */
export type RetrievalIndex = Pick<Indexer, 'configured' | 'search' | 'tick' | 'retry'>;
/** Durable material FTS work: drain queued index requests or explicitly retry
 * a failed input. The owner binds the per-engine runtime on the MaterialStore. */
export type MaterialIndexWork = Pick<MaterialIndexRuntime, 'tick' | 'retry'>;
export interface MaterialPublication {
  /** The provider's fixed C04 verifier checks the grant/fence within atomic publication. */
  publish(draft: Parameters<MaterialStore['publish']>[0], options: Parameters<MaterialStore['publish']>[1], authority: CommitAuthority): ReturnType<MaterialStore['publish']>;
}
export type FileOriginalRead = Pick<FileRawReader, 'read'>;
export type ExecutionSubmission = Pick<ExecutionEngine, 'enqueue' | 'get' | 'drain'>;
/** Handler ownership is granted to providers, independently of ordinary enqueue consumers. */
export type ExecutionHandlers = Pick<ExecutionEngine, 'register'>;
/** C03 binds one domain and schema to the handle before acquisition. The provider validates
 * updates and returns detached values; callers cannot choose another domain or read secrets
 * from a global configuration document. Values remain local until a domain defines its DTO. */
export interface ConfigurationDomain<Value> {
  snapshot(): {revision: number; value: Value};
  update(value: Partial<Value>, expectedRevision: number): Promise<{revision: number; value: Value}>;
  subscribe(listener: (snapshot: {revision: number; value: Value}) => void): () => void;
}
export type UsageRecording = Pick<UsageLedger, 'start' | 'operation'>;
export type PluginControlRead = Pick<PluginCenter, 'view' | 'instanceView'>;
export type ProcessingSubmission = Pick<ProcessingRuntime, 'enqueue' | 'view' | 'retry' | 'cancel'>;
export type MaterialMemoryCandidates = Pick<MaterialMemoryWork, 'observe' | 'withdraw' | 'planningInput' | 'sourceRequirements' | 'authorized'>;
/** Read-only managed-asset state. Installs, imports, cancellation and the
 * managed directory itself stay with the C18A owner, never the port. */
export type MediaAssetsRead = Pick<MediaAssets, 'ready' | 'status' | 'statuses'>;

/** Separate tokens deliberately keep owner mutation, model disclosure and retained-reader
 * lifetimes out of each other's read capability. Actual grant/cleanup behavior is not here. */
export const centralServices = {
  vault: serviceContract<VaultTransactions>('mote.central.vault-transactions', '1'),
  contentRead: serviceContract<ArchivedContentRead>('mote.central.archived-content-read', '1'),
  requestAuthorization: serviceContract<RequestAuthorization>('mote.central.request-authorization', '1'),
  commitAuthorization: serviceContract<CommitAuthorization>('mote.central.commit-authorization', '1'),
  modelAuthority: serviceContract<ModelAuthority>('mote.central.model-authority', '1'),
  modelAdmission: serviceContract<ModelAdmission>('mote.central.model-admission', '1'),
  captureIntake: serviceContract<CaptureIntake>('mote.central.capture-intake', '1'),
  sourceIntake: serviceContract<SourceIntake>('mote.central.source-intake', '1'),
  sources: serviceContract<SourceRepository>('mote.central.source-repository', '1'),
  sourceBindings: serviceContract<SourceBindings>('mote.central.source-bindings', '1'),
  captureRead: serviceContract<CaptureRead>('mote.central.capture-read', '1'),
  captureImageRead: serviceContract<CaptureImageRead>('mote.central.capture-image-read', '1'),
  captureContextRead: serviceContract<CaptureContextRead>('mote.central.capture-context-read', '1'),
  contextNavigationRead: serviceContract<ContextNavigationRead>('mote.central.context-navigation-read', '1'),
  contextInventoryRead: serviceContract<ContextInventoryRead>('mote.central.context-inventory-read', '1'),
  contextTreesRead: serviceContract<ContextTreesRead>('mote.central.context-trees-read', '1'),
  materialRepository: serviceContract<MaterialRepositoryRead>('mote.central.material-repository-read', '1'),
  materialPublication: serviceContract<MaterialPublication>('mote.central.material-publication', '1'),
  materialRead: serviceContract<MaterialRead>('mote.central.material-read', '1'),
  retrievalIndex: serviceContract<RetrievalIndex>('mote.central.retrieval-index', '1'),
  materialIndex: serviceContract<MaterialIndexWork>('mote.central.material-index', '1'),
  fileOriginalRead: serviceContract<FileOriginalRead>('mote.central.file-original-read', '1'),
  execution: serviceContract<ExecutionSubmission>('mote.central.execution-submission', '1'),
  executionHandlers: serviceContract<ExecutionHandlers>('mote.central.execution-handlers', '1'),
  configuration: serviceContract<ConfigurationDomain<unknown>>('mote.central.configuration-domain', '1'),
  usage: serviceContract<UsageRecording>('mote.central.usage-recording', '1'),
  pluginControlRead: serviceContract<PluginControlRead>('mote.central.plugin-control-read', '1'),
  processing: serviceContract<ProcessingSubmission>('mote.central.processing-submission', '1'),
  memoryCandidates: serviceContract<MaterialMemoryCandidates>('mote.central.material-memory-candidates', '1'),
  memoryRead: serviceContract<MemoryRead>('mote.central.memory-read', '1'),
  memorySnapshots: serviceContract<MemoryReadSnapshots>('mote.central.memory-read-snapshots', '1'),
  memoryRecords: serviceContract<MemoryRecordRead>('mote.central.memory-record-read', '1'),
  memoryRecordSnapshots: serviceContract<MemoryRecordSnapshots>('mote.central.memory-record-snapshots', '1'),
  memoryInputSelection: serviceContract<MemoryInputSelection>('mote.central.memory-input-selection', '1'),
  memoryStagePublication: serviceContract<MemoryStagePublication>('mote.central.memory-stage-publication', '1'),
  memoryOwnerPublication: serviceContract<MemoryOwnerPublication>('mote.central.memory-owner-publication', '1'),
  mediaAssetsRead: serviceContract<MediaAssetsRead>('mote.central.media-assets-read', '1'),
} as const;
export type CentralService = keyof typeof centralServices;

/** Ownership/consumer audit input, not an installable package descriptor. H03 owns Manifest;
 * each domain factory owns creation, scheduling, handlers and disposal of its listed objects.
 * H05 replaces the corresponding app.ts construction/close sites as each slice arrives. */
export interface CentralMigrationSlice {
  readonly task: string;
  readonly factory: string;
  readonly replacement: ReplacementPolicy;
  readonly legacy: readonly string[];
  readonly objects: readonly string[];
  readonly consumers: readonly string[];
}
export const centralMigrationSlices = {
  vault: {task:'C02', factory:'vault-platform', replacement:'restart', legacy:['store','archivedFiles','contentStorage','maintenanceWorker'], objects:['Store/DB/locks','ArchivedFileStore','ContentStorageService','MaintenanceWorker/retention'], consumers:['C10','C11','C19','C21','C24']},
  configuration: {task:'C03', factory:'configuration-platform', replacement:'restart', legacy:['configService','runtimeSettings','modelSettings','config'], objects:['ConfigService/validator/domain handlers/watchers','ExecutionSettings','ModelSettingsStore'], consumers:['C05','C17','C18','C21','AGENT']},
  authorization: {task:'C04', factory:'authorization-platform', replacement:'restart', legacy:['connections','connectionIdentity','credential','assertRequestActive','sourceOwner','modelAuthorization','modelAuthorizationHost','availableModelConnections'], objects:['Connections/LoginHandoffs','BackgroundModelAuthorization','ModelAuthorizationHost/evidence authority','request identities/grant fences','opaque commit references/fixed issuer verification'], consumers:['C02','C10','C11','C12','C19','C22','C25','C27','HOST']},
  execution: {task:'C05', factory:'execution-platform', replacement:'restart', legacy:['executor','providerAdmission','agentGate','llmGate','interactiveGate','interactiveModelGate'], objects:['ExecutionEngine','ProviderAdmission','four ConcurrencyGate lanes','scoped handler registrations'], consumers:['C09','C17','C19','C22','C24','C25','C27','AGENT']},
  observability: {task:'C06', factory:'observability-platform', replacement:'restart', legacy:['diagnostics','usageLedger','eventLoop','diagnosticSnapshot','softwareUpdate','serverVersion','webVersion'], objects:['ServerDiagnostics/writer','executionObserver','UsageLedger/admittedUsage','eventLoop monitor','update service'], consumers:['C05','C17','C22','C26','C27','HOST','AGENT']},
  control: {task:'C07/C08', factory:'plugin-control', replacement:'hot', legacy:['pluginCenter'], objects:['PluginCenter','WorkerPluginRuntime','durable commands/references','control HTTP/snapshot projection'], consumers:['C21','C23','C24','C25','WEB','HOST']},
  sourceRuntime: {task:'C09', factory:'source-runtime', replacement:'hot', legacy:['sourcePipelines'], objects:['SourcePipelineRuntime','recipe registry/epoch','source_pipeline_bindings','checkpoint/product-consumer registrations'], consumers:['C10','C12','C17','C19','C21','C22']},
  capture: {task:'C10/C10A/C10B/C10C', factory:'capture-sources', replacement:'hot', legacy:['sources','ingress','parseCaptureBundle','notesSource','notesCapture'], objects:['SourceStore','IngressService/RecordContext','capture/notes/devices routes','capture timeline/cache/first-data','source context routes'], consumers:['C11','C12','C19D','WEB','MAC','ANDROID']},
  files: {task:'C11', factory:'files-source', replacement:'hot', legacy:['files','fileEvidence','setPlaybackAuthorization','filesSource'], objects:['FileStore/FileEvidence','FileRawReader','upload sessions/sweep','playback grants'], consumers:['C10A','C17','C19D','C20','MAC','ANDROID']},
  connectors: {task:'C12/C13/C14/C15/C16', factory:'connector-host-adapter', replacement:'hot', legacy:['connectors'], objects:['ConnectorRegistry','six built-in connector factories','OAuth state/poll/CLI/session','recording binding/staging/retirement'], consumers:['C09','C19','AGENT','WEB','MAC','ANDROID']},
  processing: {task:'C17', factory:'processing-services', replacement:'hot', legacy:['processing','workflows','semanticSelection'], objects:['ProcessingRuntime','FileProcessing/settle','semantic/conversation processor contributions','recipe handlers'], consumers:['C18','C19','C20','C22','C25']},
  media: {task:'C18A/C18B/C18C', factory:'media-processing', replacement:'hot', legacy:['mediaAssets','mediaPreparation','perception','mediaRange','withMediaOwnerBatch','withMediaOwnerIntent'], objects:['MediaAssets','MediaPreparation/worker/config invalidation','ImageProcessing/recipes','media execution facts'], consumers:['C10A','C11','C17','C19','AGENT']},
  materials: {task:'C19A/C19B/C19C/C19D/C19E', factory:'material-context', replacement:'hot', legacy:['materials','materialOrganizer','materialMemoryWork','indexer','evidenceReader','contextTrees'], objects:['MaterialStore/revision publication','organizer/backlog','retrieval/vector index','unique EvidenceReader/SourceContextStore','MaterialMemoryWork/capture intake','context trees/library/raw projections'], consumers:['C09','C10B','C17','C20','C22','C26','C27','AGENT','WEB','MAC','ANDROID']},
  imports: {task:'C20', factory:'import-services', replacement:'hot', legacy:['imports','importTasks','launchImport','launchOwnerImport'], objects:['ImportStore','PythonSourcePackExecutor','importTasks/importAgents','queued restart/manifest/lease recovery'], consumers:['C11','C17','C19','AGENT','WEB']},
  memoryControl: {task:'C21A/C21B/C21C/C21D', factory:'memory-control-services', replacement:'hot', legacy:['memories','memoryBindings','memoryIntegrationSettings','memoryRecipeSettings'], objects:['Strategies/RecipeSettings','Automation/freeze','Bindings/retained readers/control'], consumers:['C19E','C22','C23','C24','C27']},
  memoryRecords: {task:'C21B', factory:'memory-record-repository', replacement:'hot', legacy:[], objects:['MemoryStore record storage','memory storage schema'], consumers:['C19E','C22','C23','C24','AGENT']},
  memoryRuntime: {task:'C22A/C22B/C22C', factory:'memory-lifecycle', replacement:'hot', legacy:['memoryPipeline','lifecycle','memoryDelegation','reviewExtraction','automaticMemoryScheduling'], objects:['MemoryPipeline/review cache','MemoryLifecycle/extensions/WorkingMemory','TopicsHost','owner continuation/questions/delegation'], consumers:['C19E','C21','C24','C26','AGENT']},
  memoryProviders: {task:'C23', factory:'memory-provider-adapters', replacement:'hot', legacy:[], objects:['MemoryAdapters/Mem0/Hindsight/workers','fixed namespace/config readers','Hindsight authority/usage maps','prepared stages/probes'], consumers:['C21D','C24','AGENT']},
  publication: {task:'C24', factory:'memory-publication', replacement:'hot', legacy:['memoryPublication'], objects:['MemoryPublication/poll','retirement/dependencies','submitted writes/erases/revocations/native cleanup references','EvidenceDeletion/export/provider backup'], consumers:['C10B','C19','C21D','C22','HOST']},
  actions: {task:'C25', factory:'actions-services', replacement:'hot', legacy:['actions'], objects:['Actions/handler','ActionCapabilities','ManagedCalendar/Todos','approval/grant/delivery/exact receipt'], consumers:['C26','AGENT','WEB','MAC','ANDROID']},
  activity: {task:'C26/C26A/C26B/C26C', factory:'insight-activity-services', replacement:'hot', legacy:['activity','automaticActivity','insight','insightRuns','insightRequestSchema','ownerQuestions'], objects:['ActivityProjection','AutomaticActivity/timer','InsightRuns/snapshots','OwnerQuestions','Agent view pagination'], consumers:['C22','AGENT','WEB','MAC','ANDROID']},
  query: {task:'C27', factory:'query-domain-services', replacement:'hot', legacy:['conversations','delegation','queryRuns','queryWithAttachmentsSchema','jobId'], objects:['Conversations/retention','DelegationRuntime','DelegatedQueryRuns','query preparation/snapshot/commit/direct images'], consumers:['C22','C26','AGENT','WEB','MAC','ANDROID']},
  agent: {task:'A01/A04/A08/A09/A10/A12/A14/A17', factory:'agent-contributions', replacement:'hot', legacy:['agent','agentFeatures','archiveReader','codex','queryAgent'], objects:['ReloadableAgent/runtime generations','Agent tool factories/reader adapter','model transport/admission callbacks','import Agent factory'], consumers:['C17','C19D','C20','C22','C26','C27']},
  host: {task:'H04/H05/H14', factory:'central-host', replacement:'restart', legacy:['isClosing'], objects:['Cordis/ServerResources/common host','Fastify/auth dispatch/static contribution','index.ts bootstrap/PID/runtime listener/signals'], consumers:['C02-C27','AGENT','WEB']},
} as const satisfies Record<string, CentralMigrationSlice>;
export type CentralSlice = keyof typeof centralMigrationSlices;

/** Connect feature -> consumed port -> provider factory/task without inferring a provider
 * from installation order. These are migration/consumption edges, not a startup DAG;
 * H05 derives prepare/start ordering from the actual H03 factory descriptors. */
export const centralServiceOwners = {
  vault:'vault', contentRead:'vault', requestAuthorization:'authorization', commitAuthorization:'authorization',
  modelAuthority:'authorization', modelAdmission:'authorization',
  captureIntake:'capture', sourceIntake:'capture', sources:'capture', sourceBindings:'sourceRuntime',
  captureRead:'materials', captureImageRead:'materials', captureContextRead:'materials',
  contextNavigationRead:'materials', contextInventoryRead:'materials', contextTreesRead:'materials',
  materialRepository:'materials', materialPublication:'materials', materialRead:'materials',
  retrievalIndex:'materials', materialIndex:'materials',
  fileOriginalRead:'files', execution:'execution', executionHandlers:'execution',
  configuration:'configuration', usage:'observability', pluginControlRead:'control', processing:'processing',
  memoryCandidates:'materials', memoryRead:'materials', memorySnapshots:'materials', memoryInputSelection:'materials',
  memoryRecords:'memoryRecords', memoryRecordSnapshots:'memoryRecords',
  memoryStagePublication:'publication', memoryOwnerPublication:'publication', mediaAssetsRead:'media',
} as const satisfies Record<CentralService, CentralSlice>;

export interface CentralFeatureMigration {
  readonly owners: readonly CentralSlice[];
  readonly requires: readonly CentralService[];
}
/** All current routes/features have replaceable target factories; multi-owner entries are
 * intentionally split (e.g. capture must not dispose media; storage must not own indexing).
 * The storage/capture/materials entries include the fixed C04 verifier prerequisite for
 * their Vault/intake/Material writer factory assembly. These audit requirements describe
 * availability, never capability grants: only trusted writer assembly acquires the verifier;
 * ordinary write-port consumers receive opaque references, not issuance/verification access. */
export const centralFeatureMigrations = {
  'mote.activity': {owners:['activity'], requires:['execution','materialRead']},
  'mote.files': {owners:['files'], requires:['vault','requestAuthorization','fileOriginalRead']},
  'mote.actions': {owners:['actions'], requires:['execution','requestAuthorization','modelAdmission','pluginControlRead']},
  'mote.connections': {owners:['authorization'], requires:['vault','sources']},
  'mote.system': {owners:['observability','host'], requires:['configuration','execution']},
  'mote.storage': {owners:['vault','files','materials','publication'], requires:['commitAuthorization','vault','contentRead']},
  'mote.capture': {owners:['capture'], requires:['commitAuthorization','requestAuthorization','captureIntake','captureRead']},
  'mote.context': {owners:['materials'], requires:['captureRead','captureImageRead','captureContextRead','contextNavigationRead','contextInventoryRead','contextTreesRead','memoryRead','memorySnapshots']},
  'mote.materials': {owners:['materials','publication'], requires:['commitAuthorization','vault','materialRepository','materialRead','requestAuthorization']},
  'mote.coding': {owners:['sourceRuntime','materials','agent'], requires:['sourceIntake','sourceBindings','materialPublication']},
  'mote.sources': {owners:['sourceRuntime','capture','connectors'], requires:['sources','sourceBindings','sourceIntake','requestAuthorization']},
  'mote.models': {owners:['configuration','authorization','agent'], requires:['configuration','modelAuthority']},
  'mote.processing': {owners:['processing','media','activity'], requires:['execution','executionHandlers','configuration','modelAuthority']},
  'mote.notes': {owners:['capture','materials'], requires:['captureIntake','captureRead','requestAuthorization']},
  'mote.devices': {owners:['capture'], requires:['vault','requestAuthorization']},
  'mote.media': {owners:['media'], requires:['configuration','modelAuthority','fileOriginalRead','mediaAssetsRead']},
  'mote.owner-questions': {owners:['activity','memoryRuntime'], requires:['vault','requestAuthorization']},
  'mote.memory': {owners:['memoryControl','memoryRuntime','memoryProviders','publication'], requires:['memoryCandidates','memoryRead','memorySnapshots','memoryInputSelection','memoryStagePublication','memoryOwnerPublication','modelAdmission']},
  'mote.imports': {owners:['imports','files','agent'], requires:['execution','sourceIntake','contentRead','requestAuthorization']},
  'mote.ask': {owners:['query','agent'], requires:['requestAuthorization','modelAdmission','captureRead','materialRead','memoryRead','memorySnapshots']},
  'mote.usage': {owners:['observability'], requires:['usage','requestAuthorization']},
  'mote.insights': {owners:['activity','agent'], requires:['execution','materialRead','modelAdmission']},
  'mote.diagnostics': {owners:['observability'], requires:['execution','requestAuthorization']},
  'mote.agent-view': {owners:['activity','agent'], requires:['materialRead','memoryRead']},
  'mote.features': {owners:['control','host'], requires:['pluginControlRead']},
} as const satisfies Record<string, CentralFeatureMigration>;

export interface CentralServiceDeclaration { readonly service: ServiceRef; readonly provider: ContributionIdentity }
export interface CentralServiceRequirement {
  readonly consumer: string;
  readonly service: ServiceRef;
  readonly binding?: ServiceBinding;
}
export interface CentralServiceIssue {
  readonly code: Extract<PluginErrorCode, 'conflict' | 'dependency_unavailable' | 'ambiguous_binding' | 'api_incompatible'>;
  readonly service: ServiceRef;
  readonly consumer?: string;
  readonly providers: readonly ContributionIdentity[];
}
const serviceKey = (service: ServiceRef) => JSON.stringify([service.id, service.apiVersion]);
const providerKey = (provider: ContributionIdentity) => {
  const {scope, contributionId} = provider;
  return JSON.stringify([scope.packageId,scope.installationId,scope.instanceId,scope.host.kind,scope.host.id,scope.activationId,contributionId]);
};

/** Pure preflight of the selected candidate's declarations, not a resolver: never acquire,
 * select by order/priority, construct a provider, or reinterpret a binding revision.
 * Distinct providers of one API are valid when the consumer supplies an exact binding.
 * H's runtime additionally checks availability, dependency graph, pin validity and revisions. */
export function checkCentralServiceDeclarations(declarations: readonly CentralServiceDeclaration[], requirements: readonly CentralServiceRequirement[]): CentralServiceIssue[] {
  const issues: CentralServiceIssue[] = [];
  const services = new Map<string, CentralServiceDeclaration[]>();
  for (const declaration of declarations) {
    const service = serviceRefSchema.parse(declaration.service);
    const provider = contributionIdentitySchema.parse(declaration.provider);
    const key = serviceKey(service), existing = services.get(key) ?? [];
    if (existing.some(item => providerKey(item.provider) === providerKey(provider))) {
      issues.push({code:'conflict', service, providers:[provider]});
    } else existing.push({service, provider});
    services.set(key, existing);
  }
  for (const requirement of requirements) {
    const service = serviceRefSchema.parse(requirement.service);
    const candidates = services.get(serviceKey(service)) ?? [];
    const failure = (code: CentralServiceIssue['code']) => issues.push({code, service, consumer:requirement.consumer, providers:candidates.map(item => item.provider)});
    if (requirement.binding) {
      const binding = serviceBindingSchema.parse(requirement.binding);
      if (serviceKey(binding.service) !== serviceKey(service)) { failure('api_incompatible'); continue; }
      const selected = providerKey(contributionIdentitySchema.parse(binding.provider));
      if (!candidates.some(item => providerKey(item.provider) === selected)) failure('dependency_unavailable');
    } else if (!candidates.length) {
      failure(declarations.some(item => item.service.id === service.id) ? 'api_incompatible' : 'dependency_unavailable');
    } else if (candidates.length > 1) failure('ambiguous_binding');
  }
  return issues;
}
