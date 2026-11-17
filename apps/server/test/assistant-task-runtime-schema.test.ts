import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan} from '../src/schema-installation.js';
import {assistantTaskRuntimeSchemaInstallation} from '../src/assistant-task-runtime-schema.js';

const objects=(db:DatabaseSync)=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
test('formal Task runtime selection installation requires the existing Task owner and is recoverable after outer rollback',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE generated_existing(value TEXT); INSERT INTO generated_existing VALUES('retained')");const before=objects(db);
  assert.throws(()=>installSchemaPlan(db,[assistantTaskRuntimeSchemaInstallation]),/assistant-task-runtime.*task-records.*task_records/);assert.deepEqual(objects(db),before);assert.equal(db.isTransaction,false);
  db.exec('CREATE TABLE task_records(id TEXT PRIMARY KEY)');const owner=objects(db);db.exec('BEGIN');installSchemaPlan(db,[assistantTaskRuntimeSchemaInstallation]);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(objects(db),owner);
  installSchemaPlan(db,[assistantTaskRuntimeSchemaInstallation]);assert.equal(db.isTransaction,false);const installed=objects(db);installSchemaPlan(db,[assistantTaskRuntimeSchemaInstallation]);assert.deepEqual(objects(db),installed);assert.equal(db.prepare('SELECT value FROM generated_existing').get()!.value,'retained');
  db.exec("INSERT INTO task_records VALUES('generated-task')");db.prepare('INSERT INTO assistant_task_runtime(task_id,input_hash) VALUES(?,?)').run('generated-task','generated-input-hash');
  assert.throws(()=>db.prepare("UPDATE assistant_task_runtime SET profile_id='incomplete-pin' WHERE task_id=?").run('generated-task'),/CHECK/);assert.equal(db.prepare('SELECT profile_id FROM assistant_task_runtime').get()!.profile_id,null);
 }finally{db.close();}
});
