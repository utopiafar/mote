import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSchemaPlan} from '../src/schema-installation.js';
import {memoryInputPlansSchemaInstallation} from '../src/memory-input-plans-schema.js';
import {MemoryInputPlans} from '../src/memory-input-plans.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const table=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function denyLastIndex(db:DatabaseSync){
 db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_INDEX&&name==='memory_input_plans_material'?constants.SQLITE_DENY:constants.SQLITE_OK);
}

for(const nested of [false,true])test(`native final-index failure restores the input-plan owner${nested?' with caller savepoint and outer rollback':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;CREATE TABLE generated_outer(value TEXT)');
  if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
  const before=schema(db);denyLastIndex(db);
  assert.throws(()=>installSchemaPlan(db,[memoryInputPlansSchemaInstallation]),/not authorized/);
  assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,nested);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);}
  db.setAuthorizer(null);installSchemaPlan(db,[memoryInputPlansSchemaInstallation]);const installed=schema(db);
  assert.notDeepEqual(installed,before);assert.equal(db.isTransaction,nested);
  assert.equal(table(db,'material_heads'),false);assert.equal(table(db,'memory_jobs'),false);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(memory_input_plans)').all().map(row=>row.table).sort(),['material_heads','memory_jobs']);
  if(nested){db.exec('ROLLBACK');assert.deepEqual(schema(db),before);installSchemaPlan(db,[memoryInputPlansSchemaInstallation]);assert.deepEqual(schema(db),installed);assert.equal(db.isTransaction,false);}
  installSchemaPlan(db,[memoryInputPlansSchemaInstallation]);assert.deepEqual(schema(db),installed);
 }finally{db.setAuthorizer(null);db.close();}
});

test('the real constructor retries on its Store without eagerly installing Material',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-plan-schema-')),store=new Store(directory),db=store.db;
 t.after(()=>{db.setAuthorizer(null);if(db.isTransaction)db.exec('ROLLBACK');store.close();rmSync(directory,{recursive:true,force:true});});
 new SourceStore(store);new MemoryStore(store);assert.equal(table(db,'material_heads'),false);
 db.exec("CREATE TABLE generated_outer(value TEXT);BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
 const before=schema(db);denyLastIndex(db);
 assert.throws(()=>new MemoryInputPlans(store),/not authorized/);assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,true);assert.equal(table(db,'material_heads'),false);
 db.setAuthorizer(null);let plans=new MemoryInputPlans(store);assert.deepEqual(plans.list('generated-job'),[]);assert.equal(plans.get('missing'),undefined);assert.equal(table(db,'material_heads'),false);
 db.exec('ROLLBACK TO generated_caller;RELEASE generated_caller');assert.deepEqual(schema(db),before);assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);
 plans=new MemoryInputPlans(store);assert.deepEqual(plans.list('generated-job'),[]);db.exec('ROLLBACK');assert.equal(table(db,'memory_input_plans'),false);
 plans=new MemoryInputPlans(store);assert.deepEqual(plans.list('generated-job'),[]);assert.equal(table(db,'material_heads'),false);
});
