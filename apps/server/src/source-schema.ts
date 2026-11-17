import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

export const sourceSchemaInstallation={owner:'source',requires:['capture'],install:sourceSchema} as const satisfies SchemaInstallation;

/** Source identities and immutable version pointers. Captures must exist first;
 * file schema and source catalog triggers are installed after this owner. */
export function sourceSchema(db:DatabaseSync){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='captures'").get())throw new Error('Capture schema must be installed before source schema');
 db.exec(`
      CREATE TABLE IF NOT EXISTS source_connections (id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_versions (source_id TEXT NOT NULL,external_id TEXT NOT NULL,revision TEXT NOT NULL,capture_id TEXT NOT NULL UNIQUE,hash TEXT NOT NULL,PRIMARY KEY(source_id,external_id,revision));
      CREATE TABLE IF NOT EXISTS source_heads (source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL,observed_at TEXT NOT NULL,deleted INTEGER NOT NULL,PRIMARY KEY(source_id,external_id));
      CREATE INDEX IF NOT EXISTS source_head_capture ON source_heads(capture_id);
 `);
}
