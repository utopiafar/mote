import type { FileHandle } from 'node:fs/promises';
import type { LogChannel, LogRetention } from './log-retention-config.mjs';
export interface LogFile {
  name: string;
  family: string;
  channel: LogChannel;
  firstAt: string;
  lastAt: string;
  bytes: number;
  index?:number;
  modifiedAt?:number;
}
export interface CleanupPlan {
  kind: 'trace' | 'all';
  files: LogFile[];
  bytes: number;
  oldestAt: string | null;
  newestAt: string | null;
}
export interface LogStoreOptions {
  family?: 'central' | 'supervisor';
  maxBytes?: number;
  maxTotalBytes?: number;
  retention?: LogRetention;
  now?: () => Date;
  minFreeBytes?: number;
}
export class DiagnosticLogStore {
  constructor(directory: string, options?: LogStoreOptions);
  files: LogFile[];
  init(): Promise<void>;
  append(records: {
    channel: LogChannel;
    line: string;
    at: string;
  }[]): Promise<(string | null)[]>;
  refresh(): Promise<ReturnType<DiagnosticLogStore['snapshot']>>;
  snapshot(): {
    totalBytes: number;
    unmanagedBytes: number;
    maxTotalBytes: number;
    files: LogFile[];
    channels: ({
      channel: LogChannel;
      days: number;
      maxBytes: number;
      bytes: number;
      oldestAt: string | null;
      newestAt: string | null;
    })[];
    lastCleanup: {
      at: string;
      reason: string;
      channel: LogChannel;
      files: number;
      bytes: number;
    } | null;
    deletedFiles: number;
    deletedBytes: number;
    droppedEvents: number;
    diskPressure: boolean;
  };
  preview(kind: 'trace' | 'all'): Promise<CleanupPlan>;
  clear(plan: CleanupPlan): Promise<{
    deletedFiles: number;
    deletedBytes: number;
  }>;
  settled():Promise<unknown>;
  read<T>(index: number | string, read: (file: FileHandle, size: number) => Promise<T>, missing: () => T): Promise<T>;
}
