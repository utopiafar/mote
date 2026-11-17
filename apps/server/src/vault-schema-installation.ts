import type {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from './schema-installation.js';
import {vaultSchemaInstallation} from './vault-schema.js';
import {captureSchemaInstallation,captureProjectionSchemaInstallation} from './capture-schema.js';
import {perceptionSchemaInstallation} from './perception-schema.js';
import {sourceSchemaInstallation} from './source-schema.js';
import {fileSchemaInstallation} from './file-schema.js';
import {memoryStorageSchemaInstallation} from './memory-storage-schema.js';
import {conversationSchemaInstallation} from './conversation-schema.js';
import {insightSchemaInstallation} from './insight-schema.js';
import {todoSchemaInstallation} from './todo-schema.js';
import {captureReadModelsSchemaInstallation} from './read-models.js';
import {sourceCatalogSchemaInstallation} from './source-catalog.js';
import {storageLedgerSchemaInstallation} from './storage-ledger.js';

/** The current vault's fixed startup inventory, not optional feature installation.
 * Definitions stay with their domain owners. Dependencies describe table/trigger
 * prerequisites, rather than runtime service dependencies. Feature-owned tables
 * (Material, execution, Memory indexes, conversation turns, etc.) remain with
 * their existing constructors and must finish installing before app.ready(). */
export const vaultSchemaInstallations:readonly SchemaInstallation[]=[
 vaultSchemaInstallation,
 captureSchemaInstallation,
 perceptionSchemaInstallation,
 sourceSchemaInstallation,
 fileSchemaInstallation,
 memoryStorageSchemaInstallation,
 conversationSchemaInstallation,
 insightSchemaInstallation,
 todoSchemaInstallation,
 captureProjectionSchemaInstallation,
 captureReadModelsSchemaInstallation,
 sourceCatalogSchemaInstallation,
];

/** Second Vault stage, invoked by the existing StorageLedger construction
 * point after the core EvidenceStore schema is installed. Keep it out of the
 * core array so the original constructor/lazy read ordering is unchanged. */
export const vaultStorageLedgerInstallations:readonly SchemaInstallation[]=Object.freeze([storageLedgerSchemaInstallation]);

/** EvidenceStore registers the SQL functions and enables foreign keys first.
 * All core constraints/projections are installed before the store escapes its
 * constructor; the server finishes feature installation before accepting input.
 * IF NOT EXISTS preserves the current schema and persisted identities on restart.
 * This is current-format installation only; epoch validation precedes this call. */
export function installVaultSchema(db:DatabaseSync){
 installSchemaPlan(db,vaultSchemaInstallations);
}
