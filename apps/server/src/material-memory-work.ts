import {z} from 'zod';
import type {Store} from './store.js';
import type {MaterialStore} from './materials.js';
import {materialDependencyStatus} from './material-readiness.js';

const requiredSchema=z.array(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/)).min(1).max(64)
  .refine(values=>new Set(values).size===values.length,'Duplicate material dependency');
type WorkRow={material_id:string;revision:string;required_json:string;ready_at:number;job_id:string|null;error:string|null};
type RevocationRow={job_id:string};
const TERMINAL_AT=Number.MAX_SAFE_INTEGER,RESUME_DELAY_MS=5000,RETRY_DELAY_MS=60000;

export type MaterialMemoryRunner={
  create:(input:{evidenceIds:string[];originKey:string})=>{id:string};
  get:(id:string)=>{status:string};
  run:(id:string)=>Promise<unknown>;
  cancel:(id:string)=>unknown;
};

/** Durable, revision-pinned Memory admission for materials stored outside the
 * archive pipeline. Query publication is independent of this queue. */
export class MaterialMemoryWork {
  private readonly active=new Set<string>();
  constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly now=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS material_memory_requests(
      material_id TEXT PRIMARY KEY,revision TEXT NOT NULL,required_json TEXT NOT NULL,ready_at INTEGER NOT NULL,
      job_id TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS material_memory_requests_due ON material_memory_requests(ready_at,job_id);
      CREATE TABLE IF NOT EXISTS material_memory_revocations(job_id TEXT PRIMARY KEY,material_id TEXT NOT NULL,revision TEXT NOT NULL);`);
  }
  private row(materialId:string):WorkRow|undefined {
    return this.store.db.prepare('SELECT * FROM material_memory_requests WHERE material_id=?').get(materialId) as WorkRow|undefined;
  }
  private transaction<T>(run:()=>T):T {
    const db=this.store.db,own=!db.isTransaction;
    if(own)db.exec('BEGIN IMMEDIATE');
    try{const result=run();if(own)db.exec('COMMIT');return result;}
    catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  private revoke(row:WorkRow){
    if(row.job_id)this.store.db.prepare('INSERT OR IGNORE INTO material_memory_revocations VALUES(?,?,?)').run(row.job_id,row.material_id,row.revision);
  }
  /** Call in the same fenced transaction as material publish. A new revision
   * invalidates the old queue entry and durably requests old-job cancellation. */
  observe(materialId:string,required:readonly string[],settleMs=0):void {
    const keys=requiredSchema.parse([...required]);
    if(!Number.isSafeInteger(settleMs)||settleMs<0||settleMs>7*86400000)throw Error('Invalid material Memory settle delay');
    const material=this.materials.get(materialId);
    if(!material){this.withdraw(materialId);return;}
    const requiredJson=JSON.stringify(keys),readyAt=this.now()+settleMs;
    this.transaction(()=>{
      const prior=this.row(materialId);
      if(prior?.revision===material.revision&&prior.required_json===requiredJson)return;
      if(prior)this.revoke(prior);
      this.store.db.prepare(`INSERT INTO material_memory_requests VALUES(?,?,?, ?,NULL,NULL)
        ON CONFLICT(material_id) DO UPDATE SET revision=excluded.revision,required_json=excluded.required_json,
          ready_at=excluded.ready_at,job_id=NULL,error=NULL`).run(materialId,material.revision,requiredJson,readyAt);
    });
  }
  /** Retire/forget or an explicit policy disable revokes a pending old job. */
  withdraw(materialId:string):void {
    this.transaction(()=>{const prior=this.row(materialId);if(prior)this.revoke(prior);
      this.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=?').run(materialId);});
  }
  /** Used only for source-item Material memory exposure. A ref to any old
   * revision, an unconfigured dependency, or a missing text anchor fails closed. */
  readyForMemory(ref:string):boolean {
    try{
      const pinned=this.materials.get(ref);if(!pinned)return false;
      const current=this.materials.get(pinned.id);if(!current||current.revision!==pinned.revision)return false;
      const row=this.row(pinned.id);if(!row||row.revision!==pinned.revision)return false;
      const required=requiredSchema.parse(JSON.parse(row.required_json));
      return materialDependencyStatus(current,required).ready&&
        this.materials.evidenceIds(current.ref).some(id=>this.materials.isCurrentEvidence(id));
    }catch{return false;}
  }
  private launch(runner:MaterialMemoryRunner,id:string){
    if(this.active.has(id))return;
    this.active.add(id);
    void Promise.resolve().then(()=>runner.run(id)).catch(()=>{
      this.store.db.prepare("UPDATE material_memory_requests SET error='memory_run_failed' WHERE job_id=?").run(id);
    }).finally(()=>this.active.delete(id));
  }
  /** Call periodically and after restart. create(originKey=material.ref) is
   * idempotent, so a crash between job creation and queue receipt reuses it. */
  drain(runner:MaterialMemoryRunner,enabled:boolean,limit=10):number {
    if(!enabled)return 0;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid material Memory drain limit');
    const db=this.store.db;
    for(const row of db.prepare('SELECT job_id FROM material_memory_revocations ORDER BY rowid LIMIT ?').all(limit) as RevocationRow[]){
      try{runner.cancel(row.job_id);db.prepare('DELETE FROM material_memory_revocations WHERE job_id=?').run(row.job_id);}
      catch{return 0;}
    }
    let started=0;
    // Existing receipts are drained separately. Completed jobs remain as access
    // grants, but must never consume a fresh-job slot on every timer tick.
    for(const row of db.prepare('SELECT * FROM material_memory_requests WHERE job_id IS NOT NULL AND ready_at<=? ORDER BY ready_at,material_id LIMIT ?').all(this.now(),limit) as WorkRow[]){
      const material=this.materials.get(row.material_id);
      if(!material){this.withdraw(row.material_id);continue;}
      if(material.revision!==row.revision){this.observe(row.material_id,requiredSchema.parse(JSON.parse(row.required_json)));continue;}
      if(!this.readyForMemory(material.ref)){
        this.withdraw(row.material_id);
        continue;
      }
      let status:string;
      try{status=runner.get(row.job_id!).status;}catch{
        db.prepare('UPDATE material_memory_requests SET job_id=NULL,error=NULL WHERE material_id=? AND revision=?').run(row.material_id,row.revision);continue;
      }
      if(status==='completed')db.prepare('UPDATE material_memory_requests SET ready_at=?,error=NULL WHERE material_id=? AND revision=?').run(TERMINAL_AT,row.material_id,row.revision);
      else if(['queued','running','waiting_for_model'].includes(status)){
        db.prepare('UPDATE material_memory_requests SET ready_at=? WHERE material_id=? AND revision=?').run(this.now()+RESUME_DELAY_MS,row.material_id,row.revision);
        this.launch(runner,row.job_id!);started++;
      }else db.prepare('UPDATE material_memory_requests SET ready_at=?,error=? WHERE material_id=? AND revision=?').run(
        TERMINAL_AT,['failed','cancelled','paused','pausing'].includes(status)?`memory_job_${status}`:'memory_job_unavailable',row.material_id,row.revision);
    }
    for(const row of db.prepare('SELECT * FROM material_memory_requests WHERE job_id IS NULL AND ready_at<=? ORDER BY ready_at,material_id LIMIT ?').all(this.now(),limit) as WorkRow[]){
      const material=this.materials.get(row.material_id);
      if(!material){this.withdraw(row.material_id);continue;}
      if(material.revision!==row.revision){this.observe(row.material_id,requiredSchema.parse(JSON.parse(row.required_json)));continue;}
      if(!this.readyForMemory(material.ref)){
        db.prepare('UPDATE material_memory_requests SET ready_at=? WHERE material_id=? AND revision=?').run(this.now()+RETRY_DELAY_MS,row.material_id,row.revision);
        continue;
      }
      const evidenceIds=this.materials.evidenceIds(material.ref);
      if(!evidenceIds.length){db.prepare('UPDATE material_memory_requests SET ready_at=? WHERE material_id=? AND revision=?').run(this.now()+RETRY_DELAY_MS,row.material_id,row.revision);continue;}
      let job:{id:string};
      try{job=runner.create({evidenceIds,originKey:material.ref});}
      catch{db.prepare("UPDATE material_memory_requests SET error='memory_enqueue_failed',ready_at=? WHERE material_id=? AND revision=?").run(this.now()+RETRY_DELAY_MS,row.material_id,row.revision);continue;}
      if(!this.readyForMemory(material.ref)){
        db.prepare('INSERT OR IGNORE INTO material_memory_revocations VALUES(?,?,?)').run(job.id,row.material_id,row.revision);continue;
      }
      const claimed=db.prepare('UPDATE material_memory_requests SET job_id=?,error=NULL WHERE material_id=? AND revision=? AND job_id IS NULL').run(job.id,row.material_id,row.revision).changes;
      if(!claimed){db.prepare('INSERT OR IGNORE INTO material_memory_revocations VALUES(?,?,?)').run(job.id,row.material_id,row.revision);continue;}
      // create() may return a completed or failed receipt after a crash before
      // this queue stored its job id. Never run that receipt a second time.
      let status:string;
      try{status=runner.get(job.id).status;}catch{status='unavailable';}
      if(status==='completed')db.prepare('UPDATE material_memory_requests SET ready_at=? WHERE material_id=? AND revision=?').run(TERMINAL_AT,row.material_id,row.revision);
      else if(['queued','running','waiting_for_model'].includes(status)){this.launch(runner,job.id);started++;}
      else db.prepare('UPDATE material_memory_requests SET ready_at=?,error=? WHERE material_id=? AND revision=?').run(
        TERMINAL_AT,['failed','cancelled','paused','pausing'].includes(status)?`memory_job_${status}`:'memory_job_unavailable',row.material_id,row.revision);
    }
    return started;
  }
}
