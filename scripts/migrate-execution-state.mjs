#!/usr/bin/env node
/**
 * One-time compatibility migration for Mote archives created before the
 * shared execution envelope existed.
 *
 * The server already reads old rows safely. This script is useful for an
 * operator who wants the additive `execution` projection materialized ahead
 * of a deployment. It never touches captures, files, artifacts or evidence.
 */
import {copyFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

function usage(){console.log('Usage: node scripts/migrate-execution-state.mjs --data-dir <mote-data-directory> [--dry-run]');}
const args=process.argv.slice(2),dir=args[args.indexOf('--data-dir')+1],dryRun=args.includes('--dry-run');
if(args.includes('--help')||args.includes('-h')){usage();process.exit(0);}
if(!dir||dir.startsWith('--')){usage();process.exit(2);}
const database=join(dir,'mote.sqlite');
if(!existsSync(database)){console.error('mote.sqlite was not found in the selected data directory');process.exit(2);}

const statusOf=value=>({waiting_for_model:'waiting',waiting_for_confirmation:'waiting',blocked:'waiting',waiting:'waiting',pending:'queued',queued:'queued',running:'running',retry_wait:'retry_wait',completed:'succeeded',succeeded:'succeeded',cancelled:'cancelled',canceled:'cancelled',skipped:'skipped',invalidated:'skipped',failed:'failed',interrupted:'queued'}[value]??(value?'waiting':'queued'));
const failureOf=(code,status)=>{
  if(!code)return undefined;
  const retryable=new Set(['provider_failed','model_failed','agent_response','timeout','network','rate_limited','worker_interrupted']);
  const waiting=new Set(['model_unconfigured','provider_unavailable','daily_budget','worker_offline','awaiting_confirmation']);
  const recovery=waiting.has(code)?'needs_action':retryable.has(code)?'auto_retry':'permanent';
  const scope=waiting.has(code)&&code!=='daily_budget'?'provider':code==='worker_offline'?'system':'item';
  return {code,recovery,scope,safeMessage:code==='model_unconfigured'?'Model configuration is required before this step can continue.':code==='daily_budget'?'The configured processing budget is exhausted for now.':'The step did not complete.'};
};
const actions=status=>status==='running'||status==='queued'||status==='retry_wait'?['cancel']:status==='waiting'?['continue','cancel']:status==='failed'?['retry','reprocess']:[];
function envelope(value){
  const status=statusOf(value.status??value.state),attempts=Number.isSafeInteger(value.attempts)&&value.attempts>=0?value.attempts:0;
  const code=typeof value.errorCode==='string'?value.errorCode:typeof value.error?.code==='string'?value.error.code:undefined;
  const failure=failureOf(code,status),waiting=status==='waiting'?{reason:code==='daily_budget'?'resource_limit':code==='model_unconfigured'||code==='provider_unavailable'?'provider_unavailable':code==='awaiting_confirmation'?'user_confirmation':code==='worker_offline'?'worker_offline':'dependency',...(failure?.scope==='provider'?{resource:'configured-provider'}:{})}:undefined;
  return {status,attempts,...(failure?{failure}:{}),...(waiting?{waiting}:{}),allowedActions:actions(status)};
}
const db=new DatabaseSync(database,{readOnly:dryRun});
const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
const targets=['memory_jobs','memory_batches','query_runs','insight_runs'].filter(name=>tables.has(name));
let changed=0,rows=0;
if(!dryRun)db.exec('PRAGMA wal_checkpoint(PASSIVE)');
if(!dryRun){
  const backup=`${database}.execution-compat.${new Date().toISOString().replaceAll(':','-')}.bak`;
  copyFileSync(database,backup);
  db.exec('BEGIN IMMEDIATE');
}
try{
  for(const table of targets){
    const values=db.prepare(`SELECT rowid,json FROM ${table}`).all();
    const update=db.prepare(`UPDATE ${table} SET json=? WHERE rowid=?`);
    for(const row of values){
      rows++;
      let value;try{value=JSON.parse(String(row.json));}catch{continue;}
      if(value.execution?.status)continue;
      value.execution=envelope(value);changed++;
      if(!dryRun)update.run(JSON.stringify(value),row.rowid);
    }
  }
  if(!dryRun)db.exec('COMMIT');
}catch(error){if(!dryRun)db.exec('ROLLBACK');throw error;}finally{db.close();}
console.log(JSON.stringify({ok:true,dryRun,tables:targets,rows,changed}));
