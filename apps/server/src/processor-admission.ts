import {ProviderFailure} from '@mote/shared';
import {processorAdmissionSchemaInstallation} from './admission-schema.js';
import {installSchemaPlan} from './schema-installation.js';
import {sha256,type Store} from './store.js';

/** Recheck availability, not a prediction of when a long recording finishes. */
export const PROCESSOR_BUSY_RECHECK_MS=5000;

/** Admission for the physical local HTTP worker, shared by all of its stages.
 * The executor owns capacity leases; this class only identifies that resource
 * and persists a worker's explicit pre-execution busy feedback. */
export class ProcessorAdmission {
 constructor(private store:Store,private now=Date.now){
  installSchemaPlan(store.db,[processorAdmissionSchemaInstallation]);
 }
 resourceKey(endpoint:string){
  const url=new URL(endpoint);
  // localhost and literal loopback refer to the same managed listener. Paths
  // such as /transcribe and /diarize do not create separate physical capacity.
  const host=url.hostname==='localhost'?'127.0.0.1':url.hostname;
  return 'processor:'+sha256(JSON.stringify([url.protocol,host,url.port||(url.protocol==='https:'?'443':'80')]));
 }
 check(endpoint:string){
  const row=this.store.db.prepare('SELECT until FROM processor_cooldowns WHERE scope=? AND until>?').get(this.resourceKey(endpoint),this.now());
  if(row)throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false,retryAfterMs:Math.max(1,Number(row.until)-this.now())});
 }
 async run<T>(endpoint:string,task:()=>Promise<T>):Promise<T>{
  this.check(endpoint);
  try{return await task();}
  catch(error){
   if(!(error instanceof ProviderFailure)||error.details.code!=='rate_limited'||error.details.executionStarted!==false)throw error;
   const now=this.now(),delay=error.details.retryAfterMs??PROCESSOR_BUSY_RECHECK_MS;
   const until=now+Math.max(1000,Math.min(Number.isFinite(delay)?delay:PROCESSOR_BUSY_RECHECK_MS,7*86400000));
   const scope=this.resourceKey(endpoint),db=this.store.db;
   const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
   let deadline=until;
   try{
    db.prepare('DELETE FROM processor_cooldowns WHERE until<=?').run(now);
    db.prepare('INSERT INTO processor_cooldowns VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET until=max(until,excluded.until)').run(scope,until);
    deadline=Number(db.prepare('SELECT until FROM processor_cooldowns WHERE scope=?').get(scope)!.until);
    if(own)db.exec('COMMIT');
   }catch(writeError){if(own&&db.isTransaction)db.exec('ROLLBACK');throw writeError;}
   // Scheduling and the API use the same effective deadline, including a longer
   // concurrent cooldown. The raw HTTP body/credentials are never persisted.
   throw new ProviderFailure({...error.details,retryAfterMs:Math.max(1,deadline-this.now())});
  }
 }
}
