import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

const capture={owner:'capture',objects:[{type:'table' as const,name:'captures'}]};
const fileVersions={owner:'file',objects:[{type:'table' as const,name:'file_versions'}]};

/** FileProcessing-owned media intent and work guard tables. Existing vault
 * schema stays with the vault; these are the late processing groups. */
export const fileProcessingMediaIntentsSchemaInstallation={owner:'file',requires:[],prerequisites:[capture],install:fileProcessingMediaIntentsSchema} as const satisfies SchemaInstallation;
export const fileDiarizationOverridesSchemaInstallation={owner:'file',requires:[],prerequisites:[fileVersions],install:fileDiarizationOverridesSchema} as const satisfies SchemaInstallation;
export const fileConfigurationSnapshotsSchemaInstallation={owner:'file',requires:[],prerequisites:[capture],install:fileConfigurationSnapshotsSchema} as const satisfies SchemaInstallation;
export const fileProcessorWaitsSchemaInstallation={owner:'file',requires:[],install:fileProcessorWaitsSchema} as const satisfies SchemaInstallation;
export const fileSummaryPagesSchemaInstallation={owner:'file',requires:[],prerequisites:[fileVersions],install:fileSummaryPagesSchema} as const satisfies SchemaInstallation;
export const fileSemanticWithdrawalsSchemaInstallation={owner:'file',requires:[],prerequisites:[fileVersions],install:fileSemanticWithdrawalsSchema} as const satisfies SchemaInstallation;
/** Durable identities for media worker execution receipts. */
export const mediaExecutionCallsSchemaInstallation={owner:'file',requires:[],install:mediaExecutionCallsSchema} as const satisfies SchemaInstallation;

function fileProcessingMediaIntentsSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS media_model_intents(capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,phase TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(capture_id,phase))');}
function fileDiarizationOverridesSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS file_diarization_overrides(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE,json TEXT NOT NULL)');}
function fileConfigurationSnapshotsSchema(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS file_configuration_snapshots(capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(capture_id,fingerprint))");}
function fileProcessorWaitsSchema(db:DatabaseSync){db.exec("CREATE TABLE IF NOT EXISTS file_processor_waits(resource_key TEXT PRIMARY KEY,capture_id TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','unknown')))");}
function fileSummaryPagesSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS file_summary_pages(capture_id TEXT NOT NULL REFERENCES file_versions(capture_id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(capture_id,fingerprint))');}
function fileSemanticWithdrawalsSchema(db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS file_semantic_withdrawals(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE); CREATE TABLE IF NOT EXISTS file_semantic_calls(capture_id TEXT PRIMARY KEY REFERENCES file_versions(capture_id) ON DELETE CASCADE)');}
function mediaExecutionCallsSchema(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS media_execution_instance(id INTEGER PRIMARY KEY CHECK(id=1),nonce TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS media_execution_calls(request_id TEXT PRIMARY KEY,scope TEXT NOT NULL,capture_id TEXT NOT NULL,step_id TEXT NOT NULL,input TEXT NOT NULL,generation TEXT NOT NULL,configuration TEXT NOT NULL,stage TEXT NOT NULL,issued_attempt INTEGER NOT NULL,supported INTEGER NOT NULL DEFAULT -1,fact TEXT,state TEXT NOT NULL DEFAULT 'issued');
   CREATE INDEX IF NOT EXISTS media_execution_pending ON media_execution_calls(state);`);}
