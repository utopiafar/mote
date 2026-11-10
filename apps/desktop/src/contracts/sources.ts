/** Renderer/main data contract. Keep platform and implementation dependencies outside this module. */
import type { SourceContextSnapshot } from '@mote/shared';

export type CaptureContextChannel = 'screen' | 'structured' | 'activity' | 'notifications';
export interface SourceContextState {
  snapshot: SourceContextSnapshot;
  pending?: {expectedVersion:number;description:string};
  conflict?: boolean;
  error?: 'denied'|'unavailable';
}


export type SourceRetention = 'snapshot' | 'reference' | 'archive';
export interface SourceDefinition {
  initialSync?: 'all' | 'new_only';
  id: string; name: string; kind: string; deviceId: string;
  platform: 'macos' | 'import'; retention: SourceRetention; enabled: boolean;
}
export interface SourceOptions {
  name?: string;
  /** Optional initial owner declaration, transported separately from source content. */
  description?: string;
  /** Collector-only policy: false captures one immutable import; undefined keeps continuous watching. */
  syncContinuously?: boolean;
  /** Explicit owner confirmation that snapshot file bytes are sent for central processing. */
  centralProcessingConsent?: boolean;
  allowRead?:boolean;
  initialSync?: 'all' | 'new_only';
  retention: SourceRetention; intervalSeconds: number; trackDeletions: boolean;
  extensions: string[]; excludedPaths: string[]; redactLiterals: string[];
}
export interface LocalSource extends SourceDefinition, Omit<SourceOptions, 'name'> {
  importCompletedAt?: string;
  path?: string; calendarId?: string; agent?: 'claude' | 'codex' | 'kimi' | 'opencode';
}
export interface SourceStatus {
  context?: SourceContextState;
  blocked?: number;
  failures?: {externalId:string;title:string;status:number}[];
  facts?: import('@mote/shared/native-status').NativeStatusView;
  scanComplete?: boolean;
  lastAcknowledgedAt?: string;
  /** Process-local outbox membership revision, including policy restaging and quarantine. */
  pendingContentRevision?: number;
  source: LocalSource; state: 'idle' | 'syncing' | 'paused' | 'error' | 'permission_required';
  message: string; pending: number; lastSyncAt?: string; items: number; skipped: number;
}
export interface CalendarChoice { id: string; title: string }
export type CodingProvider='claude'|'codex'|'kimi'|'opencode';

export interface CodingAgentDiscovery { provider: CodingProvider; name: string; path: string; available: boolean }
