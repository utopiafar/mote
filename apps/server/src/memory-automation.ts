import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {sha256,StoreError} from './store.js';

/** The automation owner borrows a narrow vault surface: durable control rows and
 * metadata accounting. It never needs the complete Store backdoor. */
export interface MemoryAutomationStore {
  readonly db:Pick<DatabaseSync,'exec'|'prepare'|'isTransaction'>;
  reserveMetadata(bytes:number):void;
}

export const memoryControlCommandSchema=z.object({expectedRevision:z.number().int().positive(),operationId:z.string().uuid()}).strict();
export type MemoryAutomationState={revision:number;generation:number;desired:boolean;cutoff?:number;barrier?:string;stopRequested?:boolean};
export type MemoryAutomaticWorkCounts={queued:number;running:number;checkpointed:number;resultUnknown:number};

/** New-input admission and existing-operation authority are intentionally
 * separate. A normal pause never invalidates an already persisted receipt. */
export class MemoryAutomation {
  onResume?:()=>void;
  /** Durable writes return local cleanup for command() to run after commit. */
  onStop?:()=>void|(()=>void);
  counts:()=>MemoryAutomaticWorkCounts=()=>({queued:0,running:0,checkpointed:0,resultUnknown:0});
  constructor(readonly store:MemoryAutomationStore,private readonly now=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_automation(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_control_commands(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_automation_fences(operation_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('freeze','release')),created_at INTEGER NOT NULL,PRIMARY KEY(operation_id,kind));`);
    store.db.prepare('INSERT OR IGNORE INTO memory_automation VALUES(1,?)').run(JSON.stringify({revision:1,generation:1,desired:true} satisfies MemoryAutomationState));
  }
  state():MemoryAutomationState{return JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_automation WHERE id=1').get()!.json));}
  accepting(){const state=this.state();return state.desired&&!state.barrier;}
  view(){const state=this.state(),counts=this.counts(),pending=counts.queued+counts.running+counts.checkpointed+counts.resultUnknown;
    return {...state,...counts,state:state.barrier?'blocked' as const:state.desired?'enabled' as const:pending?(state.stopRequested?'stopping' as const:'draining' as const):'paused' as const,...(state.barrier?{blockedReason:'memory_cutover_barrier'}:{})};
  }
  private save(state:MemoryAutomationState){this.store.db.prepare('UPDATE memory_automation SET json=? WHERE id=1').run(JSON.stringify(state));}
  command(kind:'pause'|'resume'|'stop',raw:unknown){
    const input=memoryControlCommandSchema.parse(raw),fingerprint=sha256(JSON.stringify({kind,...input})),db=this.store.db;
    let afterCommit:void|(()=>void)=undefined;
    db.exec('BEGIN IMMEDIATE');
    try{
      const prior=db.prepare('SELECT fingerprint FROM memory_control_commands WHERE operation_id=?').get(input.operationId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new StoreError('Memory command identity conflict',409);db.exec('COMMIT');return this.view();}
      const state=this.state();if(state.revision!==input.expectedRevision)throw new StoreError('Memory settings changed; refresh before applying',409);
      if(state.barrier&&kind!=='stop')throw new StoreError('Finish or cancel the prepared switch before changing automatic admission',409);
      if(kind==='resume'){
        if(!state.desired){this.onResume?.();state.desired=true;state.generation++;}delete state.stopRequested;
      }else{
        if(state.desired){state.desired=false;state.cutoff=this.now();}
        if(kind==='stop'){afterCommit=this.onStop?.();state.stopRequested=true;}
      }
      state.revision++;this.save(state);this.store.reserveMetadata(256);
      db.prepare('INSERT INTO memory_control_commands VALUES(?,?,?)').run(input.operationId,fingerprint,this.now());db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    try{afterCommit?.();}catch(error){throw new Error('Memory command committed; local cleanup failed',{cause:error});}
    return this.view();
  }
  /** Durable fence commands are replayed by operation id. The first accepted
   * freeze establishes ownership; the first accepted release clears only that
   * same holder. Replays never change the revision or current holder, and a
   * release cannot clear a different operation's freeze. */
  private fence(kind:'freeze'|'release',operationId:string){
    if(!operationId)throw new StoreError('Memory switch operation identity is required',400);
    const db=this.store.db,own=!db.isTransaction;
    if(own)db.exec('BEGIN IMMEDIATE');
    try{
      if(db.prepare('SELECT 1 FROM memory_automation_fences WHERE operation_id=? AND kind=?').get(operationId,kind)){if(own)db.exec('COMMIT');return;}
      const state=this.state();
      if(kind==='freeze'){
        if(state.barrier&&state.barrier!==operationId)throw new StoreError('Another Memory switch owns admission',409);
        if(state.barrier!==operationId){state.barrier=operationId;state.revision++;this.save(state);}
      }else{
        if(state.barrier!==operationId)throw new StoreError('Memory switch fence changed',409);
        delete state.barrier;state.generation++;state.revision++;this.save(state);
      }
      this.store.reserveMetadata(Buffer.byteLength(operationId)+128);
      db.prepare('INSERT INTO memory_automation_fences VALUES(?,?,?)').run(operationId,kind,this.now());
      if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  /** Only the host switch coordinator may establish/release this durable fence. */
  freeze(operationId:string){this.fence('freeze',operationId);}
  release(operationId:string){this.fence('release',operationId);}
  /** Call only inside a host-owned transaction that also changes a binding. */
  touch(){const state=this.state();state.revision++;this.save(state);}
}
