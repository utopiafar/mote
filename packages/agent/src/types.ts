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
  language?: "zh-CN" | "en";
  /** Host-selected saved connection; never interpreted as prompt content. */
  modelProfileId?: string;
  modelOverride?: string;
  signal?: AbortSignal;
  /** Host-only observation, never serialized into model prompts or tool arguments. */
  onProgress?: (event: AgentProgress) => void;
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
export function reportProgress(input: QueryInput, event: AgentProgress): void {
  try { input.onProgress?.(event); } catch { /* Observation cannot change evidence permissions or fail a query. */ }
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

export type AgentResponseReason = 'invalid_response' | 'invalid_json' | 'invalid_shape' | 'response_too_large' | 'unretrieved_citation' | 'truncated_citation' | 'undeclared_citation' | 'output_limit' | 'tools_unverified';
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
