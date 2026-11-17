import type {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from './schema-installation.js';
import {createHash} from 'node:crypto';
import type {HostScope} from '@mote/plugin-host';
import {
  StateError, stateLimits,
  type StateCheckpoint, type StateLimits, type StateRecord, type StateStore, type StateValue, type StateWriteCondition,
} from '@mote/plugin-api';
import type {Store} from './store.js';
import {sourceIdSchema} from '@mote/shared';

export const instanceStateSchemaInstallation={owner:'plugin-instance-state',requires:[],install:instanceStateSchema} as const satisfies SchemaInstallation;

/** Only the original instance-state table; ledger registration stays at its call site. */
function instanceStateSchema(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS plugin_instance_state(
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
}

type Row = {key: string; json: string; bytes: number; revision: number; updated_at: string};
type Namespace = {readonly packageId: string; readonly installationId: string; readonly instanceId: string};

/** Feature-owned DDL for the fixed startup inventory. Production wiring calls
 * this before app.ready(); InstanceState also calls it defensively for isolated
 * module tests. One table in the existing vault, no second control/state DB. */
export function installInstanceStateSchema(store: Store) {
  installSchemaPlan(store.db,[instanceStateSchemaInstallation]);
  // Creates the StorageLedger row/triggers for this new table before its
  // first write.
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

  constructor(private readonly store: Store, private readonly scope: HostScope, private readonly ownerCurrent:()=>void, limits: StateLimits = stateLimits, private readonly sourceKinds: readonly string[] = []) {
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

  compareAndSet(key: string, expectedRevision: number | null, value: StateValue, condition?: StateWriteCondition, ...namespace: never[]): Promise<StateRecord> {
    return this.admit(() => {
      this.rejectNamespace(namespace);
      if (condition !== undefined) {
        if (!condition || typeof condition !== 'object' || Array.isArray(condition) || Object.keys(condition).sort().join(',') !== 'sourceId,syncScopeVersion') throw new StateError('invalid_namespace');
        if (!sourceIdSchema.safeParse(condition.sourceId).success || !Number.isSafeInteger(condition.syncScopeVersion) || condition.syncScopeVersion < 0) throw new StateError('invalid_condition');
      }
      this.key(key);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new StateError('invalid_revision');
      const json = this.serialize(value);
      return this.write(key, expectedRevision, json, Buffer.byteLength(json), condition);
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

  /** Trusted owner-only binding, never part of StateStore or given to native
   * code. The namespace comes from this real Host scope and the key is fixed. */
  bindCommit(key:string):(expectedRevision:number,value:StateValue)=>StateRecord {
    this.key(key);
    return (expectedRevision,value)=>{
      this.current();
      if(!this.store.db.isTransaction)throw new StateError('invalid_condition');
      if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new StateError('invalid_revision');
      const json=this.serialize(value);
      return this.write(key,expectedRevision,json,Buffer.byteLength(json),undefined,true);
    };
  }

  private write(key: string, expectedRevision: number | null, json: string, bytes: number, condition?: StateWriteCondition, joined=false): StateRecord {
    const db = this.store.db, now = new Date().toISOString(), keyBytes = Buffer.byteLength(key);
    if(!joined)db.exec('BEGIN IMMEDIATE');
    try {
      this.current();
      if (condition) {
        const source = db.prepare("SELECT COALESCE(json_extract(json,'$.syncScopeVersion'),0) version,json_extract(json,'$.enabled') enabled FROM source_connections WHERE id=? AND json_extract(json,'$.kind') IN (SELECT value FROM json_each(?))").get(condition.sourceId,JSON.stringify(this.sourceKinds));
        if (!source || source.enabled !== 1 || source.version !== condition.syncScopeVersion) throw new StateError('condition_failed');
      }
      const existing = this.row(key);
      const usage = db.prepare(`SELECT COALESCE(SUM(bytes + length(CAST(key AS BLOB))),0) AS bytes, COUNT(*) AS records
        FROM plugin_instance_state WHERE package_id=? AND installation_id=? AND instance_id=?`).get(...this.values()) as {bytes: number; records: number};
      const prior = existing ? Number(existing.bytes) + Buffer.byteLength(String(existing.key)) : 0;
      const namespaceDelta = keyBytes + bytes - prior;
      if (Number(usage.bytes) + namespaceDelta > this.limits.namespaceBytes || (!existing && Number(usage.records) >= this.limits.namespaceRecords)) {
        throw new StateError('namespace_limit');
      }
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
      if(!joined)db.exec('COMMIT');
      return {key, value: JSON.parse(json) as StateValue, revision, bytes, updatedAt: now};
    } catch (error) {
      if (!joined&&db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
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
    try { this.ownerCurrent();this.scope.assertCurrent(); }
    catch { throw new StateError('stale_scope'); }
  }

  private admit<T>(work: () => T): Promise<T> {
    if (this.scope.signal.aborted) return Promise.reject(new StateError('stale_scope'));
    return this.scope.run(() => { this.current();return {value: work()}; }).then(result => {
      if (!result) throw new StateError('quiesced');
      return result.value;
    }, error => {
      if ((error as {code?: string})?.code === 'stale_scope') throw new StateError('stale_scope');
      throw error;
    });
  }
}

const joinedCommits=new WeakMap<StateStore,(key:string)=>(expectedRevision:number,value:StateValue)=>StateRecord>();

/** Vault-owned storage root. The returned object has only the four public state
 * operations; neither its prototype nor own properties expose the backend,
 * namespace, HostScope or an atomic writer. */
export function createVaultInstanceState(store:Store,scope:HostScope,ownerCurrent:()=>void,limits:StateLimits=stateLimits,sourceKinds:readonly string[]=[]):StateStore {
  const state=new InstanceState(store,scope,ownerCurrent,limits,Object.freeze([...sourceKinds]));
  const facade:StateStore=Object.freeze({get:state.get.bind(state),list:state.list.bind(state),compareAndSet:state.compareAndSet.bind(state),checkpoint:state.checkpoint.bind(state)});
  joinedCommits.set(facade,state.bindCommit.bind(state));return facade;
}

/** Host-only fixed-key binding. Copies and lookalike state objects cannot acquire
 * it; the existing owner still checks its exact transaction, CAS and limits. */
export function bindInstanceStateCommit(state:StateStore,key:string):(expectedRevision:number,value:StateValue)=>StateRecord {
  const bind=joinedCommits.get(state);if(!bind)throw new StateError('invalid_namespace');return bind(key);
}
