import {moteText} from './i18n.js';
import type {Store} from './store.js';
import type {MemoryJob,MemoryBatch} from './memory-pipeline.js';

export type MemoryPublicationDependencies={evidenceIds?:readonly string[];memoryIds?:readonly string[]};
/** Dependency routing is explicit host metadata, never an interpretation of
 * model prose. Persisted triggers also run in maintenance-only Store processes. */
export function installMemoryPublicationRetirement(store:Store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS memory_publication_dependencies(operation_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('evidence','memory')),dependency_id TEXT NOT NULL,PRIMARY KEY(operation_id,kind,dependency_id));
 CREATE INDEX IF NOT EXISTS memory_publication_original_dependencies ON memory_publication_dependencies(kind,dependency_id,operation_id);
 CREATE TABLE IF NOT EXISTS memory_publication_retirements(operation_id TEXT PRIMARY KEY);
 DROP TRIGGER IF EXISTS memory_publication_original_retired_insert;
 CREATE TRIGGER memory_publication_original_retired_insert AFTER INSERT ON memory_provider_evidence_revocations BEGIN
  INSERT INTO memory_publication_retirements SELECT operation_id FROM memory_publication_dependencies d WHERE kind='evidence' AND dependency_id=json_extract(new.json,'$.evidenceId') AND NOT EXISTS(SELECT 1 FROM memory_publication_retirements r WHERE r.operation_id=d.operation_id);
 END;
 DROP TRIGGER IF EXISTS memory_publication_original_retired_update;
 CREATE TRIGGER memory_publication_original_retired_update AFTER UPDATE OF generation,json ON memory_provider_evidence_revocations WHEN new.generation!=old.generation OR new.json!=old.json BEGIN
  INSERT INTO memory_publication_retirements SELECT operation_id FROM memory_publication_dependencies d WHERE kind='evidence' AND dependency_id=json_extract(new.json,'$.evidenceId') AND NOT EXISTS(SELECT 1 FROM memory_publication_retirements r WHERE r.operation_id=d.operation_id);
 END;
 DROP TRIGGER IF EXISTS memory_publication_memory_retired;
 CREATE TRIGGER memory_publication_memory_retired BEFORE DELETE ON memories BEGIN
  INSERT INTO memory_publication_retirements SELECT operation_id FROM memory_publication_dependencies d WHERE kind='memory' AND dependency_id=old.id AND NOT EXISTS(SELECT 1 FROM memory_publication_retirements r WHERE r.operation_id=d.operation_id);
 END;
 DROP TRIGGER IF EXISTS memory_publication_operation_retired;
 CREATE TRIGGER memory_publication_operation_retired AFTER INSERT ON memory_publication_retirements BEGIN
  UPDATE memory_provider_writes SET json=json_set(json_remove(json,'$.memory'),'$.privateRetired',json('true'),'$.hostPublished',json(CASE WHEN coalesce(json_extract(json,'$.hostPublished'),0)=1 OR EXISTS(SELECT 1 FROM memory_publications p WHERE p.id=new.operation_id AND p.state='committed') OR EXISTS(SELECT 1 FROM memory_owner_mutations m WHERE m.id=new.operation_id AND m.state='committed') OR (EXISTS(SELECT 1 FROM memory_plan_binding b WHERE json_extract(b.json,'$.namespace')=json_extract(memory_provider_writes.json,'$.namespace')) AND EXISTS(SELECT 1 FROM memories m WHERE m.id=json_extract(memory_provider_writes.json,'$.key.memoryId') AND json_extract(m.json,'$.version')=json_extract(memory_provider_writes.json,'$.key.version') AND json_extract(m.json,'$.fingerprint')=json_extract(memory_provider_writes.json,'$.key.fingerprint'))) THEN 'true' ELSE 'false' END)) WHERE parent_id=new.operation_id;
  UPDATE memory_publications SET json=json_set(json_remove(json,'$.prepared'),'$.privateRetired',json('true')),state='retired' WHERE id=new.operation_id;
  UPDATE memory_publication_outputs SET json='{"privateRetired":true}' WHERE id=new.operation_id;
  UPDATE memory_owner_mutations SET json=json_set(json_remove(json,'$.before','$.result','$.changed'),'$.privateRetired',json('true')),state='retired' WHERE id=new.operation_id;
 END;`);
 // A held worker/transport can finish after the retirement transaction. Never
 // let a later INSERT or saved in-memory JSON restore those exact operations.
 for(const [table,id,body,state] of [
  ['memory_provider_writes','new.parent_id',"json_set(json_remove(new.json,'$.memory'),'$.privateRetired',json('true'))",''],
  ['memory_publications','new.id',"json_set(json_remove(new.json,'$.prepared'),'$.privateRetired',json('true'))",",state='retired'"],
  ['memory_publication_outputs','new.id',"'{\"privateRetired\":true}'",''],
  ['memory_owner_mutations','new.id',"json_set(json_remove(new.json,'$.before','$.result','$.changed'),'$.privateRetired',json('true'))",",state='retired'"],
 ] as const)for(const event of ['INSERT','UPDATE OF json'] as const)db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_private_retired_${event==='INSERT'?'insert':'update'} AFTER ${event} ON ${table}
  WHEN coalesce(json_extract(new.json,'$.privateRetired'),0)!=1 AND EXISTS(SELECT 1 FROM memory_publication_retirements WHERE operation_id=${id}) BEGIN
   UPDATE ${table} SET json=${body}${state} WHERE id=new.id;
  END;`);
}
export function registerMemoryPublicationDependencies(store:Store,operationId:string,dependencies:MemoryPublicationDependencies){
 const insert=store.db.prepare('INSERT OR IGNORE INTO memory_publication_dependencies VALUES(?,?,?)');
 const exists=store.db.prepare('SELECT 1 FROM memory_publication_dependencies WHERE operation_id=? AND kind=? AND dependency_id=?');
 for(const [kind,ids] of [['evidence',dependencies.evidenceIds],['memory',dependencies.memoryIds]] as const)for(const id of new Set(ids??[])){if(exists.get(operationId,kind,id))continue;store.reserveMetadata(Buffer.byteLength(operationId)+Buffer.byteLength(kind)+Buffer.byteLength(id)+64);insert.run(operationId,kind,id);}
}
export function memoryPublicationRetired(store:Store,operationId:string){return Boolean(store.db.prepare('SELECT 1 FROM memory_publication_retirements WHERE operation_id=?').get(operationId));}

export function encodeMemoryPrivate(store:Store,value:unknown):string {const body=JSON.stringify(value);return store.contentEncryption.enabled?'aes:'+store.contentEncryption.seal(Buffer.from(body)).toString('base64'):'json:'+body;}
export function decodeMemoryPrivate<T>(store:Store,value:string):T {
 if(value.startsWith('aes:'))return JSON.parse(store.contentEncryption.open(Buffer.from(value.slice(4),'base64')).toString('utf8')) as T;
 if(value.startsWith('json:'))return JSON.parse(value.slice(5)) as T;
 throw new Error('Unsupported Memory private payload format');
}
/** Keep identity/ranges queryable; only owner-authorized reads open model prose. */
export function decodeMemoryJob<T extends MemoryJob=MemoryJob>(store:Store,json:string):T {
 const {private:body,privateRetired:retired,...value}=JSON.parse(json);
 if(body&&!retired){const payload=decodeMemoryPrivate<{workPackage?:{goal:string;instruction:string}}>(store,body);if(value.workPackage&&payload.workPackage)Object.assign(value.workPackage,payload.workPackage);}
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
 if(body&&!retired){const payload=decodeMemoryPrivate<{workerGoal?:string;workerInstruction?:string;coverage?:PrivateCoverage[]}>(store,body);if(payload.workerGoal!==undefined)value.workerGoal=payload.workerGoal;if(payload.workerInstruction!==undefined)value.workerInstruction=payload.workerInstruction;for(const row of payload.coverage??[]){const entry=value.coverage?.find((entry:{key:string})=>entry.key===row.key);if(entry)Object.assign(entry,row);}}
 if(retired){delete value.workerGoal;delete value.workerInstruction;value.coverage?.forEach(stripCoverageProse);}
 return value as T;
}
type PrivateCoverage=Pick<NonNullable<MemoryBatch['coverage']>[number],'key'|'reason'|'contextRefs'|'question'|'attributionContext'>;
const stripCoverageProse=(row:PrivateCoverage)=>{delete row.reason;delete row.contextRefs;delete row.question;delete row.attributionContext;};
export function encodeMemoryBatch(store:Store,batch:MemoryBatch,retired=false):string {
 const value:any=structuredClone(batch);delete value.private;delete value.privateRetired;
 if(retired||store.contentEncryption.enabled){const prose=(value.coverage??[]).filter((row:PrivateCoverage)=>row.reason!==undefined||row.contextRefs!==undefined||row.question!==undefined||row.attributionContext!==undefined).map(({key,reason,contextRefs,question,attributionContext}:PrivateCoverage)=>({key,reason,contextRefs,question,attributionContext}));value.coverage?.forEach(stripCoverageProse);const workerGoal=value.workerGoal,workerInstruction=value.workerInstruction;delete value.workerGoal;delete value.workerInstruction;if(retired)value.privateRetired=true;else if(prose.length||workerGoal!==undefined||workerInstruction!==undefined)value.private=encodeMemoryPrivate(store,{coverage:prose,workerGoal,workerInstruction});}
 return JSON.stringify(value);
}
/** Purge private prose in the same transaction as evidence invalidation.
 * Retired markers prevent a late in-memory save from restoring removed prose. */
export function installMemoryPrivateRetirement(store:Store){
 const db=store.db;
 db.exec(`DROP TRIGGER IF EXISTS memory_private_batch_retired;
 CREATE TRIGGER memory_private_batch_retired AFTER UPDATE OF json ON memory_batches
 WHEN json_extract(new.json,'$.status')='invalidated' AND coalesce(json_extract(new.json,'$.privateRetired'),0)!=1 BEGIN
  UPDATE memory_batches SET json=json_set(json_remove(json,'$.private','$.workerGoal','$.workerInstruction'),'$.privateRetired',json('true'),'$.coverage',json(coalesce((SELECT json_group_array(json_remove(value,'$.reason','$.contextRefs','$.question','$.attributionContext')) FROM json_each(new.json,'$.coverage')),'[]'))) WHERE id=new.id;
  UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id=new.job_id;
 END;
 CREATE TRIGGER IF NOT EXISTS memory_private_original_deleted AFTER DELETE ON captures BEGIN
  UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id IN (SELECT job_id FROM memory_job_dependencies WHERE evidence_id=old.id);
 END;
 CREATE TABLE IF NOT EXISTS memory_job_dependencies(job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(job_id,evidence_id));
 CREATE INDEX IF NOT EXISTS memory_job_original_dependencies ON memory_job_dependencies(evidence_id,job_id);
 `);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_evidence'").get())db.exec("CREATE TRIGGER IF NOT EXISTS memory_private_material_retired AFTER UPDATE OF invalidated ON material_evidence WHEN new.invalidated=1 BEGIN UPDATE memory_jobs SET json=json_set(json_remove(json,'$.private','$.workPackage.goal','$.workPackage.instruction'),'$.privateRetired',json('true')) WHERE id IN (SELECT job_id FROM memory_job_dependencies WHERE evidence_id=new.id); END;");
 for(const row of db.prepare("SELECT id,json FROM memory_batches WHERE json_extract(json,'$.privateRetired')=1").all()){const json=encodeMemoryBatch(store,decodeMemoryBatch(store,String(row.json)),true);if(json!==row.json)db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(json,row.id);}
 if(store.contentEncryption.enabled){
  for(const row of db.prepare("SELECT id,json FROM memory_jobs WHERE json_type(json,'$.workPackage.goal')='text'").all()){const json=encodeMemoryJob(store,decodeMemoryJob(store,String(row.json)));store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(json,row.id);}
  for(const row of db.prepare("SELECT b.id,b.json FROM memory_batches b WHERE coalesce(json_extract(b.json,'$.privateRetired'),0)!=1 AND (json_type(b.json,'$.workerGoal')='text' OR json_type(b.json,'$.workerInstruction')='text' OR EXISTS(SELECT 1 FROM json_each(b.json,'$.coverage') c WHERE json_type(c.value,'$.reason')='text' OR json_type(c.value,'$.contextRefs')='array' OR json_type(c.value,'$.question')='object' OR json_type(c.value,'$.attributionContext')='object'))").all()){const json=encodeMemoryBatch(store,decodeMemoryBatch(store,String(row.json)));store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));db.prepare('UPDATE memory_batches SET json=? WHERE id=?').run(json,row.id);}
 }
}
