import type {DatabaseSync} from 'node:sqlite';

/** Capture originals, device/blob identities, change feed and capture browsing/search projections. */
export function captureSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, captured_at TEXT NOT NULL, received_at TEXT NOT NULL,
        json TEXT NOT NULL, fingerprint TEXT NOT NULL, blob_hash TEXT, mime TEXT, index_status TEXT NOT NULL, context_at TEXT, context_end TEXT,
        summary TEXT, embedding TEXT, embedding_model TEXT, index_error TEXT, attempts INTEGER NOT NULL DEFAULT 0
      );
CREATE INDEX IF NOT EXISTS captures_vectors ON captures(embedding_model,captured_at DESC,id) WHERE embedding IS NOT NULL;
 CREATE INDEX IF NOT EXISTS captures_time ON captures(captured_at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS captures_device ON captures(device_id,captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_device_source_time ON captures(device_id,json_extract(json,'$.source'),captured_at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS captures_app ON captures(json_extract(json,'$.appId'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_source ON captures(json_extract(json,'$.source'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_ios_notification_key ON captures(device_id,json_extract(json,'$.metadata.notification.notificationKey')) WHERE json_extract(json,'$.platform')='ios' AND json_extract(json,'$.source')='notification';
 CREATE INDEX IF NOT EXISTS captures_collection ON captures(COALESCE(json_extract(json,'$.privacy.collection'),'content'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_ui_page_scope ON captures(device_id,json_extract(json,'$.appId'),json_extract(json,'$.metadata.uiPage.objects[0].kind'),captured_at DESC,id DESC) WHERE json_extract(json,'$.source')='ui_page' AND json_extract(json,'$.metadata.uiPage.version')=3;
 CREATE INDEX IF NOT EXISTS captures_coding_repository ON captures(json_extract(json,'$.provenance.document.coding.repositoryKey'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_coding_project ON captures(json_extract(json,'$.provenance.document.coding.projectKey'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_coding_session ON captures(json_extract(json,'$.provenance.document.coding.sessionId'),captured_at DESC);
 CREATE INDEX IF NOT EXISTS captures_coding_provider ON captures(json_extract(json,'$.provenance.document.coding.provider'),captured_at DESC);
 CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, operation TEXT NOT NULL, changed_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS changes_entity_operation ON changes(id,operation);
 CREATE TABLE IF NOT EXISTS capture_ocr_receipts (id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE, original_fingerprint TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(id UNINDEXED, text, tokenize='unicode61');
`);}

/** Capture browsing/search triggers are installed after intake domains and before input opens. */
export function captureProjectionSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS capture_gallery (
        id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL, captured_at TEXT NOT NULL, app_id TEXT NOT NULL, app_name TEXT NOT NULL, has_image INTEGER NOT NULL
      );
 CREATE INDEX IF NOT EXISTS gallery_device_time ON capture_gallery(device_id,captured_at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS gallery_app_time ON capture_gallery(device_id,app_id,captured_at DESC,id DESC);
 CREATE TRIGGER IF NOT EXISTS gallery_insert AFTER INSERT ON captures WHEN json_extract(NEW.json,'$.source')='screen' BEGIN
        INSERT INTO capture_gallery VALUES(NEW.id,NEW.device_id,NEW.captured_at,COALESCE(json_extract(NEW.json,'$.appId'),''),COALESCE(json_extract(NEW.json,'$.appName'),''),NEW.blob_hash IS NOT NULL);
      END;

CREATE VIRTUAL TABLE IF NOT EXISTS captures_trigram USING fts5(id UNINDEXED,text,tokenize='trigram');
 CREATE TRIGGER IF NOT EXISTS captures_trigram_insert AFTER INSERT ON captures BEGIN INSERT INTO captures_trigram(rowid,id,text) VALUES(new.rowid,new.id,mote_search_text(new.json)); END;
 CREATE TRIGGER IF NOT EXISTS captures_trigram_delete AFTER DELETE ON captures BEGIN DELETE FROM captures_trigram WHERE rowid=old.rowid; END;
 CREATE TRIGGER IF NOT EXISTS captures_trigram_update AFTER UPDATE OF json ON captures WHEN new.json!=old.json BEGIN DELETE FROM captures_trigram WHERE rowid=old.rowid; INSERT INTO captures_trigram(rowid,id,text) VALUES(new.rowid,new.id,mote_search_text(new.json)); END;
CREATE TRIGGER IF NOT EXISTS captures_words_delete BEFORE DELETE ON captures BEGIN DELETE FROM captures_fts WHERE rowid=old.rowid; END;
`);}
