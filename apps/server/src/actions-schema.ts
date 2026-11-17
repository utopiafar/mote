import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Actions keeps its original constructor stages. These installers check
 * already-active owners; they never construct an Engine, seed or recover jobs. */
export const actionsSchemaInstallation={
 owner:'actions',requires:[],
 prerequisites:[
  {owner:'file',objects:[{type:'table',name:'file_chunks'},{type:'table',name:'file_artifacts'}]},
  {owner:'evidence-archive',objects:[{type:'table',name:'context_artifacts'}]},
 ],install:actionsSchema,
} as const satisfies SchemaInstallation;

/** Runs only after the borrowed or owned Engine has installed its tables. */
export const actionsExecutionSchemaInstallation={
 owner:'actions',requires:[],
 prerequisites:[
  {owner:'actions',objects:[{type:'table',name:'action_jobs'}]},
  {owner:'execution',objects:[{type:'table',name:'execution_steps'}]},
 ],install(db:DatabaseSync){
    // The engine's durable transitions project identically even when another host
    // cancels a step without loading this domain's in-memory handler.
    db.exec(`CREATE TRIGGER IF NOT EXISTS action_execution_created AFTER INSERT ON execution_steps WHEN new.kind='actions.extract' BEGIN UPDATE action_jobs SET status=CASE new.state WHEN 'waiting' THEN 'pending' WHEN 'succeeded' THEN 'completed' ELSE new.state END,attempts=new.attempts WHERE key=json_extract(new.input,'$.jobKey'); END; CREATE TRIGGER IF NOT EXISTS action_execution_changed AFTER UPDATE OF state,attempts ON execution_steps WHEN new.kind='actions.extract' BEGIN UPDATE action_jobs SET status=CASE new.state WHEN 'waiting' THEN 'pending' WHEN 'succeeded' THEN 'completed' ELSE new.state END,attempts=new.attempts WHERE key=json_extract(new.input,'$.jobKey'); END;`);
 },
} as const satisfies SchemaInstallation;

/** Original final-stage erasure projections, after registration and recovery. */
export const actionsRetirementSchemaInstallation={
 owner:'actions',requires:[],
 prerequisites:[
  {owner:'actions',objects:[{type:'table',name:'action_proposals'},{type:'table',name:'action_jobs'}]},
  {owner:'capture',objects:[{type:'table',name:'captures'}]},
  {owner:'file',objects:[{type:'table',name:'file_chunks'}]},
 ],install:actionsRetirementSchema,
} as const satisfies SchemaInstallation;

function actionsSchema(db:DatabaseSync){
    db.exec(`CREATE TABLE IF NOT EXISTS action_meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_proposals(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_semantic_checkpoints(artifact_id TEXT PRIMARY KEY REFERENCES context_artifacts(id) ON DELETE CASCADE,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_targets(device_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_jobs(key TEXT PRIMARY KEY,id TEXT NOT NULL,offset INTEGER NOT NULL,length INTEGER NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS action_chunk_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS action_chunk_added AFTER INSERT ON file_chunks BEGIN INSERT INTO action_chunk_changes(id) VALUES(NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS action_artifact_changed AFTER UPDATE OF current ON file_artifacts BEGIN INSERT INTO action_chunk_changes(id) SELECT id FROM file_chunks WHERE artifact_id=NEW.id; END;
      CREATE INDEX IF NOT EXISTS action_jobs_status ON action_jobs(status);`);
}


function actionsRetirementSchema(db:DatabaseSync){
    // Erase deleted original quotations even while discovery is disabled or the UI is closed.
    for(const table of ['captures','file_chunks'])db.exec(`CREATE TRIGGER IF NOT EXISTS actions_${table}_deleted AFTER DELETE ON ${table} BEGIN
      UPDATE action_proposals SET json=json_set(json,'$.evidence',json('[]'),'$.version',json_extract(json,'$.version')+1,
        '$.event',CASE WHEN json_extract(json,'$.status') IN ('proposed','approved','dismissed','stale') THEN json('{"title":"来源已删除的日程建议","start":null,"end":null,"timeZone":null,"allDay":false,"location":"","description":""}') ELSE json_extract(json,'$.event') END,
        '$.uncertainty','', '$.status',CASE WHEN json_extract(json,'$.status') IN ('proposed','approved','dismissed','stale') THEN 'stale' ELSE json_extract(json,'$.status') END)
      WHERE EXISTS(SELECT 1 FROM json_each(action_proposals.json,'$.evidence') e WHERE json_extract(e.value,'$.id')=OLD.id);
      DELETE FROM action_jobs WHERE id=OLD.id;
    END;`);
    for(const table of ['captures','file_chunks'])db.exec(`CREATE TRIGGER IF NOT EXISTS actions_related_${table}_deleted AFTER DELETE ON ${table} BEGIN
      UPDATE action_proposals SET json=json_set(json,'$.related.event',json('{"title":"来源已删除的日程建议","start":null,"end":null,"timeZone":null,"allDay":false,"location":"","description":""}'))
      WHERE json_type(json,'$.related')='object' AND json_extract(json,'$.status') IN ('proposed','approved','dismissed','stale') AND EXISTS(SELECT 1 FROM json_each(action_proposals.json,'$.evidence') e WHERE json_extract(e.value,'$.id')=OLD.id);
    END;`);
}
