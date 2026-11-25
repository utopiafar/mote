import {safeUpstreamRequestId} from './failure-diagnostics.js';

const counters = [
  'promptTokens', 'completionTokens', 'totalTokens', 'cachedPromptTokens', 'completionReasoningTokens',
  'billedInputTokens', 'billedCacheReadTokens', 'billedCacheWrite5mTokens', 'billedCacheWrite1hTokens',
  'billedOutputTokens', 'billedReasoningTokens',
] as const;

/** One physical request. OpenCode billing and API usage are separate measurements.
 * null means the supplier omitted the field. A reported zero stays zero. */
export type OpenCodeRequestUsage = Readonly<Record<typeof counters[number], number | null> & {
  modelRequestId: string;
  requestState: 'started' | 'finished';
  upstreamRequestId?: string;
  httpStatus?: number;
  durationMs: number;
  billingSource?: 'go' | 'go-plus' | 'free' | 'balance' | 'byok';
  allowanceUsd: number | null;
}>;

export function normalizeOpenCodeRequestUsage(raw: unknown): OpenCodeRequestUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  if (typeof value.modelRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.modelRequestId)) return;
  const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const count = (n: unknown): n is number => nonnegative(n) && Number.isSafeInteger(n);
  if (!nonnegative(value.durationMs)) return;
  const requestState = value.requestState === 'started' ? 'started' : 'finished';
  const result = {} as Record<typeof counters[number], number | null>;
  for (const key of counters) {
    const n = value[key];
    result[key] = count(n) ? n : null;
  }
  const upstreamRequestId = safeUpstreamRequestId(value.upstreamRequestId);
  const httpStatus = count(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
  const billingSource = (['go', 'go-plus', 'free', 'balance', 'byok'] as const).find(source => source === value.billingSource);
  return Object.freeze({
    ...result, modelRequestId: value.modelRequestId, requestState, durationMs: value.durationMs,
    ...(upstreamRequestId ? {upstreamRequestId} : {}),
    ...(httpStatus !== undefined ? {httpStatus} : {}),
    ...(billingSource ? {billingSource} : {}),
    allowanceUsd: nonnegative(value.allowanceUsd) ? value.allowanceUsd : null,
  });
}
