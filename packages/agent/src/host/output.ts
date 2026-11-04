import {parseAnswer} from '../answer-parser.js';
import {restoreMemoryCoverageKeys} from '../tasks/memory-context.js';
import {AgentResponseError, reportTrace, validateHostOutput, type AgentAnswer} from '../types.js';
import type {HostEvidenceSnapshot, HostOutputDecision, HostOutputInput, HostOutputProvider} from './run-contracts.js';
import type {QueryInput} from '../query-contracts.js';
import {copyEvidencePresentation} from '../evidence-ledger.js';

export function hostOutputPolicy(input: QueryInput): HostOutputInput['policy'] {
  return {responseMode: input.responseMode, skill: input.skill, taskContext: input.taskContext,
    ...(input.validateOutput ? {validateOutput: async (answer: AgentAnswer) => {
      const issue = await input.validateOutput!(answer);
      if (issue) reportTrace(input, {type: 'validation.host_rejected', runId: answer.runId, stage: 'validating', status: 'rejected', payload: {code: issue.code, feedback: issue.feedback}});
      return issue;
    }} : {}),
  };
}

/** Copy the Host ledger at evaluation time; neither model JSON nor validators own it. */
export function snapshotHostEvidence(source: HostEvidenceSnapshot): HostEvidenceSnapshot {
  const snapshot = structuredClone({
    records: new Map(source.records), deliveredRanges: source.deliveredRanges,
    imageReadReceipts: source.imageReadReceipts, sourceContextDependencies: source.sourceContextDependencies,
    evidenceDependencies: source.evidenceDependencies, trace: source.trace,
    deliveredCharacters: source.deliveredCharacters,
  });
  for (const [id, record] of source.records) copyEvidencePresentation(record, snapshot.records.get(id)!);
  return snapshot;
}

/** The single parse -> coverage restoration -> domain validation pipeline. */
async function buildHostOutput(input: Omit<HostOutputInput, 'identity'> & {runId: string; includeReadRanges?: boolean}): Promise<AgentAnswer> {
  const evidence = snapshotHostEvidence(input.evidence);
  const parsed = parseAnswer(input.candidate.text, evidence.records);
  const result: AgentAnswer = {
    ...parsed,
    answer: restoreMemoryCoverageKeys(parsed.answer, input.policy.taskContext),
    imageReadReceipts: [...evidence.imageReadReceipts],
    ...(input.includeReadRanges !== false ? {evidenceReadRanges: [...evidence.deliveredRanges]} : {}),
    sourceContextDependencies: [...evidence.sourceContextDependencies],
    evidenceDependencies: evidence.evidenceDependencies,
    trace: [...evidence.trace],
    contextUsage: {...input.contextUsage, toolResults: evidence.deliveredCharacters},
    runId: input.runId,
  };
  // A trusted asynchronous domain validator receives a detached view, not a way
  // to replace the base parser's answer, ledger or final result by mutation.
  await validateHostOutput(input.policy, structuredClone(result));
  return result;
}

export function evaluateHostOutput(input: HostOutputInput): Promise<AgentAnswer> {
  return buildHostOutput({...input, runId: input.identity.runId});
}

async function decide(evaluate: () => Promise<AgentAnswer>): Promise<HostOutputDecision> {
  try { return {kind: 'accepted', result: await evaluate()}; }
  catch (error) {
    if (!(error instanceof AgentResponseError)) throw error;
    return {kind: 'rejected', reason: error.reason, feedback: error.message};
  }
}

export function createHostOutputProvider(): HostOutputProvider {
  return Object.freeze({evaluate: (input: HostOutputInput) => decide(() => evaluateHostOutput(input))});
}
