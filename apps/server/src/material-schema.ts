import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation,SchemaPrerequisite} from './schema-installation.js';

/** Material's persisted heads, immutable revisions, evidence and search state.
 * Asset bytes and original captures retain their existing owners. */
export const materialSchemaInstallation={
 owner:'material',requires:[],
 prerequisites:[
  {owner:'capture',objects:[{type:'table',name:'captures'}]},
  {owner:'assets',objects:[{type:'table',name:'asset_references'}]},
 ],
 install:materialSchema,
} as const satisfies SchemaInstallation;

export const materialHeadsPrerequisite={owner:'material',objects:[{type:'table',name:'material_heads'}]} as const satisfies SchemaPrerequisite;

function materialSchema(db:DatabaseSync){
 db.exec(`
      CREATE TABLE IF NOT EXISTS material_searchable(material_id TEXT PRIMARY KEY REFERENCES material_heads(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS material_evidence(id TEXT PRIMARY KEY,material_id TEXT NOT NULL,revision TEXT NOT NULL,block_id TEXT NOT NULL,invalidated INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_evidence_parent ON material_evidence(material_id,revision);
      CREATE INDEX IF NOT EXISTS material_evidence_invalidated ON material_evidence(material_id,id) WHERE invalidated=1;
      CREATE TABLE IF NOT EXISTS material_evidence_context(
        anchor_id TEXT PRIMARY KEY REFERENCES material_evidence(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_evidence_dependencies(
        anchor_id TEXT NOT NULL REFERENCES material_evidence(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,
        PRIMARY KEY(anchor_id,evidence_id));
      CREATE INDEX IF NOT EXISTS material_evidence_dependencies_input ON material_evidence_dependencies(evidence_id,anchor_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(material_id UNINDEXED,text,content='',tokenize='trigram',contentless_delete=1);
      CREATE VIRTUAL TABLE IF NOT EXISTS material_fts_blocks USING fts5(text,content='',tokenize='trigram',contentless_delete=1);
      CREATE TABLE IF NOT EXISTS material_heads(
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT NOT NULL,kind TEXT NOT NULL,
        revision TEXT NOT NULL,sequence INTEGER NOT NULL,retired INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,first_at TEXT,last_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,min_visible_sequence INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS material_index_garbage(kind TEXT NOT NULL,row_id INTEGER NOT NULL,PRIMARY KEY(kind,row_id));
      DROP TRIGGER IF EXISTS material_search_delete;
      CREATE TRIGGER material_search_delete BEFORE DELETE ON material_heads BEGIN
        INSERT OR IGNORE INTO material_index_garbage VALUES('head',old.rowid);
      END;
      CREATE INDEX IF NOT EXISTS material_heads_source ON material_heads(source_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS material_heads_recent ON material_heads(retired,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS material_revisions(
        material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL,
        text_length INTEGER NOT NULL,block_count INTEGER NOT NULL,member_count INTEGER NOT NULL,asset_count INTEGER NOT NULL,
        draft_hash TEXT,PRIMARY KEY(material_id,revision),UNIQUE(material_id,sequence));
      CREATE TABLE IF NOT EXISTS material_owner_declarations(material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(material_id,id,version));
      CREATE TABLE IF NOT EXISTS material_coding_snapshots(material_id TEXT NOT NULL,revision TEXT NOT NULL,
        archive_checkpoint TEXT,append_epoch INTEGER,head_count INTEGER,
        PRIMARY KEY(material_id,revision),FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS material_block_payloads(hash TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_block_versions(
        id INTEGER PRIMARY KEY,material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,
        from_revision TEXT NOT NULL,from_sequence INTEGER NOT NULL,until_sequence INTEGER,
        idx INTEGER NOT NULL,block_id TEXT NOT NULL,kind TEXT NOT NULL,format TEXT,
        payload_hash TEXT NOT NULL REFERENCES material_block_payloads(hash),asset_hash TEXT,mime_type TEXT,
        member_ids TEXT NOT NULL,locator TEXT,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,anchor_id TEXT,
        UNIQUE(material_id,from_revision,idx));
      CREATE INDEX IF NOT EXISTS material_block_versions_range ON material_block_versions(material_id,start_offset,from_sequence,until_sequence);
      CREATE INDEX IF NOT EXISTS material_block_versions_index ON material_block_versions(material_id,idx,from_sequence,until_sequence);
      CREATE INDEX IF NOT EXISTS material_block_versions_anchor ON material_block_versions(material_id,anchor_id,from_sequence,until_sequence);
      CREATE TABLE IF NOT EXISTS material_blocks(
        material_id TEXT NOT NULL,revision TEXT NOT NULL,idx INTEGER NOT NULL,block_id TEXT NOT NULL,
        kind TEXT NOT NULL,format TEXT,payload_hash TEXT NOT NULL REFERENCES material_block_payloads(hash),
        asset_hash TEXT,mime_type TEXT,member_ids TEXT NOT NULL,locator TEXT,
        start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,
        anchor_id TEXT,identity_hash TEXT,PRIMARY KEY(material_id,revision,idx),UNIQUE(material_id,revision,block_id),
        FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_blocks_range ON material_blocks(material_id,revision,end_offset);
      CREATE INDEX IF NOT EXISTS material_blocks_anchor ON material_blocks(material_id,revision,anchor_id);
      CREATE TABLE IF NOT EXISTS material_members(
        material_id TEXT NOT NULL,revision TEXT NOT NULL,idx INTEGER NOT NULL,id TEXT NOT NULL,
        kind TEXT NOT NULL,ref TEXT NOT NULL,source_revision TEXT,locator TEXT,
        PRIMARY KEY(material_id,revision,idx),UNIQUE(material_id,revision,id),
        FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_members_source ON material_members(kind,ref,material_id);
      CREATE TRIGGER IF NOT EXISTS material_block_asset_insert AFTER INSERT ON material_blocks
        WHEN new.asset_hash IS NOT NULL BEGIN
        INSERT INTO asset_references(owner,hash) VALUES('material:'||new.material_id||':'||new.revision||':'||new.block_id,new.asset_hash);
      END;
      CREATE TRIGGER IF NOT EXISTS material_block_asset_delete AFTER DELETE ON material_blocks
        WHEN old.asset_hash IS NOT NULL BEGIN
        DELETE FROM asset_references WHERE owner='material:'||old.material_id||':'||old.revision||':'||old.block_id;
      END;
      CREATE TRIGGER IF NOT EXISTS material_block_payload_delete AFTER DELETE ON material_blocks BEGIN
        DELETE FROM material_block_payloads WHERE hash=old.payload_hash
          AND NOT EXISTS(SELECT 1 FROM material_blocks WHERE payload_hash=old.payload_hash)
          AND NOT EXISTS(SELECT 1 FROM material_block_versions WHERE payload_hash=old.payload_hash);
      END;
      DROP TRIGGER IF EXISTS material_block_version_delete;
      CREATE TRIGGER material_block_version_delete AFTER DELETE ON material_block_versions BEGIN
        INSERT OR IGNORE INTO material_index_garbage VALUES('block',old.id);
        DELETE FROM material_block_payloads WHERE hash=old.payload_hash
          AND NOT EXISTS(SELECT 1 FROM material_blocks WHERE payload_hash=old.payload_hash)
          AND NOT EXISTS(SELECT 1 FROM material_block_versions WHERE payload_hash=old.payload_hash);
      END;
      -- A captures DELETE currently means user/privacy deletion or retention expiry. Physical
      -- fragment compaction must use a separate path and preserve a lightweight source anchor.
      CREATE TRIGGER IF NOT EXISTS material_capture_delete AFTER DELETE ON captures BEGIN
        DELETE FROM material_heads WHERE id IN
          (SELECT material_id FROM material_members WHERE kind='capture' AND ref='capture:'||old.id);
      END;
    `);
 db.exec(`CREATE TABLE IF NOT EXISTS material_index_requests(
      material_id TEXT PRIMARY KEY REFERENCES material_heads(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,enabled INTEGER NOT NULL,generation INTEGER NOT NULL,
      state TEXT NOT NULL,error TEXT);
      INSERT OR IGNORE INTO material_index_requests SELECT h.id,h.revision,1,1,'indexed',NULL
        FROM material_heads h JOIN material_searchable s ON s.material_id=h.id;`);
 db.exec(`
      CREATE TABLE IF NOT EXISTS material_coding_relations(
        material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,ref TEXT NOT NULL,details TEXT NOT NULL,
        PRIMARY KEY(material_id,kind,ref,details));
      CREATE INDEX IF NOT EXISTS material_coding_relations_target ON material_coding_relations(kind,ref);`);
}
