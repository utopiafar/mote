export const stages = ['APP','CONFIG','CAPTURE','MODEL','MODEL_DOWNLOAD','OCR','PRIVACY','QUEUE','UPLOAD','HEARTBEAT','NOTE','SUPPORT','SOURCE','CONNECTION','UPDATE'] as const;
export const codes = ['STARTED','STOPPED','OK','FILTERED','WAIT_NETWORK','PERMISSION','CONFIG_INVALID','NETWORK','TIMEOUT','TLS','AUTH','CONFLICT','SERVER','RESPONSE','STORAGE','MODEL_UNAVAILABLE','SCHEDULER','CANCELLED','OTHER'] as const;
/** Renderer/main data contract. Keep platform and implementation dependencies outside this module. */
export type EventStage = typeof stages[number];
export type EventCode = typeof codes[number];
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/** Describes only the file explicitly selected in this native operation. */
export interface BackupFileIdentity { name: string; path: string; sizeBytes?: number }
export interface WorkProgress { message: string; completed?: number; total?: number; file?: BackupFileIdentity; phase?: 'committing' | 'committed' }
export interface BackgroundJob extends WorkProgress { id: string; startedAt: number; state: 'running' | 'completed' | 'failed' }
export interface SupportEvent { level?: EventLevel; atMs: number; stage: EventStage; code: EventCode; elapsedMs?: number; httpStatus?: number; errorName?: string; operation?: string; sourceId?: string; sourceKind?: string }
