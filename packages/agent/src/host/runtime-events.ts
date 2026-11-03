import {hasCompleteTokenUsage, type TokenUsage} from '@mote/shared';

/** A provider sample is copied into the current TokenUsage format. Optional
 * cache/reasoning buckets stay unknown when absent: a missing bucket is not
 * zero. Unknown provider fields are not forwarded, and normalization never
 * promotes an interrupted or partially reported sample to complete. */
export function normalizeRuntimeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const usage = value as Record<string, unknown>;
  const count = (candidate: unknown): candidate is number => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!['requests', 'reportedRequests', 'inputTokens', 'outputTokens', 'totalTokens'].every(key => count(usage[key]))) return undefined;
  if (['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'].some(key => usage[key] !== undefined && !count(usage[key]))) return undefined;
  if (usage.measurement !== undefined && usage.measurement !== 'thread_cumulative') return undefined;
  if (usage.complete !== undefined && typeof usage.complete !== 'boolean') return undefined;
  return Object.freeze({
    requests: usage.requests as number,
    reportedRequests: usage.reportedRequests as number,
    inputTokens: usage.inputTokens as number,
    outputTokens: usage.outputTokens as number,
    totalTokens: usage.totalTokens as number,
    ...(usage.cacheReadTokens === undefined ? {} : {cacheReadTokens: usage.cacheReadTokens as number}),
    ...(usage.cacheWriteTokens === undefined ? {} : {cacheWriteTokens: usage.cacheWriteTokens as number}),
    ...(usage.reasoningTokens === undefined ? {} : {reasoningTokens: usage.reasoningTokens as number}),
    ...(usage.measurement === undefined ? {} : {measurement: usage.measurement as 'thread_cumulative'}),
    ...(usage.complete === undefined ? {} : {complete: usage.complete as boolean}),
  });
}

export type RuntimeUsageEmission = 'observed' | 'duplicate' | 'invalid';

export interface RuntimeUsageEvent {
  readonly attemptId: string;
  readonly usage: TokenUsage;
}

/** Local Host observation. Exceptions are isolated from execution, grants and
 * the usage series itself. */
export type RuntimeUsageObserver = (event: RuntimeUsageEvent) => void;

export interface RuntimeUsageEvents {
  /** One attempt is one cumulative series. An identical repeat carries no new
   * observation; a later sample with new counts, cache buckets or completeness
   * is distinct and must reach the observer. */
  emit(attemptId: string, value: unknown): RuntimeUsageEmission;
  forget(attemptId: string): void;
}

export function createRuntimeUsageEvents(observe: RuntimeUsageObserver): RuntimeUsageEvents {
  const latest = new Map<string, string>();
  return {
    emit(attemptId, value) {
      if (typeof attemptId !== 'string' || !attemptId) return 'invalid';
      let usage: TokenUsage | undefined;
      try { usage = normalizeRuntimeUsage(value); } catch { return 'invalid'; }
      if (!usage) return 'invalid';
      const fingerprint = JSON.stringify(usage);
      if (latest.get(attemptId) === fingerprint) return 'duplicate';
      // Record before observing: a throwing observer cannot replay or erase
      // the already accepted sample.
      latest.set(attemptId, fingerprint);
      try { observe({attemptId, usage}); } catch { /* Observation grants nothing. */ }
      return 'observed';
    },
    forget(attemptId) { latest.delete(attemptId); },
  };
}

/** The existing completeness contract decides partial/unknown usage, with one
 * Host-side addition: an explicit interrupted flag is never overridden by
 * matching request counts. This wrapper keeps call sites on the Host event path
 * from inventing a second definition. */
export function runtimeUsageComplete(usage: TokenUsage | undefined): usage is TokenUsage {
  return Boolean(usage && usage.complete !== false && hasCompleteTokenUsage(usage));
}
