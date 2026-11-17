import type {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from './schema-installation.js';
import {operationProjectionSchemaInstallation} from './operation-projection.js';

export const executionSchemaInstallation={owner:'execution',requires:[],install:executionSchema} as const satisfies SchemaInstallation;

/** Only the original Engine constructor closure. Other features keep their
 * own activation and never join this plan merely to satisfy a prerequisite. */
export const executionSchemaInstallations=[executionSchemaInstallation,operationProjectionSchemaInstallation] as const;
export function installExecutionSchema(db:DatabaseSync){installSchemaPlan(db,executionSchemaInstallations);}

function executionSchema(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,recovery_deadline INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS execution_resources(step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,resource_key TEXT NOT NULL,PRIMARY KEY(step_id,resource_key));
   CREATE INDEX IF NOT EXISTS execution_resource_owners ON execution_resources(resource_key,step_id);
   CREATE TABLE IF NOT EXISTS execution_dependencies(step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,dependency_id TEXT NOT NULL REFERENCES execution_steps(id),PRIMARY KEY(step_id,dependency_id));
   CREATE INDEX IF NOT EXISTS execution_dependents ON execution_dependencies(dependency_id,step_id);
   CREATE TABLE IF NOT EXISTS execution_cancellation_aliases(alias_id TEXT PRIMARY KEY,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,cancelled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS execution_operation_steps(operation_id TEXT NOT NULL,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,slot TEXT NOT NULL DEFAULT '',generation TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,optional INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,step_id));
   CREATE INDEX IF NOT EXISTS execution_membership_step ON execution_operation_steps(step_id,active,operation_id);
   CREATE INDEX IF NOT EXISTS execution_ready ON execution_steps(pool,state,available_at,created_at);
   CREATE INDEX IF NOT EXISTS execution_operations ON execution_steps(operation_id,created_at);
   CREATE TABLE IF NOT EXISTS execution_sequence(pool TEXT PRIMARY KEY,next INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS execution_fairness(pool TEXT NOT NULL,operation_id TEXT NOT NULL,last_started INTEGER NOT NULL,PRIMARY KEY(pool,operation_id));`);
  db.exec('CREATE TABLE IF NOT EXISTS execution_failures(step_id TEXT PRIMARY KEY REFERENCES execution_steps(id) ON DELETE CASCADE,json TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS execution_recovery_deadline ON execution_steps(state,recovery_deadline)');
}
