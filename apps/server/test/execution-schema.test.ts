import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store,StoreError} from '../src/evidence-store.js';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {executionSchemaInstallations,installExecutionSchema} from '../src/execution-schema.js';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';
import {TaskRecords,taskRecordsSchemaInstallations,type AssertTaskCurrent} from '../src/task-records.js';
import {RunExecution,runExecutionSchemaInstallation} from '../src/run-execution.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {Operations} from '../src/operations.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));

test('the original Engine and TaskRecords groups reject reversed owners and absent external objects before any installer',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  let invoked=false;
  const probe:SchemaInstallation={owner:'generated-probe',requires:[],install:()=>{invoked=true;db.exec('CREATE TABLE generated_partial(id TEXT)');}};
  for(const [plan,error] of [
   [[...executionSchemaInstallations].reverse(),/operation-projection schema requires execution first/],
   [[...taskRecordsSchemaInstallations].reverse(),/task-evidence schema requires task-records first/],
   [executionSchemaInstallations,/operation-projection schema requires memory object/],
   [taskRecordsSchemaInstallations,/task-evidence schema requires capture object/],
  ] as const){
   assert.throws(()=>installSchemaPlan(db,[probe,...plan]),error);assert.equal(invoked,false);assert.deepEqual(schema(db),[]);
  }
  db.exec('CREATE TABLE memories(id TEXT PRIMARY KEY)');installExecutionSchema(db);
  for(const name of ['task_records','run_execution_owners','material_heads'])assert.equal(exists(db,name),false);
  assert.ok(exists(db,'operation_parents'));assert.ok(exists(db,'operation_memory_changed'));
  db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY); CREATE TABLE file_chunks(id TEXT PRIMARY KEY)');
  const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,taskRecordsSchemaInstallations),/task-evidence schema requires evidence-archive object/);
  assert.deepEqual(schema(db),before);db.exec('CREATE TABLE context_artifacts(id TEXT PRIMARY KEY)');
  installSchemaPlan(db,taskRecordsSchemaInstallations);assert.ok(exists(db,'task_memories_deleted'));
  assert.equal(exists(db,'run_execution_owners'),false);
 }finally{db.close();}
});

for(const nested of [false,true])test(`actual Engine hierarchy SQL failure rolls back its whole group${nested?' and preserves the caller savepoint':''}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-engine-schema-failure-')),store=new Store(directory);let engine:ExecutionEngine|undefined;
 t.after(async()=>{await engine?.close();store.close();rmSync(directory,{recursive:true,force:true});});
 store.db.exec("CREATE TABLE operation_parent_children(marker TEXT PRIMARY KEY); INSERT INTO operation_parent_children VALUES('retained'); CREATE TABLE generated_outer(value TEXT)");
 if(nested)store.db.exec("BEGIN; SAVEPOINT generated_caller; INSERT INTO generated_outer VALUES('before')");
 const before=schema(store.db);
 assert.throws(()=>new ExecutionEngine(store),/already a table named operation_parent_children/);
 assert.deepEqual(schema(store.db),before);assert.equal(store.db.isTransaction,nested);
 assert.equal(store.db.prepare('SELECT marker FROM operation_parent_children').get()?.marker,'retained');
 if(nested){store.db.exec("INSERT INTO generated_outer VALUES('after'); RELEASE generated_caller; COMMIT");assert.equal(store.db.prepare('SELECT count(*) n FROM generated_outer').get()?.n,2);}
 store.db.exec('DROP TABLE operation_parent_children');engine=new ExecutionEngine(store);
 assert.ok(exists(store.db,'operation_child_removed'));assert.ok(exists(store.db,'execution_recovery_deadline'));
 const installed=schema(store.db);installExecutionSchema(store.db);assert.deepEqual(schema(store.db),installed);
});

for(const nested of [false,true])test(`late TaskEvidence SQL failure removes the earlier TaskRecords DDL${nested?' without consuming the caller savepoint':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE captures(id TEXT PRIMARY KEY); CREATE TABLE file_chunks(id TEXT PRIMARY KEY); CREATE TABLE context_artifacts(id TEXT PRIMARY KEY); CREATE TABLE memories(id TEXT PRIMARY KEY); CREATE TABLE task_evidence(marker TEXT PRIMARY KEY); INSERT INTO task_evidence VALUES('retained'); CREATE TABLE generated_outer(value TEXT)");
  if(nested)db.exec("BEGIN; SAVEPOINT generated_caller; INSERT INTO generated_outer VALUES('before')");
  const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,taskRecordsSchemaInstallations),/no such column: evidence_id/);
  assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT marker FROM task_evidence').get()?.marker,'retained');assert.equal(db.isTransaction,nested);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after'); RELEASE generated_caller; COMMIT");assert.equal(db.prepare('SELECT count(*) n FROM generated_outer').get()?.n,2);}
  db.exec('DROP TABLE task_evidence');installSchemaPlan(db,taskRecordsSchemaInstallations);
  assert.ok(exists(db,'task_captures_deleted'));assert.ok(exists(db,'task_context_artifacts_deleted'));assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

test('an Engine and RunExecution handle use the real installers again after their outer schema rollback',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-execution-schema-rollback-')),store=new Store(directory);let runs:RunExecution|undefined,engine:ExecutionEngine|undefined;
 t.after(async()=>{await runs?.stop();await engine?.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const before=schema(store.db);store.db.exec('BEGIN');engine=new ExecutionEngine(store);store.db.exec('ROLLBACK');assert.deepEqual(schema(store.db),before);
 installExecutionSchema(store.db);assert.equal(exists(store.db,'run_execution_owners'),false);
 const withEngine=schema(store.db),outputs:unknown[]=[];
 store.db.exec('BEGIN');runs=new RunExecution(store,'insight',{project:()=>{},commit:(_id,result)=>outputs.push(result),failure:(_id,error)=>assert.fail(String(error))},{executor:engine});
 store.db.exec('ROLLBACK');assert.deepEqual(schema(store.db),withEngine);
 installSchemaPlan(store.db,[runExecutionSchemaInstallation]);
 runs.start('generated-same-handle',async()=>({answer:'Generated result after schema retry'}));await runs.wait('generated-same-handle');
 assert.equal(runs.step('generated-same-handle')?.state,'succeeded');assert.deepEqual(outputs,[{answer:'Generated result after schema retry'}]);
});

test('the real Engine commits a private TaskRecord, reopens its terminal step without replay and retains deletion protection',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-execution-schema-chain-')),options={contentEncryptionEnabled:true,dataKey:'53'.repeat(32)};
 let store=new Store(directory,options),engine=new ExecutionEngine(store),tasks=new TaskRecords(store),calls=0;
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const original=randomUUID();await store.ingest({id:original,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-11-17T00:00:00.000Z',durationMs:0,ocrText:'Generated task schema original'});
 const dependencies={version:1 as const,complete:true as const,ids:[original]},input={instruction:'Generated private schema request'},result={answer:'Generated private schema result'};
 const authorize:AssertTaskCurrent=ids=>{assert.deepEqual(ids,[original]);if(!store.isCurrentEvidence(original))throw new StoreError('Generated source revoked',409);};
 const task=tasks.create({operationId:'generated:schema-task',kind:'generated.schema',requestId:randomUUID(),input,evidenceDependencies:dependencies},authorize);
 const handler:ExecutionHandler={kind:'generated.schema',pool:'generated.schema',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>store.isCurrentEvidence(original),
  execute:async(step,_signal,grant)=>{calls++;grant.assert();const current=tasks.get(String(step.input.taskId));assert.deepEqual(tasks.input(current.id,current.revision,authorize),input);return result;},
  commit:(step,value)=>{const current=tasks.get(String(step.input.taskId));tasks.saveResult(current.id,current.revision,value,dependencies,authorize);}};
 engine.register(handler);const id=engine.enqueue(task.operationId,handler.kind,{taskId:task.id});await engine.drain([id]);
 const finished=tasks.get(task.id);assert.equal(finished.state,'succeeded');assert.equal(engine.get(id)?.state,'succeeded');assert.equal(new Operations(store).detail(task.operationId).operation.state,'succeeded');
 assert.deepEqual(tasks.result(task.id,finished.revision,authorize),result);assert.deepEqual(engine.get(id)?.input,{taskId:task.id});
 const row=store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(task.id)!;
 assert.ok(String(row.input_json).startsWith('aes:'));assert.ok(String(row.result_json).startsWith('aes:'));
 await engine.close();store.close();store=new Store(directory,options);engine=new ExecutionEngine(store);tasks=new TaskRecords(store);
 engine.register(handler);assert.equal(engine.enqueue(task.operationId,handler.kind,{taskId:task.id}),id);await engine.drain([id]);
 assert.equal(calls,1);assert.deepEqual(tasks.get(task.id),finished);assert.deepEqual(tasks.result(task.id,finished.revision,authorize),result);
 assert.equal(engine.get(id)?.state,'succeeded');assert.equal(new Operations(store).detail(task.operationId).operation.state,'succeeded');
 store.delete(original);assert.equal(tasks.get(task.id).state,'stale');
 const retired=store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(task.id)!;assert.equal(retired.input_json,null);assert.equal(retired.result_json,null);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
