import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {EXECUTION_POLICIES} from './execution-policy.js';
import {sha256,StoreError,type Store} from './store.js';
import {memoryEngineDraftPin,type MemoryEngineDraftContext,type MemoryEngineDraftPin,type MemoryNativeStageAdapter,type MemoryNativeStagePort} from './memory-native-stage-contract.js';

/** Owns native preparation pins and transport cleanup, independently of the
 * extraction/review checkpoints and the canonical publication journal. */
export class MemoryNativeStages implements MemoryNativeStagePort {
  private stopping=false;
  private abort=new AbortController();
  private pending=new Set<Promise<unknown>>();
  private unregister?:()=>Promise<void>;
  private closing?:Promise<void>;
  constructor(private store:Store,private engine:ExecutionEngine,private adapter:MemoryNativeStageAdapter={}){
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_engine_stage_cleanups(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
    store.db.exec('CREATE TABLE IF NOT EXISTS memory_engine_stage_drafts(id TEXT PRIMARY KEY,json TEXT NOT NULL,checkpoint_id TEXT); CREATE INDEX IF NOT EXISTS memory_engine_stage_checkpoint ON memory_engine_stage_drafts(checkpoint_id);');
    store.registerStorage('memory-lifecycle',{
      memory_engine_stage_cleanups:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+length(CAST(state AS BLOB))+128',
      memory_engine_stage_drafts:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+coalesce(length(CAST(checkpoint_id AS BLOB)),0)+128',
    });
    if(adapter.settle){
      this.unregister=engine.register({kind:'memory.engine-stage-cleanup',pool:'plugin-control',concurrency:()=>1,policy:EXECUTION_POLICIES.control,validate:()=>!this.stopping,
        execute:async step=>{const row=store.db.prepare('SELECT json,state FROM memory_engine_stage_cleanups WHERE id=?').get(String(step.input.id));if(row?.state==='pending')try{await this.track(()=>adapter.settle!(JSON.parse(String(row.json))));}catch{throw new ExecutionFailure('waiting','memory_engine_cleanup_pending',5000);}},
        commit:step=>{store.db.prepare("UPDATE memory_engine_stage_cleanups SET state='acknowledged' WHERE id=?").run(String(step.input.id));}});
      for(const row of store.db.prepare("SELECT id FROM memory_engine_stage_cleanups WHERE state='pending'").all())this.queueCleanup(String(row.id));
      for(const row of store.db.prepare("SELECT DISTINCT d.checkpoint_id FROM memory_engine_stage_drafts d JOIN execution_steps e ON e.id=d.checkpoint_id WHERE e.state IN ('succeeded','failed','cancelled','stale')").all()){const step=engine.get(String(row.checkpoint_id));if(step)this.finalize(step);}
    }
  }
  /** Track actual adapter completion even after the engine releases its logical
   * task on cancellation. Module retirement waits until this work exits. */
  private track<T>(work:()=>Promise<T>):Promise<T>{
    const task=Promise.resolve().then(work);this.pending.add(task);
    void task.finally(()=>this.pending.delete(task)).catch(()=>{});return task;
  }
  prepare(input:QueryInput,context:MemoryEngineDraftContext){
    if(this.stopping)return Promise.reject(new StoreError('Native Memory stages are closed',503));
    const signal=AbortSignal.any([this.abort.signal,...(input.signal?[input.signal]:[])]);
    return this.track(async()=>{
      signal.throwIfAborted();
      // A new invocation gets distinct cleanup authority; reused drafts keep
      // their original exact provider pin and cleanup generation.
      context.cleanupGeneration??=randomUUID();
      const remember=()=>{if(!context.provider)return;const pin=memoryEngineDraftPin(context),id=sha256(JSON.stringify(pin)),json=JSON.stringify(pin);if(!this.store.db.prepare('SELECT 1 FROM memory_engine_stage_drafts WHERE id=?').get(id)){this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT INTO memory_engine_stage_drafts VALUES(?,?,?)').run(id,json,context.checkpointId??null);}};
      try{
        const pending=this.adapter.prepare?.({...input,signal},context);
        // Adapters pin the selected configuration synchronously before I/O.
        remember();const result=await pending;signal.throwIfAborted();return result;
      }finally{remember();}
    });
  }
  /** Reviewed output or a final host checkpoint already exists. Cleanup has a
   * durable receipt and never repeats semantic generation. */
  async settle(context:MemoryEngineDraftContext|MemoryEngineDraftPin){
    if(!this.adapter.settle)return;
    const {id,prior}=this.recordCleanup(context);if(prior?.state==='acknowledged'||this.stopping)return;
    const pin=memoryEngineDraftPin(context);
    try{await this.track(()=>this.adapter.settle!(pin));this.store.db.prepare("UPDATE memory_engine_stage_cleanups SET state='acknowledged' WHERE id=?").run(id);}catch{this.queueCleanup(id);}
  }
  abandon(context:MemoryEngineDraftContext|MemoryEngineDraftPin){
    if(!this.adapter.settle||!context.provider)return;
    const {id,prior}=this.recordCleanup(context);if(prior?.state!=='acknowledged')this.queueCleanup(id);
  }
  private recordCleanup(context:MemoryEngineDraftContext|MemoryEngineDraftPin){
    const pin=memoryEngineDraftPin(context),id=sha256(JSON.stringify(pin)),prior=this.store.db.prepare('SELECT state FROM memory_engine_stage_cleanups WHERE id=?').get(id);
    if(!prior){const json=JSON.stringify(pin);this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare("INSERT INTO memory_engine_stage_cleanups VALUES(?,?,'pending')").run(id,json);}return {id,prior};
  }
  finalize(step:ExecutionStep){
    if(!['succeeded','failed','cancelled','stale'].includes(step.state))return;
    for(const row of this.store.db.prepare('SELECT json FROM memory_engine_stage_drafts WHERE checkpoint_id=?').all(step.id))this.abandon(JSON.parse(String(row.json)));
  }
  private queueCleanup(id:string){
    // The durable intent survives shutdown; a new owner admits it on restart.
    if(this.stopping||this.engine.closed)return;
    const operationId='memory-engine-stage-cleanup:'+id,prior=this.engine.get(operationId);
    if(!prior)this.engine.enqueue(operationId,'memory.engine-stage-cleanup',{id},{id:operationId});
    else if(['failed','stale','cancelled','blocked'].includes(prior.state)&&!this.engine.isActiveStep(operationId))this.engine.retry(operationId);
    this.engine.localEffect(()=>{if(!this.stopping)void this.engine.tick().catch(()=>{});});
  }
  stop(){if(this.stopping)return;this.stopping=true;this.abort.abort();}
  close(){return this.closing??=this.dispose();}
  private async dispose(){this.stop();try{await this.unregister?.();}finally{await Promise.allSettled([...this.pending]);}}
}
