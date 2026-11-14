import {randomUUID} from 'node:crypto';
import {operationStateSchema,type OperationState,type EvidenceDependencies} from '@mote/shared';
import {z} from 'zod';
import {StoreError,sha256,type Store} from './store.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {addTaskEvidence,installTaskEvidence,retireTaskRecordsSql,taskEvidenceIds,validateTaskDependencies} from './task-evidence.js';

/** Server-local task metadata, not a second assistant DTO or execution engine.
 * Scope, origin, model choice and domain input stay in the caller's existing
 * typed input. Public wire definitions belong to the shared contract. */
export type TaskRecord={id:string;operationId:string;kind:string;state:OperationState;revision:number;createdAt:string;updatedAt:string};
type Row={id:string;operation_id:string;kind:string;state:OperationState;revision:number;request_hash:string;input_json:string|null;result_json:string|null;created_at:string;updated_at:string};
/** Scope/domain owners synchronously check current permissions and pinned versions here,
 * inside the same transaction as the read/write. A receipt is no authorization. */
export type AssertTaskCurrent=(evidenceIds:readonly string[])=>void;
const identity=z.string().min(1).max(512);
const metadata=(row:Row):TaskRecord=>({id:row.id,operationId:row.operation_id,kind:row.kind,state:row.state,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at});
const terminal=(state:OperationState)=>['succeeded','cancelled','stale','skipped'].includes(state);
function checkCurrent(assertCurrent:AssertTaskCurrent,ids:readonly string[]){
  const result:unknown=assertCurrent(ids);
  if(result!==undefined){
    // A Promise must never be mistaken for a completed authorization check.
    void Promise.resolve(result).catch(()=>{});
    throw new StoreError('Task current-state validation must complete synchronously',409);
  }
}

/** Called by EvidenceStore after its private storage and quota ledger exist.
 * All bodies live in the vault database, so stopped full backups include them
 * and retain the existing separate content-key recovery requirement. */
export function installTaskRecords(store:Store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_records(
    id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
    revision INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
    input_json TEXT,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_records_operation ON task_records(operation_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS task_records_recent ON task_records(created_at DESC,id DESC);`);
  installTaskEvidence(store);
  store.registerStorage('task-records',{
    task_records:'length(CAST(id AS BLOB))+length(CAST(operation_id AS BLOB))+length(CAST(kind AS BLOB))+length(CAST(request_id AS BLOB))+length(CAST(request_hash AS BLOB))+coalesce(length(CAST(input_json AS BLOB)),0)+coalesce(length(CAST(result_json AS BLOB)),0)+256',
    task_evidence:'length(CAST(task_id AS BLOB))+length(CAST(evidence_id AS BLOB))+64',
  });
}

/** Owner-only durable requests/products. No logging, indexing, original-evidence
 * export, authorization minting, queue, retry policy or automatic model call. */
export class TaskRecords {
  constructor(private readonly store:Store,private readonly now=()=>new Date().toISOString()){}

  // Own writes reserve the writer before reading; a deferred snapshot cannot
  // upgrade after another process commits. Nested writes retain savepoints so
  // a caller can catch quota/write failures without keeping a half task.
  // Private reads keep a read snapshot without reserving the vault writer.
  private transaction<T>(run:()=>T,mode:'read'|'write'='write'):T{
    const db=this.store.db,own=mode==='write'&&!db.isTransaction;
    db.exec(own?'BEGIN IMMEDIATE':'SAVEPOINT task_records_write');
    try{const value=run();db.exec(own?'COMMIT':'RELEASE task_records_write');return value;}
    catch(error){if(own){if(db.isTransaction)db.exec('ROLLBACK');}else db.exec('ROLLBACK TO task_records_write; RELEASE task_records_write');throw error;}
  }
  private row(id:string):Row{
    const row=this.store.db.prepare('SELECT * FROM task_records WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new StoreError('Task record not found',404);return row;
  }
  private current(id:string,expectedRevision:number){
    const row=this.row(id);
    if(!Number.isSafeInteger(expectedRevision)||row.revision!==expectedRevision||row.state==='stale'||row.state==='cancelled')
      throw new StoreError('Task record changed; reload before continuing',409);
    return row;
  }
  private normalize(value:unknown){
    // JSON round-trip strips undefined consistently before hashing or storage.
    // Validation errors never include the private value or a parser excerpt.
    let plain:string;
    try{plain=JSON.stringify(value);if(plain===undefined)throw Error();JSON.parse(plain);}
    catch{throw new StoreError('Task payload must be JSON');}
    if(Buffer.byteLength(plain)>2_000_000)throw new StoreError('Task payload is too large',413);
    return JSON.parse(plain) as unknown;
  }
  private dependencies(id:string){return this.store.db.prepare('SELECT evidence_id FROM task_evidence WHERE task_id=? ORDER BY evidence_id').all(id).map(row=>String(row.evidence_id));}

  create(input:{operationId:string;kind:string;requestId:string;input:unknown;evidenceDependencies:EvidenceDependencies},assertCurrent:AssertTaskCurrent):TaskRecord{
    const operationId=identity.parse(input.operationId),kind=identity.parse(input.kind),requestId=identity.parse(input.requestId);
    return this.transaction(()=>{
      const payload=this.normalize(input.input),dependencies=validateTaskDependencies(input.evidenceDependencies);
      const hash=sha256(canonicalRecipeJson({operationId,kind,input:payload,evidenceDependencies:dependencies}));
      const prior=this.store.db.prepare('SELECT * FROM task_records WHERE request_id=?').get(requestId) as Row|undefined;
      if(prior){if(prior.request_hash!==hash)throw new StoreError('Task request ID was reused with different content',409);return metadata(prior);}
      const ids=taskEvidenceIds(this.store,dependencies);checkCurrent(assertCurrent,ids);
      const encoded=encodeMemoryPrivate(this.store,payload);
      const id=randomUUID(),now=this.now();
      // Meter actual inserted rows too, so future meter changes cannot silently
      // bypass quota. The savepoint rolls every row back on a failed reservation.
      this.store.reserveMetadata(0);
      this.store.db.prepare(`INSERT INTO task_records VALUES(?,?,?,'waiting',1,?,?,?,NULL,?,?)`).run(id,operationId,kind,requestId,hash,encoded,now,now);
      addTaskEvidence(this.store,id,ids);this.store.reserveMetadata(0);
      return metadata(this.row(id));
    });
  }
  get(id:string):TaskRecord{return metadata(this.row(id));}

  /** A not-yet-started input may gain a deterministic readiness projection.
   * Its identity is unchanged; current dependencies and private bytes are
   * replaced atomically. Running or completed inputs remain immutable. */
  replaceWaitingInput(id:string,expectedRevision:number,input:unknown,rawDependencies:EvidenceDependencies,assertCurrent:AssertTaskCurrent):TaskRecord{
    return this.transaction(()=>{
      const row=this.current(id,expectedRevision);if(row.kind!=='assistant.change'||row.state!=='waiting')throw new StoreError('Task input cannot be refreshed',409);
      const payload=this.normalize(input),dependencies=validateTaskDependencies(rawDependencies),ids=taskEvidenceIds(this.store,dependencies);
      checkCurrent(assertCurrent,ids);this.current(id,expectedRevision);
      const encoded=encodeMemoryPrivate(this.store,payload),hash=sha256(canonicalRecipeJson({operationId:row.operation_id,kind:row.kind,input:payload,evidenceDependencies:dependencies}));
      this.store.db.prepare('UPDATE task_records SET input_json=?,request_hash=?,revision=revision+1,updated_at=? WHERE id=?').run(encoded,hash,this.now(),id);
      this.store.db.prepare('DELETE FROM task_evidence WHERE task_id=?').run(id);addTaskEvidence(this.store,id,ids);
      this.store.reserveMetadata(0);return this.get(id);
    });
  }

  /** Stable creation ordering: status changes do not move records across pages. */
  page(args:{operationId?:string;state?:OperationState;limit?:number;cursor?:string}={}){
    const selected=z.object({operationId:identity.optional(),state:operationStateSchema.optional(),limit:z.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict().parse(args);
    const where:string[]=[],values:(string|number)[]=[];
    if(selected.operationId!==undefined){where.push('operation_id=?');values.push(selected.operationId);}
    if(selected.state!==undefined){where.push('state=?');values.push(selected.state);}
    if(selected.cursor){
      let cursor:{at:string;id:string};
      try{cursor=z.object({at:z.string().datetime({offset:true}),id:z.string().uuid()}).strict().parse(JSON.parse(Buffer.from(selected.cursor,'base64url').toString()));}
      catch{throw new StoreError('Invalid task record cursor');}
      where.push('(created_at<? OR (created_at=? AND id<?))');values.push(cursor.at,cursor.at,cursor.id);
    }
    const rows=this.store.db.prepare(`SELECT id,operation_id,kind,state,revision,created_at,updated_at FROM task_records ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values,selected.limit+1) as Row[];
    const page=rows.slice(0,selected.limit),last=page.at(-1);
    return {items:page.map(metadata),nextCursor:rows.length>selected.limit&&last?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null};
  }
  byEvidence(id:string):TaskRecord[]{
    return (this.store.db.prepare('SELECT t.* FROM task_records t JOIN task_evidence e ON e.task_id=t.id WHERE e.evidence_id=? ORDER BY t.created_at DESC,t.id DESC').all(id) as Row[]).map(metadata);
  }
  /** Carry the original disclosure lineage into a later aggregate; a task ID
   * itself is never a new original or a permission grant. */
  evidenceDependencies(id:string,expectedRevision:number,assertCurrent:AssertTaskCurrent):EvidenceDependencies{
    return this.transaction(()=>{
      this.current(id,expectedRevision);const ids=this.dependencies(id);checkCurrent(assertCurrent,ids);this.current(id,expectedRevision);
      return {version:1,complete:true,ids};
    },'read');
  }
  input<T>(id:string,expectedRevision:number,assertCurrent:AssertTaskCurrent):T{
    return this.transaction(()=>{
      const row=this.current(id,expectedRevision);checkCurrent(assertCurrent,this.dependencies(id));this.current(id,expectedRevision);
      if(row.input_json===null)throw new StoreError('Task input is no longer available',409);
      return decodeMemoryPrivate<T>(this.store,row.input_json);
    },'read');
  }
  result<T>(id:string,expectedRevision:number,assertCurrent:AssertTaskCurrent):T|undefined{
    return this.transaction(()=>{
      const row=this.current(id,expectedRevision);checkCurrent(assertCurrent,this.dependencies(id));this.current(id,expectedRevision);
      return row.result_json===null?undefined:decodeMemoryPrivate<T>(this.store,row.result_json);
    },'read');
  }
  setState(id:string,expectedRevision:number,state:OperationState):TaskRecord{
    operationStateSchema.parse(state);
    return this.transaction(()=>{
      const row=this.current(id,expectedRevision);
      if(terminal(row.state))throw new StoreError('Task record is already finished',409);
      if(state==='succeeded')throw new StoreError('Write a task result before marking success',409);
      if(state==='stale')this.store.db.prepare(retireTaskRecordsSql('SELECT id FROM task_records WHERE id=?')).run(id);
      else this.store.db.prepare('UPDATE task_records SET state=?,revision=revision+1,updated_at=? WHERE id=?').run(state,this.now(),id);
      return this.get(id);
    });
  }
  saveResult(id:string,expectedRevision:number,result:unknown,dependencies:EvidenceDependencies,assertCurrent:AssertTaskCurrent):TaskRecord{
    return this.transaction(()=>{
      const row=this.current(id,expectedRevision);
      if(terminal(row.state))throw new StoreError('Task record is already finished',409);
      const ids=[...new Set([...this.dependencies(id),...taskEvidenceIds(this.store,dependencies)])].sort();
      checkCurrent(assertCurrent,ids);this.current(id,expectedRevision);
      const encoded=encodeMemoryPrivate(this.store,this.normalize(result));
      this.store.db.prepare("UPDATE task_records SET result_json=?,state='succeeded',revision=revision+1,updated_at=? WHERE id=?").run(encoded,this.now(),id);
      addTaskEvidence(this.store,id,ids);this.store.reserveMetadata(0);
      return this.get(id);
    });
  }
}
