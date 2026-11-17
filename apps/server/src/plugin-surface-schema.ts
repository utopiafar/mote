import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Activated only at the existing PluginCenter constructor boundary. */
export const pluginReleasePreviewsSchemaInstallation={owner:'plugin-release-previews',requires:[],install:pluginReleasePreviewsSchema} as const satisfies SchemaInstallation;

/** Activated only at the existing DeveloperAccessHost constructor boundary. */
export const developerAccessSchemaInstallation={owner:'developer-access',requires:[],install:developerAccessSchema} as const satisfies SchemaInstallation;

/** Activated only at the existing OutboundExportHost constructor boundary. */
export const outboundExportSchemaInstallation={owner:'outbound-export',requires:[],install:outboundExportSchema} as const satisfies SchemaInstallation;

function pluginReleasePreviewsSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS plugin_release_previews(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
}

function developerAccessSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS developer_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event TEXT NOT NULL,source_id TEXT NOT NULL,
      material_id TEXT NOT NULL,revision TEXT NOT NULL,material_kind TEXT NOT NULL,device_id TEXT,
      occurred_at TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS developer_events_source ON developer_events(source_id,sequence);
      CREATE INDEX IF NOT EXISTS developer_events_type ON developer_events(event,sequence);
      CREATE TABLE IF NOT EXISTS developer_deliveries(
      id TEXT PRIMARY KEY,event_id TEXT NOT NULL,event_sequence INTEGER NOT NULL,endpoint_id TEXT NOT NULL,
      status TEXT NOT NULL,attempts INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,http_status INTEGER,
      last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(event_id,endpoint_id));
      CREATE INDEX IF NOT EXISTS developer_deliveries_pending ON developer_deliveries(status,next_attempt_at,created_at);
      CREATE INDEX IF NOT EXISTS developer_deliveries_endpoint ON developer_deliveries(endpoint_id,created_at DESC);`);
}

function outboundExportSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS outbound_export_items(
      instance_id TEXT NOT NULL,material_id TEXT NOT NULL,relative_path TEXT NOT NULL,
      revision TEXT,content_hash TEXT,state TEXT NOT NULL,conflict_hash TEXT,conflict_at TEXT,updated_at TEXT NOT NULL,
      PRIMARY KEY(instance_id,material_id));
      CREATE TABLE IF NOT EXISTS outbound_export_instances(
      instance_id TEXT PRIMARY KEY,last_sync_at TEXT,last_error TEXT);`);
}
