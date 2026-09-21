import type {DatabaseSync} from 'node:sqlite';

/** Transactional projections: request paths never scan capture JSON for global counts. */
export function initializeReadModels(db:DatabaseSync){
  if(!db.prepare('PRAGMA table_info(captures)').all().some(c=>c.name==='context_at')){
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE captures ADD COLUMN context_at TEXT;
      ALTER TABLE captures ADD COLUMN context_end TEXT;
      UPDATE captures SET context_at=mote_context_time(json),context_end=mote_context_end(json);
      COMMIT;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS captures_context ON captures(context_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS captures_context_device ON captures(device_id,context_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS captures_index_status ON captures(index_status);
    CREATE INDEX IF NOT EXISTS memory_batches_job ON memory_batches(job_id,idx);
    CREATE TABLE IF NOT EXISTS capture_counts(source TEXT NOT NULL,index_status TEXT NOT NULL,has_image INTEGER NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(source,index_status,has_image));
    CREATE TABLE IF NOT EXISTS blob_counts(id INTEGER PRIMARY KEY CHECK(id=1),n INTEGER NOT NULL,bytes INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS capture_counts_insert AFTER INSERT ON captures BEGIN
      UPDATE captures SET context_at=mote_context_time(new.json),context_end=mote_context_end(new.json) WHERE id=new.id;
      INSERT INTO capture_counts VALUES(json_extract(new.json,'$.source'),new.index_status,new.blob_hash IS NOT NULL,1) ON CONFLICT(source,index_status,has_image) DO UPDATE SET n=n+1;
    END;
    CREATE TRIGGER IF NOT EXISTS capture_counts_delete AFTER DELETE ON captures BEGIN
      UPDATE capture_counts SET n=n-1 WHERE source=json_extract(old.json,'$.source') AND index_status=old.index_status AND has_image=(old.blob_hash IS NOT NULL);
    END;
    CREATE TRIGGER IF NOT EXISTS capture_counts_update AFTER UPDATE OF json,index_status,blob_hash ON captures BEGIN
      UPDATE captures SET context_at=mote_context_time(new.json),context_end=mote_context_end(new.json) WHERE id=new.id;
      UPDATE capture_counts SET n=n-1 WHERE source=json_extract(old.json,'$.source') AND index_status=old.index_status AND has_image=(old.blob_hash IS NOT NULL);
      INSERT INTO capture_counts VALUES(json_extract(new.json,'$.source'),new.index_status,new.blob_hash IS NOT NULL,1) ON CONFLICT(source,index_status,has_image) DO UPDATE SET n=n+1;
    END;
    CREATE TRIGGER IF NOT EXISTS blob_counts_insert AFTER INSERT ON blobs BEGIN UPDATE blob_counts SET n=n+1,bytes=bytes+new.bytes; END;
    CREATE TRIGGER IF NOT EXISTS blob_counts_delete AFTER DELETE ON blobs BEGIN UPDATE blob_counts SET n=n-1,bytes=bytes-old.bytes; END;
    CREATE TRIGGER IF NOT EXISTS blob_counts_update AFTER UPDATE ON blobs BEGIN UPDATE blob_counts SET bytes=bytes+new.bytes-old.bytes; END;`);
  if(!db.prepare("SELECT 1 FROM settings WHERE key='read-models-v1'").get())db.exec(`BEGIN IMMEDIATE;
    DELETE FROM capture_counts;
    INSERT INTO capture_counts SELECT json_extract(json,'$.source'),index_status,blob_hash IS NOT NULL,count(*) FROM captures GROUP BY 1,2,3;
    INSERT OR REPLACE INTO blob_counts SELECT 1,count(*),coalesce(sum(bytes),0) FROM blobs;
    INSERT INTO settings VALUES('read-models-v1','1'); COMMIT;`);
}
