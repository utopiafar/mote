import type {DatabaseSync} from 'node:sqlite';

export type SchemaObject={readonly type:'table'|'index'|'trigger'|'view';readonly name:string};
/** Objects supplied by an already active owner, checked against SQLite on every
 * installation. This is an internal declaration, never an installation receipt. */
export type SchemaPrerequisite={readonly owner:string;readonly objects:readonly SchemaObject[]};

/** An internal, domain-owned installer. Required owners appear earlier in the
 * same fixed plan; prerequisites already exist before this plan starts.
 * Installation never discovers or activates other features. */
export type SchemaInstallation={
 readonly owner:string;
 readonly requires:readonly string[];
 readonly prerequisites?:readonly SchemaPrerequisite[];
 readonly install:(db:DatabaseSync)=>void;
};

function missingSchemaObjects(db:DatabaseSync,objects:readonly SchemaObject[]){
 const rows=db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${objects.map(()=>'?').join(',')})`).all(...objects.map(object=>object.name));
 return objects.filter(object=>!rows.some(row=>row.type===object.type&&row.name===object.name));
}
/** Read current schema facts, including DDL changed by an outer rollback. */
export function schemaObjectsExist(db:DatabaseSync,objects:readonly SchemaObject[]){
 return objects.length>0&&missingSchemaObjects(db,objects).length===0;
}

function validateSchemaPlan(plan:readonly SchemaInstallation[]){
 const owners=new Map<string,number>();
 for(const [index,item] of plan.entries()){
  if(owners.has(item.owner))throw new Error(`Duplicate schema owner: ${item.owner}`);
  owners.set(item.owner,index);
  for(const prerequisite of item.prerequisites??[])if(!prerequisite.objects.length)
   throw new Error(`${item.owner} schema prerequisite ${prerequisite.owner} has no objects`);
 }
 for(const [index,item] of plan.entries())for(const dependency of item.requires){
  const prerequisite=owners.get(dependency);
  if(prerequisite===undefined)throw new Error(`${item.owner} schema requires missing owner ${dependency}`);
  if(prerequisite>=index)throw new Error(`${item.owner} schema requires ${dependency} first`);
 }
}

let savepointSequence=0;

/** Validate the whole plan before writing, then install it as one atomic group.
 * A savepoint preserves an existing caller transaction. There are no cached
 * installation receipts: an outer rollback must allow the same plan to retry. */
export function installSchemaPlan(db:DatabaseSync,plan:readonly SchemaInstallation[]){
 validateSchemaPlan(plan);
 const nested=db.isTransaction,savepoint=`mote_schema_install_${++savepointSequence}`;
 db.exec(nested?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
 try{
  // Check every external prerequisite under the transaction before invoking
  // even the first installer. Never reinstall another owner to satisfy it.
  for(const item of plan)for(const prerequisite of item.prerequisites??[]){
   const missing=missingSchemaObjects(db,prerequisite.objects);
   if(missing.length)throw new Error(`${item.owner} schema requires ${prerequisite.owner} object(s): ${missing.map(object=>`${object.type}:${object.name}`).join(', ')}`);
  }
  for(const item of plan)item.install(db);
  db.exec(nested?`RELEASE ${savepoint}`:'COMMIT');
 }catch(error){
  // SQLITE_FULL can abort the transaction itself. Preserve that original error
  // rather than replacing it with a failed ROLLBACK or missing-savepoint error.
  if(db.isTransaction)try{
   db.exec(nested?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK');
  }catch(rollbackError){
   throw new AggregateError([error,rollbackError],'Schema installation and rollback failed',{cause:error});
  }
  throw error;
 }
}
