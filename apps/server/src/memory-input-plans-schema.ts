import type {SchemaInstallation} from './schema-installation.js';

/** Selection metadata is legal before either referenced owner is activated.
 * Keep the original forward FKs; installing this owner never opens Material. */
export const memoryInputPlansSchemaInstallation={
 owner:'memory-input-plans',requires:[],
 install(db){db.exec(`CREATE TABLE IF NOT EXISTS memory_input_plans(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS memory_input_plans_job ON memory_input_plans(job_id);
  CREATE INDEX IF NOT EXISTS memory_input_plans_material ON memory_input_plans(material_id);`);},
} as const satisfies SchemaInstallation;
