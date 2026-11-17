import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Activated only at the existing source-archive.ts constructor boundary. */
export const sourceArchiveSchemaInstallation={owner:'source-archive',requires:[],
 install:sourceArchiveSchema,
} as const satisfies SchemaInstallation;

function sourceArchiveSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS source_archive_sizes(source_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_archive_indexed_sources(source_id TEXT PRIMARY KEY REFERENCES source_archive_sizes(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_groups(source_id TEXT NOT NULL,group_hash TEXT NOT NULL,group_key TEXT NOT NULL,checkpoint TEXT NOT NULL,
        append_epoch INTEGER NOT NULL DEFAULT 0,head_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_id,group_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_versions(source_id TEXT NOT NULL,version_key TEXT NOT NULL,content_hash TEXT NOT NULL,
        batch_hash TEXT NOT NULL,batch_index INTEGER NOT NULL,observed_at TEXT NOT NULL,group_hash TEXT NOT NULL,
        PRIMARY KEY(source_id,version_key),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_heads(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL,external_key TEXT NOT NULL,
        version_key TEXT NOT NULL,group_hash TEXT NOT NULL,observed_at TEXT NOT NULL,content_hash TEXT NOT NULL,
        UNIQUE(source_id,external_key),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS source_archive_heads_group ON source_archive_heads(source_id,group_hash,id);
      CREATE TABLE IF NOT EXISTS source_archive_batches(source_id TEXT NOT NULL,batch_hash TEXT NOT NULL,bytes INTEGER NOT NULL,
        PRIMARY KEY(source_id,batch_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_recovery_groups(source_id TEXT NOT NULL,group_hash TEXT NOT NULL,
        PRIMARY KEY(source_id,group_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);`);
}

/** Activated only at the existing source-context.ts constructor boundary. */
export const sourceContextSchemaInstallation={owner:'source-context',requires:[],
 prerequisites:[{owner:'source',objects:[{type:'table',name:'source_connections'}]}],
 install:sourceContextSchema,
} as const satisfies SchemaInstallation;

function sourceContextSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS source_context_declarations(
      source_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(source_id,version));`);
}

/** Activated only at the existing source-pipelines.ts constructor boundary. */
export const sourcePipelineSchemaInstallation={owner:'source-pipeline',requires:[],
 install:sourcePipelineSchema,
} as const satisfies SchemaInstallation;

function sourcePipelineSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS source_pipeline_bindings(source_id TEXT PRIMARY KEY,pipeline_id TEXT NOT NULL,storage TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_work(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,pipeline_id TEXT NOT NULL,version TEXT NOT NULL,group_key TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,material_ref TEXT,generation INTEGER NOT NULL DEFAULT 0,archive_checkpoint TEXT,memory_trigger TEXT NOT NULL,
        recipe_id TEXT,recipe_version TEXT,recipe_definition_fingerprint TEXT,recipe_config_fingerprint TEXT,recipe_component_pins TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_config(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
}
