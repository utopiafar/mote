import type {ServiceLease} from '@mote/plugin-api/contracts';
import type {AgentAnswer} from '../src/types.js';
import type {HostOutputInput, HostOutputProvider, HostRunBudget, HostRunDependencies} from '../src/host/run-contracts.js';
import type {HostRunPort, ModelLease, ResolvedRuntimeProfile, RuntimeHandle, RuntimeOutcome, RuntimeProvider} from '../src/runtime/contracts.js';

// Compile-only consumers of the real A01 declarations. Not an assembled runtime or T3.
declare const provider: RuntimeProvider;
declare const profile: ResolvedRuntimeProfile;
declare const model: ModelLease;
declare const port: HostRunPort;
declare const output: ServiceLease<HostOutputProvider>;
declare const withoutOutput: Omit<HostRunDependencies, 'output'>;
declare const outputInput: HostOutputInput;
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
void citations; void cancelled; void missingOutput; void swapped; void forged;
