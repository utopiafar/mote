import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Native preparation journals install before ledger registration or recovery.
 * The checkpoint identifier is retained text, not a new execution-table FK. */
export const memoryNativeStagesSchemaInstallation={
  owner:'memory-native-stages',requires:[],
  install:memoryNativeStagesSchema,
} as const satisfies SchemaInstallation;

function memoryNativeStagesSchema(db:DatabaseSync){
    db.exec('CREATE TABLE IF NOT EXISTS memory_engine_stage_cleanups(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
    db.exec('CREATE TABLE IF NOT EXISTS memory_engine_stage_drafts(id TEXT PRIMARY KEY,json TEXT NOT NULL,checkpoint_id TEXT); CREATE INDEX IF NOT EXISTS memory_engine_stage_checkpoint ON memory_engine_stage_drafts(checkpoint_id);');
}
