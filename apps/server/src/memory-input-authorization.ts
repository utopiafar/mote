import {z} from 'zod';
import type {Store} from './store.js';
import {memoryRecipeScope,type MemoryRecipeSettings} from './memory-recipe-settings.js';
import {memoryRecipeBindingSchema,type MemoryRecipeBinding} from './memory-strategy-contract.js';

export const DEFAULT_MEMORY_INPUT_SCOPE='memory.default';
const scope=z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/@-]*$/);
const identity=z.object({sourceId:z.string().min(1).max(256),inputKey:z.string().min(1).max(256),captureId:z.string().uuid().optional(),scope:scope.default(DEFAULT_MEMORY_INPUT_SCOPE)}).strict();
type Identity=z.input<typeof identity>;
export const automaticMemoryGrantSchema=z.object({sourceId:z.string().min(1).max(256),inputKey:z.string().min(1).max(256),scope}).strict();
export type AutomaticMemoryGrant=z.infer<typeof automaticMemoryGrantSchema>;
export type MemoryInputGrant={scope:string;binding?:MemoryRecipeBinding;contextTime:string;authorized:boolean};

/** A host receipt authorizes one automatic job per explicitly enabled scope.
 * No source timestamp, derived revision or retry can issue or renew this grant. */
export class MemoryInputAuthorization {
  constructor(private readonly store:Store,private readonly enabled=()=>false,private readonly now=Date.now,private readonly recipes?:MemoryRecipeSettings){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_input_authorizations(
      source_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      input_key TEXT NOT NULL,scope TEXT NOT NULL,capture_id TEXT REFERENCES captures(id) ON DELETE CASCADE,
      authorized INTEGER NOT NULL,received_at INTEGER NOT NULL,job_id TEXT,binding_json TEXT,revoked_at INTEGER,
      PRIMARY KEY(source_id,input_key,scope));
      CREATE INDEX IF NOT EXISTS memory_input_authorizations_capture ON memory_input_authorizations(capture_id) WHERE capture_id IS NOT NULL;`);
  }
  /** Only a newly accepted raw revision calls this, inside its receive transaction.
   * Persist denied receipts too: a duplicate ACK must not acquire a later grant. */
  receive(raw:Identity,automatic=true):void {
    if(!this.store.db.isTransaction)throw Error('Memory input authorization requires the receive transaction');
    if(raw.scope===undefined&&this.recipes){
      // New scopes can only be minted by this original receipt, never duplicate
      // delivery, publication, activation or an installed plugin version.
      if(this.store.db.prepare('SELECT 1 FROM memory_input_authorizations WHERE source_id=? AND input_key=? LIMIT 1').get(raw.sourceId,raw.inputKey))return;
      const selected=this.recipes.selection(raw.sourceId),receivedAt=this.now();
      if(!selected.length)this.insert({...raw,scope:DEFAULT_MEMORY_INPUT_SCOPE},false,receivedAt);
      for(const binding of selected)this.insert({...raw,scope:memoryRecipeScope(binding)},automatic,receivedAt,binding);
      return;
    }
    this.insert(raw,automatic,this.now());
  }
  private insert(raw:Identity,automatic:boolean,receivedAt:number,binding?:MemoryRecipeBinding){
    const value=identity.parse(raw);
    if(this.store.db.prepare('SELECT 1 FROM memory_input_authorizations WHERE source_id=? AND input_key=? AND scope=?').get(value.sourceId,value.inputKey,value.scope))return;
    const json=binding?JSON.stringify(binding):null;
    this.store.reserveMetadata(Buffer.byteLength(value.sourceId+value.inputKey+value.scope+(json??''))+256);
    this.store.db.prepare('INSERT OR IGNORE INTO memory_input_authorizations(source_id,input_key,scope,capture_id,authorized,received_at,job_id,binding_json) VALUES(?,?,?,?,?,?,NULL,?)')
      .run(value.sourceId,value.inputKey,value.scope,value.captureId??null,Number(automatic&&this.enabled()),receivedAt,json);
  }
  list(sourceId:string,inputKey:string):MemoryInputGrant[]{return this.store.db.prepare('SELECT scope,binding_json,received_at,authorized,revoked_at FROM memory_input_authorizations WHERE source_id=? AND input_key=? ORDER BY rowid').all(sourceId,inputKey).map(row=>({scope:String(row.scope),binding:row.binding_json?memoryRecipeBindingSchema.parse(JSON.parse(String(row.binding_json))):undefined,contextTime:new Date(Number(row.received_at)).toISOString(),authorized:Boolean(row.authorized&&row.revoked_at===null)}));}
  revokeDisabled(){if(!this.recipes)return;for(const row of this.store.db.prepare('SELECT source_id,input_key,scope,binding_json FROM memory_input_authorizations WHERE authorized=1 AND revoked_at IS NULL').all()){
    if(!row.binding_json||!this.recipes.enabled(String(row.source_id),memoryRecipeBindingSchema.parse(JSON.parse(String(row.binding_json)))))this.store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=? WHERE source_id=? AND input_key=? AND scope=?').run(this.now(),row.source_id,row.input_key,row.scope);
  }}
  available(sourceId:string,inputKey:string,jobId?:string,scopeId=DEFAULT_MEMORY_INPUT_SCOPE):boolean {
    const row=this.store.db.prepare('SELECT authorized,job_id,revoked_at FROM memory_input_authorizations WHERE source_id=? AND input_key=? AND scope=?')
      .get(sourceId,inputKey,scopeId) as {authorized:number;job_id:string|null;revoked_at:number|null}|undefined;
    return Boolean(row?.authorized&&row.revoked_at===null&&(!row.job_id||jobId!==undefined&&row.job_id===jobId));
  }
  /** Claim atomically with the queue receipt. Recovery may reclaim only its own job. */
  claim(sourceId:string,inputKey:string,jobId:string,scopeId=DEFAULT_MEMORY_INPUT_SCOPE):boolean {
    if(!this.store.db.isTransaction)throw Error('Memory authorization claim requires a queue transaction');
    z.string().min(1).max(128).parse(jobId);
    return Boolean(this.store.db.prepare(`UPDATE memory_input_authorizations SET job_id=? WHERE source_id=? AND input_key=? AND scope=?
      AND authorized=1 AND revoked_at IS NULL AND (job_id IS NULL OR job_id=?)`).run(jobId,sourceId,inputKey,scopeId,jobId).changes);
  }
  /** Every member retains its own receipt. A failed claim cannot consume a prefix. */
  claimMany(grants:readonly AutomaticMemoryGrant[],jobId:string):boolean {
    if(!this.store.db.isTransaction)throw Error('Memory package authorization requires a queue transaction');
    const selected=grants.map(grant=>automaticMemoryGrantSchema.parse(grant)),keys=selected.map(grant=>JSON.stringify(grant));
    if(!selected.length||new Set(keys).size!==keys.length)throw Error('Invalid Memory package grants');
    if(selected.some(grant=>!this.available(grant.sourceId,grant.inputKey,jobId,grant.scope)))return false;
    this.store.db.exec('SAVEPOINT memory_package_claim');
    try{for(const grant of selected)if(!this.claim(grant.sourceId,grant.inputKey,jobId,grant.scope)){this.store.db.exec('ROLLBACK TO memory_package_claim');this.store.db.exec('RELEASE memory_package_claim');return false;}this.store.db.exec('RELEASE memory_package_claim');return true;}
    catch(error){this.store.db.exec('ROLLBACK TO memory_package_claim');this.store.db.exec('RELEASE memory_package_claim');throw error;}
  }
  forgetSource(sourceId:string):void {this.store.db.prepare('DELETE FROM memory_input_authorizations WHERE source_id=?').run(sourceId);}
}
