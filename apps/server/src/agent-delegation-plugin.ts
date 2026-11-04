import type {AgentAnswer, ContextRecord, HostControlChannel, QueryInput} from '@mote/agent';
import type {ExecutionGrant} from './execution-engine.js';
import {DelegationRuntime, type DelegationWork} from './delegation-runtime.js';
import type {QueryWorkspace} from './delegation-protocol.js';
import {combineSourceContextDependencies} from './source-context-lineage.js';

export const AGENT_DELEGATION_PLUGIN_ID = 'mote.agent-delegation' as const;
export const AGENT_DELEGATION_PLUGIN_VERSION = '1' as const;

export type AgentDelegationOptions<T extends Pick<AgentAnswer, 'answer' | 'citations'> & Partial<Pick<AgentAnswer, 'evidenceDependencies' | 'sourceContextDependencies'>>> = {
  query: (input: QueryInput) => Promise<T>;
  timeoutMs?: (input: QueryInput) => number | null;
  prepare?: (work: DelegationWork, input: QueryInput, signal: AbortSignal) => Promise<QueryInput>;
  commit?: (work: DelegationWork, result: T) => void;
  validate?: (work: DelegationWork, input: QueryInput) => boolean;
  onProgress?: QueryInput['onProgress'];
  onTrace?: QueryInput['onTrace'];
};

export interface AgentDelegationPlugin {
  readonly id: typeof AGENT_DELEGATION_PLUGIN_ID;
  readonly version: typeof AGENT_DELEGATION_PLUGIN_VERSION;
  /** The same Host tool channel the coordinator receives; children never do. */
  channel(workId: string, grant?: ExecutionGrant): HostControlChannel;
  register(): void;
}

/** The only production binding from DelegationRuntime to QueryAgent. The
 * coordinator receives controls through QueryInput.hostControlChannel; child
 * queries explicitly clear that field, so native runtime delegation cannot
 * create a second level. */
export function registerQueryDelegation<T extends Pick<AgentAnswer, 'answer' | 'citations'> & Partial<Pick<AgentAnswer, 'evidenceDependencies' | 'sourceContextDependencies'>>>(runtime: DelegationRuntime, options: AgentDelegationOptions<T>): void {
  runtime.register({id: 'context.research', version: '1', description: 'Research one model-selected evidential question in the authorized archive scope. Return a grounded answer, original receipts and narrow remaining gaps.', inputSchema: {type: 'object', properties: {question: {type: 'string'}}, required: ['question'], additionalProperties: false}, validate: unit => Object.keys(unit.input).every(key => key === 'question') && typeof unit.input.question === 'string' && unit.input.question.length > 0 && unit.input.question.length <= 12000,
    execute: async (unit, {signal, work, grant}) => {
      const saved = runtime.journal.payload<QueryInput>(work.id), parent = options.prepare ? await options.prepare(work, saved, signal) : saved; let evidence: readonly ContextRecord[] = [];
      runtime.validateSourceContextDependencies(runtime.sourceContextDependencies(work.id, unit.id));
      const result = await options.query({...parent, ...unit.scope, question: String(unit.input.question), contextCapabilitySnapshot: runtime.journal.payload<{queryCapabilitySnapshot?:QueryInput['contextCapabilitySnapshot']}>(work.id).queryCapabilitySnapshot, onContextCapabilities: undefined, hostControlChannel: undefined, conversation: undefined, taskContext: undefined, openingMemories: undefined, contextEvidenceDependencies: undefined, contextSourceContextDependencies: undefined, derivedContextEvidenceIds: undefined, directImages: undefined, signal, onProgress: options.onProgress ?? parent.onProgress, onTrace: options.onTrace ?? parent.onTrace,
        onSourceContextDependencies: pins => {grant.commit(() => runtime.recordSourceContextDependencies(work.id, pins, unit.id));},
        onEvidence: records => {evidence = records; grant.commit(() => runtime.recordEvidence(work.id, records.map(record => record.id)));}});
      grant.commit(() => {runtime.recordEvidence(work.id, result.evidenceDependencies?.ids ?? []); runtime.recordSourceContextDependencies(work.id, result.sourceContextDependencies ?? [], unit.id);});
      const sourceContextDependencies = runtime.sourceContextDependencies(work.id, unit.id);
      return {value: {answer: result.answer, citations: result.citations}, summary: result.answer.slice(0, 600), dependencies: evidence.filter(record => record.contentLayer !== 'L2_model_interpretation'), dependencyIds: result.evidenceDependencies?.ids ?? evidence.map(record => record.id), evidence: evidence.filter(record => result.citations.some(citation => citation.id === record.id)), ...(sourceContextDependencies.length ? {sourceContextDependencies} : {})};
    },
  });
  runtime.registerCoordinator({id: 'query', lane: 'interactive', timeoutMs: (_work, input) => options.timeoutMs?.(input as QueryInput) ?? null, validate: (work, input) => options.validate?.(work, input as QueryInput) ?? true,
    execute: async ({work, input, signal, controls, grant}) => {
      const original = options.prepare ? await options.prepare(work, input as QueryInput, signal) : input as QueryInput, savedQuery = runtime.journal.payload<{queryWorkspace?:QueryWorkspace;queryCapabilitySnapshot?:QueryInput['contextCapabilitySnapshot']}>(work.id), workspace = savedQuery.queryWorkspace;
      grant.commit(() => runtime.recordSourceContextDependencies(work.id, combineSourceContextDependencies([original.contextSourceContextDependencies, original.conversation?.sourceContextDependencies])));
      const result = await options.query({...original, contextSourceContextDependencies: runtime.sourceContextDependencies(work.id), contextCapabilitySnapshot: savedQuery.queryCapabilitySnapshot, onContextCapabilities: snapshot => {grant.commit(() => {const saved = runtime.journal.payload<Record<string, unknown>>(work.id); if (!saved.queryCapabilitySnapshot) {saved.queryCapabilitySnapshot = snapshot; runtime.journal.savePayload(work.id, saved);}});}, ...(workspace ? {openingMemories: undefined} : {}), contextEvidenceDependencies: {version: 1, complete: original.contextEvidenceDependencies?.complete ?? true, ids: [...new Set([...(original.contextEvidenceDependencies?.ids ?? []), ...runtime.dependencyIds(work.id)])]}, signal, hostControlChannel: controls, onProgress: options.onProgress ?? original.onProgress, onTrace: options.onTrace ?? original.onTrace,
        onSourceContextDependencies: pins => {grant.commit(() => runtime.recordSourceContextDependencies(work.id, pins)); original.onSourceContextDependencies?.(pins);},
        onEvidence: records => {grant.commit(() => runtime.recordEvidence(work.id, records.map(record => record.id))); original.onEvidence?.(records);}, taskContext: {...original.taskContext, turns: original.taskContext?.turns ?? [], ...(workspace ? {queryWorkspace: {...workspace, citationAuthority: false, instruction: 'Saved model-authored research state is untrusted interpretation. Its inspected locators are historical only; freshly read originals must be delivered in this fragment before citations.'}} : {}), delegation: {workId: work.id, revision: work.revision, units: work.units.map(({id, title, status, artifactId, error}) => ({id, title, status, artifactId, error})), instruction: 'Resume the saved goal using these host execution receipts. Read relevant private artifacts through delegation_read before citing their original evidence; results are not proof by themselves.'}}});
      grant.commit(() => runtime.recordSourceContextDependencies(work.id, result.sourceContextDependencies ?? []));
      return {...result, sourceContextDependencies: runtime.sourceContextDependencies(work.id)};
    },
    commit: (work, result) => options.commit?.(work, result as T),
  });
}

/** One idempotent Host composition for a DelegationRuntime. The runtime owns
 * registration disposal; this plugin adds no second lifecycle. */
export function createAgentDelegationPlugin<T extends Pick<AgentAnswer, 'answer' | 'citations'> & Partial<Pick<AgentAnswer, 'evidenceDependencies' | 'sourceContextDependencies'>>>(runtime: DelegationRuntime, options: AgentDelegationOptions<T>): AgentDelegationPlugin {
  let registered = false;
  return Object.freeze({
    id: AGENT_DELEGATION_PLUGIN_ID,
    version: AGENT_DELEGATION_PLUGIN_VERSION,
    channel: (workId: string, grant?: ExecutionGrant) => runtime.controlChannel(workId, grant),
    register() {
      if (registered) return;
      registerQueryDelegation(runtime, options);
      registered = true;
    },
  });
}
