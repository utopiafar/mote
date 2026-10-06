import type {Store} from './store.js';
import type {ExecutionEngine} from './execution-engine.js';

// Historical codes are recognized only to retire saved admission state.
const retiredReasons=new Set(['daily_budget','input_budget','budget','model_token_budget','model_cost_budget','budget_price_required','budget_unbounded_runtime','model_budget_unavailable']);
const retiredTables=['processing_usage','model_budget_usage','model_budget_attempts','model_budget_reservations'];

/** One-way, idempotent cleanup. Actual usage receipts and model prices remain. */
export function removeRetiredBudgetState(store:Store){
  const db=store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
    const saved=db.prepare("SELECT value FROM settings WHERE key='processing-policy'").get();
    if(saved){
      const policies=JSON.parse(String(saved.value)) as Record<string,Record<string,unknown>>;
      let changed=false;
      for(const policy of Object.values(policies)){
        if(!Object.hasOwn(policy,'dailyCalls')&&!Object.hasOwn(policy,'dailyInputCharacters'))continue;
        policy.enabled=policy.enabled??(policy.dailyCalls!==0&&policy.dailyInputCharacters!==0);
        delete policy.dailyCalls;delete policy.dailyInputCharacters;changed=true;
      }
      if(changed)db.prepare("UPDATE settings SET value=? WHERE key='processing-policy'").run(JSON.stringify(policies));
    }
    db.prepare("DELETE FROM settings WHERE key='model-budgets'").run();
    for(const table of retiredTables){db.exec('DROP TABLE IF EXISTS '+table);db.prepare('DELETE FROM storage_ledger WHERE name=?').run(table);}
    if(own)db.exec('COMMIT');
  }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}

/** Resume replayable background work after all domain projections are registered.
 * Claims still validate input versions, owner enablement and parent authority.
 * Interactive run receipts have no replayable request and remain historical. */
export function resumeRetiredBudgetWork(store:Store,engine:ExecutionEngine){
  const db=store.db,hasTable=(name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
    const rows=db.prepare("SELECT id,kind FROM execution_steps WHERE state IN ('waiting','blocked') AND error IN (SELECT value FROM json_each(?))").all(JSON.stringify([...retiredReasons]));
    const ids=new Set(rows.filter(row=>!/^(query|insight)\.run\./.test(String(row.kind))).map(row=>String(row.id)));
    // A blocked semantic child can also have blocked its Memory parent.
    if(hasTable('processing_jobs'))for(const id of [...ids]){
      const row=db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id);
      const parent=row&&JSON.parse(String(row.json)).parentGrant?.stepId as string|undefined;
      if(parent&&engine.get(parent)?.error==='semantic_processing_blocked')ids.add(parent);
    }
    const memoryInactive=(jobId:unknown)=>{
      const row=typeof jobId==='string'&&hasTable('memory_jobs')?db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(jobId):undefined;
      return Boolean(row&&['paused','pausing','cancelled','completed'].includes(JSON.parse(String(row.json)).status));
    };
    const resumed=new Set<string>();
    for(const id of ids){
      const step=engine.get(id);if(!step||!['waiting','blocked'].includes(step.state))continue;
      if(memoryInactive(step.input.jobId))continue;
      const processing=hasTable('processing_jobs')?db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id):undefined;
      const parentId=processing&&JSON.parse(String(processing.json)).parentGrant?.stepId as string|undefined;
      const parent=parentId?engine.get(parentId):undefined;
      if(parent&&(['cancelled','stale','failed','succeeded'].includes(parent.state)||memoryInactive(parent.input.jobId)||parent.state==='blocked'&&!ids.has(parent.id)))continue;
      db.prepare('UPDATE execution_steps SET recovery_deadline=0 WHERE id=?').run(id);
      engine.retry(id,false);
      resumed.add(id);
    }
    if(hasTable('memory_lifecycle_state'))for(const row of db.prepare('SELECT id,json FROM memory_lifecycle_state').all()){
      const state=JSON.parse(String(row.json));if(state.cancelled)continue;
      const related=state.active&&db.prepare('SELECT 1 FROM operation_parents p JOIN execution_steps e ON e.operation_id=p.child_id WHERE p.parent_id=? AND e.id IN (SELECT value FROM json_each(?)) LIMIT 1').get('workflow:lifecycle:'+state.active.id,JSON.stringify([...resumed]));
      if(!retiredReasons.has(state.error)&&!(state.error==='semantic_processing_blocked'&&related))continue;
      delete state.error;delete state.retryAt;delete state.manualRetryRequired;
      db.prepare('UPDATE memory_lifecycle_state SET json=? WHERE id=?').run(JSON.stringify(state),row.id);
    }
    if(own)db.exec('COMMIT');
  }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
