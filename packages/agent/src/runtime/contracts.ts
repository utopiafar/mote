import type {Cancellation, ServiceBinding, ServiceContract, ServiceLease} from '@mote/plugin-api/contracts';
import type {ProviderFailureDetails, TokenUsage} from '@mote/shared';
import type {AgentProgress, AgentTraceEvent} from '../query-contracts.js';

export const RUNTIME_API_VERSION = '1';

/** Resolved by the Host, never decoded from a question, tool argument or HTTP query DTO. */
export interface ResolvedRuntimeProfile<Configuration = unknown> {
  readonly binding: ServiceBinding;
  readonly runtimeId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assemblyFingerprint: string;
  readonly taskKind: string;
  readonly configuration: Configuration;
}

export interface ModelSelection {
  readonly modelId: string;
  readonly modelRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly transport: string;
}

/** Local model/transport access may contain secrets. Only selection is eligible for a public receipt.
 * A02/A10 define the actual adapter value and pairing checks; a Codex login is not an HTTP model. */
export interface ModelLease<Adapter = unknown> extends ServiceLease<Adapter> {
  readonly selection: ModelSelection;
}

/** Host stamps this envelope on observations; providers do not choose or override it. */
export interface RuntimeRunIdentity {
  readonly runId: string;
  readonly runtime: {
    readonly id: string;
    readonly revision: number;
    readonly profileId: string;
    readonly profileRevision: number;
    readonly assemblyFingerprint: string;
  };
  readonly model: ModelSelection;
}

export interface RuntimeCapabilities {
  readonly modelTransports: readonly string[];
  readonly taskKinds: readonly string[];
  readonly tools: boolean;
  readonly images: boolean;
  readonly importWorkspace: boolean;
  readonly hostDelegation: boolean;
  readonly recovery: 'none' | 'same-process' | 'durable';
  readonly replacement: 'hot' | 'restart';
}

export interface RuntimeToolIdentity {
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
}
export interface RuntimeToolDefinition extends RuntimeToolIdentity {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface RuntimeToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}
/** Untrusted tool content. An image here is prepared data, not a model-attention claim. */
export interface RuntimeToolPayload {
  readonly text: string;
  readonly images?: readonly {readonly mimeType: string; readonly data: string}[];
}
export interface HostToolPort {
  readonly definitions: readonly RuntimeToolDefinition[];
  /** Host verifies this issued attempt is still active, plus scope/grant/plugin, before I/O,
   * after reading/before disclosure and after awaiting the sender, before any receipt mutation.
   * A valid run lease alone cannot admit a late callback from an already settled attempt.
   * The sender resolves only after the adapter's actual delivery boundary. A05/A12 implement it:
   * DSH attachment preparation; Codex same-active-turn steer ACK, including exact turn identity.
   * Failure/cancellation/stale identity cannot confirm a delivery. No provider-supplied receipt is accepted. */
  deliver<T>(attempt: RuntimeAttempt, call: RuntimeToolCall, sender: (payload: RuntimeToolPayload) => Promise<T>): Promise<T>;
}

export type RuntimeEvent =
  | {readonly type: 'tools.ready'; readonly tools: readonly RuntimeToolIdentity[]}
  | {readonly type: 'progress'; readonly progress: AgentProgress}
  | {readonly type: 'usage'; readonly usage: TokenUsage};

/** All callbacks are local trusted adapters, not RPC escape hatches or a sandbox. */
export interface HostRunPort {
  readonly identity: RuntimeRunIdentity;
  /** Exact Host-assembled system policy, fixed before runtime prepare. */
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly tools: HostToolPort;
  /** Host-owned diagnostic sink for provider protocol observations. It grants
   * nothing, is dropped after a controlled cancellation and cannot change
   * execution, authorization or product output. */
  observe?(event: AgentTraceEvent): void;
  assertCurrent(): void;
  /** Host admission runs outside active-time accounting; all repairs share one active budget.
   * A10 additionally fences each observable DSH HTTP attempt. Codex internal retries are not observable. */
  runModel<T>(attempt: RuntimeAttempt, task: () => Promise<T>): Promise<T>;
  /** Host validates its issued attempt, stamps identity, normalizes usage and isolates observers.
   * null is only for tool readiness during prepare; Host also rejects readiness after prepare.
   * Late/unknown attempts cannot update Host state. */
  emit(event: Extract<RuntimeEvent, {type: 'tools.ready'}>, attempt: null): void;
  emit(event: Exclude<RuntimeEvent, {type: 'tools.ready'}>, attempt: RuntimeAttempt): void;
}

export interface RuntimeAttempt {
  /** Host-issued, scoped to this run; neither a tool callId nor a provider-chosen turn identity. */
  readonly id: string;
  readonly index: number;
}
export interface RuntimeRunRequest {
  readonly attempt: RuntimeAttempt;
  /** Fully assembled by Host, including untrusted evidence labels. Grants are not prompt fields. */
  readonly prompt: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}
export interface RuntimeRepairRequest extends RuntimeRunRequest {
  /** Host-authored bounded correction, never a replacement answer. Same handle/session and budget. */
  readonly validation: {readonly reason: string; readonly feedback: string};
}

export interface RuntimeCandidate { readonly text: string }
export type RuntimeFailureReason = 'provider_error' | 'tools_unverified' | 'tool_failure' | 'processing_limit';
export type RuntimeTerminal =
  | {readonly kind: 'completed'}
  | {readonly kind: 'output_limit'}
  | {readonly kind: 'failed'; readonly reason: RuntimeFailureReason; readonly providerFailure?: ProviderFailureDetails}
  | {readonly kind: 'cancelled'; readonly cause: Cancellation['kind']}
  | {readonly kind: 'yielded'};
export type RuntimeOutcome =
  | {readonly terminal: Extract<RuntimeTerminal, {kind: 'completed'}>; readonly candidate: RuntimeCandidate}
  | {readonly terminal: Extract<RuntimeTerminal, {kind: 'output_limit'}>; readonly candidate?: RuntimeCandidate}
  | {readonly terminal: Exclude<RuntimeTerminal, {kind: 'completed' | 'output_limit'}>; readonly candidate?: never};

export interface RuntimeHandle {
  run(request: RuntimeRunRequest): Promise<RuntimeOutcome>;
  repair(request: RuntimeRepairRequest): Promise<RuntimeOutcome>;
  /** Stop this handle's work; the pending run/repair settles with a typed cancelled terminal. */
  cancel(cause: Cancellation): Promise<void>;
  /** Idempotent; await pending setup, tool delivery, process exit and private resource removal.
   * Release this handle's resources, not another run's model lease or siblings. */
  close(): Promise<void>;
}
export interface RuntimeProvider<Configuration = unknown, Adapter = unknown> {
  readonly capabilities: RuntimeCapabilities;
  /** Prepare must not start without a Host session backed by the required output service.
   * Partial preparation rolls back; model/runtime leases remain Host-owned. */
  prepare(profile: ResolvedRuntimeProfile<Configuration>, model: ModelLease<Adapter>, host: HostRunPort): Promise<RuntimeHandle>;
}
export const runtimeService: ServiceContract<RuntimeProvider> = Object.freeze({id: 'mote.agent.runtime', apiVersion: RUNTIME_API_VERSION});

/** A narrow candidate boundary, not a validator for evidence, authority, semantic output or arbitrary code. */
export class RuntimeContractError extends Error {
  constructor() { super('Invalid runtime candidate or terminal event'); this.name = 'RuntimeContractError'; }
}
function data(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeContractError();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new RuntimeContractError();
  const properties = Object.getOwnPropertyDescriptors(input), result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in properties[key]!)) throw new RuntimeContractError();
    result[key] = properties[key]!.value;
  }
  return result;
}
function providerFailure(input: unknown): ProviderFailureDetails {
  const value = data(input, ['category', 'code', 'retryAfterMs', 'executionStarted', 'admissionWaiting']);
  if (typeof value.category !== 'string' || !['transient', 'permanent', 'blocked'].includes(value.category) ||
      typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code) ||
      value.retryAfterMs !== undefined && (typeof value.retryAfterMs !== 'number' || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0) ||
      value.executionStarted !== undefined && value.executionStarted !== false ||
      value.admissionWaiting !== undefined && value.admissionWaiting !== true) throw new RuntimeContractError();
  return value as ProviderFailureDetails;
}
/** Reconstructs plain data and rejects ALL authority/receipt/result fields, including nested extras.
 * Empty/oversized/invalid candidate text is left to Host parsing so existing response reasons survive. */
export function parseRuntimeOutcome(input: unknown): RuntimeOutcome {
  const value = data(input, ['terminal', 'candidate']);
  const terminal = data(value.terminal, ['kind', 'reason', 'providerFailure', 'cause']);
  const kind = terminal.kind;
  const allowed = kind === 'failed' ? ['kind', 'reason', 'providerFailure'] : kind === 'cancelled' ? ['kind', 'cause'] : ['kind'];
  if (Object.keys(terminal).some(key => !allowed.includes(key))) throw new RuntimeContractError();
  let parsed: RuntimeTerminal;
  if (kind === 'completed' || kind === 'output_limit' || kind === 'yielded') parsed = {kind};
  else if (kind === 'failed' && typeof terminal.reason === 'string' && ['provider_error', 'tools_unverified', 'tool_failure', 'processing_limit'].includes(terminal.reason)) {
    parsed = {kind, reason: terminal.reason as RuntimeFailureReason, ...(terminal.providerFailure === undefined ? {} : {providerFailure: providerFailure(terminal.providerFailure)})};
  } else if (kind === 'cancelled' && typeof terminal.cause === 'string' && ['cancelled', 'deadline_exceeded', 'revoked', 'scope_stopped'].includes(terminal.cause)) {
    parsed = {kind, cause: terminal.cause as Cancellation['kind']};
  } else throw new RuntimeContractError();
  if (kind === 'completed' || kind === 'output_limit') {
    if (!Object.hasOwn(value, 'candidate') && kind === 'output_limit') return {terminal: {kind}};
    const candidate = data(value.candidate, ['text']);
    if (typeof candidate.text !== 'string') throw new RuntimeContractError();
    if (kind === 'completed') return {terminal: {kind}, candidate: {text: candidate.text}};
    return {terminal: {kind}, candidate: {text: candidate.text}};
  }
  if (Object.hasOwn(value, 'candidate')) throw new RuntimeContractError();
  return {terminal: parsed as Exclude<RuntimeTerminal, {kind: 'completed' | 'output_limit'}>};
}
