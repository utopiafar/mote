import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Activated only at the existing ProcessorAdmission constructor boundary. */
export const processorAdmissionSchemaInstallation={owner:'processor-admission',requires:[],install:processorAdmissionSchema} as const satisfies SchemaInstallation;

function processorAdmissionSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS processor_cooldowns(scope TEXT PRIMARY KEY,until INTEGER NOT NULL)');
}

/** Activated only at the existing ProviderAdmission constructor boundary. */
export const providerAdmissionSchemaInstallation={owner:'provider-admission',requires:[],install:providerAdmissionSchema} as const satisfies SchemaInstallation;

function providerAdmissionSchema(db:DatabaseSync){
 db.exec('CREATE TABLE IF NOT EXISTS provider_cooldowns(scope TEXT PRIMARY KEY,code TEXT NOT NULL,until INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS provider_cooldown_expiry ON provider_cooldowns(until);');
}
