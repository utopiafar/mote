export const MiB: number;
export const MAX_LOG_FILE_BYTES: number;
export const MAX_TRACE_EVENT_BYTES: number;
export const LOG_CHANNELS: readonly ['error', 'warn', 'info', 'debug', 'trace'];
export type LogChannel = typeof LOG_CHANNELS[number];
export type LogRetention = Record<LogChannel, {
  days: number;
  maxBytes: number;
}>;
export const DEFAULT_LOG_RETENTION: Readonly<LogRetention>;
export function defaultLogMaxBytes(profile?: string): number;
export class LogRetentionError extends Error {
  field: string;
  constructor(field: string, message: string);
}
export function logRetentionFromDocument(document: Record<string, unknown>): {
  maxBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
  retention: LogRetention;
  source: 'profile-default' | 'explicit';
};
export function logRetentionFromEnv(env: Record<string, string | undefined>, profile?: string): ReturnType<typeof logRetentionFromDocument>;
