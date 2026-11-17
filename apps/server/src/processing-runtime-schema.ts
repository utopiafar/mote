import type {SchemaInstallation} from './schema-installation.js';

/** Storage is installed at the existing ProcessingRuntime constructor boundary. */
export const processingRuntimeSchemaInstallation={
 owner:'processing-runtime',requires:[],
 install(db){db.exec(`CREATE TABLE IF NOT EXISTS processing_jobs(id TEXT PRIMARY KEY,lane TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processing_ready ON processing_jobs(lane,state,available_at);
      CREATE INDEX IF NOT EXISTS processing_parent_grant ON processing_jobs(json_extract(json,'$.parentGrant.stepId'),json_extract(json,'$.config.generationContract'),coalesce(json_extract(json,'$.config.modelFingerprint'),''),id);
      CREATE TABLE IF NOT EXISTS processing_dependencies(job_id TEXT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES processing_jobs(id),PRIMARY KEY(job_id,dependency_id));`);},
} as const satisfies SchemaInstallation;
