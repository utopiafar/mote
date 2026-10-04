import type {Store} from './store.js';
const states=['waiting','running','blocked','succeeded','failed','cancelled','stale'] as const;
export type OperationMembership={generation?:{slot:string;version:string};optional?:boolean};
/** Fresh current-definition projections. Step state and historical links remain durable. */
export function installOperationProjection(store:Store){
 const db=store.db;
 const excluded=(state:string,optional:string)=>`(${optional} AND ${state} IN ('blocked','failed','cancelled','stale'))`;
 const applyLink=(alias:'old'|'new',sign:'+'|'-')=>`UPDATE operation_progress SET total=total${sign}${alias}.active,not_scheduled=not_scheduled${sign}(${alias}.active AND ${alias}.optional AND (SELECT state FROM execution_steps WHERE id=${alias}.step_id)='blocked'),${states.map(state=>`${state}=${state}${sign}(${alias}.active AND NOT ${excluded(`(SELECT state FROM execution_steps WHERE id=${alias}.step_id)`,`${alias}.optional`)} AND (SELECT state FROM execution_steps WHERE id=${alias}.step_id)='${state}')`).join(',')},updated_at=max(updated_at,coalesce((SELECT updated_at FROM execution_steps WHERE id=${alias}.step_id),updated_at)) WHERE id=${alias}.operation_id;`;
 const applyState=(alias:'old'|'new',sign:'+'|'-')=>`UPDATE operation_progress SET not_scheduled=not_scheduled${sign}(coalesce((SELECT optional FROM execution_operation_steps WHERE operation_id=operation_progress.id AND step_id=${alias}.id AND active=1),0) AND ${alias}.state='blocked'),${states.map(state=>`${state}=${state}${sign}(${alias}.state='${state}' AND NOT ${excluded(`${alias}.state`,`coalesce((SELECT optional FROM execution_operation_steps WHERE operation_id=operation_progress.id AND step_id=${alias}.id),0)`)} )`).join(',')},updated_at=max(updated_at,new.updated_at) WHERE id IN (SELECT operation_id FROM execution_operation_steps WHERE step_id=${alias}.id AND active=1);`;
 db.exec(`CREATE TABLE IF NOT EXISTS operation_progress(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,total INTEGER NOT NULL DEFAULT 0,not_scheduled INTEGER NOT NULL DEFAULT 0,${states.map(state=>state+' INTEGER NOT NULL DEFAULT 0').join(',')},state TEXT GENERATED ALWAYS AS (CASE WHEN total=not_scheduled THEN 'skipped' WHEN running>0 THEN 'running' WHEN waiting>0 THEN 'waiting' WHEN failed>0 THEN 'failed' WHEN blocked>0 THEN 'blocked' WHEN stale>0 THEN 'stale' WHEN cancelled>0 THEN 'cancelled' ELSE 'succeeded' END) STORED,kind TEXT GENERATED ALWAYS AS (substr(id,1,instr(id,':')-1)) STORED);
   CREATE INDEX IF NOT EXISTS operation_progress_filter ON operation_progress(state,created_at,id);
   CREATE INDEX IF NOT EXISTS operation_progress_kind ON operation_progress(kind,created_at,id);
   CREATE INDEX IF NOT EXISTS operation_membership_generation ON execution_operation_steps(operation_id,slot,generation,active);
   CREATE TABLE IF NOT EXISTS operation_generations(operation_id TEXT NOT NULL,slot TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(operation_id,slot));
   CREATE TABLE IF NOT EXISTS operation_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS operation_changes_bounded AFTER INSERT ON operation_changes BEGIN DELETE FROM operation_changes WHERE seq<new.seq-100000; END;
   CREATE TRIGGER IF NOT EXISTS operation_link_added AFTER INSERT ON execution_operation_steps BEGIN
    INSERT OR IGNORE INTO operation_progress(id,created_at,updated_at) SELECT new.operation_id,created_at,updated_at FROM execution_steps WHERE id=new.step_id;
    ${applyLink('new','+')}
   END;
   CREATE TRIGGER IF NOT EXISTS operation_link_changed AFTER UPDATE OF active,optional,generation ON execution_operation_steps BEGIN ${applyLink('old','-')} ${applyLink('new','+')} END;
   CREATE TRIGGER IF NOT EXISTS operation_link_removed BEFORE DELETE ON execution_operation_steps BEGIN ${applyLink('old','-')} END;
   CREATE TRIGGER IF NOT EXISTS operation_step_changed AFTER UPDATE OF state,updated_at ON execution_steps BEGIN ${applyState('old','-')} ${applyState('new','+')} END;
   CREATE TRIGGER IF NOT EXISTS operation_step_removed BEFORE DELETE ON execution_steps BEGIN DELETE FROM execution_operation_steps WHERE step_id=old.id; END;
   CREATE TRIGGER IF NOT EXISTS operation_changed AFTER UPDATE ON operation_progress BEGIN INSERT INTO operation_changes(operation_id) VALUES(new.id); END;
   CREATE TRIGGER IF NOT EXISTS operation_created AFTER INSERT ON operation_progress BEGIN INSERT INTO operation_changes(operation_id) VALUES(new.id); END;`);
 installOperationHierarchy(store);
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

/** Durable parent attribution copies membership, never execution state. Later
 * child admission, generation changes and deletion reach the parent atomically. */
function installOperationHierarchy(store:Store){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS operation_parents(parent_id TEXT NOT NULL,child_id TEXT NOT NULL,PRIMARY KEY(parent_id,child_id));
 CREATE INDEX IF NOT EXISTS operation_parent_children ON operation_parents(child_id,parent_id);
 CREATE TRIGGER IF NOT EXISTS operation_child_added AFTER INSERT ON execution_operation_steps BEGIN
  INSERT OR IGNORE INTO execution_operation_steps(operation_id,step_id,slot,generation,active,optional)
   SELECT parent_id,new.step_id,new.operation_id||':'||new.slot,new.generation,new.active,new.optional FROM operation_parents WHERE child_id=new.operation_id;
 END;
 CREATE TRIGGER IF NOT EXISTS operation_child_changed AFTER UPDATE OF active,optional,generation ON execution_operation_steps BEGIN
  UPDATE execution_operation_steps SET active=new.active,optional=new.optional,generation=new.generation WHERE step_id=new.step_id AND operation_id IN (SELECT parent_id FROM operation_parents WHERE child_id=new.operation_id);
 END;
 CREATE TRIGGER IF NOT EXISTS operation_child_removed AFTER DELETE ON execution_operation_steps BEGIN
  DELETE FROM execution_operation_steps WHERE step_id=old.step_id AND operation_id IN (SELECT parent_id FROM operation_parents WHERE child_id=old.operation_id);
 END;`);
}
export function linkOperationParent(store:Store,parentId:string,childId:string){
 const db=store.db;if(parentId===childId)throw Error('An operation cannot contain itself');
 if(db.prepare('WITH RECURSIVE descendants(id) AS (SELECT child_id FROM operation_parents WHERE parent_id=? UNION SELECT p.child_id FROM operation_parents p JOIN descendants d ON p.parent_id=d.id) SELECT 1 FROM descendants WHERE id=? LIMIT 1').get(childId,parentId))throw Error('Operation ancestry cycle');
 if(db.prepare('SELECT 1 FROM operation_parents WHERE parent_id=? AND child_id=?').get(parentId,childId))return;
 const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
 try{
  store.reserveMetadata(Buffer.byteLength(parentId)+Buffer.byteLength(childId)+256);
  db.prepare('INSERT INTO operation_parents VALUES(?,?)').run(parentId,childId);
  db.prepare("INSERT OR IGNORE INTO execution_operation_steps(operation_id,step_id,slot,generation,active,optional) SELECT ?,step_id,operation_id||':'||slot,generation,active,optional FROM execution_operation_steps WHERE operation_id=?").run(parentId,childId);
  if(own)db.exec('COMMIT');
 }catch(error){if(own)db.exec('ROLLBACK');throw error;}
}
