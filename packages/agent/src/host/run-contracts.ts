import type {CallContext, Cancellation, PluginFailure, PluginScope, ServiceBinding, ServiceContract, ServiceLease} from '@mote/plugin-api/contracts';
import type {QueryInput} from '../query-contracts.js';
import type {ContextRecord} from '../context-contracts.js';
import type {AgentAnswer, AgentResponseReason} from '../types.js';
import type {
  HostRunPort, ModelLease, ResolvedRuntimeProfile, RuntimeCandidate, RuntimeEvent, RuntimeHandle, RuntimeProvider,
  RuntimeRunIdentity, RuntimeTerminal, RuntimeToolDefinition,
} from '../runtime/contracts.js';

export const HOST_OUTPUT_API_VERSION = '1';
export const HOST_MAX_OUTPUT_REPAIRS = 3;

/** This is a Host policy, not a fresh wall-clock timeout for every attempt. */
export interface HostRunBudget {
  /** Admitted active work only; null disables the active execution deadline. Queueing is excluded. */
  readonly activeTimeoutMs: number | null;
  /** Independent optional outer deadline (Unix milliseconds), unchanged across retries. */
  readonly deadline?: CallContext['deadline'];
}
export interface HostActiveBudget {
  /** One shared instance for the initial run and every repair; never reset on a new attempt. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Host-owned read snapshot, never produced from runtime JSON or given as a mutable runtime port. */
export interface HostEvidenceSnapshot {
  readonly records: ReadonlyMap<string, ContextRecord>;
  readonly deliveredRanges: readonly {readonly id: string; readonly offset: number; readonly length: number}[];
  readonly imageReadReceipts: Readonly<NonNullable<AgentAnswer['imageReadReceipts']>>;
  readonly sourceContextDependencies: Readonly<NonNullable<AgentAnswer['sourceContextDependencies']>>;
  readonly evidenceDependencies: NonNullable<AgentAnswer['evidenceDependencies']>;
  readonly trace: Readonly<AgentAnswer['trace']>;
  readonly deliveredCharacters: number;
}
export interface HostOutputInput {
  readonly identity: RuntimeRunIdentity;
  readonly candidate: RuntimeCandidate;
  /** Pure Host-selected policy only: no tool execution, mutation channel, grants or observer callbacks. */
  readonly policy: Readonly<Pick<QueryInput, 'responseMode' | 'skill' | 'taskContext' | 'validateOutput'>>;
  readonly evidence: HostEvidenceSnapshot;
  /** Host assembly metrics plus actual tool delivery counts, never runtime-reported context usage. */
  readonly contextUsage: NonNullable<AgentAnswer['contextUsage']>;
}
export type HostOutputDecision =
  | {readonly kind: 'accepted'; readonly result: AgentAnswer}
  | {readonly kind: 'rejected'; readonly reason: AgentResponseReason; readonly feedback: string; readonly requiresToolUse?: boolean};

/** Trusted restart-replaceable Host foundation, not a RuntimeProvider capability.
 * Owns parseAnswer -> restoreMemoryCoverageKeys -> domain validation and Host result construction.
 * It returns no product side effects; C27/Memory/Import retain their actual persistence fences. */
export interface HostOutputProvider {
  evaluate(input: HostOutputInput): Promise<HostOutputDecision>;
}
export const hostOutputService: ServiceContract<HostOutputProvider> = Object.freeze({id: 'mote.agent.host-output', apiVersion: HOST_OUTPUT_API_VERSION});

/** Exactly one Host final terminal after validation/fencing and required cleanup; not a durable-write receipt. */
export type HostRunTerminal =
  | {readonly kind: 'completed'}
  | {readonly kind: 'rejected'; readonly reason: AgentResponseReason}
  | {readonly kind: 'failed'; readonly failure: PluginFailure}
  | {readonly kind: 'cancelled'; readonly cause: Cancellation['kind']}
  | {readonly kind: 'yielded'};
export type HostRunEvent = {
  readonly identity: RuntimeRunIdentity;
  /** Preparation has no model attempt yet. Only Host can emit its failed/cancelled final terminal. */
  readonly attemptId: null;
  readonly event: Extract<RuntimeEvent, {type: 'tools.ready'}>
    | {readonly type: 'run.terminal'; readonly terminal: Extract<HostRunTerminal, {kind: 'failed' | 'cancelled'}>};
} | {
  readonly identity: RuntimeRunIdentity;
  readonly attemptId: string;
  /** Host derives terminal observations from outcomes; RuntimeProvider.emit cannot forge them. */
  readonly event: Exclude<RuntimeEvent, {type: 'tools.ready'}>
    | {readonly type: 'attempt.terminal'; readonly terminal: RuntimeTerminal}
    | {readonly type: 'run.terminal'; readonly terminal: HostRunTerminal};
};
export interface HostCommitFence {
  /** Check current domain grants and source/evidence pins, including after run-owned leases are released.
   * HostRunSession separately checks scope/cancellation/deadline and every runtime/model/output/tool lease
   * before release; after awaited release it rechecks the remaining scope/cancellation/deadline and this
   * domain fence without asserting intentionally released leases. Writers recheck in their transaction. */
  assertCurrent(): void;
}
export interface HostRunDependencies {
  readonly scope: PluginScope;
  readonly identity: RuntimeRunIdentity;
  readonly input: QueryInput;
  readonly profile: ResolvedRuntimeProfile;
  readonly runtime: ServiceLease<RuntimeProvider>;
  readonly model: ModelLease;
  /** Mandatory exact binding; absence/unavailability rejects BEFORE runtime prepare or disclosure. */
  readonly output: ServiceLease<HostOutputProvider>;
  readonly tools: {
    readonly definitions: readonly RuntimeToolDefinition[];
    readonly bindings: readonly ServiceBinding[];
    /** Fresh checks continue after snapshot pin, including across stop/reinstall/revocation. */
    assertCurrent(): void;
  };
  readonly budget: HostRunBudget;
  readonly activeBudget: HostActiveBudget;
  readonly commitFence: HostCommitFence;
}

/** Host-only execution skeleton implemented by A04; providers receive only HostRunPort.
 * Owns input/scope/tool pin, context assembly, actual delivery ledger, repairs and final result.
 * No commit() method: accepting a candidate never authorizes a product write. */
export interface HostRunSession {
  readonly dependencies: HostRunDependencies;
  readonly port: HostRunPort;
  readonly handle: RuntimeHandle;
  /** Host getter/snapshot; never exposed on the provider's port. */
  readonly evidence: HostEvidenceSnapshot;
  /** Number of model-authored corrections already requested, between zero and repairLimit. */
  readonly repairs: number;
  readonly repairLimit: typeof HOST_MAX_OUTPUT_REPAIRS;
  /** Reject unverified tools/tool failure/cancelled/failed/yielded terminals as successful answers.
   * output_limit rejects the candidate but may request a shorter model-authored repair in the same session.
   * On success run the final fence after awaited validation and construct receipts from the Host ledger. */
  execute(): Promise<AgentAnswer>;
  cancel(cause: Cancellation): Promise<void>;
  /** Await setup, model/tool queue, runtime/bridge/transport cleanup and lease release.
   * Keep the primary failure; report secondary cleanup failures without hiding either. */
  close(): Promise<void>;
}
