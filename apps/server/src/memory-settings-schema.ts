import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Provider configuration rows are a plugin-adapter journal. Their original DDL
 * executes at the MemoryAdapters construction point, before storage accounting
 * is registered. */
export const memoryProviderConfigurationsSchemaInstallation={
 owner:'memory-provider-configurations',requires:[],
 install:memoryProviderConfigurationsSchema,
} as const satisfies SchemaInstallation;

function memoryProviderConfigurationsSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS memory_provider_configurations(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
}

/** Owner recipe selections keep the original Source FK. The FK is a schema
 * boundary, not data authority over the Source table. */
export const memoryRecipeSettingsSchemaInstallation={
 owner:'memory-recipe-settings',requires:[],
 install:memoryRecipeSettingsSchema,
} as const satisfies SchemaInstallation;

function memoryRecipeSettingsSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS memory_recipe_settings(id TEXT PRIMARY KEY,source_id TEXT REFERENCES source_connections(id) ON DELETE CASCADE,json TEXT NOT NULL)');
}
