import type {Store} from './store.js';

/** A version and its feedback can outlive its current projection. Cleanup also
 * increments the card revision when only historical material was affected, so
 * an analysis based on the old history cannot overwrite the corrected state. */
function retirementStatements(selection:string,versionTable='assistant_card_evidence',feedbackTable='assistant_card_feedback_evidence'){
 const versions=`SELECT card_id,version FROM ${versionTable} WHERE ${selection}`;
 const feedback=`SELECT feedback_seq FROM ${feedbackTable} WHERE ${selection}`;
 const affected=`SELECT card_id FROM ${versionTable} WHERE ${selection} UNION SELECT f.card_id FROM assistant_card_feedback f WHERE f.seq IN (${feedback})`;
 const other=versionTable==='assistant_card_evidence'?'assistant_card_context':'assistant_card_evidence';
 const current=`(id,current_version) IN (${versions})`;
 return [
  `UPDATE assistant_cards SET state=CASE WHEN ${current} THEN 'stale' ELSE state END,
   accepted_task_id=CASE WHEN ${current} THEN NULL ELSE accepted_task_id END,
   read_at=CASE WHEN ${current} THEN NULL ELSE read_at END,revision=revision+1,
   updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${affected})`,
  `DELETE FROM assistant_card_feedback WHERE (card_id,version) IN (${versions}) OR seq IN (${feedback})`,
  `UPDATE assistant_card_versions SET private_json=NULL WHERE (card_id,version) IN (${versions})`,
  `DELETE FROM ${other} WHERE (card_id,version) IN (${versions})`,
  `DELETE FROM ${versionTable} WHERE (card_id,version) IN (${versions})`,
 ];
}

/** Private version bodies and owner feedback are purged in the same transaction
 * as evidence deletion. Ordinary revisions mark historical versions stale;
 * identity/version receipts remain so a delayed replay cannot restore prose. */
export function invalidateAssistantCardEvidence(store:Store,ids?:readonly string[],deleted:boolean|'retired'=false){
 if(ids!==undefined&&!ids.length)return;
 const db=store.db,selection=ids===undefined?'1':'evidence_id IN (SELECT value FROM json_each(?1))';
 const params=ids===undefined?[]:[JSON.stringify(ids)];
 if(!deleted){
  const versions=`SELECT e.card_id,e.version FROM assistant_card_evidence e JOIN assistant_card_versions v ON v.card_id=e.card_id AND v.version=e.version WHERE v.stale=0 AND ${ids===undefined?'1':"e.evidence_id IN (SELECT value FROM json_each(?1))"}`;
  const feedback=`SELECT f.seq FROM assistant_card_feedback f JOIN assistant_card_feedback_evidence e ON e.feedback_seq=f.seq WHERE f.stale=0 AND ${ids===undefined?'1':"e.evidence_id IN (SELECT value FROM json_each(?1))"}`;
  const affected=ids===undefined?'SELECT id FROM assistant_cards':`SELECT card_id FROM (${versions}) UNION SELECT card_id FROM assistant_card_feedback WHERE seq IN (${feedback})`;
  const current=ids===undefined?'1':`(id,current_version) IN (${versions})`;
  db.prepare(`UPDATE assistant_cards SET state=CASE WHEN ${current} THEN 'stale' ELSE state END,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${affected})`).run(...params);
  db.prepare(`UPDATE assistant_card_versions SET stale=1 WHERE ${ids===undefined?'1':`(card_id,version) IN (SELECT card_id,version FROM assistant_card_evidence WHERE ${selection})`}`).run(...params);
  db.prepare(`UPDATE assistant_card_feedback SET stale=1 WHERE ${ids===undefined?'1':`seq IN (SELECT feedback_seq FROM assistant_card_feedback_evidence WHERE ${selection})`}`).run(...params);
  return;
 }
 if(ids===undefined){
  db.exec(`UPDATE assistant_cards SET state='stale',revision=revision+1,accepted_task_id=NULL,read_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
   DELETE FROM assistant_card_feedback; UPDATE assistant_card_versions SET private_json=NULL; DELETE FROM assistant_card_evidence; DELETE FROM assistant_card_context;`);
 }else for(const statement of retirementStatements(selection))db.prepare(statement).run(...params);
}

/** Install on every vault open, including maintenance-only writers. */
export function installAssistantCards(store:Store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS assistant_cards(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,cursor_key TEXT NOT NULL,kind TEXT NOT NULL,matter_id TEXT,
  revision INTEGER NOT NULL,current_version TEXT NOT NULL,state TEXT NOT NULL,accepted_task_id TEXT,
  read_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assistant_card_versions(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,card_id TEXT NOT NULL REFERENCES assistant_cards(id) ON DELETE CASCADE,
  version TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0,private_json TEXT,created_at TEXT NOT NULL,
  UNIQUE(card_id,version));
 CREATE INDEX IF NOT EXISTS assistant_card_versions_history ON assistant_card_versions(card_id,seq DESC);
 CREATE TABLE IF NOT EXISTS assistant_card_evidence(
  card_id TEXT NOT NULL,version TEXT NOT NULL,evidence_id TEXT NOT NULL,
  PRIMARY KEY(card_id,version,evidence_id),FOREIGN KEY(card_id,version) REFERENCES assistant_card_versions(card_id,version) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS assistant_card_evidence_original ON assistant_card_evidence(evidence_id,card_id,version);
 CREATE TABLE IF NOT EXISTS assistant_card_context(
  card_id TEXT NOT NULL,version TEXT NOT NULL,source_id TEXT NOT NULL,
  PRIMARY KEY(card_id,version,source_id),FOREIGN KEY(card_id,version) REFERENCES assistant_card_versions(card_id,version) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS assistant_card_context_source ON assistant_card_context(source_id,card_id,version);
 CREATE TABLE IF NOT EXISTS assistant_card_feedback(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,card_id TEXT NOT NULL,version TEXT NOT NULL,action TEXT NOT NULL,
  private_json TEXT,stale INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,FOREIGN KEY(card_id,version) REFERENCES assistant_card_versions(card_id,version) ON DELETE CASCADE);
 CREATE INDEX IF NOT EXISTS assistant_card_feedback_history ON assistant_card_feedback(card_id,seq);
 CREATE TABLE IF NOT EXISTS assistant_card_feedback_evidence(
  feedback_seq INTEGER NOT NULL REFERENCES assistant_card_feedback(seq) ON DELETE CASCADE,evidence_id TEXT NOT NULL,
  PRIMARY KEY(feedback_seq,evidence_id));
 CREATE INDEX IF NOT EXISTS assistant_card_feedback_evidence_original ON assistant_card_feedback_evidence(evidence_id,feedback_seq);
 CREATE TABLE IF NOT EXISTS assistant_card_feedback_context(
  feedback_seq INTEGER NOT NULL REFERENCES assistant_card_feedback(seq) ON DELETE CASCADE,source_id TEXT NOT NULL,
  PRIMARY KEY(feedback_seq,source_id));
 CREATE INDEX IF NOT EXISTS assistant_card_feedback_context_source ON assistant_card_feedback_context(source_id,feedback_seq);`);
 for(const table of ['captures','file_chunks','context_artifacts','memories'])db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_cards_${table}_deleted BEFORE DELETE ON ${table} BEGIN ${retirementStatements('evidence_id=old.id').join(';')}; END;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_cards_memory_changed AFTER UPDATE OF json ON memories WHEN new.json IS NOT old.json BEGIN
  UPDATE assistant_cards SET state=CASE WHEN (id,current_version) IN (SELECT card_id,version FROM assistant_card_evidence WHERE evidence_id=new.id) THEN 'stale' ELSE state END,
   revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (
    SELECT e.card_id FROM assistant_card_evidence e JOIN assistant_card_versions v ON v.card_id=e.card_id AND v.version=e.version WHERE e.evidence_id=new.id AND v.stale=0
    UNION SELECT f.card_id FROM assistant_card_feedback f JOIN assistant_card_feedback_evidence e ON e.feedback_seq=f.seq WHERE e.evidence_id=new.id AND f.stale=0);
  UPDATE assistant_card_versions SET stale=1 WHERE (card_id,version) IN (SELECT card_id,version FROM assistant_card_evidence WHERE evidence_id=new.id);
  UPDATE assistant_card_feedback SET stale=1 WHERE seq IN (SELECT feedback_seq FROM assistant_card_feedback_evidence WHERE evidence_id=new.id);
 END;`);
 // An accepted task has its own evidence scope and lifecycle. If it retires,
 // remove the link without treating task text as card evidence.
 db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_cards_task_stale AFTER UPDATE OF state ON task_records
 WHEN new.state='stale' AND old.state!='stale' BEGIN
  UPDATE assistant_cards SET accepted_task_id=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE accepted_task_id=new.id;
 END;
 CREATE TRIGGER IF NOT EXISTS assistant_cards_task_deleted BEFORE DELETE ON task_records BEGIN
  UPDATE assistant_cards SET accepted_task_id=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE accepted_task_id=old.id;
 END;`);
 // Metadata and owner declarations are separate from original captures. Track
 // their identities without ever treating them as new evidence or permission.
 db.exec(`CREATE TRIGGER IF NOT EXISTS assistant_cards_source_deleted BEFORE DELETE ON source_connections BEGIN
  ${retirementStatements('source_id=old.id','assistant_card_context','assistant_card_feedback_context').join(';')}; END;
 CREATE TRIGGER IF NOT EXISTS assistant_cards_source_changed AFTER UPDATE OF json ON source_connections
 WHEN json_extract(old.json,'$.name') IS NOT json_extract(new.json,'$.name')
   OR json_extract(old.json,'$.kind') IS NOT json_extract(new.json,'$.kind')
   OR json_extract(old.json,'$.deviceId') IS NOT json_extract(new.json,'$.deviceId')
   OR json_extract(old.json,'$.retention') IS NOT json_extract(new.json,'$.retention')
   OR json_extract(old.json,'$.enabled') IS NOT json_extract(new.json,'$.enabled')
   OR json_extract(old.json,'$.sourceContext') IS NOT json_extract(new.json,'$.sourceContext')
   OR json_extract(old.json,'$.ownerRelation') IS NOT json_extract(new.json,'$.ownerRelation') BEGIN
  UPDATE assistant_cards SET state=CASE WHEN (id,current_version) IN (SELECT card_id,version FROM assistant_card_context WHERE source_id=new.id) THEN 'stale' ELSE state END,
   revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (
    SELECT c.card_id FROM assistant_card_context c JOIN assistant_card_versions v ON v.card_id=c.card_id AND v.version=c.version WHERE c.source_id=new.id AND v.stale=0
    UNION SELECT f.card_id FROM assistant_card_feedback f JOIN assistant_card_feedback_context c ON c.feedback_seq=f.seq WHERE c.source_id=new.id AND f.stale=0);
  UPDATE assistant_card_versions SET stale=1 WHERE (card_id,version) IN (SELECT card_id,version FROM assistant_card_context WHERE source_id=new.id);
  UPDATE assistant_card_feedback SET stale=1 WHERE seq IN (SELECT feedback_seq FROM assistant_card_feedback_context WHERE source_id=new.id);
 END;`);
 store.registerStorage('assistant-cards',{
  assistant_cards:'length(CAST(id AS BLOB))+length(CAST(cursor_key AS BLOB))+length(CAST(kind AS BLOB))+coalesce(length(CAST(matter_id AS BLOB)),0)+length(CAST(current_version AS BLOB))+coalesce(length(CAST(accepted_task_id AS BLOB)),0)+256',
  assistant_card_versions:'length(CAST(card_id AS BLOB))+length(CAST(version AS BLOB))+length(CAST(request_hash AS BLOB))+coalesce(length(CAST(private_json AS BLOB)),0)+128',
  assistant_card_evidence:'length(CAST(card_id AS BLOB))+length(CAST(version AS BLOB))+length(CAST(evidence_id AS BLOB))+64',
  assistant_card_context:'length(CAST(card_id AS BLOB))+length(CAST(version AS BLOB))+length(CAST(source_id AS BLOB))+64',
  assistant_card_feedback:'length(CAST(card_id AS BLOB))+length(CAST(version AS BLOB))+length(CAST(action AS BLOB))+coalesce(length(CAST(private_json AS BLOB)),0)+128',
  assistant_card_feedback_evidence:'length(CAST(evidence_id AS BLOB))+64',
  assistant_card_feedback_context:'length(CAST(source_id AS BLOB))+64',
 });
}
