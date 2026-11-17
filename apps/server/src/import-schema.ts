import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

const capture={owner:'capture',objects:[{type:'table' as const,name:'captures'}]};

/** Import owner groups stay at their existing constructor boundaries: upload
 * staging, frozen attribution, then the durable job/intake projection. */
export const importUploadsSchemaInstallation={owner:'import',requires:[],install:importUploadsSchema} as const satisfies SchemaInstallation;
export const importAttributionSchemaInstallation={owner:'import',requires:[],prerequisites:[capture],install:importAttributionSchema} as const satisfies SchemaInstallation;
export const importIntakeOverridesSchemaInstallation={owner:'import',requires:[],prerequisites:[capture],install:importIntakeOverridesSchema} as const satisfies SchemaInstallation;
export const importJobsSchemaInstallation={owner:'import',requires:[],install:importJobsSchema} as const satisfies SchemaInstallation;
export const importCreateRequestsSchemaInstallation={owner:'import',requires:[],install:importCreateRequestsSchema} as const satisfies SchemaInstallation;

function importUploadsSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS import_uploads(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS import_upload_parts(upload_id TEXT NOT NULL REFERENCES import_uploads(id) ON DELETE CASCADE,part INTEGER NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(upload_id,part))');}
function importAttributionSchema(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS import_owner_declarations(
      id TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,
      PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS capture_import_declarations(
      capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,id TEXT NOT NULL,version INTEGER NOT NULL,
      FOREIGN KEY(id,version) REFERENCES import_owner_declarations(id,version));
      CREATE INDEX IF NOT EXISTS capture_import_declarations_parent ON capture_import_declarations(id,version);
      CREATE TRIGGER IF NOT EXISTS capture_import_declaration_removed AFTER DELETE ON capture_import_declarations BEGIN
        DELETE FROM import_owner_declarations WHERE id=old.id AND version=old.version AND NOT EXISTS
          (SELECT 1 FROM capture_import_declarations c WHERE c.id=old.id AND c.version=old.version);
      END;`);}
function importIntakeOverridesSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS image_intake_overrides(capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,profile_id TEXT NOT NULL)');}
function importJobsSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL)');}
function importCreateRequestsSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS import_create_requests(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,job_id TEXT NOT NULL)');}
