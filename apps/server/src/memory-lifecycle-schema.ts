import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

export const memoryLifecycleEffectiveSchemaInstallation={
 owner:'memory-lifecycle',requires:[],
 install:memoryLifecycleEffectiveSchema,
} as const satisfies SchemaInstallation;

function memoryLifecycleEffectiveSchema(db:DatabaseSync){
  db.exec('CREATE TABLE IF NOT EXISTS memory_lifecycle_effective(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');
}
