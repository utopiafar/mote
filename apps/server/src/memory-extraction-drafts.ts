import type {QueryResult} from '@mote/shared';
import type {Store} from './store.js';

/** Private, bounded stage output. Never indexed, served as evidence, or a Memory verdict. */
export class MemoryExtractionDrafts {
  constructor(private store:Store,private maxBytes=8*1024*1024,private maxEntries=128){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_extraction_drafts(
      batch_id TEXT PRIMARY KEY REFERENCES memory_batches(id) ON DELETE CASCADE,
      input_hash TEXT NOT NULL,json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS memory_draft_batch_terminal AFTER UPDATE OF json ON memory_batches
        WHEN json_extract(new.json,'$.status') IN ('completed','invalidated') BEGIN
        DELETE FROM memory_extraction_drafts WHERE batch_id=new.id; END;
      CREATE TRIGGER IF NOT EXISTS memory_draft_dependency_removed AFTER DELETE ON memory_batch_dependencies BEGIN
        DELETE FROM memory_extraction_drafts WHERE batch_id=old.batch_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_draft_job_cancelled AFTER UPDATE OF json ON memory_jobs
        WHEN json_extract(new.json,'$.status')='cancelled' BEGIN
        DELETE FROM memory_extraction_drafts WHERE batch_id IN (SELECT id FROM memory_batches WHERE job_id=new.id); END;`);
  }
  get(batchId:string,inputHash:string):QueryResult|undefined {
    const row=this.store.db.prepare('SELECT input_hash,json FROM memory_extraction_drafts WHERE batch_id=?').get(batchId);
    if(!row)return;
    if(row.input_hash!==inputHash){this.clear(batchId);return;}
    return JSON.parse(String(row.json));
  }
  /** Caller supplies the active execution fence and host validation transaction. */
  put(batchId:string,inputHash:string,result:QueryResult){
    // Reusing generation does not create another call, trace or usage receipt.
    const json=JSON.stringify({answer:result.answer,citations:result.citations,runId:result.runId,trace:[]}),bytes=Buffer.byteLength(json);
    this.clear(batchId);
    if(bytes>Math.min(this.maxBytes,512*1024))return;
    const rows=this.store.db.prepare('SELECT batch_id,length(CAST(json AS BLOB)) bytes FROM memory_extraction_drafts ORDER BY created_at,rowid').all();
    let total=rows.reduce((sum,row)=>sum+Number(row.bytes),0),count=rows.length;
    for(const row of rows){if(total+bytes<=this.maxBytes&&count<this.maxEntries)break;this.clear(String(row.batch_id));total-=Number(row.bytes);count--;}
    this.store.reserveMetadata(bytes+256);
    this.store.db.prepare('INSERT INTO memory_extraction_drafts VALUES(?,?,?,?)').run(batchId,inputHash,json,Date.now());
  }
  clear(batchId:string){this.store.db.prepare('DELETE FROM memory_extraction_drafts WHERE batch_id=?').run(batchId);}
}
