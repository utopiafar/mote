import {z} from 'zod';
import type {Store} from './store.js';

export const DEFAULT_MEMORY_INPUT_SCOPE='memory.default';
const scope=z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/@-]*$/);
const identity=z.object({sourceId:z.string().min(1).max(256),inputKey:z.string().min(1).max(256),captureId:z.string().uuid().optional(),scope:scope.default(DEFAULT_MEMORY_INPUT_SCOPE)}).strict();
type Identity=z.input<typeof identity>;

/** A host receipt authorizes one automatic job per explicitly enabled scope.
 * No source timestamp, derived revision or retry can issue or renew this grant. */
export class MemoryInputAuthorization {
  constructor(private readonly store:Store,private readonly enabled=()=>false,private readonly now=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_input_authorizations(
      source_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      input_key TEXT NOT NULL,scope TEXT NOT NULL,capture_id TEXT REFERENCES captures(id) ON DELETE CASCADE,
      authorized INTEGER NOT NULL,received_at INTEGER NOT NULL,job_id TEXT,
      PRIMARY KEY(source_id,input_key,scope));
      CREATE INDEX IF NOT EXISTS memory_input_authorizations_capture ON memory_input_authorizations(capture_id) WHERE capture_id IS NOT NULL;`);
  }
  /** Only a newly accepted raw revision calls this, inside its receive transaction.
   * Persist denied receipts too: a duplicate ACK must not acquire a later grant. */
  receive(raw:Identity,automatic=true):void {
    if(!this.store.db.isTransaction)throw Error('Memory input authorization requires the receive transaction');
    const value=identity.parse(raw);
    if(this.store.db.prepare('SELECT 1 FROM memory_input_authorizations WHERE source_id=? AND input_key=? AND scope=?').get(value.sourceId,value.inputKey,value.scope))return;
    this.store.reserveMetadata(Buffer.byteLength(value.sourceId+value.inputKey+value.scope)+256);
    this.store.db.prepare('INSERT OR IGNORE INTO memory_input_authorizations VALUES(?,?,?,?,?,?,NULL)')
      .run(value.sourceId,value.inputKey,value.scope,value.captureId??null,Number(automatic&&this.enabled()),this.now());
  }
  available(sourceId:string,inputKey:string,jobId?:string,scopeId=DEFAULT_MEMORY_INPUT_SCOPE):boolean {
    const row=this.store.db.prepare('SELECT authorized,job_id FROM memory_input_authorizations WHERE source_id=? AND input_key=? AND scope=?')
      .get(sourceId,inputKey,scopeId) as {authorized:number;job_id:string|null}|undefined;
    return Boolean(row?.authorized&&(!row.job_id||jobId!==undefined&&row.job_id===jobId));
  }
  /** Claim atomically with the queue receipt. Recovery may reclaim only its own job. */
  claim(sourceId:string,inputKey:string,jobId:string,scopeId=DEFAULT_MEMORY_INPUT_SCOPE):boolean {
    if(!this.store.db.isTransaction)throw Error('Memory authorization claim requires a queue transaction');
    z.string().min(1).max(128).parse(jobId);
    return Boolean(this.store.db.prepare(`UPDATE memory_input_authorizations SET job_id=? WHERE source_id=? AND input_key=? AND scope=?
      AND authorized=1 AND (job_id IS NULL OR job_id=?)`).run(jobId,sourceId,inputKey,scopeId,jobId).changes);
  }
  forgetSource(sourceId:string):void {this.store.db.prepare('DELETE FROM memory_input_authorizations WHERE source_id=?').run(sourceId);}
}
