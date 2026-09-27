import type {QueryResult} from '@mote/shared';
import type {Store} from './store.js';

/** Private, bounded stage output. Explicit recipes may share a validated product
 * with identical generation inputs; review/checkpoint identities stay separate.
 * Never indexed, served as evidence, or treated as a Memory verdict. */
export class MemoryExtractionDrafts {
  constructor(private store:Store,private maxBytes=8*1024*1024,private maxEntries=128){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_extraction_drafts(
      batch_id TEXT PRIMARY KEY REFERENCES memory_batches(id) ON DELETE CASCADE,
      input_hash TEXT NOT NULL,json TEXT NOT NULL,created_at INTEGER NOT NULL,shared INTEGER NOT NULL DEFAULT 0);`);
    if(!(store.db.prepare('PRAGMA table_info(memory_extraction_drafts)').all() as {name:string}[]).some(c=>c.name==='shared'))store.db.exec('ALTER TABLE memory_extraction_drafts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0');
    store.db.exec(`CREATE INDEX IF NOT EXISTS memory_drafts_shared ON memory_extraction_drafts(input_hash) WHERE shared=1;
      DROP TRIGGER IF EXISTS memory_draft_batch_terminal;
      CREATE TRIGGER IF NOT EXISTS memory_draft_batch_terminal AFTER UPDATE OF json ON memory_batches
        WHEN json_extract(new.json,'$.status') IN ('completed','invalidated') BEGIN
        DELETE FROM memory_extraction_drafts WHERE batch_id=new.id AND (shared=0 OR json_extract(new.json,'$.status')='invalidated'); END;
      CREATE TRIGGER IF NOT EXISTS memory_draft_dependency_removed AFTER DELETE ON memory_batch_dependencies BEGIN
        DELETE FROM memory_extraction_drafts WHERE batch_id=old.batch_id; END;
      DROP TRIGGER IF EXISTS memory_draft_job_cancelled;
      CREATE TRIGGER memory_draft_job_cancelled AFTER UPDATE OF json ON memory_jobs
        WHEN json_extract(new.json,'$.status')='cancelled' BEGIN
        DELETE FROM memory_extraction_drafts WHERE shared=0 AND batch_id IN (SELECT id FROM memory_batches WHERE job_id=new.id); END;`);
  }
  // Cancellation ends a consumer's work, not an already validated shared stage.
  // Other consumers still need their own admission, exact input hash and review.
  // Evidence invalidation/deletion and bounded eviction remove shared drafts;
  // the cancelled producer cannot add or update them after its fence closes.
  get(batchId:string,inputHash:string,shared=false):QueryResult|undefined {
    if(shared){const common=this.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE input_hash=? AND shared=1 LIMIT 1').get(inputHash);if(common)return JSON.parse(String(common.json));}
    const row=this.store.db.prepare('SELECT input_hash,json FROM memory_extraction_drafts WHERE batch_id=?').get(batchId);
    if(!row)return;
    if(row.input_hash!==inputHash){this.clear(batchId);return;}
    return JSON.parse(String(row.json));
  }
  /** Caller supplies the active execution fence and host validation transaction. */
  put(batchId:string,inputHash:string,result:QueryResult,shared=false){
    if(shared&&this.store.db.prepare('SELECT 1 FROM memory_extraction_drafts WHERE input_hash=? AND shared=1').get(inputHash))return;
    // Reusing generation does not create another call, trace or usage receipt.
    const json=JSON.stringify({answer:result.answer,citations:result.citations,runId:result.runId,trace:[]}),bytes=Buffer.byteLength(json);
    this.clear(batchId);
    if(bytes>Math.min(this.maxBytes,512*1024))return;
    const rows=this.store.db.prepare('SELECT batch_id,length(CAST(json AS BLOB)) bytes FROM memory_extraction_drafts ORDER BY created_at,rowid').all();
    let total=rows.reduce((sum,row)=>sum+Number(row.bytes),0),count=rows.length;
    for(const row of rows){if(total+bytes<=this.maxBytes&&count<this.maxEntries)break;this.clear(String(row.batch_id));total-=Number(row.bytes);count--;}
    this.store.reserveMetadata(bytes+256);
    this.store.db.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?,?,?,?)').run(batchId,inputHash,json,Date.now(),Number(shared));
  }
  clear(batchId:string){this.store.db.prepare('DELETE FROM memory_extraction_drafts WHERE batch_id=?').run(batchId);}
}
