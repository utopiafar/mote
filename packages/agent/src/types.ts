import type {CaptureInput,SourceDocument,fileEvidenceSchema} from '@mote/shared';
import type {MoteSkillId} from './skills.js';
import type {ModelProtocol} from '@mote/shared/models';
export interface ContextRecord {
  id: string;
  capturedAt: string;
  appName: string;
  ocrText: string;
  summary?: string;
  deviceId?: string;
  sourceType?: string;
  durationMs?: number;
  [field: string]: unknown;
}

export interface ContextRange {
  after?: string;
  before?: string;
  deviceId?: string;
  limit?: number;
  cursor?: string;
  source?: CaptureInput['source'];
  appId?: string;
  collection?: 'content' | 'activity';
}

export interface ContextPage {
  items: ContextRecord[];
  nextCursor: string | null;
  /** Total records in the time/device scope, independent of the page cursor. */
  totalCount?: number;
}

export interface MediaContextRange extends ContextRange {
  appVisibility?: 'foreground' | 'background' | 'unknown';
  screenLocked?: boolean;
  playbackType?: 'local' | 'remote' | 'unknown';
}

export interface ContextReader {
  segments?(args:ContextRange & {id?:string;query?:string}):Promise<{items:{members:string[];[key:string]:unknown}[];nextCursor:string|null;[key:string]:unknown}>;
  readImage?(args:{id:string}):Promise<{mimeType:string;data:string}>;
  search(args: ContextRange & { query?: string }): Promise<ContextRecord[]>;
  timeline(args: ContextRange): Promise<ContextRecord[] | ContextPage>;
  evidence(args: { ids: string[] }): Promise<ContextRecord[]>;
  activity(args: ContextRange): Promise<unknown>;
  mediaActivity?(args: MediaContextRange): Promise<unknown>;
  devices(): Promise<unknown>;
  readFileEvidence?(args:ContextRange & {id:string;offset:number;length:number}):Promise<{status:string;record?:ContextRecord;reason?:string}>;
  fileChunks?(args:ContextRange & {id:string;offset?:number}):Promise<ContextRecord[]>;
  sourceHistory?(args:ContextRange & {id:string}): Promise<ContextRecord[]>;
  sources?(args:ContextRange): Promise<unknown>;
  sourceItems?(args:ContextRange & {sourceId?:string;kind?:string;includeDeleted?:boolean}): Promise<ContextRecord[]|ContextPage>;
  memories?(args:ContextRange & {id?:string;query?:string;tier?:'episode'|'consolidated';layer?:'observation'|'memory'|'legacy';kind?:'episodic'|'semantic'|'procedural'}): Promise<{items:unknown[];nextCursor?:string|null;evidence?:ContextRecord[]}>;
}

export interface AgentOptions {
  /** Host-wide admission for model runs; Codex turns include their internal tool loop. */
  runModel?: <T>(task:()=>Promise<T>,signal?:AbortSignal)=>Promise<T>;
  reader: ContextReader;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  protocol?: ModelProtocol;
  provider?: string;
  /** Server-owned launch configuration, never accepted from profile or query APIs. */
  codex?: {executable?:string;home?:string};
  /** Custom request headers and JSON parameters are secrets, not diagnostics. */
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Explicit opt-in for a local endpoint that does not need a credential. */
  allowUnauthenticatedLocal?: boolean;
  /** Maximum time for one provider/model request. Null means no provider request deadline. */
  requestTimeoutMs?: number | null;
  /** Maximum time for the complete Agent run. Null disables the host deadline. */
  agentTimeoutMs?: number | null;
  /** @deprecated Use requestTimeoutMs and agentTimeoutMs. Kept for third-party callers during migration. */
  timeoutMs?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  reasoningEffort?: "auto" | "off" | "low" | "high" | "max";
}

export interface QueryInput {
  /** Pure host validation before the session closes. Return only trusted repair guidance; never commit output here. */
  validateOutput?: (answer: AgentAnswer) => Promise<{code:string;feedback:string}|undefined> | {code:string;feedback:string}|undefined;
  language?: "zh-CN" | "en";
  /** Host-selected saved connection; never interpreted as prompt content. */
  modelProfileId?: string;
  modelOverride?: string;
  signal?: AbortSignal;
  /** Host-only observation, never serialized into model prompts or tool arguments. */
  onProgress?: (event: AgentProgress) => void;
  /** Host-only detailed execution trace. The host must explicitly opt in before persisting it. */
  onTrace?: (event: AgentTraceEvent) => void;
  /** Host-only correlation data for logs; never serialized into model prompts or tool arguments. */
  traceContext?: AgentTraceContext;
  onUsage?: (usage: import('@mote/shared').TokenUsage) => void;
  question: string;
  /** Bounded host-owned input for background tasks, separate from the user question. */
  taskContext?: {untrustedMemoryDraft?:unknown;previousSummary?:string;turns: {turnId:string;[key:string]:unknown}[]};
  responseMode?: 'answer'|'personal-insight'|'memory-extraction'|'calendar-extraction';
  /** Host-selected procedure, never selected from captured text. */
  skill?: Exclude<MoteSkillId,'document-import'>;
  /** A bounded extraction session may read only these original evidence ranges. */
  evidenceIds?: string[];
  /** Host snapshot for paginated change disclosure; does not restrict historical retrieval. */
  incrementalEvidenceIds?:string[];
  evidenceRanges?: {id:string;offset:number;length:number}[];
  after?: string;
  before?: string;
  deviceId?: string;
  timeZone?: string;
  /** Server-owned dialogue context. Earlier model prose is not original evidence. */
  conversation?: {
    turns: {question:string;answer:string;scope:{after?:string;before?:string;deviceId?:string;timeZone?:string};createdAt:string;answerTruncated?:boolean;evidenceDeleted?:boolean}[];
    omittedTurns:number;
    workingMemory?:{text:string;coveredTurns:number;generatedAt:string};
  };
}
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
export function reportProgress(input: QueryInput, event: AgentProgress): void {
  try { input.onProgress?.(event); } catch { /* Observation cannot change evidence permissions or fail a query. */ }
}
export function reportTrace(input: QueryInput, event: AgentTraceEvent): void {
  try { input.onTrace?.({at: new Date().toISOString(), ...event}); } catch { /* Trace sinks cannot change model execution. */ }
}
export interface Citation {
  id: string;
  capturedAt: string;
  appName: string;
  excerpt: string;
  contentAt?:string;
  fileEvidence?:ReturnType<typeof fileEvidenceSchema.parse>;
  provenance?:{sourceId?:string;externalId?:string;revision?:string;layer?:string;document?:SourceDocument};
}
export interface ToolTrace {
  tool: string;
  arguments: Record<string, unknown>;
  count: number;
}
export interface AgentAnswer {
  contextUsage?:{unit:'utf16_characters';system:number;tools:number;question:number;conversation:number;task:number;evidence:number;prompt:number;outputTokenReserve:number;toolResults:number};
  answer: string;
  citations: Citation[];
  trace: ToolTrace[];
  runId: string;
}

export class AgentNotConfiguredError extends Error {
  readonly statusCode = 503;
  constructor() {
    super(
      "Configure an agent model and its API credential before asking Mote.",
    );
    this.name = "AgentNotConfiguredError";
  }
}

export type AgentResponseReason = 'invalid_response' | 'invalid_json' | 'invalid_shape' | 'response_too_large' | 'unretrieved_citation' | 'truncated_citation' | 'undeclared_citation' | 'output_limit' | 'tools_unverified' | 'host_validation';
export class AgentResponseError extends Error {
  readonly statusCode = 502;
  constructor(message: string, readonly reason: AgentResponseReason = 'invalid_response') {
    super(message);
    this.name = "AgentResponseError";
  }
}

export class AgentConfigurationError extends Error {
  readonly statusCode = 400;
  constructor(message = 'Invalid model connection settings.') {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

export class AgentProviderError extends Error {
  readonly statusCode = 502;
  constructor() {
    super('The model request failed. Check the endpoint, API credential, model and protocol settings.');
    this.name = 'AgentProviderError';
  }
}

/** A locally observed deadline or a typed SDK request timeout; not a diagnosis of its cause. */
export class AgentTimeoutError extends Error {
  readonly statusCode = 504;
  constructor() {
    super("The agent request timed out. Please retry or narrow the question.");
    this.name = "AgentTimeoutError";
  }
}

/** Runs before closing the model conversation, so a rejected output can be repaired in place. */
export async function validateHostOutput(input:QueryInput, answer:AgentAnswer):Promise<void> {
  const issue=await input.validateOutput?.(answer);
  if(issue){reportTrace(input,{type:'validation.host_rejected',runId:answer.runId,stage:'validating',status:'rejected',payload:{code:issue.code,feedback:issue.feedback}});throw new AgentResponseError(`${issue.code}: ${issue.feedback}`,'host_validation');}
}
