import {z} from 'zod';
import {sha256,StoreError,type Store} from './store.js';
import type {MaterialStore} from './materials.js';
import {materialDependencyStatus} from './material-readiness.js';
import {DEFAULT_MEMORY_INPUT_SCOPE,MemoryInputAuthorization,type AutomaticMemoryGrant} from './memory-input-authorization.js';
import type {MemoryRecipeSettings} from './memory-recipe-settings.js';
import {memoryRecipeBindingSchema,type MemoryStrategyRef} from './memory-strategy-contract.js';

const requiredSchema=z.array(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/)).min(1).max(64).refine(v=>new Set(v).size===v.length,'Duplicate material dependency');
type WorkRow={material_id:string;scope:string;revision:string;required_json:string;ready_at:number;job_id:string|null;error:string|null;input_key:string;auto_authorized:number;binding_json:string|null;context_time:string|null};
const TERMINAL_AT=Number.MAX_SAFE_INTEGER,RESUME_DELAY_MS=5000,RETRY_DELAY_MS=60000;
export type MaterialMemoryRunner={
  create:(input:{evidenceIds:string[];originKey:string;contextTime?:string;recipes?:MemoryStrategyRef[];automaticGrant?:AutomaticMemoryGrant})=>{id:string};
  get:(id:string)=>{status:string};run:(id:string)=>Promise<unknown>;cancel:(id:string)=>unknown;
};
export type MaterialMemoryObservation={inputKey:string;change:'source'|'rebuild';automatic?:boolean};

/** One common durable queue, independently scoped by selected product recipe.
 * Readiness is separate from the raw receipt's permission to run paid work. */
export class MaterialMemoryWork {
  private readonly active=new Set<string>();
  readonly inputs:MemoryInputAuthorization;
  constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly now=Date.now,private readonly automaticEnabled=()=>true,private readonly recipes?:MemoryRecipeSettings){
    this.inputs=new MemoryInputAuthorization(store,automaticEnabled,now,recipes);
    const db=store.db;
    this.transaction(()=>{
    db.exec('CREATE TABLE IF NOT EXISTS material_memory_revocations(job_id TEXT PRIMARY KEY,material_id TEXT NOT NULL,revision TEXT NOT NULL)');
    const columns=new Set(db.prepare('PRAGMA table_info(material_memory_requests)').all().map(r=>String(r.name)));
    if(columns.size&&!columns.has('scope')){
      // Preserve evidence and products, retiring only unpinned old automatic work.
      db.exec(`DROP TRIGGER IF EXISTS ledger_material_memory_requests_insert; DROP TRIGGER IF EXISTS ledger_material_memory_requests_update; DROP TRIGGER IF EXISTS ledger_material_memory_requests_delete;
        DELETE FROM storage_ledger WHERE name='material_memory_requests'; DROP TRIGGER IF EXISTS material_memory_forget; DROP INDEX IF EXISTS material_memory_requests_due;
        ALTER TABLE material_memory_requests RENAME TO material_memory_requests_previous;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS material_memory_requests(
      material_id TEXT NOT NULL,scope TEXT NOT NULL,revision TEXT NOT NULL,required_json TEXT NOT NULL,ready_at INTEGER NOT NULL,
      job_id TEXT,error TEXT,input_key TEXT NOT NULL,auto_authorized INTEGER NOT NULL,binding_json TEXT,context_time TEXT,
      PRIMARY KEY(material_id,scope));
      CREATE INDEX IF NOT EXISTS material_memory_requests_due ON material_memory_requests(ready_at,job_id);`);
    if(columns.size&&!columns.has('scope'))this.transaction(()=>{
      db.exec(`INSERT INTO material_memory_requests SELECT material_id,'memory.default',revision,required_json,ready_at,job_id,error,${columns.has('input_key')?'input_key':"''"},0,NULL,NULL FROM material_memory_requests_previous;
        INSERT OR IGNORE INTO material_memory_revocations SELECT job_id,material_id,revision FROM material_memory_requests_previous WHERE job_id IS NOT NULL;
        DROP TABLE material_memory_requests_previous;`);
    });
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_memory_work'").get())this.transaction(()=>{
      db.exec(`INSERT OR IGNORE INTO material_memory_requests SELECT material_id,'memory.default',revision,'["material"]',ready_at,job_id,error,'',0,NULL,NULL FROM material_memory_work;
        INSERT OR IGNORE INTO material_memory_revocations SELECT job_id,material_id,revision FROM material_memory_work WHERE job_id IS NOT NULL; DROP TABLE material_memory_work;`);
    });
    db.exec(`DROP TRIGGER IF EXISTS material_memory_forget;
      CREATE TRIGGER material_memory_forget BEFORE DELETE ON material_heads BEGIN
      INSERT OR IGNORE INTO material_memory_revocations SELECT job_id,material_id,revision FROM material_memory_requests WHERE material_id=old.id AND job_id IS NOT NULL;
      DELETE FROM memory_input_authorizations WHERE source_id=old.source_id AND input_key IN (SELECT input_key FROM material_memory_requests WHERE material_id=old.id);
      DELETE FROM material_memory_requests WHERE material_id=old.id; END;`);
    });
  }
  private rows(id:string){return this.store.db.prepare('SELECT * FROM material_memory_requests WHERE material_id=?').all(id) as WorkRow[];}
  private transaction<T>(run:()=>T):T{const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=run();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
  private update(row:WorkRow,set:string,values:(string|number|null)[]=[]){return this.store.db.prepare(`UPDATE material_memory_requests SET ${set} WHERE material_id=? AND scope=? AND revision=?`).run(...values,row.material_id,row.scope,row.revision);}
  private revoke(row:WorkRow){if(row.job_id)this.store.db.prepare('INSERT OR IGNORE INTO material_memory_revocations VALUES(?,?,?)').run(row.job_id,row.material_id,row.revision);}
  private available(row:WorkRow,sourceId:string,jobId?:string){
    if(row.binding_json){const binding=memoryRecipeBindingSchema.parse(JSON.parse(row.binding_json));if(!this.recipes?.enabled(sourceId,binding))return false;}
    else if(this.recipes)return false;
    return this.inputs.available(sourceId,row.input_key,jobId,row.scope);
  }
  /** Publication can continue an unused grant, never mint a new scope or renew
   * a completed raw input after deterministic reprocessing. */
  observe(materialId:string,required:readonly string[],observation:MaterialMemoryObservation,settleMs=0):void{
    const keys=requiredSchema.parse([...required]),inputKey=z.string().min(1).max(256).parse(observation.inputKey);
    if(!Number.isSafeInteger(settleMs)||settleMs<0||settleMs>7*86400000)throw Error('Invalid material Memory settle delay');
    const material=this.materials.get(materialId);if(!material){this.withdraw(materialId);return;}
    const requiredJson=JSON.stringify(keys),readyAt=this.now()+settleMs;
    this.transaction(()=>{
      const previous=this.rows(materialId),grants=this.inputs.list(material.origin.sourceId,inputKey);
      if(!grants.length)grants.push({scope:DEFAULT_MEMORY_INPUT_SCOPE,authorized:false,contextTime:new Date(this.now()).toISOString()});
      for(const row of previous)if(!grants.some(g=>g.scope===row.scope)){this.revoke(row);this.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=? AND scope=?').run(materialId,row.scope);}
      for(const grant of grants){
        const prior=previous.find(r=>r.scope===grant.scope),bindingJson=grant.binding?JSON.stringify(grant.binding):null;
        const current:WorkRow={material_id:materialId,scope:grant.scope,revision:material.revision,required_json:requiredJson,ready_at:readyAt,job_id:null,error:null,input_key:inputKey,auto_authorized:0,binding_json:bindingJson,context_time:grant.contextTime};
        const automatic=this.automaticEnabled()&&observation.automatic!==false&&grant.authorized&&this.available(current,material.origin.sourceId,prior?.job_id??undefined);
        const authorized=automatic&&(prior?.input_key===inputKey?Boolean(prior.auto_authorized&&!prior.job_id):observation.change==='source');
        if(prior?.revision===material.revision&&prior.required_json===requiredJson){
          if(!automatic&&prior.auto_authorized){this.revoke(prior);this.update(prior,'auto_authorized=0,job_id=NULL,input_key=?',[inputKey]);}
          else this.update(prior,'input_key=?,auto_authorized=?',[inputKey,prior.job_id?prior.auto_authorized:Number(authorized)]);
          continue;
        }
        if(prior)this.revoke(prior);
        this.store.reserveMetadata(Buffer.byteLength(requiredJson+(bindingJson??''))+512);
        this.store.db.prepare(`INSERT INTO material_memory_requests VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?) ON CONFLICT(material_id,scope) DO UPDATE SET
          revision=excluded.revision,required_json=excluded.required_json,ready_at=excluded.ready_at,job_id=NULL,error=NULL,input_key=excluded.input_key,auto_authorized=excluded.auto_authorized,binding_json=excluded.binding_json,context_time=excluded.context_time`)
          .run(materialId,grant.scope,material.revision,requiredJson,readyAt,inputKey,Number(authorized),bindingJson,grant.contextTime);
      }
    });
  }
  withdraw(materialId:string){this.transaction(()=>{for(const row of this.rows(materialId))this.revoke(row);this.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=?').run(materialId);});}
  readyForMemory(ref:string):boolean{
    try{const pinned=this.materials.get(ref);if(!pinned)return false;const current=this.materials.get(pinned.id);if(current?.revision!==pinned.revision)return false;
      const row=this.rows(pinned.id).find(r=>r.revision===pinned.revision);if(!row)return false;
      return materialDependencyStatus(current,requiredSchema.parse(JSON.parse(row.required_json))).ready&&this.materials.evidenceIds(current.ref).some(id=>this.materials.isCurrentEvidence(id));
    }catch{return false;}
  }
  /** Execution and commit both check this, including a retry of an old auto job. */
  authorized(job:{id:string;automaticGrant?:AutomaticMemoryGrant}):boolean{
    if(!job.automaticGrant)return true;
    const {sourceId,inputKey,scope}=job.automaticGrant;
    if(!this.automaticEnabled()||!this.inputs.available(sourceId,inputKey,job.id,scope))return false;
    const grant=this.inputs.list(sourceId,inputKey).find(g=>g.scope===scope);
    return Boolean(grant&&(!this.recipes||grant.binding&&this.recipes.enabled(sourceId,grant.binding)));
  }
  /** Selection changes revoke work, without creating receipts or deleting products. */
  reconcile(runner:MaterialMemoryRunner){
    this.inputs.revokeDisabled();
    for(const row of this.store.db.prepare('SELECT * FROM material_memory_requests WHERE auto_authorized=1').all() as WorkRow[]){
      const material=this.materials.get(row.material_id);
      if(material&&this.available(row,material.origin.sourceId,row.job_id??undefined))continue;
      this.revoke(row);this.update(row,'auto_authorized=0');
    }
    this.cancelRevocations(runner,Number.MAX_SAFE_INTEGER);
  }
  private cancelRevocations(runner:MaterialMemoryRunner,limit:number){for(const row of this.store.db.prepare('SELECT job_id FROM material_memory_revocations ORDER BY rowid LIMIT ?').all(limit)){
    try{runner.cancel(String(row.job_id));}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))return false;}
    this.store.db.prepare('DELETE FROM material_memory_revocations WHERE job_id=?').run(row.job_id);
  }return true;}
  private launch(runner:MaterialMemoryRunner,row:WorkRow,allowed:(id:string)=>boolean){
    const id=row.job_id!;if(this.active.has(id))return;this.active.add(id);
    void Promise.resolve().then(()=>{
      const current=this.rows(row.material_id).find(r=>r.scope===row.scope&&r.job_id===id&&r.auto_authorized);
      if(!current||!this.automaticEnabled()||!allowed(row.material_id))return;
      const material=this.materials.get(row.material_id);
      if(material?.revision!==current.revision||!this.readyForMemory(material.ref)||!this.available(current,material.origin.sourceId,id))return;
      return runner.run(id);
    }).catch(()=>this.update(row,"error='memory_run_failed'")).finally(()=>this.active.delete(id));
  }
  drain(runner:MaterialMemoryRunner,enabled:boolean,limit=10,allowed:(materialId:string)=>boolean=()=>true):number{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid material Memory drain limit');
    if(!this.cancelRevocations(runner,limit)||!enabled)return 0;
    let started=0;
    for(const existing of [true,false])for(const row of this.store.db.prepare(`SELECT * FROM material_memory_requests WHERE auto_authorized=1 AND job_id IS ${existing?'NOT ':''}NULL AND ready_at<=? ORDER BY ready_at,material_id,scope LIMIT ?`).all(this.now(),limit) as WorkRow[]){
      if(!allowed(row.material_id)){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}
      const material=this.materials.get(row.material_id);if(!material){this.withdraw(row.material_id);continue;}
      if(!this.available(row,material.origin.sourceId,row.job_id??undefined)){this.revoke(row);this.update(row,'auto_authorized=0');continue;}
      if(material.revision!==row.revision){this.observe(row.material_id,requiredSchema.parse(JSON.parse(row.required_json)),{inputKey:row.input_key||'unknown',change:'rebuild'});continue;}
      if(!this.readyForMemory(material.ref)){
        if(existing){this.revoke(row);this.update(row,'auto_authorized=0');}else this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;
      }
      if(!existing){
        const evidenceIds=this.materials.evidenceIds(material.ref);if(!evidenceIds.length){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}
        try{
          const binding=row.binding_json?memoryRecipeBindingSchema.parse(JSON.parse(row.binding_json)):undefined;
          if(binding&&!this.recipes?.available(binding))throw Error('recipe unavailable');
          const job=runner.create({evidenceIds,originKey:binding?'material:'+sha256(JSON.stringify([material.ref,row.scope,row.input_key])):material.ref,...(binding?{contextTime:row.context_time!,recipes:[{id:binding.recipe.id,version:binding.recipe.version}],automaticGrant:{sourceId:material.origin.sourceId,inputKey:row.input_key,scope:row.scope}}:{})});
          const claimed=this.transaction(()=>{
            const current=this.rows(row.material_id).find(r=>r.scope===row.scope);
            if(!current?.auto_authorized||current.revision!==row.revision||current.input_key!==row.input_key||current.job_id||!this.readyForMemory(material.ref)||!this.available(current,material.origin.sourceId))return false;
            if(!this.inputs.claim(material.origin.sourceId,row.input_key,job.id,row.scope))return false;
            return Boolean(this.update(row,'job_id=?,error=NULL',[job.id]).changes);
          });
          if(!claimed){this.revoke({...row,job_id:job.id});continue;}row.job_id=job.id;
        }catch{this.update(row,"error='memory_enqueue_failed',ready_at=?",[this.now()+RETRY_DELAY_MS]);continue;}
      }
      let status:string;
      try{status=runner.get(row.job_id!).status;}catch{this.update(row,"error='memory_job_unavailable',ready_at=?",[TERMINAL_AT]);continue;}
      if(status==='completed')this.update(row,'ready_at=?,error=NULL',[TERMINAL_AT]);
      else if(['queued','running','waiting_for_model'].includes(status)){if(existing)this.update(row,'ready_at=?',[this.now()+RESUME_DELAY_MS]);this.launch(runner,row,allowed);started++;}
      else this.update(row,'ready_at=?,error=?',[TERMINAL_AT,['failed','cancelled','paused','pausing'].includes(status)?`memory_job_${status}`:'memory_job_unavailable']);
    }
    return started;
  }
}
