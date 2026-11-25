export const usageCaptureKinds = ['projection', 'screen', 'unknownScreen', 'page', 'system', 'other'] as const;
export type UsageCaptureKind = typeof usageCaptureKinds[number];

export interface MeasuredCount {
  value: number | null;
  /** Additional observations or outcomes were unavailable in this interval. */
  partial: boolean;
}

export interface UsageStatisticsCounts {
  captures: Record<UsageCaptureKind, number>;
  turns: number;
  turnFailures: number;
  toolCalls: MeasuredCount;
  toolFailures: MeasuredCount;
  processingFailures: number;
}

export interface UsageStatisticsSummary {
  total: UsageStatisticsCounts;
  days: (UsageStatisticsCounts & { day: string })[];
  tools: { name: string; calls: number; failures: number }[];
}

export const usageActivityKinds = ['capture', 'turn', 'tool'] as const;
export type UsageActivityKind = typeof usageActivityKinds[number];
export type UsageToolResult = 'completed' | 'failed' | 'cancelled' | 'running' | 'unknown';
export type UsageTurnResult = 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type UsageActivity = { id: string; at: string } & (
  | { kind: 'capture'; captureKind: UsageCaptureKind; appName: string; deviceName: string; hasImage: boolean }
  | { kind: 'turn'; state: UsageTurnResult }
  | { kind: 'tool'; name: string; state: UsageToolResult; durationMs: number | null }
);

export const usageFailureKinds = ['tool', 'turn', 'processing'] as const;
export type UsageFailureKind = typeof usageFailureKinds[number];
export type UsageRetryResult = 'unrecorded' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface UsageFailure {
  id: string;
  at: string;
  kind: UsageFailureKind;
  reason: string | null;
  tool?: string;
  retry: UsageRetryResult;
}

export interface UsageStatisticsPage<T> {
  items: T[];
  nextCursor: string | null;
}
