import type {SchemaInstallation} from './schema-installation.js';

/** Existing capability metadata, opened at the Actions control-plane boundary. */
export const actionCapabilitiesSchemaInstallation={
 owner:'action-capabilities',requires:[],
 install:db=>db.exec(`
  CREATE TABLE IF NOT EXISTS action_device_capabilities(device_id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_grants(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_drafts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);`),
} as const satisfies SchemaInstallation;
