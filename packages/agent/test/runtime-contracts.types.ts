import type {ServiceLease} from '@mote/plugin-api/contracts';
import type {AgentAnswer} from '../src/types.js';
import type {HostOutputInput, HostOutputProvider, HostRunBudget, HostRunDependencies, HostRunEvent} from '../src/host/run-contracts.js';
import type {HostRunPort, ModelLease, ResolvedRuntimeProfile, RuntimeAttempt, RuntimeHandle, RuntimeOutcome, RuntimeProvider, RuntimeToolCall, RuntimeToolPayload} from '../src/runtime/contracts.js';

// Compile-only consumers of the real A01 declarations. Not an assembled runtime or T3.
declare const provider: RuntimeProvider;
declare const profile: ResolvedRuntimeProfile;
declare const model: ModelLease;
declare const port: HostRunPort;
declare const output: ServiceLease<HostOutputProvider>;
declare const withoutOutput: Omit<HostRunDependencies, 'output'>;
declare const outputInput: HostOutputInput;
declare const call: RuntimeToolCall;
declare const sender: (payload: RuntimeToolPayload) => Promise<void>;
const prepared: Promise<RuntimeHandle> = provider.prepare(profile, model, port);
void prepared;
const outcome: RuntimeOutcome = {terminal: {kind: 'completed'}, candidate: {text: 'candidate only'}};
void outcome;
const noActiveTimeout: HostRunBudget = {activeTimeoutMs: null};
const outerDeadline: HostRunBudget = {activeTimeoutMs: 1000, deadline: 1800000000000};
void noActiveTimeout; void outerDeadline;

// @ts-expect-error runtime outcomes cannot supply Host-owned citations
const citations: RuntimeOutcome = {terminal: {kind: 'completed'}, candidate: {text: 'candidate'}, citations: []};
// @ts-expect-error a failed/cancelled run cannot attach a product candidate
const cancelled: RuntimeOutcome = {terminal: {kind: 'cancelled', cause: 'revoked'}, candidate: {text: 'late'}};
// @ts-expect-error the required output dependency cannot be omitted
const missingOutput: HostRunDependencies = withoutOutput;
// @ts-expect-error a Host output provider is not a RuntimeProvider
const swapped: ServiceLease<RuntimeProvider> = output;
// @ts-expect-error RuntimeHandle cannot return an AgentAnswer directly
const forged: RuntimeHandle['run'] = async (): Promise<AgentAnswer> => ({answer: 'forged', citations: [], trace: [], runId: 'forged'});
// @ts-expect-error only Host can announce a final Host terminal
port.emit({type: 'run.terminal', terminal: {kind: 'completed'}}, null);
// @ts-expect-error the output service gets pure policy, not a Host mutation channel
outputInput.policy.hostControlChannel;
// @ts-expect-error progress/usage require a Host-issued attempt; only prepare readiness may use null
port.emit({type: 'progress', progress: {stage: 'model'}}, null);
const initial: RuntimeAttempt = {id: 'generated-initial', index: 0};
const repair: RuntimeAttempt = {id: 'generated-repair', index: 1};
// Both carry issued identity. If repair is active, the first call is dynamically stale:
// A04 must reject it before disclosure/receipt, not infer currency from the still-valid run lease.
port.tools.deliver(initial, call, sender);
port.tools.deliver(repair, call, sender);
// @ts-expect-error delivery cannot omit the Host-issued attempt
port.tools.deliver(call, sender);
// @ts-expect-error readiness belongs only to prepare/null, never an initial/repair attempt
port.emit({type: 'tools.ready', tools: []}, repair);
// @ts-expect-error the Host event envelope cannot pair readiness with a model attempt either
const lateReady: HostRunEvent = {identity: port.identity, attemptId: repair.id, event: {type: 'tools.ready', tools: []}};
const prepareFailure: HostRunEvent = {identity: port.identity, attemptId: null, event: {type: 'run.terminal', terminal: {kind: 'failed', failure: {code: 'dependency_unavailable'}}}};
// @ts-expect-error prepare cannot announce success without a model attempt and Host output checks
const prepareSuccess: HostRunEvent = {identity: port.identity, attemptId: null, event: {type: 'run.terminal', terminal: {kind: 'completed'}}};
void lateReady; void prepareFailure; void prepareSuccess;
void citations; void cancelled; void missingOutput; void swapped; void forged;
