import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

export const assetSchemaInstallation={owner:'assets',requires:[],
 install:assetSchema,
} as const satisfies SchemaInstallation;
function assetSchema(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,format TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS asset_parts(hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,part INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(hash,part));
   CREATE TABLE IF NOT EXISTS asset_references(owner TEXT PRIMARY KEY,hash TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS asset_references_hash ON asset_references(hash);
   CREATE TABLE IF NOT EXISTS asset_pins(id TEXT PRIMARY KEY,hash TEXT NOT NULL,expires INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS asset_pins_hash ON asset_pins(hash,expires);`);}

export const archivedFilesSchemaInstallation={owner:'archived-files',requires:[],prerequisites:[{owner:'capture',objects:[{type:'table',name:'captures'}]}],
 install:archivedFilesSchema,
} as const satisfies SchemaInstallation;
function archivedFilesSchema(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS file_blobs(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archived_files(id TEXT PRIMARY KEY,hash TEXT NOT NULL REFERENCES file_blobs(hash),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capture_files(capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,file_id TEXT NOT NULL REFERENCES archived_files(id),PRIMARY KEY(capture_id,file_id));`);}

export const evidenceMaterialLineageSchemaInstallation={owner:'evidence-material-lineage',requires:[],prerequisites:[{owner:'evidence-archive',objects:[{type:'table',name:'context_artifacts'}]},{owner:'material',objects:[{type:'table',name:'material_heads'}]}],
 install:evidenceMaterialLineageSchema,
} as const satisfies SchemaInstallation;
function evidenceMaterialLineageSchema(db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_material_inputs(
      artifact_id TEXT NOT NULL REFERENCES context_artifacts(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,PRIMARY KEY(artifact_id,material_id));
    CREATE INDEX IF NOT EXISTS artifact_material_parent ON artifact_material_inputs(material_id);
    CREATE TRIGGER IF NOT EXISTS artifact_material_revision_change AFTER UPDATE OF revision,retired ON material_heads
      WHEN new.revision!=old.revision OR new.retired!=old.retired BEGIN
      DELETE FROM context_artifacts WHERE id IN
        (SELECT artifact_id FROM artifact_material_inputs WHERE material_id=new.id AND revision!=new.revision);
    END;
    CREATE TRIGGER IF NOT EXISTS artifact_material_removed BEFORE DELETE ON material_heads BEGIN
      DELETE FROM context_artifacts WHERE id IN
        (SELECT artifact_id FROM artifact_material_inputs WHERE material_id=old.id);
    END;
  `);}

/** Each original producer connection remains a separate activation batch. */
export const assetSnapshotInputsReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"file","objects":[{"type":"table","name":"file_snapshot_inputs"}]}],install:assetSnapshotInputsReferencesSchema} as const satisfies SchemaInstallation;
function assetSnapshotInputsReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_inputs_insert AFTER INSERT ON file_snapshot_inputs WHEN new.object_hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('snapshot-input:'||new.capture_id,new.object_hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_inputs_delete AFTER DELETE ON file_snapshot_inputs BEGIN DELETE FROM asset_references WHERE owner='snapshot-input:'||old.capture_id; END;
     CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_inputs_update AFTER UPDATE OF object_hash ON file_snapshot_inputs BEGIN DELETE FROM asset_references WHERE owner='snapshot-input:'||old.capture_id; INSERT OR REPLACE INTO asset_references SELECT 'snapshot-input:'||new.capture_id,new.object_hash WHERE new.object_hash IS NOT NULL; END;`);}

export const assetSnapshotTextReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"file","objects":[{"type":"table","name":"file_snapshot_text"}]}],install:assetSnapshotTextReferencesSchema} as const satisfies SchemaInstallation;
function assetSnapshotTextReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_text_insert AFTER INSERT ON file_snapshot_text WHEN new.object_hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('snapshot-text:'||new.capture_id,new.object_hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_text_delete AFTER DELETE ON file_snapshot_text BEGIN DELETE FROM asset_references WHERE owner='snapshot-text:'||old.capture_id; END;
     CREATE TRIGGER IF NOT EXISTS asset_file_snapshot_text_update AFTER UPDATE OF object_hash ON file_snapshot_text BEGIN DELETE FROM asset_references WHERE owner='snapshot-text:'||old.capture_id; INSERT OR REPLACE INTO asset_references SELECT 'snapshot-text:'||new.capture_id,new.object_hash WHERE new.object_hash IS NOT NULL; END;`);}

export const assetFileVersionsReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"file","objects":[{"type":"table","name":"file_versions"}]}],install:assetFileVersionsReferencesSchema} as const satisfies SchemaInstallation;
function assetFileVersionsReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_versions_insert AFTER INSERT ON file_versions WHEN new.object_hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('file:'||new.capture_id,new.object_hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_file_versions_delete AFTER DELETE ON file_versions BEGIN DELETE FROM asset_references WHERE owner='file:'||old.capture_id; END;
     CREATE TRIGGER IF NOT EXISTS asset_file_versions_update AFTER UPDATE OF object_hash ON file_versions BEGIN DELETE FROM asset_references WHERE owner='file:'||old.capture_id; INSERT OR REPLACE INTO asset_references SELECT 'file:'||new.capture_id,new.object_hash WHERE new.object_hash IS NOT NULL; END;`);}

export const assetFileAssetsReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"file","objects":[{"type":"table","name":"file_assets"}]}],install:assetFileAssetsReferencesSchema} as const satisfies SchemaInstallation;
function assetFileAssetsReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_file_assets_insert AFTER INSERT ON file_assets WHEN new.object_hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('artifact:'||new.artifact_id||':'||new.name,new.object_hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_file_assets_delete AFTER DELETE ON file_assets BEGIN DELETE FROM asset_references WHERE owner='artifact:'||old.artifact_id||':'||old.name; END;
     CREATE TRIGGER IF NOT EXISTS asset_file_assets_update AFTER UPDATE OF object_hash ON file_assets BEGIN DELETE FROM asset_references WHERE owner='artifact:'||old.artifact_id||':'||old.name; INSERT OR REPLACE INTO asset_references SELECT 'artifact:'||new.artifact_id||':'||new.name,new.object_hash WHERE new.object_hash IS NOT NULL; END;`);}

export const assetCaptureReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"capture","objects":[{"type":"table","name":"captures"}]}],install:assetCaptureReferencesSchema} as const satisfies SchemaInstallation;
function assetCaptureReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_captures_insert AFTER INSERT ON captures WHEN new.blob_hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('capture:'||new.id,new.blob_hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_captures_delete AFTER DELETE ON captures BEGIN DELETE FROM asset_references WHERE owner='capture:'||old.id; END;
     CREATE TRIGGER IF NOT EXISTS asset_captures_update AFTER UPDATE OF blob_hash ON captures BEGIN DELETE FROM asset_references WHERE owner='capture:'||old.id; INSERT OR REPLACE INTO asset_references SELECT 'capture:'||new.id,new.blob_hash WHERE new.blob_hash IS NOT NULL; END;`);}

export const assetArchivedFilesReferencesInstallation={owner:"asset-reference-projections",requires:[],prerequisites:[{"owner":"assets","objects":[{"type":"table","name":"asset_references"}]},{"owner":"archived-files","objects":[{"type":"table","name":"archived_files"}]}],install:assetArchivedFilesReferencesSchema} as const satisfies SchemaInstallation;
function assetArchivedFilesReferencesSchema(db:DatabaseSync){db.exec(`CREATE TRIGGER IF NOT EXISTS asset_archived_files_insert AFTER INSERT ON archived_files WHEN new.hash IS NOT NULL BEGIN INSERT OR REPLACE INTO asset_references VALUES('archive:'||new.id,new.hash); END;
     CREATE TRIGGER IF NOT EXISTS asset_archived_files_delete AFTER DELETE ON archived_files BEGIN DELETE FROM asset_references WHERE owner='archive:'||old.id; END;
     CREATE TRIGGER IF NOT EXISTS asset_archived_files_update AFTER UPDATE OF hash ON archived_files BEGIN DELETE FROM asset_references WHERE owner='archive:'||old.id; INSERT OR REPLACE INTO asset_references SELECT 'archive:'||new.id,new.hash WHERE new.hash IS NOT NULL; END;`);}

/** Fixed producer order; callers still install only tables that already exist. */
export const assetReferenceSchemaInstallations=[
 {table:"file_snapshot_inputs",installation:assetSnapshotInputsReferencesInstallation},
 {table:"file_snapshot_text",installation:assetSnapshotTextReferencesInstallation},
 {table:"file_versions",installation:assetFileVersionsReferencesInstallation},
 {table:"file_assets",installation:assetFileAssetsReferencesInstallation},
 {table:"captures",installation:assetCaptureReferencesInstallation},
 {table:"archived_files",installation:assetArchivedFilesReferencesInstallation},
] as const;

/** The original view deliberately permits forward references to inactive owners. */
export const evidenceDependenciesWithoutMaterialsInstallation={owner:"evidence-dependencies",requires:[],install:evidenceDependenciesWithoutMaterialsSchema} as const satisfies SchemaInstallation;
// The escaped blank branch preserves the original SQL's single space.
function evidenceDependenciesWithoutMaterialsSchema(db:DatabaseSync){db.exec(`
 DROP VIEW IF EXISTS evidence_dependency_edges;
 CREATE VIEW evidence_dependency_edges AS
 SELECT 'capture' parent_kind,observation_id parent_id,'context_artifact' child_kind,artifact_id child_id FROM artifact_inputs
 UNION ALL SELECT 'context_artifact',parent_id,'context_artifact',artifact_id FROM artifact_dependencies
 UNION ALL SELECT 'capture',capture_id,'file_artifact',id FROM file_artifacts
 UNION ALL SELECT 'file_artifact',p.value,'file_artifact',a.id FROM file_artifacts a,json_each(a.json,'$.inputArtifacts') p
 UNION ALL SELECT 'file_artifact',artifact_id,'file_chunk',id FROM file_chunks
\x20
 UNION ALL SELECT CASE WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory',d.memory_id FROM memory_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id
 UNION ALL SELECT 'context_artifact',artifact_id,'memory',memory_id FROM memory_artifact_dependencies
 UNION ALL SELECT 'memory',p.value,'memory',m.id FROM memories m,json_each(m.json,'$.relatedMemoryIds') p
 UNION ALL SELECT CASE WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory_batch',d.batch_id FROM memory_batch_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id;
 `);}

export const evidenceDependenciesWithMaterialsInstallation={owner:"evidence-dependencies",requires:[],install:evidenceDependenciesWithMaterialsSchema} as const satisfies SchemaInstallation;
function evidenceDependenciesWithMaterialsSchema(db:DatabaseSync){db.exec(`
 DROP VIEW IF EXISTS evidence_dependency_edges;
 CREATE VIEW evidence_dependency_edges AS
 SELECT 'capture' parent_kind,observation_id parent_id,'context_artifact' child_kind,artifact_id child_id FROM artifact_inputs
 UNION ALL SELECT 'context_artifact',parent_id,'context_artifact',artifact_id FROM artifact_dependencies
 UNION ALL SELECT 'capture',capture_id,'file_artifact',id FROM file_artifacts
 UNION ALL SELECT 'file_artifact',p.value,'file_artifact',a.id FROM file_artifacts a,json_each(a.json,'$.inputArtifacts') p
 UNION ALL SELECT 'file_artifact',artifact_id,'file_chunk',id FROM file_chunks
 UNION ALL SELECT CASE WHEN EXISTS(SELECT 1 FROM material_evidence e WHERE e.id=d.evidence_id) THEN 'material_evidence' WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'material_evidence',d.anchor_id FROM material_evidence_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id
 UNION ALL SELECT CASE WHEN EXISTS(SELECT 1 FROM material_evidence e WHERE e.id=d.evidence_id) THEN 'material_evidence' WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory',d.memory_id FROM memory_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id
 UNION ALL SELECT 'context_artifact',artifact_id,'memory',memory_id FROM memory_artifact_dependencies
 UNION ALL SELECT 'memory',p.value,'memory',m.id FROM memories m,json_each(m.json,'$.relatedMemoryIds') p
 UNION ALL SELECT CASE WHEN EXISTS(SELECT 1 FROM material_evidence e WHERE e.id=d.evidence_id) THEN 'material_evidence' WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory_batch',d.batch_id FROM memory_batch_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id;
 `);}
