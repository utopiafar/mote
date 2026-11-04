import {createHash} from 'node:crypto';
import type {HostScope} from '@mote/plugin-host';
import {
  StateError, stateLimits,
  type StateCheckpoint, type StateLimits, type StateRecord, type StateStore, type StateValue,
} from '@mote/plugin-api';
import type {Store} from '../store.js';

type Row = {key: string; json: string; bytes: number; revision: number; updated_at: string};
type Namespace = {readonly packageId: string; readonly installationId: string; readonly instanceId: string};

/** Feature-owned DDL for the fixed startup inventory. Production wiring calls
 * this before app.ready(); InstanceState also calls it defensively for isolated
 * module tests. One table in the existing vault, no second control/state DB. */
export function installInstanceStateSchema(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS plugin_instance_state(
    package_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    key TEXT NOT NULL,
    json TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(package_id, installation_id, instance_id, key)
  ) WITHOUT ROWID`);
  // Creates the StorageLedger row/triggers for this new table before the
  // first quota check.
  store.registerStorage('plugin-control',{plugin_instance_state:"bytes+length(CAST(key AS BLOB))+length(CAST(package_id AS BLOB))+length(CAST(installation_id AS BLOB))+length(CAST(instance_id AS BLOB))+length(CAST(updated_at AS BLOB))+32"});
  store.logicalBytes();
}

function bounded(input: StateLimits): StateLimits {
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!positive(input.keyBytes) || !positive(input.valueBytes) || !positive(input.namespaceBytes) ||
    !positive(input.namespaceRecords) || !positive(input.listDefault) || !positive(input.listMax) ||
    input.listDefault > input.listMax) throw new StateError('invalid_limit');
  return Object.freeze({...input});
}

/** One table in the existing vault. The trusted factory supplies the real
 * HostScope; ordinary code cannot choose a namespace, instance ID or SQL. */
class InstanceState implements StateStore {
  private readonly namespace: Namespace;
  private readonly limits: StateLimits;

  constructor(private readonly store: Store, private readonly scope: HostScope, limits: StateLimits = stateLimits) {
    this.namespace = Object.freeze({
      packageId: scope.identity.packageId,
      installationId: scope.identity.installationId,
      instanceId: scope.identity.instanceId,
    });
    this.limits = bounded(limits);
    installInstanceStateSchema(store);
  }

  get(key: string, ...namespace: never[]): Promise<StateRecord | undefined> {
    return this.admit(() => {
      this.rejectNamespace(namespace);
      this.key(key);
      const row = this.row(key);
      return row ? this.record(row) : undefined;
    });
  }

  list(prefix = '', limit = this.limits.listDefault, ...namespace: never[]): Promise<readonly StateRecord[]> {
    return this.admit(() => {
      this.rejectNamespace(namespace);
      this.prefix(prefix);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.listMax) throw new StateError('invalid_limit');
      const rows = this.store.db.prepare(`SELECT key,json,bytes,revision,updated_at FROM plugin_instance_state
        WHERE package_id=? AND installation_id=? AND instance_id=? ORDER BY key`).all(...this.values()) as Row[];
      return rows.filter(row => String(row.key).startsWith(prefix)).slice(0, limit).map(row => this.record(row));
    });
  }

  compareAndSet(key: string, expectedRevision: number | null, value: StateValue, ...namespace: never[]): Promise<StateRecord> {
    return this.admit(() => {
      this.rejectNamespace(namespace);
      this.key(key);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new StateError('invalid_revision');
      const json = this.serialize(value);
      return this.write(key, expectedRevision, json, Buffer.byteLength(json));
    });
  }

  checkpoint(...namespace: never[]): Promise<StateCheckpoint> {
    return this.admit(() => {
      this.rejectNamespace(namespace);
      const rows = this.store.db.prepare(`SELECT key,json,bytes,revision,updated_at FROM plugin_instance_state
        WHERE package_id=? AND installation_id=? AND instance_id=? ORDER BY key`).all(...this.values()) as Row[];
      const digest = createHash('sha256').update(JSON.stringify({
        namespace: this.namespace,
        records: rows.map(row => [row.key, row.revision, row.json]),
      })).digest('hex');
      return {
        digest,
        bytes: rows.reduce((sum, row) => sum + Number(row.bytes) + Buffer.byteLength(String(row.key)), 0),
        records: rows.length,
      };
    });
  }

  private write(key: string, expectedRevision: number | null, json: string, bytes: number): StateRecord {
    const db = this.store.db, now = new Date().toISOString(), keyBytes = Buffer.byteLength(key);
    db.exec('BEGIN IMMEDIATE');
    try {
      this.current();
      const existing = this.row(key);
      const usage = db.prepare(`SELECT COALESCE(SUM(bytes + length(CAST(key AS BLOB))),0) AS bytes, COUNT(*) AS records
        FROM plugin_instance_state WHERE package_id=? AND installation_id=? AND instance_id=?`).get(...this.values()) as {bytes: number; records: number};
      const prior = existing ? Number(existing.bytes) + Buffer.byteLength(String(existing.key)) : 0;
      const namespaceDelta = keyBytes + bytes - prior;
      if (Number(usage.bytes) + namespaceDelta > this.limits.namespaceBytes || (!existing && Number(usage.records) >= this.limits.namespaceRecords)) {
        throw new StateError('namespace_limit');
      }
      // Match StorageLedger's plugin_instance_state expression exactly: value,
      // key, namespace IDs, timestamp and the fixed row overhead. Reserving only
      // key/value would let a new row commit past the vault budget.
      const delta = this.rowCost(bytes, key, now) - (existing ? this.rowCost(Number(existing.bytes), String(existing.key), String(existing.updated_at)) : 0);
      try { this.store.reserveMetadata(delta); }
      catch (error) { throw new StateError('limit_exceeded', error instanceof Error ? error.message : 'Vault storage limit reached'); }

      let revision: number;
      if (expectedRevision === null) {
        if (existing) throw new StateError('conflict');
        db.prepare(`INSERT INTO plugin_instance_state(package_id,installation_id,instance_id,key,json,bytes,revision,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(...this.values(), key, json, bytes, 1, now);
        revision = 1;
      } else {
        if (!existing) throw new StateError('not_found');
        if (Number(existing.revision) !== expectedRevision) throw new StateError('conflict');
        const result = db.prepare(`UPDATE plugin_instance_state SET json=?,bytes=?,revision=revision+1,updated_at=?
          WHERE package_id=? AND installation_id=? AND instance_id=? AND key=? AND revision=?`)
          .run(json, bytes, now, ...this.values(), key, expectedRevision);
        if (Number(result.changes) !== 1) throw new StateError('conflict');
        revision = expectedRevision + 1;
      }
      this.current();
      db.exec('COMMIT');
      return {key, value: JSON.parse(json) as StateValue, revision, bytes, updatedAt: now};
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  private rowCost(valueBytes: number, key: string, updatedAt: string) {
    return valueBytes + Buffer.byteLength(key) + Buffer.byteLength(this.namespace.packageId) +
      Buffer.byteLength(this.namespace.installationId) + Buffer.byteLength(this.namespace.instanceId) +
      Buffer.byteLength(updatedAt) + 32;
  }

  private row(key: string): Row | undefined {
    return this.store.db.prepare(`SELECT key,json,bytes,revision,updated_at FROM plugin_instance_state
      WHERE package_id=? AND installation_id=? AND instance_id=? AND key=?`).get(...this.values(), key) as Row | undefined;
  }

  private record(row: Row): StateRecord {
    let value: StateValue;
    try { value = JSON.parse(String(row.json)) as StateValue; }
    catch { throw new StateError('invalid_value'); }
    return {key: String(row.key), value, revision: Number(row.revision), bytes: Number(row.bytes), updatedAt: String(row.updated_at)};
  }

  private serialize(value: StateValue): string {
    let json: string | undefined;
    try {
      json = JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new StateError('invalid_value');
        return item;
      });
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError('invalid_value');
    }
    if (typeof json !== 'string') throw new StateError('invalid_value');
    if (Buffer.byteLength(json) > this.limits.valueBytes) throw new StateError('value_too_large');
    return json;
  }

  /** The methods expose no namespace parameter; reject JS callers that append one
   * instead of silently ignoring an attempted namespace/instance override. */
  private rejectNamespace(namespace: readonly unknown[]) {
    if (namespace.length) throw new StateError('invalid_namespace');
  }

  private key(key: string) {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > this.limits.keyBytes || key.includes('\0')) throw new StateError('invalid_key');
  }

  private prefix(prefix: string) {
    if (typeof prefix !== 'string' || Buffer.byteLength(prefix) > this.limits.keyBytes || prefix.includes('\0')) throw new StateError('invalid_key');
  }

  private values(): [string, string, string] { return [this.namespace.packageId, this.namespace.installationId, this.namespace.instanceId]; }

  private current() {
    try { this.scope.assertCurrent(); }
    catch { throw new StateError('stale_scope'); }
  }

  private admit<T>(work: () => T): Promise<T> {
    if (this.scope.signal.aborted) return Promise.reject(new StateError('stale_scope'));
    return this.scope.run(() => ({value: work()})).then(result => {
      if (!result) throw new StateError('quiesced');
      return result.value;
    }, error => {
      if ((error as {code?: string})?.code === 'stale_scope') throw new StateError('stale_scope');
      throw error;
    });
  }
}

/** Trusted factory: the handle binds itself to the real activation scope. No
 * public state method accepts an identity, namespace, validator or SQL. */
export function createInstanceState(store: Store, scope: HostScope, limits: StateLimits = stateLimits): StateStore {
  return new InstanceState(store, scope, limits);
}
