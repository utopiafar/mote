/** Host-owned, instance-scoped plugin state. The host binds the namespace from
 * the executing ScopeIdentity; callers never pass a namespace or instance ID.
 * Values are private plugin data, not host snapshots or authorization grants. */
export type StateValue =
  | null
  | boolean
  | number
  | string
  | readonly StateValue[]
  | {readonly [key: string]: StateValue};

export type StateErrorCode =
  | 'invalid_key'
  | 'invalid_value'
  | 'invalid_revision'
  | 'invalid_limit'
  | 'value_too_large'
  | 'namespace_limit'
  | 'limit_exceeded'
  | 'conflict'
  | 'not_found'
  | 'quiesced'
  | 'stale_scope';

export class StateError extends Error {
  constructor(readonly code: StateErrorCode, message: string = code) {
    super(message);
    this.name = 'StateError';
  }
}

/** Bounded limits are host-owned contract, not per-plugin policy. `bytes` on a
 * record counts its serialized JSON value; namespace accounting also includes
 * the key bytes. Global vault quota remains the Store's metadata budget. */
export interface StateLimits {
  readonly keyBytes: number;
  readonly valueBytes: number;
  readonly namespaceBytes: number;
  readonly namespaceRecords: number;
  readonly listDefault: number;
  readonly listMax: number;
}

export const stateLimits: StateLimits = Object.freeze({
  keyBytes: 256,
  valueBytes: 64 * 1024,
  namespaceBytes: 1024 * 1024,
  namespaceRecords: 1024,
  listDefault: 100,
  listMax: 1000,
});

export interface StateRecord {
  readonly key: string;
  readonly value: StateValue;
  /** Monotonic per-key compare-and-set revision; never a control-plane revision. */
  readonly revision: number;
  /** Serialized value bytes, excluding the key and namespace columns. */
  readonly bytes: number;
  readonly updatedAt: string;
}

/** A committed read-only marker. It never creates a second database, backup
 * file or mutation journal; the existing vault backup already carries the table. */
export interface StateCheckpoint {
  readonly digest: string;
  readonly bytes: number;
  readonly records: number;
}

export interface StateStore {
  get(key: string): Promise<StateRecord | undefined>;
  list(prefix?: string, limit?: number): Promise<readonly StateRecord[]>;
  /** `null` creates only; a number updates only that exact revision. */
  compareAndSet(key: string, expectedRevision: number | null, value: StateValue): Promise<StateRecord>;
  checkpoint(): Promise<StateCheckpoint>;
}
