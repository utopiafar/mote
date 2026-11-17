import type {SchemaInstallation} from './schema-installation.js';

/** Private journal storage is installed only when DelegationStore is opened. */
export const delegationJournalSchemaInstallation={
 owner:'delegation',requires:[],
 prerequisites:[{owner:'capture',objects:[{type:'table',name:'changes'}]}],
 install(db){db.exec(`CREATE TABLE IF NOT EXISTS delegation_works(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_payloads(work_id TEXT PRIMARY KEY REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_results(work_id TEXT PRIMARY KEY REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_units(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_units_work ON delegation_units(work_id);
      CREATE TABLE IF NOT EXISTS delegation_artifacts(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,unit_id TEXT NOT NULL REFERENCES delegation_units(id) ON DELETE CASCADE,json TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,type TEXT NOT NULL,message TEXT,unit_id TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_events_work ON delegation_events(work_id,id);
      CREATE TABLE IF NOT EXISTS delegation_dependencies(work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(work_id,evidence_id));
      CREATE INDEX IF NOT EXISTS delegation_dependency_evidence ON delegation_dependencies(evidence_id,work_id);
      DROP TRIGGER IF EXISTS delegation_original_deleted;
      CREATE TRIGGER IF NOT EXISTS delegation_original_deleted AFTER INSERT ON changes WHEN new.operation='delete' BEGIN
        DELETE FROM delegation_artifacts WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_payloads WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_results WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_events WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        UPDATE delegation_works SET json=json_set(json_remove(json,'$.private'),'$.status','stale','$.goal','','$.error','evidence_deleted') WHERE id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        UPDATE delegation_units SET json=json_set(json_remove(json,'$.private'),'$.status','stale','$.title','','$.goal','','$.input',json('{}'),'$.error','evidence_deleted') WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
      END;`);},
} as const satisfies SchemaInstallation;

/** The runtime-owned extension keeps its later construction boundary. */
export const delegationSourceContextSchemaInstallation={
 owner:'delegation',requires:[],
 prerequisites:[{owner:'delegation',objects:[{type:'table',name:'delegation_works'}]}],
 install(db){db.exec(`CREATE TABLE IF NOT EXISTS delegation_source_context_dependencies(
    work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,unit_id TEXT NOT NULL,
    source_id TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'description',
    PRIMARY KEY(work_id,unit_id,kind,source_id,version,fingerprint));`);},
} as const satisfies SchemaInstallation;
