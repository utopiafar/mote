import type {Store} from './store.js';
const states=['waiting','running','blocked','succeeded','failed','cancelled','stale'] as const;
export type OperationMembership={generation?:{slot:string;version:string};optional?:boolean};
/** A current-definition read projection. Historical links and step states are retained. */
export function installOperationProjection(store:Store){
 const db=store.db;if(db.prepare("SELECT 1 FROM settings WHERE key='operation-projection-v1'").get())return;
 db.exec('BEGIN IMMEDIATE');
 try{
  const columns=new Set(db.prepare('PRAGMA table_info(execution_operation_steps)').all().map(row=>String(row.name)));
  for(const [name,type] of [['slot',"TEXT NOT NULL DEFAULT ''"],['generation',"TEXT NOT NULL DEFAULT ''"],['active','INTEGER NOT NULL DEFAULT 1'],['optional','INTEGER NOT NULL DEFAULT 0']])if(!columns.has(name))db.exec(`ALTER TABLE execution_operation_steps ADD COLUMN ${name} ${type}`);
  const effective=(state:string,active:string,optional:string)=>`${active} AND NOT (${optional} AND ${state}='blocked')`;
  const applyLink=(alias:'old'|'new',sign:'+'|'-')=>`UPDATE operation_progress SET total=total${sign}${alias}.active,not_scheduled=not_scheduled${sign}(${alias}.active AND ${alias}.optional AND (SELECT state FROM execution_steps WHERE id=${alias}.step_id)='blocked'),${states.map(state=>`${state}=${state}${sign}(${effective(`(SELECT state FROM execution_steps WHERE id=${alias}.step_id)`,`${alias}.active`,`${alias}.optional`)} AND (SELECT state FROM execution_steps WHERE id=${alias}.step_id)='${state}')`).join(',')},updated_at=max(updated_at,coalesce((SELECT updated_at FROM execution_steps WHERE id=${alias}.step_id),updated_at)) WHERE id=${alias}.operation_id;`;
  const applyState=(alias:'old'|'new',sign:'+'|'-')=>`UPDATE operation_progress SET not_scheduled=not_scheduled${sign}(coalesce((SELECT optional FROM execution_operation_steps WHERE operation_id=operation_progress.id AND step_id=${alias}.id AND active=1),0) AND ${alias}.state='blocked'),${states.map(state=>`${state}=${state}${sign}(${alias}.state='${state}' AND NOT (${alias}.state='blocked' AND coalesce((SELECT optional FROM execution_operation_steps WHERE operation_id=operation_progress.id AND step_id=${alias}.id),0)))`).join(',')},updated_at=max(updated_at,new.updated_at) WHERE id IN (SELECT operation_id FROM execution_operation_steps WHERE step_id=${alias}.id AND active=1);`;
  db.exec(`CREATE TABLE operation_progress(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0,not_scheduled INTEGER NOT NULL DEFAULT 0,${states.map(state=>state+' INTEGER NOT NULL DEFAULT 0').join(',')},state TEXT GENERATED ALWAYS AS (CASE WHEN total=not_scheduled THEN 'skipped' WHEN running>0 THEN 'running' WHEN waiting>0 THEN 'waiting' WHEN failed>0 THEN 'failed' WHEN blocked>0 THEN 'blocked' WHEN stale>0 THEN 'stale' WHEN cancelled>0 THEN 'cancelled' ELSE 'succeeded' END) STORED,kind TEXT GENERATED ALWAYS AS (substr(id,1,instr(id,':')-1)) STORED);
   CREATE INDEX operation_progress_filter ON operation_progress(state,created_at,id);
   CREATE INDEX operation_progress_kind ON operation_progress(kind,created_at,id);
   CREATE INDEX operation_membership_generation ON execution_operation_steps(operation_id,slot,generation,active);
   CREATE TABLE operation_generations(operation_id TEXT NOT NULL,slot TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(operation_id,slot));
   CREATE TABLE operation_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL);
   CREATE TRIGGER operation_changes_bounded AFTER INSERT ON operation_changes BEGIN DELETE FROM operation_changes WHERE seq<new.seq-100000; END;
   CREATE TRIGGER operation_link_added AFTER INSERT ON execution_operation_steps BEGIN
    INSERT OR IGNORE INTO operation_progress(id,created_at,updated_at) SELECT new.operation_id,created_at,updated_at FROM execution_steps WHERE id=new.step_id;
    ${applyLink('new','+')}
   END;
   CREATE TRIGGER operation_link_changed AFTER UPDATE OF active,optional,generation ON execution_operation_steps BEGIN ${applyLink('old','-')} ${applyLink('new','+')} END;
   CREATE TRIGGER operation_link_removed BEFORE DELETE ON execution_operation_steps BEGIN ${applyLink('old','-')} END;
   CREATE TRIGGER operation_step_changed AFTER UPDATE OF state,updated_at ON execution_steps BEGIN ${applyState('old','-')} ${applyState('new','+')} END;
   CREATE TRIGGER operation_step_removed BEFORE DELETE ON execution_steps BEGIN DELETE FROM execution_operation_steps WHERE step_id=old.id; END;
   CREATE TRIGGER operation_changed AFTER UPDATE ON operation_progress BEGIN INSERT INTO operation_changes(operation_id) VALUES(new.id); END;
   CREATE TRIGGER operation_created AFTER INSERT ON operation_progress BEGIN INSERT INTO operation_changes(operation_id) VALUES(new.id); END;
  `);
  // Before this projection existed, links did not record configuration generations.
  // Recover only host metadata: parents identify revisions; children follow their
  // first parent in insertion order. Keep every historical link for inspection.
  db.exec(`UPDATE execution_operation_steps AS o SET
    slot=CASE WHEN e.kind LIKE 'files.%' OR e.kind LIKE 'file-step.%' THEN 'file-pipeline' ELSE json_extract(e.input,'$.kind') END,
    generation=coalesce(CASE WHEN e.kind LIKE 'files.%' THEN json_extract(e.input,'$.revision')
      WHEN e.kind LIKE 'perception.%' THEN json_extract(e.input,'$.configRevision')
      ELSE (SELECT json_extract(p.input,'$.revision') FROM execution_steps p JOIN execution_operation_steps po ON po.step_id=p.id WHERE po.operation_id=o.operation_id AND p.kind='files.pipeline' AND p.rowid<e.rowid ORDER BY p.rowid DESC LIMIT 1) END,''),
    optional=coalesce(e.kind='files.summary' AND e.error IN ('local_only','summary_disabled'),0)
    FROM execution_steps e WHERE e.id=o.step_id AND (e.kind IN ('files.pipeline','files.summary','perception.ocr','perception.semantic') OR e.kind LIKE 'file-step.%');
   INSERT INTO operation_generations(operation_id,slot,version)
    SELECT operation_id,slot,generation FROM (SELECT o.*,row_number() OVER(PARTITION BY o.operation_id,o.slot ORDER BY e.rowid DESC) position FROM execution_operation_steps o JOIN execution_steps e ON e.id=o.step_id WHERE e.kind IN ('files.pipeline','perception.ocr','perception.semantic')) WHERE position=1;
   UPDATE execution_operation_steps AS o SET active=(generation=coalesce((SELECT version FROM operation_generations g WHERE g.operation_id=o.operation_id AND g.slot=o.slot),generation));
   INSERT INTO operation_progress(id,created_at,updated_at,total,not_scheduled,${states.join(',')}) SELECT o.operation_id,min(e.created_at),max(e.updated_at),sum(o.active),sum(o.active AND o.optional AND e.state='blocked'),${states.map(state=>"sum(o.active AND e.state='"+state+"' AND NOT (o.optional AND e.state='blocked'))").join(',')} FROM execution_operation_steps o JOIN execution_steps e ON e.id=o.step_id GROUP BY o.operation_id;
   INSERT INTO settings VALUES('operation-projection-v1','1');`);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function linkOperation(store:Store,operationId:string,stepId:string,membership:OperationMembership={}){
 const db=store.db,slot=membership.generation?.slot??'',version=membership.generation?.version??'';
 if(membership.generation){
  const prior=db.prepare('SELECT version FROM operation_generations WHERE operation_id=? AND slot=?').get(operationId,slot);
  if(prior?.version!==version){
   db.prepare('INSERT INTO operation_generations VALUES(?,?,?) ON CONFLICT(operation_id,slot) DO UPDATE SET version=excluded.version').run(operationId,slot,version);
   db.prepare('UPDATE execution_operation_steps SET active=(generation=?) WHERE operation_id=? AND slot=? AND active!=(generation=?)').run(version,operationId,slot,version);
  }
 }
 db.prepare('INSERT INTO execution_operation_steps(operation_id,step_id,slot,generation,optional,active) VALUES(?,?,?,?,?,1) ON CONFLICT(operation_id,step_id) DO UPDATE SET slot=excluded.slot,generation=excluded.generation,optional=excluded.optional,active=1 WHERE slot!=excluded.slot OR generation!=excluded.generation OR optional!=excluded.optional OR active!=1').run(operationId,stepId,slot,version,Number(membership.optional??false));
}
