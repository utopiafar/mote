import type {DatabaseSync} from 'node:sqlite';

/** An internal, domain-owned installer. Prerequisites must appear earlier in the
 * caller's fixed plan; installation never discovers or activates features. */
export type SchemaInstallation={
 readonly owner:string;
 readonly requires:readonly string[];
 readonly install:(db:DatabaseSync)=>void;
};

function validateSchemaPlan(plan:readonly SchemaInstallation[]){
 const owners=new Map<string,number>();
 for(const [index,item] of plan.entries()){
  if(owners.has(item.owner))throw new Error(`Duplicate schema owner: ${item.owner}`);
  owners.set(item.owner,index);
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
