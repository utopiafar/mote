import {moteText} from './i18n.js';
import type {Store} from './store.js';
import type {MemoryJob,MemoryBatch} from './memory-pipeline.js';

export function encodeMemoryPrivate(store:Store,value:unknown):string {const body=JSON.stringify(value);return store.contentEncryption.enabled?'aes:'+store.contentEncryption.seal(Buffer.from(body)).toString('base64'):'json:'+body;}
export function decodeMemoryPrivate<T>(store:Store,value:string):T {
 if(value.startsWith('aes:'))return JSON.parse(store.contentEncryption.open(Buffer.from(value.slice(4),'base64')).toString('utf8')) as T;
 if(value.startsWith('json:'))return JSON.parse(value.slice(5)) as T;
 throw new Error('Unsupported Memory private payload format');
}
/** Keep identity/ranges queryable; only owner-authorized reads open model prose. */
export function decodeMemoryJob<T extends MemoryJob=MemoryJob>(store:Store,json:string):T {
 const {private:body,privateRetired:retired,...value}=JSON.parse(json);
 if(body){const payload=decodeMemoryPrivate<{workPackage?:{goal:string;instruction:string}}>(store,body);if(value.workPackage&&payload.workPackage)Object.assign(value.workPackage,payload.workPackage);}
 if(retired&&value.workPackage){value.workPackage.goal=moteText('整理所选资料的记忆');value.workPackage.instruction='Previously authorized input was retired; require current authorization before processing.';}
 return value as T;
}
export function encodeMemoryJob(store:Store,job:Pick<MemoryJob,'workPackage'>,retired=false):string {
 const value:any=structuredClone(job);delete value.private;delete value.privateRetired;
 if(value.workPackage){const {goal,instruction,...metadata}=value.workPackage;if(retired){value.workPackage=metadata;value.privateRetired=true;}else if(store.contentEncryption.enabled){value.workPackage=metadata;value.private=encodeMemoryPrivate(store,{workPackage:{goal,instruction}});}}
 return JSON.stringify(value);
}
export function decodeMemoryBatch<T extends MemoryBatch=MemoryBatch>(store:Store,json:string):T {
 const {private:body,privateRetired:retired,...value}=JSON.parse(json);
 if(body&&!retired){const payload=decodeMemoryPrivate<{workerGoal?:string;workerInstruction?:string;coverage?:{key:string;reason?:string;contextRefs?:string[]}[]}>(store,body);if(payload.workerGoal!==undefined)value.workerGoal=payload.workerGoal;if(payload.workerInstruction!==undefined)value.workerInstruction=payload.workerInstruction;for(const row of payload.coverage??[]){const entry=value.coverage?.find((entry:{key:string})=>entry.key===row.key);if(entry)Object.assign(entry,row);}}
 return value as T;
}
export function encodeMemoryBatch(store:Store,batch:MemoryBatch,retired=false):string {
 const value:any=structuredClone(batch);delete value.private;delete value.privateRetired;
 if(retired||store.contentEncryption.enabled){const prose=(value.coverage??[]).filter((row:any)=>row.reason!==undefined||row.contextRefs!==undefined).map(({key,reason,contextRefs}:any)=>({key,reason,contextRefs}));value.coverage?.forEach((row:any)=>{delete row.reason;delete row.contextRefs;});const workerGoal=value.workerGoal,workerInstruction=value.workerInstruction;delete value.workerGoal;delete value.workerInstruction;if(retired)value.privateRetired=true;else if(prose.length||workerGoal!==undefined||workerInstruction!==undefined)value.private=encodeMemoryPrivate(store,{coverage:prose,workerGoal,workerInstruction});}
 return JSON.stringify(value);
}
/** Purge private prose in the same transaction as evidence invalidation.
 * Retired markers prevent a late in-memory save from restoring removed prose. */
export function installMemoryPrivateRetirement(store:Store){
 const db=store.db;
 db.exec(`CREATE TRIGGER IF NOT EXISTS memory_private_batch_retired AFTER UPDATE OF json ON memory_batches
 WHEN json_extract(new.json,'$.status')='invalidated' AND coalesce(json_extract(new.json,'$.privateRetired'),0)!=1 BEGIN
  UPDATE memory_batches SET json=json_set(json_remove(json,'$.private','$.workerGoal','$.workerInstruction'),'$.privateRetired',json('true'),'$.coverage',json(coalesce((SELECT json_group_array(json_remove(value,'$.reason','$.contextRefs')) FROM json_each(new.json,'$.coverage')),'[]'))) WHERE id=new.id;
  UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id=new.job_id;
 END;
 CREATE TRIGGER IF NOT EXISTS memory_private_original_deleted AFTER DELETE ON captures BEGIN
  UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id IN (SELECT job_id FROM memory_job_dependencies WHERE evidence_id=old.id);
 END;
 CREATE TABLE IF NOT EXISTS memory_job_dependencies(job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(job_id,evidence_id));
 CREATE INDEX IF NOT EXISTS memory_job_original_dependencies ON memory_job_dependencies(evidence_id,job_id);
 `);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_evidence'").get())db.exec("CREATE TRIGGER IF NOT EXISTS memory_private_material_retired AFTER UPDATE OF invalidated ON material_evidence WHEN new.invalidated=1 BEGIN UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id IN (SELECT job_id FROM memory_job_dependencies WHERE evidence_id=new.id); END;");
 if(store.contentEncryption.enabled){
  for(const row of db.prepare("SELECT id,json FROM memory_jobs WHERE json_type(json,'$.workPackage.goal')='text'").all()){const json=encodeMemoryJob(store,decodeMemoryJob(store,String(row.json)));store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(json,row.id);}
  for(const row of db.prepare("SELECT id,json FROM memory_batches WHERE json_type(json,'$.workerGoal')='text' OR json_type(json,'$.workerInstruction')='text' OR EXISTS(SELECT 1 FROM json_each(json,'$.coverage') c WHERE json_type(c.value,'$.reason')='text' OR json_type(c.value,'$.contextRefs')='array')").all()){const json=encodeMemoryBatch(store,decodeMemoryBatch(store,String(row.json)));store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(json,row.id);}
 }
}
