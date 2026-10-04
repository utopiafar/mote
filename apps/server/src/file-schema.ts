import type {DatabaseSync} from 'node:sqlite';

export function fileSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS file_objects(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,parts INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS file_versions(capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,source_id TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,manifest TEXT NOT NULL,object_hash TEXT REFERENCES file_objects(hash));
 CREATE TABLE IF NOT EXISTS file_snapshot_inputs(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,object_hash TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS file_snapshot_text(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,object_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS file_snapshot_index(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS file_heads(source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,origin_missing INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,external_id));
 CREATE UNIQUE INDEX IF NOT EXISTS file_revision_identity ON file_versions(source_id,external_id,revision);
 CREATE INDEX IF NOT EXISTS file_head_capture ON file_heads(capture_id);
 CREATE TABLE IF NOT EXISTS file_forgotten(source_id TEXT NOT NULL,external_id TEXT NOT NULL,PRIMARY KEY(source_id,external_id));
 CREATE TABLE IF NOT EXISTS file_uploads(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,manifest TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,ack TEXT);
 CREATE TABLE IF NOT EXISTS file_parts(upload_id TEXT NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,part INTEGER NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(upload_id,part));
 CREATE TABLE IF NOT EXISTS file_jobs(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'waiting',stage TEXT NOT NULL DEFAULT 'transcribe',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT,config_revision TEXT,summary_state TEXT NOT NULL DEFAULT 'waiting',policy_json TEXT,local_only INTEGER NOT NULL DEFAULT 0,auto_eligible INTEGER NOT NULL DEFAULT 1,reuse_allowed INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS file_artifacts(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,kind TEXT NOT NULL,created_at TEXT NOT NULL,config_revision TEXT NOT NULL,json TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS file_chunks(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,start_ms REAL,end_ms REAL,text TEXT NOT NULL,embedding TEXT,embedding_model TEXT,index_error TEXT,metadata TEXT NOT NULL DEFAULT '{}',ordinal INTEGER);
 CREATE INDEX IF NOT EXISTS file_chunk_capture ON file_chunks(capture_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
 CREATE TRIGGER IF NOT EXISTS file_chunk_fts_insert AFTER INSERT ON file_chunks BEGIN INSERT INTO file_chunks_fts VALUES(NEW.id,NEW.text); END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_fts_delete AFTER DELETE ON file_chunks BEGIN DELETE FROM file_chunks_fts WHERE id=OLD.id; END;
 CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks_trigram USING fts5(id UNINDEXED,text,tokenize='trigram');
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_insert AFTER INSERT ON file_chunks BEGIN INSERT INTO file_chunks_trigram VALUES(NEW.id,NEW.text); END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_delete AFTER DELETE ON file_chunks BEGIN DELETE FROM file_chunks_trigram WHERE id=OLD.id; END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_update AFTER UPDATE OF text ON file_chunks WHEN NEW.text!=OLD.text BEGIN DELETE FROM file_chunks_trigram WHERE id=OLD.id; INSERT INTO file_chunks_trigram VALUES(NEW.id,NEW.text); DELETE FROM file_chunks_fts WHERE id=OLD.id; INSERT INTO file_chunks_fts VALUES(NEW.id,NEW.text); END;


 CREATE TABLE IF NOT EXISTS file_usage(day TEXT PRIMARY KEY,audio_ms REAL NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS file_artifact_capture_kind ON file_artifacts(capture_id,kind,current);
 CREATE TABLE IF NOT EXISTS file_steps(capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,step TEXT NOT NULL,processor TEXT NOT NULL,version TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,artifact_id TEXT,error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(capture_id,step));
 CREATE TABLE IF NOT EXISTS file_assets(artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,object_hash TEXT NOT NULL REFERENCES file_objects(hash),PRIMARY KEY(artifact_id,name));
 CREATE TABLE IF NOT EXISTS file_reviews(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL);
 `);

}

/** Run only after all persisted capture-trigger functions are registered. */
export function migrateSnapshotIndexProjection(db:DatabaseSync){
 // Earlier snapshot processing rewrote the accepted source record's index
 // receipt, making its source-version checksum unreadable. Preserve the derived
 // receipt separately and recover the immutable input from the upload manifest.
 db.exec(`INSERT OR IGNORE INTO file_snapshot_index(capture_id,json)
   SELECT v.capture_id,json_extract(c.json,'$.provenance.document.fileIndex') FROM file_versions v JOIN captures c ON c.id=v.capture_id
   WHERE json_extract(v.manifest,'$.item.layer')='snapshot'
     AND json_extract(c.json,'$.provenance.document.fileIndex') IS NOT NULL
     AND json_extract(v.manifest,'$.item.document.fileIndex') IS NOT NULL
     AND json_extract(c.json,'$.provenance.document.fileIndex')!=json_extract(v.manifest,'$.item.document.fileIndex');
   UPDATE captures SET json=json_set(json,'$.provenance.document.fileIndex',json((SELECT json_extract(v.manifest,'$.item.document.fileIndex') FROM file_versions v WHERE v.capture_id=captures.id)))
   WHERE id IN (SELECT v.capture_id FROM file_versions v JOIN captures c ON c.id=v.capture_id
     WHERE json_extract(v.manifest,'$.item.layer')='snapshot'
       AND json_extract(v.manifest,'$.item.document.fileIndex') IS NOT NULL
       AND json_extract(c.json,'$.provenance.document.fileIndex')!=json_extract(v.manifest,'$.item.document.fileIndex'));`);

}
