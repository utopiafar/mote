import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from '../schema-installation.js';

/** Publication's own journals. The constructor keeps the existing Memory-owned
 * revocation table and retirement helper in the same atomic installation group. */
export const memoryPublicationSchemaInstallation={
 owner:'memory-publication',requires:[],
 prerequisites:[{owner:'memory',objects:[{type:'table',name:'memories'}]}],
 install:memoryPublicationSchema,
} as const satisfies SchemaInstallation;

function memoryPublicationSchema(db:DatabaseSync){
  db.exec('CREATE TABLE IF NOT EXISTS memory_publications(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS memory_publication_outputs(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS memory_provider_writes(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL,json TEXT NOT NULL,state TEXT NOT NULL,automatic INTEGER NOT NULL DEFAULT 0);');
  db.exec('CREATE TABLE IF NOT EXISTS memory_owner_mutations(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
  db.exec('CREATE TABLE IF NOT EXISTS memory_provider_erases(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);');
}
