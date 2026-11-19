import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

export const memoryStorageSchemaInstallation={owner:'memory',requires:[],install:memoryStorageSchema} as const satisfies SchemaInstallation;

/** Memory owns native cards, work/checkpoints, evidence dependencies and durable provider revocations. */
export function memoryStorageSchema(db:DatabaseSync){db.exec(`
 CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_provider_evidence_revocations(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_dependencies (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(memory_id,evidence_id));
 CREATE INDEX IF NOT EXISTS memory_dependencies_evidence ON memory_dependencies(evidence_id);
 CREATE TABLE IF NOT EXISTS memory_jobs (id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_batches (id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,idx INTEGER NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS memory_batch_dependencies (batch_id TEXT NOT NULL REFERENCES memory_batches(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(batch_id,evidence_id));
 CREATE INDEX IF NOT EXISTS memory_batch_dependencies_evidence ON memory_batch_dependencies(evidence_id);
 CREATE TABLE IF NOT EXISTS memory_checkpoints (key TEXT PRIMARY KEY,evidence_id TEXT NOT NULL,completed_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS memory_checkpoints_evidence ON memory_checkpoints(evidence_id);
 CREATE INDEX IF NOT EXISTS memory_batches_job ON memory_batches(job_id,idx);
`);}
