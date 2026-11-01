import type {DatabaseSync} from 'node:sqlite';

/** Perception owns OCR work, results and the intake trigger; captures must already exist. */
export function perceptionSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS perception_jobs(capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,kind TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,requested INTEGER NOT NULL DEFAULT 0,auto_eligible INTEGER NOT NULL DEFAULT 1,error TEXT,PRIMARY KEY(capture_id,kind));
 CREATE TABLE IF NOT EXISTS perception_results(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS perception_cache ON perception_results(fingerprint);
 CREATE INDEX IF NOT EXISTS perception_current ON perception_results(capture_id,kind,current);
 CREATE TRIGGER IF NOT EXISTS perception_ingest AFTER INSERT ON captures WHEN new.blob_hash IS NOT NULL AND json_extract(new.json,'$.source')='screen' BEGIN
        INSERT INTO perception_jobs(capture_id,kind,state,created_at) VALUES(new.id,'ocr','waiting',CAST(strftime('%s','now') AS INTEGER)*1000);
      END;
`);}
