import {readAnswerEnvelope} from '../answer-parser.js';
import {restoreMemoryCoverageKeys} from '../tasks/memory-context.js';

/** Scope for a correction to one existing row or quote. */
export interface MemoryRepairScope {
  readonly section: 'memories' | 'coverage';
  readonly index: number;
  readonly spanIndex?: number;
  readonly feedback: string;
}

export interface MemoryReviewDraft {
  readonly answer: string;
  readonly citationIds: readonly string[];
}

type MemoryOutput = {memories: unknown[]; coverage: unknown[]} & Record<string, unknown>;
type Reply = {answer: string; citationIds: string[]};
type RepairBase = {scope: MemoryRepairScope; reply: Reply};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const indexIn = (index: unknown, rows: readonly unknown[]): index is number =>
  typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < rows.length;

function readReply(text: string): Reply | undefined {
  try {
    const value = object(readAnswerEnvelope(text));
    if (value && Object.keys(value).length === 2 && typeof value.answer === 'string' && Array.isArray(value.citationIds) && value.citationIds.every(id => typeof id === 'string')) {
      return {answer: value.answer, citationIds: value.citationIds};
    }
  } catch { /* The regular output validator diagnoses an invalid full reply. */ }
}
function json(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)); } catch { return undefined; }
}
function work(text: string): MemoryOutput | undefined {
  const value = json(text);
  if (Array.isArray(value?.memories) && Array.isArray(value.coverage)) return value as MemoryOutput;
}

/** Reference existing rows only. */
export function prepareMemoryRepair(text: string, scope: MemoryRepairScope): RepairBase | undefined {
  const reply = readReply(text);
  const value = reply && work(reply.answer);
  if (!reply || !value || !['memories','coverage'].includes(scope.section) || !indexIn(scope.index,value[scope.section])) return;
  const row = object(value[scope.section][scope.index]);
  if (!row) return;
  if (scope.spanIndex !== undefined && (scope.section !== 'memories' || !Array.isArray(row.evidence) || !indexIn(scope.spanIndex,row.evidence) || typeof object(row.evidence[scope.spanIndex])?.id !== 'string')) return;
  return {scope, reply};
}

function referencedIds(value: MemoryOutput) {
  const ids = new Set<string>();
  for (const row of value.memories) {
    const evidenceIds = object(row)?.evidenceIds;
    if (Array.isArray(evidenceIds)) for (const id of evidenceIds) if (typeof id === 'string') ids.add(id);
  }
  for (const row of value.coverage) {
    const evidence = object(object(row)?.question)?.evidence;
    if (Array.isArray(evidence)) for (const proof of evidence) {
      const id = object(proof)?.id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}
function envelope(value: MemoryOutput, baseCitationIds: readonly string[], suppliedCitationIds: readonly string[]) {
  const referenced = referencedIds(value);
  const citationIds = [...new Set([...baseCitationIds.filter(id => referenced.has(id)), ...suppliedCitationIds])];
  return JSON.stringify({answer: JSON.stringify(value), citationIds});
}

/** Patch only the Host's requested row. A normal complete response may still
 * pass through. The model cannot select another row via a path in its JSON. */
export function applyMemoryRepair(text: string, base: RepairBase, task?: Record<string, unknown>): string {
  const reply = readReply(text);
  const patch = reply && json(reply.answer);
  const replacement = object(patch?.replacement);
  if (!reply || !patch || Object.keys(patch).length !== 1 || !replacement) return text;
  const value = work(base.reply.answer)!;
  const {section,index,spanIndex} = base.scope;
  const row = object(value[section][index])!;
  if (spanIndex !== undefined) {
    const evidence = row.evidence as unknown[];
    const prior = object(evidence[spanIndex]);
    if (replacement.id !== prior?.id || typeof replacement.quote !== 'string' || !replacement.quote ||
        Object.keys(replacement).some(key => !['id','quote','offset','length'].includes(key))) return text;
    evidence[spanIndex] = replacement;
  } else {
    // The repaired coverage row must still account for the same target.
    if (section === 'coverage' && resolveCoverageKey(replacement, task) !== resolveCoverageKey(row, task)) return text;
    value[section][index] = replacement;
  }
  return envelope(value,base.reply.citationIds,reply.citationIds);
}

export const memoryReviewEditsInstruction = "After independently inspecting the originals and checking every target, you may return a compact review if the candidate count, order and coverage keys stay the same. In answer use a JSON object with exactly memoryChanges:[{index,candidate}] and coverageChanges:[{index,row}], using zero-based indices of the supplied draft. Supply complete replacement objects only for rows that need changes. Keep every unchanged row. Both arrays may be empty after complete independent assessment of a correct non-empty draft. List any newly used evidence in the outer citationIds. The host carries over citations still used by retained rows and validates them against originals delivered in this review. Read original evidence even for rows you keep. If a candidate must be added, dropped, reordered, or otherwise changes the structure, return the full normal memories and coverage object.";

function resolveCoverageKey(row: Record<string, unknown>, task?: Record<string, unknown>): unknown {
  const value = restoreMemoryCoverageKeys(JSON.stringify({coverage:[row]}),task);
  return JSON.parse(value).coverage[0].key;
}

export function applyMemoryReviewEdits(text: string, draft: MemoryReviewDraft, task?: Record<string, unknown>): string {
  const value = work(draft.answer);
  const reply = readReply(text);
  const patch = reply && json(reply.answer);
  if (!value || !reply || !patch || Object.keys(patch).length !== 2 ||
      !Array.isArray(patch.memoryChanges) || !Array.isArray(patch.coverageChanges)) return text;
  for (const [changes, rows, key] of [
    [patch.memoryChanges,value.memories,'candidate'],
    [patch.coverageChanges,value.coverage,'row'],
  ] as const) {
    const seen = new Set<number>();
    if (changes.length > rows.length) return text;
    for (const edit of changes) {
      const replacement = object(edit?.[key]), index = edit?.index;
      if (!object(edit) || Object.keys(edit).length !== 2 || !indexIn(index,rows) || seen.has(index) || !replacement) return text;
      if (key === 'row') {
        const prior = object(rows[index]);
        if (!prior || resolveCoverageKey(replacement, task) !== resolveCoverageKey(prior, task)) return text;
      }
      seen.add(index);
      rows[index] = replacement;
    }
  }
  return envelope(value,draft.citationIds,reply.citationIds);
}
