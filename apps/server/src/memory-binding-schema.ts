import type {SchemaInstallation} from './schema-installation.js';

/** Durable Memory binding state, installed at the existing control construction
 * point. The four original singleton/command/receipt tables have no foreign keys. */
export const memoryBindingSchemaInstallation={
 owner:'memory-binding',requires:[],
 install(db){db.exec(`CREATE TABLE IF NOT EXISTS memory_plan_binding(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_preparation(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_binding_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_provider_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);},
} as const satisfies SchemaInstallation;
