import type {ContextRange,ContextRecord} from './context-contracts.js';
import type {AgentAnswer} from './types.js';

/** The request and host-prepared context presented to a query. */
export interface QueryRequest {
  language?: import('@mote/shared/i18n').Locale;
  question: string;
  /** Bounded host-owned input for background tasks, separate from the user question. */
  taskContext?: {imageEvidence?:unknown;queryWorkspace?:unknown;delegation?:unknown;memoryWork?:unknown;ownerClarificationReply?:unknown;untrustedMemoryDraft?:unknown;untrustedInterpretations?:string;previousSummary?:string;turns: {turnId:string;[key:string]:unknown}[]};
  responseMode?: 'answer'|'personal-insight'|'memory-extraction'|'calendar-extraction';
  /** Host-selected procedure, never selected from captured text. */
  skill?: string;
  /** User-selected starting originals for an open query; never an authorization grant. */
  anchorEvidenceIds?: string[];
  /** Owner-selected pinned Material entrypoint. It grants no additional reads. */
  anchorMaterialRef?: string;
  /** Host-reported archive-wide coverage, not a guarantee for the selected window. */
  memoryCoverage?:{scope:'archive';pendingBatches:number;failedBatches:number;lastSavedAt:string|null};
  /** Small host-selected derived leads, never citation evidence or an owner-identity grant. */
  openingMemories?:{id:string;title:string;statement:string;uncertainty:string;status:'published'|'proposed';tier:'episode'|'consolidated';createdAt:string;admission?:{scope:string;attribution:'user'|'third_party'|'observed'|'inferred'};validFrom?:string;validUntil?:string}[];
  after?: string;
  before?: string;
  deviceId?: string;
  timeZone?: string;
  /** Server-owned dialogue context. Earlier model prose is not original evidence. */
  conversation?: {
    /** Host-only immutable dialogue snapshot and original permission roots. */
    historyContext?:NonNullable<QueryInput['historyContext']>;
    evidenceDependencies?:import('@mote/shared').EvidenceDependencies;
    sourceContextDependencies?:{sourceId:string;version:number;fingerprint:string}[];
    turns: {question:string;answer:string;scope:{after?:string;before?:string;deviceId?:string;timeZone?:string};createdAt:string;answerTruncated?:boolean;evidenceDeleted?:boolean;evidenceStale?:boolean;contextStale?:boolean;attachments?:{id:string;name:string;mimeType:string}[]}[];
    omittedTurns:number;
    workingMemory?:{text:string;coveredTurns:number;generatedAt:string};
  };
}

/** Host-selected execution identity and admission context. */
export interface QueryExecutionContext {
  /** Internal adapter selection for the trusted benchmark arm. */
  hostContextToolMode?:'all-native'|'catalog';
  /** Host-only exact runtime tool surface for one bounded task (for example an
   * image pass that only needs read_image). Unknown names are ignored and no
   * catalog or control tool is implied. Never parsed from model input. */
  hostToolSelection?:readonly string[];
  /** Host-local task contributions and exact selection; never parsed from model or query text. */
  taskRegistry?:import('./tasks/registry.js').TaskRegistry;
  taskSelection?:import('./tasks/descriptor.js').TaskSelection;
  /** Immutable host manifest receipts for a durable query, never read grants. */
  contextCapabilitySnapshot?:readonly {name:string;version:string;fingerprint:string}[];
  /** Revalidate the task's frozen input at each model admission and send. */
  assertContextAuthority?:()=>void;
  /** Host-owned temporal snapshot for a durable task; retries use the same clock. */
  contextTime?:string;
  executionLane?:'interactive'|'background';
  /** Host-selected saved connection; never interpreted as prompt content. */
  modelProfileId?: string;
  modelOverride?: string;
  signal?: AbortSignal;
  /** Host-only correlation data for logs; never serialized into model prompts or tool arguments. */
  traceContext?: AgentTraceContext;
}

/** Host-only tool and original-read authority. Captured prose cannot create these fields. */
export interface QueryGrants {
  /** Explicit host-only mutation authority, separate from archive retrieval. */
  hostControlChannel?:import('./host-controls.js').HostControlChannel;
  /** Host-only metadata planning sessions can disable every archive read. */
  hostRetrieval?:'none';
  /** Host-only pinned tool contributions; never accepted from query HTTP input. */
  toolContributions?:readonly import('./tools/official-read-packs.js').ReadPackRegistration[];
  /** Host-verified originals deliberately attached to this dialogue. Bytes remain in the vault. */
  directImages?:{id:string;name:string;mimeType:string;hash:string;sizeBytes:number}[];
  /** Host-only lineage of derived context already included in taskContext. Used
   * solely for disclosure authorization/revocation; never evidence seeds or tools. */
  derivedContextEvidenceIds?:readonly string[];
  /** Host-only original lineage for opening cards or derived task context. Never
   * grants original reads or appears in the model context envelope. */
  contextSourceContextDependencies?:{sourceId:string;version:number;fingerprint:string}[];
  contextEvidenceDependencies?:import('@mote/shared').EvidenceDependencies;
  /** Host-only bounded observation and coverage snapshot for one insight version. */
  insightSnapshot?: import('@mote/shared').InsightSnapshot;
  /** Host-only read grant for original action proposals. No mutation capability is exposed. */
  actionCatalog?: (args:ContextRange & {id?:string;query?:string})=>Promise<{items:unknown[];nextCursor:string|null}>;
  /** Initially supplied original IDs for a bounded extraction session. */
  evidenceIds?: string[];
  /** Host-only immutable evidence fingerprints for a bounded background read. */
  processingEvidence?: Record<string,string>;
  /** Host-only named material outputs for a bounded background read. */
  processingMaterialInputs?: {materialId:string;required:string[];fingerprint:string;evidenceIds:string[]}[];
  /** Host-only current archive image availability; never an authorization grant. */
  archiveImagesEnabled?: boolean;
  /** Exact original-image grants attached to current named Material outputs.
   * They authorize no raw capture text or archive discovery. */
  processingImages?: readonly {id:string;materialId:string;required:string[];fingerprint:string;originalSha256:string}[];
  /** Host snapshot for paginated change disclosure; does not restrict historical retrieval. */
  incrementalEvidenceIds?:string[];
  evidenceRanges?: {id:string;offset:number;length:number}[];
  /** Host-only additional original read grant. These exact ranges are a catalog,
   * not delivered evidence or extraction targets. No archive discovery is added. */
  evidenceReadRanges?: readonly {id:string;offset:number;length:number}[];
  /** Host-only dialogue snapshot for compaction; never an original-read grant. */
  historyContext?:{conversationId:string;revision:number;turns:{id:string;runId:string}[];evidenceDependencies:import('@mote/shared').EvidenceDependencies};
  /** Host-only original selection retained after ordinary deletion. Fresh
   * evidenceIds remain the exact readable subset; an empty subset denies reads. */
  historicalSelection?:{evidenceIds?:string[];anchorEvidenceIds?:string[]};
}

/** Host callbacks; observation never grants model authority. */
export interface QueryHooks {
  onContextCapabilities?:(snapshot:readonly {name:string;version:string;fingerprint:string}[])=>void;
  /** Host-local receipts of exactly delivered original ranges; never model output. */
  onEvidence?: (records:readonly ContextRecord[])=>void;
  /** Host-only body disclosure receipt, emitted after actual tool serialization.
   * Metadata/navigation and saved quote locators do not count as body delivery. */
  onMemoryBodies?:(cards:readonly {id:string;version?:number;fingerprint:string}[])=>void;
  /** Host receipt of source metadata actually disclosed, including fragments that yield. */
  onSourceContextDependencies?:(pins:readonly import('@mote/shared').SourceContextDeclaration[])=>void;
  /** Pure host validation before the session closes. Return only trusted repair guidance; never commit output here.
   * `requiresToolUse` marks a rejection that cannot be repaired by rewriting the answer alone: the model must call
   * the required read-only tool (for example read_image) again before returning the product. */
  validateOutput?: (answer: AgentAnswer) => Promise<{code:string;feedback:string;requiresToolUse?:boolean}|undefined> | {code:string;feedback:string;requiresToolUse?:boolean}|undefined;
  /** Host-only live fact for repair prompts. While true, even an output-limit repair must allow the read-only
   * tool call that is still required (for example an image whose pixels were never inspected). */
  repairRequiresToolUse?: () => boolean;
  /** Host-only observation, never serialized into model prompts or tool arguments. */
  onProgress?: (event: AgentProgress) => void;
  /** Host-only detailed execution trace. The host must explicitly opt in before persisting it. */
  onTrace?: (event: AgentTraceEvent) => void;
  onUsage?: (usage: import('@mote/shared').TokenUsage) => void;
  /** Local trusted observation of the authoritative Host identity/attempt envelope.
   * Never model input or a wire field. Observer errors are isolated: execution
   * guards and terminal ownership must not depend on throwing from this hook. */
  onHostRunEvent?: (event: import('./host/run-contracts.js').HostRunEvent) => void;
}

/** Flat host API retained for existing adapters; its authority is never parsed from model text. */
export interface QueryInput extends QueryRequest,QueryExecutionContext,QueryGrants,QueryHooks {}

export interface AgentProgress {
  stage: 'starting' | 'model' | 'tool' | 'validating';
  /** Deliberately authored public status, never raw reasoning deltas. */
  message?: string;
  phase?: 'started' | 'completed';
  step?: number;
  tool?: string;
  count?: number;
}
export interface AgentTraceContext {
  operationId?: string;
  traceId?: string;
  requestId?: string;
  jobId?: string;
  batchId?: string;
  batchIndex?: number;
  attempt?: number;
  phase?: string;
  operation?: string;
  moduleId?: string;
  profileId?: string;
  provider?: string;
  protocol?: string;
  model?: string;
}
export interface AgentTraceEvent {
  type: string;
  at?: string;
  runId?: string;
  stage?: AgentProgress['stage'];
  phase?: AgentProgress['phase'] | string;
  step?: number;
  tool?: string;
  durationMs?: number;
  status?: string;
  /** Detailed data is intentionally opaque to the model and only emitted through the host trace sink. */
  payload?: unknown;
}
