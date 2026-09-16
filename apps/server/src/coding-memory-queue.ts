import type {Store} from './store.js';
import {sha256} from './store.js';
import type {MemoryPipeline} from './memory-pipeline.js';

/** A transactional inbox, not a high-water mark: an old failed item cannot be skipped by a newer success. */
export class CodingMemoryQueue {
  private timer?:ReturnType<typeof setInterval>;
  constructor(private store:Store,private pipeline:MemoryPipeline,private configured:()=>boolean,private settleMs=60000){
    store.db.exec('CREATE TABLE IF NOT EXISTS coding_memory_inbox(evidence_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,group_key TEXT NOT NULL,ready_at INTEGER NOT NULL)');
  }
  /** Called inside the source ingestion transaction, including replayed acknowledgements. */
  stage(id:string):void {
    const record=this.store.evidence([id])[0],coding=record?.provenance?.document?.coding;
    if(!coding||!record.ocrText||record.provenance?.deleted||record.provenance?.layer==='reference')return;
    const key=sha256(JSON.stringify([record.provenance?.sourceId,coding.provider,coding.projectKey,coding.sessionId]));
    if(this.store.db.prepare('SELECT 1 FROM coding_memory_inbox WHERE evidence_id=?').get(id))return;
    // A replay after enqueueing a durable job need not start another extraction.
    if(this.store.db.prepare('SELECT 1 FROM memory_batch_dependencies WHERE evidence_id=? LIMIT 1').get(id))return;
    this.store.db.prepare('INSERT INTO coding_memory_inbox VALUES(?,?,?)').run(id,key,Date.now()+this.settleMs);
    this.store.db.prepare('UPDATE coding_memory_inbox SET ready_at=? WHERE group_key=?').run(Date.now()+this.settleMs,key);
  }
  start(){this.timer=setInterval(()=>{try{this.drain();}catch{/* Inbox remains durable; next tick retries. */}},15000);this.timer.unref();}
  drain(now=Date.now()):string[] {
    if(!this.configured())return [];
    const groups=this.store.db.prepare('SELECT group_key FROM coding_memory_inbox GROUP BY group_key HAVING MAX(ready_at)<=? ORDER BY MIN(rowid) LIMIT 4').all(now) as {group_key:string}[];
    const jobs:string[]=[];
    for(const group of groups){
      const rows=this.store.db.prepare('SELECT evidence_id FROM coding_memory_inbox WHERE group_key=? ORDER BY rowid LIMIT 2000').all(group.group_key) as {evidence_id:string}[];
      const ids=rows.map(r=>r.evidence_id).filter(id=>this.store.isCurrentEvidence(id));
      if(ids.length){const job=this.pipeline.create({evidenceIds:ids,originKey:'coding:'+sha256(JSON.stringify(ids))});jobs.push(job.id);void this.pipeline.run(job.id).catch(()=>{});}
      // Creating the idempotent job before acknowledging the inbox is crash-safe.
      this.store.db.exec('BEGIN IMMEDIATE');
      try{for(const row of rows)this.store.db.prepare('DELETE FROM coding_memory_inbox WHERE evidence_id=?').run(row.evidence_id);this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}
    }
    return jobs;
  }
  close(){if(this.timer)clearInterval(this.timer);}
}
