import {ProviderFailure,type ProviderFailureDetails,type FailureDiagnostics} from '@mote/shared';
import type {SourceDocument,fileEvidenceSchema} from '@mote/shared';
import type {ContextReader} from './context-contracts.js';
import type {QueryInput,AgentProgress,AgentTraceEvent} from './query-contracts.js';
export type * from './context-contracts.js';
export type * from './query-contracts.js';
import type {ModelProtocol,ModelReasoningEffort,CodexServiceTier} from '@mote/shared/models';
/** Local trusted control handoff for one query. Composites forward the same lease;
 * only the chosen leaf reports its finalizer, synchronously before execution. */
export interface QueryRunLease {
  onFinalizer?(mode: 'host'): void;
}

export interface AgentOptions {
  /** Trusted benchmark arm only; no profile, HTTP or product setting. */
  contextToolMode?:'all-native'|'catalog';
  /** Host-only evidence authorization before each outbound HTTP model attempt, including SDK turns/repairs. */
  authorizeModelRequest?: ()=>void|Promise<void>;
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
  maxToolCalls?: number;
  maxTokens?: number;
  /** Total model context window in tokens. Separate from maxTokens (output limit). */
  contextWindow?: number;
  reasoningEffort?: ModelReasoningEffort;
  serviceTier?: CodexServiceTier;
}

export function reportProgress(input: QueryInput, event: AgentProgress): void {
  try { input.onProgress?.(event); } catch { /* Observation cannot change evidence permissions or fail a query. */ }
}
export function reportTrace(input: Pick<QueryInput, 'onTrace'>, event: AgentTraceEvent): void {
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
  imageView?:import('@mote/shared').ImageViewTrace;
  /** Requested and delivered normal page lengths; no capacity fitting. */
  materialPage?:{requestedLength:number;returnedLength:number};
  /** A host context disclosure page never grants original citation authority. */
  attributionPage?:{contextFingerprint:string;offset:number;total:number;requestedLength:number;returnedLength:number};
  tool: string;
  arguments: Record<string, unknown>;
  count: number;
}
export interface AgentAnswer {
  /** Confirmed pixel deliveries from this session, never parsed from model JSON. */
  imageReadReceipts?: {id:string;imageView:import('@mote/shared').ImageView}[];
  /** Host-generated receipt of original ranges actually delivered in this run.
   * Populated before host validation, never parsed from model output. */
  evidenceReadRanges?: {id:string;offset:number;length:number}[];
  /** Fixed owner metadata versions disclosed by this run; never original citation grants. */
  sourceContextDependencies?:{sourceId:string;version:number;fingerprint:string}[];
  evidenceDependencies?:import('@mote/shared').EvidenceDependencies;
  contextUsage?:{unit:'utf16_characters';system:number;tools:number;question:number;conversation:number;task:number;evidence:number;prompt:number;outputTokenReserve:number;toolResults:number};
  /** A model-proposed goal only. The host binds identity, scope, revision and
   * capabilities and decides whether any command is available. */
  draftProposal?:import('@mote/shared').AssistantDraftProposal;
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

export type AgentResponseReason = 'invalid_response' | 'invalid_json' | 'invalid_shape' | 'response_too_large' | 'unretrieved_citation' | 'truncated_citation' | 'undeclared_citation' | 'output_limit' | 'tools_unverified' | 'host_validation' | 'tool_failure' | 'image_disclosure_disabled';
export class AgentResponseError extends Error {
  readonly statusCode = 502;
  constructor(message: string, readonly reason: AgentResponseReason = 'invalid_response', readonly requiresToolUse = false) {
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

/** A host request contract failure cannot be repaired by retrying a provider. */
export class AgentInputError extends ProviderFailure {
  constructor() {
    super({category:'permanent',code:'invalid_agent_input',executionStarted:false},'The agent question must contain non-whitespace text.');
    this.name = 'AgentInputError';
  }
}

export class AgentProviderError extends ProviderFailure {
  constructor(details:ProviderFailureDetails={category:'transient',code:'provider_failed'},diagnostic:FailureDiagnostics={source:'unknown'}) {
    super(details,details.code==='processing_limit'?'The model request exceeded a processing or context limit. Reduce the input or adjust the configured model window.':'The model request failed. Check the endpoint, API credential, model and protocol settings.',diagnostic);
    this.name = 'AgentProviderError';
  }
}

/** A locally observed deadline or a typed SDK request timeout; not a diagnosis of its cause. */
export class AgentTimeoutError extends Error {
  readonly statusCode = 504;
  constructor(readonly diagnostic:FailureDiagnostics={source:'runtime',code:'deadline_exceeded',stage:'model'}) {
    super("The agent request timed out. Please retry or narrow the question.");
    this.name = "AgentTimeoutError";
  }
}

/** Runs before closing the model conversation, so a rejected output can be repaired in place. */
export async function validateHostOutput(input:Pick<QueryInput, 'validateOutput' | 'onTrace'>, answer:AgentAnswer):Promise<void> {
  const issue=await input.validateOutput?.(answer);
  if(issue){reportTrace(input,{type:'validation.host_rejected',runId:answer.runId,stage:'validating',status:'rejected',payload:{code:issue.code,feedback:issue.feedback}});throw new AgentResponseError(`${issue.code}: ${issue.feedback}`,'host_validation',issue.requiresToolUse===true);}
}

/** Shared output-repair budget: initial result plus at most three corrections. */
export const MAX_OUTPUT_REPAIRS=3;
