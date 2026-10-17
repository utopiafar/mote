import {attachmentVisible} from './ingress-attachments.js';
import type {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';

/** Epoch 5 only. The host admission gate runs before this domain installer.
 * Composite keys are deliberate: identical upstream identities belong to both
 * accounts independently. No ownership backfill or old-vault migration. */
export function installPrivateData(db:DatabaseSync){
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS pd_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),cursor_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pd_sources(
      user_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS pd_source_contexts(
      user_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),
      fingerprint TEXT NOT NULL,description TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,source_id,version),
      FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_captures(
      user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT,external_id TEXT,revision TEXT,
      fingerprint TEXT NOT NULL,context_at TEXT NOT NULL,received_at TEXT NOT NULL,json TEXT NOT NULL,
      PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,external_id,revision),UNIQUE(user_id,source_id,external_id,id),
      CHECK((source_id IS NULL AND external_id IS NULL AND revision IS NULL) OR (source_id IS NOT NULL AND external_id IS NOT NULL AND revision IS NOT NULL)),
      FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS pd_captures_recent ON pd_captures(user_id,context_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS pd_import_declarations(user_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT NOT NULL,fingerprint TEXT NOT NULL,instruction TEXT NOT NULL,PRIMARY KEY(user_id,id,version),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_capture_imports(user_id TEXT NOT NULL,capture_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(user_id,capture_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,id,version) REFERENCES pd_import_declarations(user_id,id,version) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_source_heads(
      user_id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL,observed_at TEXT NOT NULL,
      PRIMARY KEY(user_id,source_id,external_id),
      FOREIGN KEY(user_id,source_id,external_id,capture_id) REFERENCES pd_captures(user_id,source_id,external_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_materials(
      user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,
      revision TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,min_visible_sequence INTEGER NOT NULL DEFAULT 1 CHECK(min_visible_sequence>0 AND min_visible_sequence<=sequence+1),
      PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,external_id),
      FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE,
      FOREIGN KEY(user_id,id,revision) REFERENCES pd_material_versions(user_id,material_id,revision) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE IF NOT EXISTS pd_material_versions(
      user_id TEXT NOT NULL,material_id TEXT NOT NULL,revision TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>0),
      json TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,material_id,revision),UNIQUE(user_id,material_id,sequence),
      FOREIGN KEY(user_id,material_id) REFERENCES pd_materials(user_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_material_declarations(user_id TEXT NOT NULL,material_id TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,base_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,material_id,id,version),FOREIGN KEY(user_id,material_id) REFERENCES pd_materials(user_id,id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS pd_material_captures(
      user_id TEXT NOT NULL,material_id TEXT NOT NULL,revision TEXT NOT NULL,member_id TEXT NOT NULL,capture_id TEXT NOT NULL,
      PRIMARY KEY(user_id,material_id,revision,member_id),
      FOREIGN KEY(user_id,material_id,revision) REFERENCES pd_material_versions(user_id,material_id,revision) ON DELETE CASCADE,
      FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE RESTRICT);
    CREATE TABLE IF NOT EXISTS pd_material_inputs(
      user_id TEXT NOT NULL,material_id TEXT NOT NULL,revision TEXT NOT NULL,member_id TEXT NOT NULL,input_material_id TEXT NOT NULL,input_revision TEXT NOT NULL,
      PRIMARY KEY(user_id,material_id,revision,member_id),
      FOREIGN KEY(user_id,material_id,revision) REFERENCES pd_material_versions(user_id,material_id,revision) ON DELETE CASCADE,
      FOREIGN KEY(user_id,input_material_id,input_revision) REFERENCES pd_material_versions(user_id,material_id,revision) ON DELETE RESTRICT);
    CREATE TABLE IF NOT EXISTS pd_material_contexts(
      user_id TEXT NOT NULL,material_id TEXT NOT NULL,revision TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,
      PRIMARY KEY(user_id,material_id,revision,source_id),
      FOREIGN KEY(user_id,material_id,revision) REFERENCES pd_material_versions(user_id,material_id,revision) ON DELETE CASCADE,
      FOREIGN KEY(user_id,source_id,version) REFERENCES pd_source_contexts(user_id,source_id,version) ON DELETE RESTRICT);
    CREATE TABLE IF NOT EXISTS pd_material_sources(
      user_id TEXT NOT NULL,material_id TEXT NOT NULL,revision TEXT NOT NULL,source_id TEXT NOT NULL,
      PRIMARY KEY(user_id,material_id,revision,source_id),
      FOREIGN KEY(user_id,material_id,revision) REFERENCES pd_material_versions(user_id,material_id,revision) ON DELETE CASCADE,
      FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE RESTRICT);
    CREATE VIRTUAL TABLE IF NOT EXISTS pd_fts USING fts5(user_id UNINDEXED,kind UNINDEXED,entity_id UNINDEXED,revision UNINDEXED,text,tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS pd_capture_index AFTER INSERT ON pd_captures BEGIN
      INSERT INTO pd_fts(user_id,kind,entity_id,revision,text) VALUES(new.user_id,'capture',new.id,'',json_extract(new.json,'$.windowTitle')||char(10)||json_extract(new.json,'$.ocrText'));
    END;
    CREATE TRIGGER IF NOT EXISTS pd_capture_unindex AFTER DELETE ON pd_captures BEGIN
      DELETE FROM pd_fts WHERE user_id=old.user_id AND kind='capture' AND entity_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS pd_material_index AFTER INSERT ON pd_material_versions BEGIN
      INSERT INTO pd_fts(user_id,kind,entity_id,revision,text) VALUES(new.user_id,'material',new.material_id,new.revision,json_extract(new.json,'$.title')||char(10)||new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS pd_material_unindex AFTER DELETE ON pd_material_versions BEGIN
      DELETE FROM pd_fts WHERE user_id=old.user_id AND kind='material' AND entity_id=old.material_id AND revision=old.revision;
    END;`);
  try{
    db.prepare('INSERT OR IGNORE INTO pd_meta VALUES(1,1,?)').run(randomBytes(32).toString('hex'));
    const row=db.prepare('SELECT version,cursor_key FROM pd_meta WHERE singleton=1').get();
    if(row?.version!==1||typeof row.cursor_key!=='string'||!/^[a-f0-9]{64}$/.test(row.cursor_key))throw Error('Invalid private-data schema');
    db.exec('COMMIT');return row.cursor_key;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

/** Fixed host-only maintenance, called inside the existing M05 commit transaction. */
export function rebuildPrivateIndex(db:DatabaseSync){
 db.exec(`DELETE FROM pd_fts;
    INSERT INTO pd_fts(user_id,kind,entity_id,revision,text)
     SELECT c.user_id,'capture',c.id,'',json_extract(c.json,'$.windowTitle')||char(10)||json_extract(c.json,'$.ocrText')
     FROM pd_captures c JOIN auth_accounts a ON a.user_id=c.user_id
     LEFT JOIN ig_capture_scopes b ON b.user_id=c.user_id AND b.capture_id=c.id
     LEFT JOIN pd_sources s ON s.user_id=c.user_id AND s.id=coalesce(c.source_id,b.source_id)
     WHERE a.disabled=0 AND COALESCE(json_extract(c.json,'$.privacy.excluded'),0)=0
     AND COALESCE(json_extract(c.json,'$.provenance.deleted'),0)=0
     AND (coalesce(c.source_id,b.source_id) IS NULL OR(s.id IS NOT NULL AND COALESCE(json_extract(s.json,'$.enabled'),1)=1))
     AND(c.source_id IS NULL OR EXISTS(SELECT 1 FROM pd_source_heads h WHERE h.user_id=c.user_id AND h.capture_id=c.id))
     AND ${attachmentVisible()};
    INSERT INTO pd_fts(user_id,kind,entity_id,revision,text)
     SELECT m.user_id,'material',m.id,m.revision,json_extract(v.json,'$.title')||char(10)||v.text
     FROM pd_materials m JOIN pd_material_versions v ON v.user_id=m.user_id AND v.material_id=m.id AND v.revision=m.revision
     JOIN auth_accounts a ON a.user_id=m.user_id
     WHERE a.disabled=0 AND m.sequence>=m.min_visible_sequence
     AND NOT EXISTS(SELECT 1 FROM pd_material_sources x LEFT JOIN pd_sources s ON s.user_id=x.user_id AND s.id=x.source_id
      WHERE x.user_id=m.user_id AND x.material_id=m.id AND x.revision=m.revision AND(s.id IS NULL OR COALESCE(json_extract(s.json,'$.enabled'),1)=0));`);
}
