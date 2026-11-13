import type {Store} from './store.js';

/** A correction refers to a specific timeline item. If that item is retired,
 * its corrections cannot remain as independent derived prose. Receipts stay
 * behind to reject a late replay of a removed item. */
function retirementStatements(selection:string,erase:boolean){
 const direct=`SELECT event_id FROM assistant_commitment_evidence WHERE ${selection}`;
 return retirementForEvents(direct,erase);
}
function retirementForEvents(direct:string,erase:boolean,fromContext=false){
 const affected=`SELECT event_id FROM assistant_commitment_events WHERE event_id IN (${direct}) OR target_event_id IN (${direct})`;
 const eligible=erase?'(stale=0 OR private_json IS NOT NULL)':'stale=0';
 const selected=`SELECT event_id FROM assistant_commitment_events WHERE event_id IN (${affected}) AND ${eligible}`;
 return [
  `UPDATE assistant_commitments SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT commitment_id FROM assistant_commitment_events WHERE event_id IN (${selected}))`,
  `UPDATE assistant_commitment_events SET stale=1${erase?',private_json=NULL':''} WHERE event_id IN (${selected})`,
  ...(erase?(fromContext?[
   `DELETE FROM assistant_commitment_evidence WHERE event_id IN (${affected})`,
   `DELETE FROM assistant_commitment_context WHERE event_id IN (${affected})`,
  ]:[
   `DELETE FROM assistant_commitment_context WHERE event_id IN (${affected})`,
   `DELETE FROM assistant_commitment_evidence WHERE event_id IN (${affected})`,
  ]):[]),
 ];
}

/** Called from the same transaction as evidence retirement. Ordinary version
 * changes leave historical private bodies stale; deletion/withdrawal erases
 * only the affected entries and their corrections. */
export function invalidateAssistantCommitmentEvidence(store:Store,ids?:readonly string[],deleted:boolean|'retired'=false){
 if(ids!==undefined&&!ids.length)return;
 const selection=ids===undefined?'1':'evidence_id IN (SELECT value FROM json_each(?1))';
 const args=ids===undefined?[]:[JSON.stringify(ids)];
 for(const sql of retirementStatements(selection,Boolean(deleted)))store.db.prepare(sql).run(...args);
}

/** Installed for every vault writer, including maintenance-only processes. */
export function installAssistantCommitments(store:Store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS assistant_commitments(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,cursor_key TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_commitment_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,commitment_id TEXT NOT NULL REFERENCES assistant_commitments(id) ON DELETE CASCADE,
  target_event_id TEXT,request_hash TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0,private_json TEXT,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS assistant_commitment_events_timeline ON assistant_commitment_events(commitment_id,seq);
 CREATE INDEX IF NOT EXISTS assistant_commitment_events_target ON assistant_commitment_events(target_event_id);
 CREATE TABLE IF NOT EXISTS assistant_commitment_evidence(
  event_id TEXT NOT NULL REFERENCES assistant_commitment_events(event_id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(event_id,evidence_id));
 CREATE INDEX IF NOT EXISTS assistant_commitment_evidence_original ON assistant_commitment_evidence(evidence_id,event_id);
 CREATE TABLE IF NOT EXISTS assistant_commitment_context(
  event_id TEXT NOT NULL REFERENCES assistant_commitment_events(event_id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(event_id,source_id));
 CREATE INDEX IF NOT EXISTS assistant_commitment_context_source ON assistant_commitment_context(source_id,event_id);`);
 for(const table of ['captures','file_chunks','context_artifacts','memories'])db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_commitments_${table}_deleted BEFORE DELETE ON ${table} BEGIN ${retirementStatements('evidence_id=old.id',true).join(';')}; END;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_commitments_memory_changed AFTER UPDATE OF json ON memories WHEN new.json IS NOT old.json BEGIN
  ${retirementStatements('evidence_id=new.id',false).join(';')}; END;
 CREATE TRIGGER IF NOT EXISTS assistant_commitments_source_deleted BEFORE DELETE ON source_connections BEGIN
  ${retirementForEvents('SELECT event_id FROM assistant_commitment_context WHERE source_id=old.id',true,true).join(';')}; END;
 CREATE TRIGGER IF NOT EXISTS assistant_commitments_source_changed AFTER UPDATE OF json ON source_connections
 WHEN json_extract(old.json,'$.name') IS NOT json_extract(new.json,'$.name')
   OR json_extract(old.json,'$.kind') IS NOT json_extract(new.json,'$.kind')
   OR json_extract(old.json,'$.deviceId') IS NOT json_extract(new.json,'$.deviceId')
   OR json_extract(old.json,'$.retention') IS NOT json_extract(new.json,'$.retention')
   OR json_extract(old.json,'$.enabled') IS NOT json_extract(new.json,'$.enabled')
   OR json_extract(old.json,'$.sourceContext') IS NOT json_extract(new.json,'$.sourceContext')
   OR json_extract(old.json,'$.ownerRelation') IS NOT json_extract(new.json,'$.ownerRelation') BEGIN
  ${retirementForEvents('SELECT event_id FROM assistant_commitment_context WHERE source_id=new.id',false).join(';')}; END;`);
 store.registerStorage('assistant-commitments',{
  assistant_commitments:'length(CAST(id AS BLOB))+length(CAST(cursor_key AS BLOB))+128',
  assistant_commitment_events:'length(CAST(event_id AS BLOB))+length(CAST(commitment_id AS BLOB))+coalesce(length(CAST(target_event_id AS BLOB)),0)+length(CAST(request_hash AS BLOB))+coalesce(length(CAST(private_json AS BLOB)),0)+128',
  assistant_commitment_evidence:'length(CAST(event_id AS BLOB))+length(CAST(evidence_id AS BLOB))+64',
  assistant_commitment_context:'length(CAST(event_id AS BLOB))+length(CAST(source_id AS BLOB))+64',
 });
}
