import type {DatabaseSync} from 'node:sqlite';

export function fileSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS file_objects(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,parts INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS file_versions(capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,source_id TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,manifest TEXT NOT NULL,object_hash TEXT REFERENCES file_objects(hash));
 CREATE TABLE IF NOT EXISTS file_heads(source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,origin_missing INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,external_id));
 CREATE TABLE IF NOT EXISTS file_forgotten(source_id TEXT NOT NULL,external_id TEXT NOT NULL,PRIMARY KEY(source_id,external_id));
 CREATE TABLE IF NOT EXISTS file_uploads(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,manifest TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,ack TEXT);
 CREATE TABLE IF NOT EXISTS file_parts(upload_id TEXT NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,part INTEGER NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(upload_id,part));
 CREATE TABLE IF NOT EXISTS file_jobs(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'waiting',stage TEXT NOT NULL DEFAULT 'transcribe',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,error TEXT,config_revision TEXT,summary_state TEXT NOT NULL DEFAULT 'waiting');
 CREATE TABLE IF NOT EXISTS file_artifacts(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,kind TEXT NOT NULL,created_at TEXT NOT NULL,config_revision TEXT NOT NULL,json TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS file_chunks(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,start_ms REAL,end_ms REAL,text TEXT NOT NULL,embedding TEXT,embedding_model TEXT);
 CREATE INDEX IF NOT EXISTS file_chunk_capture ON file_chunks(capture_id);
 CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
 CREATE TRIGGER IF NOT EXISTS file_chunk_fts_insert AFTER INSERT ON file_chunks BEGIN INSERT INTO file_chunks_fts VALUES(NEW.id,NEW.text); END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_fts_delete AFTER DELETE ON file_chunks BEGIN DELETE FROM file_chunks_fts WHERE id=OLD.id; END;
 CREATE VIRTUAL TABLE IF NOT EXISTS file_chunks_trigram USING fts5(id UNINDEXED,text,tokenize='trigram');
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_insert AFTER INSERT ON file_chunks BEGIN INSERT INTO file_chunks_trigram VALUES(NEW.id,NEW.text); END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_delete AFTER DELETE ON file_chunks BEGIN DELETE FROM file_chunks_trigram WHERE id=OLD.id; END;
 CREATE TRIGGER IF NOT EXISTS file_chunk_trigram_update AFTER UPDATE OF text ON file_chunks WHEN NEW.text!=OLD.text BEGIN DELETE FROM file_chunks_trigram WHERE id=OLD.id; INSERT INTO file_chunks_trigram VALUES(NEW.id,NEW.text); DELETE FROM file_chunks_fts WHERE id=OLD.id; INSERT INTO file_chunks_fts VALUES(NEW.id,NEW.text); END;
 INSERT INTO file_chunks_trigram(id,text) SELECT id,text FROM file_chunks WHERE id NOT IN (SELECT id FROM file_chunks_trigram);

 CREATE TABLE IF NOT EXISTS file_usage(day TEXT PRIMARY KEY,audio_ms REAL NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS file_artifact_capture_kind ON file_artifacts(capture_id,kind,current);
 CREATE TABLE IF NOT EXISTS file_steps(capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,step TEXT NOT NULL,processor TEXT NOT NULL,version TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,artifact_id TEXT,error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(capture_id,step));
 CREATE TABLE IF NOT EXISTS file_assets(artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,object_hash TEXT NOT NULL REFERENCES file_objects(hash),PRIMARY KEY(artifact_id,name));
 CREATE TABLE IF NOT EXISTS file_reviews(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES file_artifacts(id) ON DELETE CASCADE,kind TEXT NOT NULL,status TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL);
 `);
 const columns=new Set((db.prepare('PRAGMA table_info(file_chunks)').all() as {name:string}[]).map(r=>r.name));
 if(!columns.has('index_error'))db.exec('ALTER TABLE file_chunks ADD COLUMN index_error TEXT');
 if(!columns.has('metadata'))db.exec("ALTER TABLE file_chunks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
 const jobs=new Set((db.prepare('PRAGMA table_info(file_jobs)').all() as {name:string}[]).map(r=>r.name));
 if(!jobs.has('policy_json'))db.exec('ALTER TABLE file_jobs ADD COLUMN policy_json TEXT');
 if(!jobs.has('local_only'))db.exec('ALTER TABLE file_jobs ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0');
}
