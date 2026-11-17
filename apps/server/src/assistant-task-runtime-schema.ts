import type {SchemaInstallation} from './schema-installation.js';

/** One owner-local selection marker/pin per formal Task. This is metadata,
 * without credentials, task prose, scheduling or model authorization. */
export const assistantTaskRuntimeSchemaInstallation={
 owner:'assistant-task-runtime',requires:[],
 prerequisites:[{owner:'task-records',objects:[{type:'table',name:'task_records'}]}],
 install:db=>db.exec(`CREATE TABLE IF NOT EXISTS assistant_task_runtime(
  task_id TEXT PRIMARY KEY REFERENCES task_records(id) ON DELETE CASCADE,input_hash TEXT NOT NULL,
  profile_id TEXT,model_id TEXT,configuration_fingerprint TEXT,
  CHECK((profile_id IS NULL AND model_id IS NULL AND configuration_fingerprint IS NULL) OR
   (profile_id IS NOT NULL AND model_id IS NOT NULL AND configuration_fingerprint IS NOT NULL)))`),
} as const satisfies SchemaInstallation;
