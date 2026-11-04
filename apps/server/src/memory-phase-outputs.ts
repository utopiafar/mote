import {ExecutionEngine,ExecutionFailure} from './execution-engine.js';
import {EXECUTION_POLICIES} from './execution-policy.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {sha256,StoreError,type Store} from './store.js';

/** Owned execution checkpoints, not an evictable cache or query evidence. */
export class MemoryPhaseOutputs {
 constructor(private store:Store,private engine:ExecutionEngine){
  store.db.exec(`CREATE TABLE IF NOT EXISTS memory_phase_outputs(
   step_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,
   batch_id TEXT NOT NULL REFERENCES memory_batches(id) ON DELETE CASCADE,
   phase TEXT NOT NULL CHECK(phase IN ('extract','review')),input_hash TEXT NOT NULL,
   output_hash TEXT NOT NULL,json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS memory_phase_batch ON memory_phase_outputs(batch_id);
   CREATE TRIGGER IF NOT EXISTS memory_phase_batch_retired AFTER UPDATE OF json ON memory_batches
   WHEN json_extract(new.json,'$.status')='invalidated' OR coalesce(json_extract(new.json,'$.privateRetired'),0)=1 BEGIN
    DELETE FROM memory_phase_outputs WHERE batch_id=new.id; END;
   -- A job's privateRetired flag retires shared work-package prose after any
   -- sibling is invalidated. Phase authority belongs to each batch and its
   -- dependencies; cancellation alone revokes the entire job here.
   CREATE TRIGGER IF NOT EXISTS memory_phase_job_cancelled AFTER UPDATE OF json ON memory_jobs
   WHEN json_extract(new.json,'$.status')='cancelled' BEGIN
    DELETE FROM memory_phase_outputs WHERE batch_id IN (SELECT id FROM memory_batches WHERE job_id=new.id); END;
   CREATE TRIGGER IF NOT EXISTS memory_phase_dependency_removed AFTER DELETE ON memory_batch_dependencies BEGIN
    DELETE FROM memory_phase_outputs WHERE batch_id=old.batch_id; END;
   CREATE TRIGGER IF NOT EXISTS memory_phase_late_insert BEFORE INSERT ON memory_phase_outputs
   WHEN NOT EXISTS(SELECT 1 FROM memory_batches b JOIN memory_jobs j ON j.id=b.job_id WHERE b.id=new.batch_id
    AND json_extract(b.json,'$.status') NOT IN ('invalidated','completed') AND coalesce(json_extract(b.json,'$.privateRetired'),0)=0
    AND json_extract(j.json,'$.status') NOT IN ('cancelled','paused'))
   BEGIN SELECT RAISE(ABORT,'Memory phase authority retired'); END;`);
 }
 id(batchId:string,phase:'extract'|'review',inputHash:string){return 'memory-phase:'+sha256([batchId,phase,inputHash].join(':'));}
 read<T>(stepId:string,inputHash:string):T|undefined{
  const row=this.store.db.prepare('SELECT input_hash,output_hash,json FROM memory_phase_outputs WHERE step_id=?').get(stepId);if(!row)return;
  try{if(row.input_hash!==inputHash)throw Error();const payload=decodeMemoryPrivate<T>(this.store,JSON.parse(String(row.json)).private);if(sha256(JSON.stringify(payload))!==row.output_hash)throw Error();return payload;}
  catch{throw new ExecutionFailure('permanent','memory_phase_output_invalid');}
 }
 run<T>(options:{batchId:string;jobId:string;phase:'extract'|'review';inputHash:string;generation:string;signal:AbortSignal;validate:()=>boolean;execute:(signal:AbortSignal)=>Promise<T>;assertCommit:()=>void}):Promise<T>{
  const {batchId,jobId,phase,inputHash}=options,id=this.id(batchId,phase,inputHash);
  return this.engine.runStep({id,operationId:'memory:'+jobId,kind:'memory.phase',pool:'memory.phase',input:{batchId,jobId,phase,inputHash,generation:options.generation},signal:options.signal,
   policy:EXECUTION_POLICIES.modelCall,requireDurableResult:true,validate:options.validate,
   execute:options.execute,commit:output=>{options.assertCommit();const plain=JSON.stringify(output),json=JSON.stringify({private:encodeMemoryPrivate(this.store,output)});this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT INTO memory_phase_outputs VALUES(?,?,?,?,?,?)').run(id,batchId,phase,inputHash,sha256(plain),json);},
   read:()=>{if(!options.validate())throw new ExecutionFailure('stale','input_changed');return this.read<T>(id,inputHash);},project:()=>{},classify:error=>error instanceof StoreError&&error.statusCode===507?new ExecutionFailure('blocked','storage_full'):new ExecutionFailure('permanent','memory_phase_failed')});
 }
 retryFailed(batchId:string,ownerAction:boolean,generation:string){
  for(const row of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind LIKE 'memory.phase.%' AND json_extract(input,'$.batchId')=? AND json_extract(input,'$.generation')=? AND state IN ('failed','blocked')").all(batchId,generation))this.engine.retry(String(row.id),ownerAction);
 }
}
