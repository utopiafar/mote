import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Activated only at the existing insight-runs.ts constructor boundary. */
export const insightRunsSchemaInstallation={owner:'insight-runs',requires:[],
 install:insightRunsSchema,
} as const satisfies SchemaInstallation;

function insightRunsSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS insight_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
}

/** Activated only at the existing record-context.ts constructor boundary. */
export const recordContextSchemaInstallation={owner:'record-context',requires:[],
 prerequisites:[{owner:'capture',objects:[{type:'table',name:'captures'}]}],
 install:recordContextSchema,
} as const satisfies SchemaInstallation;

function recordContextSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS record_context_declarations(
      capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version=1),capture_fingerprint TEXT NOT NULL,
      fingerprint TEXT NOT NULL,json TEXT NOT NULL);`);
}
