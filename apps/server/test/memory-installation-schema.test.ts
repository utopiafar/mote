import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants,DatabaseSync} from 'node:sqlite';
import {Store,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryNativeStages} from '../src/memory-native-stages.js';
import {MemoryStore} from '../src/memory.js';
import {Conversations} from '../src/conversations.js';
import {MemoryLifecycle,defaultLifecycleSettings,projectMemoryLifecycleSettings,storedMemoryLifecycleSettings,memoryLifecycleSchemaInstallation} from '../src/memory-lifecycle.js';
import {MemoryPublication,type MemoryPublicationBindingPort} from '../src/plugins/memory-publication.js';
import {memoryPublicationSchemaInstallation} from '../src/plugins/memory-publication-schema.js';
import {installSchemaPlan} from '../src/schema-installation.js';

test('native stage installation rolls back a real late index failure and retries on the same borrowed store and engine',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-installation-'));
  const store=new Store(directory,{dataKey:'13'.repeat(32),contentEncryptionEnabled:true}),engine=new ExecutionEngine(store);
  let native:MemoryNativeStages|undefined;
  t.after(async()=>{await native?.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('generated-history','retained');
  store.db.exec('CREATE TABLE memory_engine_stage_checkpoint(generated TEXT)');
  const schema=()=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const before=schema(),key=Buffer.from(store.key);
  assert.throws(()=>new MemoryNativeStages(store,engine,{settle:async()=>{}}),/already a table named memory_engine_stage_checkpoint/);
  assert.deepEqual(schema(),before,'a failed native installation must not retain its earlier tables');
  assert.equal(store.db.isTransaction,false);
  store.db.exec('DROP TABLE memory_engine_stage_checkpoint');
  native=new MemoryNativeStages(store,engine,{settle:async()=>{}});
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('memory_engine_stage_cleanups','memory_engine_stage_drafts','memory_engine_stage_checkpoint')").get()?.n,3);
  assert.equal(store.db.prepare('SELECT value FROM settings WHERE key=?').get('generated-history')?.value,'retained');
  assert.deepEqual(store.key,key);
  await native.close();
  assert.equal(engine.closed,false,'native stage cleanup must not close its borrowed engine');
  assert.equal(store.db.prepare('SELECT 1 alive').get()?.alive,1);
});

function fixture(t:test.TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-installation-'));
  const store=new Store(directory,{dataKey:'17'.repeat(32),contentEncryptionEnabled:true});
  const memories=new MemoryStore(store);new Conversations(store);
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('generated-history','retained');
  const key=Buffer.from(store.key);
  const closers:(()=>Promise<void>)[]=[];
  t.after(async()=>{try{for(const close of closers)await close();}finally{store.db.setAuthorizer(null);if(store.db.isTransaction)store.db.exec('ROLLBACK');store.close();rmSync(directory,{recursive:true,force:true});}});
  const schema=()=>sha256(JSON.stringify(store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
  const history=()=>{assert.equal(store.db.prepare('SELECT value FROM settings WHERE key=?').get('generated-history')?.value,'retained');assert.deepEqual(store.key,key);};
  return {store,memories,schema,history,beforeClose:(close:()=>Promise<void>)=>closers.push(close)};
}

function denyTrigger(db:DatabaseSync,name:string){db.setAuthorizer((code,object)=>code===constants.SQLITE_CREATE_TRIGGER&&object===name?constants.SQLITE_DENY:constants.SQLITE_OK);}

function sqliteFailure(message:RegExp){
  return (error:unknown)=>{
    assert.ok(error instanceof Error);assert.match(error.message,message);
    assert.equal((error as Error&{code?:string}).code,'ERR_SQLITE_ERROR');
    assert.equal(error.cause,undefined,'an ordinary SQLite failure must not be replaced or wrapped');
    return true;
  };
}

for(const nested of [false,true])test(`lifecycle installation rolls back a real late trigger failure${nested?' inside the caller transaction':''} and retries its borrowed store`,async t=>{
  const {store,schema,history,beforeClose}=fixture(t);
  let lifecycle:MemoryLifecycle|undefined;
  beforeClose(async()=>{await lifecycle?.close();});
  const before=schema();
  if(nested)store.db.exec("BEGIN;INSERT INTO settings VALUES('generated-caller','before');SAVEPOINT generated_caller");
  denyTrigger(store.db,'conversation_event_update');
  assert.throws(()=>new MemoryLifecycle(store,()=>false),sqliteFailure(/not authorized/));
  store.db.setAuthorizer(null);
  assert.equal(schema(),before,'late trigger failure must restore the entire schema');
  assert.equal(store.db.isTransaction,nested);history();
  if(nested){
    assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='generated-caller'").get()?.value,'before');
    store.db.exec("INSERT INTO settings VALUES('generated-after','after');ROLLBACK TO generated_caller;RELEASE generated_caller");
    assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='generated-after'").get(),undefined);
  }
  lifecycle=new MemoryLifecycle(store,()=>false);
  assert.deepEqual(storedMemoryLifecycleSettings(store),defaultLifecycleSettings);
  await lifecycle.close();lifecycle=undefined;
  if(nested){
    store.db.exec('ROLLBACK');assert.equal(schema(),before,'the outer rollback must remove the successful installation');
    lifecycle=new MemoryLifecycle(store,()=>false);
  }
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('memory_event_insert','memory_event_update','conversation_event_insert','conversation_event_update')").get()?.n,4);
  assert.equal(store.db.isTransaction,false);history();
  await lifecycle?.close();lifecycle=undefined;
  assert.equal(store.db.prepare('SELECT 1 alive').get()?.alive,1);
});

for(const nested of [false,true])test(`lifecycle projection failure rolls back runtime DDL and preserves the previous settings${nested?' inside the caller transaction':''}`,async t=>{
  const {store,schema,history}=fixture(t),previous=structuredClone(defaultLifecycleSettings);
  previous.consolidation.enabled=false;projectMemoryLifecycleSettings(store,previous);
  store.db.exec("CREATE TRIGGER generated_projection_failure BEFORE INSERT ON memory_lifecycle_effective BEGIN SELECT RAISE(ABORT,'generated projection failure');END");
  const before=schema();
  if(nested)store.db.exec("BEGIN;INSERT INTO settings VALUES('generated-caller','retained')");
  assert.throws(()=>new MemoryLifecycle(store,()=>false),sqliteFailure(/generated projection failure/));
  assert.equal(schema(),before);assert.deepEqual(storedMemoryLifecycleSettings(store),previous);
  assert.equal(store.db.isTransaction,nested);history();
  if(nested){assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='generated-caller'").get()?.value,'retained');store.db.exec('ROLLBACK');}
  store.db.exec('DROP TRIGGER generated_projection_failure');
  const lifecycle=new MemoryLifecycle(store,()=>false);
  try{assert.deepEqual(storedMemoryLifecycleSettings(store),defaultLifecycleSettings);history();}
  finally{await lifecycle.close();}
});

for(const nested of [false,true])test(`publication installation rolls back its last dynamic retirement trigger failure${nested?' inside the caller transaction':''} before publishing collaborators`,async t=>{
  const {store,memories,schema,history,beforeClose}=fixture(t);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_plan_binding'").get(),undefined,'publication installation must not gain an eager binding-table prerequisite');
  const references=()=>[];
  const bindings={binding:()=>({planId:'mote.builtin',generation:1}),plugins:{references},assertNewManualWork:()=>{}} as unknown as MemoryPublicationBindingPort;
  let publication:MemoryPublication|undefined;
  beforeClose(async()=>{await publication?.close();});
  const before=schema();
  if(nested)store.db.exec("BEGIN;INSERT INTO settings VALUES('generated-caller','retained')");
  denyTrigger(store.db,'memory_owner_mutations_private_retired_update');
  assert.throws(()=>new MemoryPublication(store,memories,bindings,undefined,{autostart:false}),sqliteFailure(/not authorized/));
  store.db.setAuthorizer(null);
  assert.equal(schema(),before,'the last dynamic trigger must roll back every preceding publication table and trigger');
  assert.equal(store.db.isTransaction,nested);history();
  assert.equal(bindings.stageMigrationRecord,undefined);assert.equal(bindings.migrationActivated,undefined);assert.equal(bindings.plugins.references,references);
  publication=new MemoryPublication(store,memories,bindings,undefined,{autostart:false});
  assert.equal(typeof bindings.stageMigrationRecord,'function');
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='memory_owner_mutations_private_retired_update'").get()?.n,1);
  await publication.close();publication=undefined;
  if(nested){
    assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='generated-caller'").get()?.value,'retained');
    store.db.exec('ROLLBACK');assert.equal(schema(),before);
    publication=new MemoryPublication(store,memories,bindings,undefined,{autostart:false});
  }
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('memory_publications','memory_publication_outputs','memory_provider_writes','memory_owner_mutations','memory_provider_erases','memory_provider_evidence_revocations','memory_publication_dependencies','memory_publication_retirements')").get()?.n,8);
  assert.equal(store.db.isTransaction,false);history();
  await publication?.close();publication=undefined;
  assert.equal(store.db.prepare('SELECT 1 alive').get()?.alive,1);
});

test('native stage installation uses a savepoint, preserves caller writes and reinstalls after an outer rollback',async t=>{
  const {store,schema,history,beforeClose}=fixture(t),engine=new ExecutionEngine(store);
  let native:MemoryNativeStages|undefined;
  beforeClose(async()=>{await native?.close();await engine.close();});
  store.db.exec('CREATE TABLE memory_engine_stage_checkpoint(generated TEXT)');
  const before=schema();
  store.db.exec("BEGIN;INSERT INTO settings VALUES('generated-caller','retained')");
  assert.throws(()=>new MemoryNativeStages(store,engine,{settle:async()=>{}}),sqliteFailure(/already a table named memory_engine_stage_checkpoint/));
  assert.equal(schema(),before);assert.equal(store.db.isTransaction,true);history();
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='generated-caller'").get()?.value,'retained');
  store.db.exec('DROP TABLE memory_engine_stage_checkpoint');native=new MemoryNativeStages(store,engine,{settle:async()=>{}});
  assert.equal(store.db.isTransaction,true);await native.close();native=undefined;
  store.db.exec('ROLLBACK');assert.equal(schema(),before);
  store.db.exec('DROP TABLE memory_engine_stage_checkpoint');native=new MemoryNativeStages(store,engine,{settle:async()=>{}});
  assert.equal(store.db.isTransaction,false);history();await native.close();native=undefined;
  assert.equal(engine.closed,false);assert.equal(store.db.prepare('SELECT 1 alive').get()?.alive,1);
});

test('early lifecycle projection stays independent and rolls back a failed seed or the caller transaction before retry',()=>{
  const db=new DatabaseSync(':memory:'),store={db} as Store,settings=structuredClone(defaultLifecycleSettings);
  settings.consolidation.enabled=false;
  try{
    assert.deepEqual(storedMemoryLifecycleSettings(store),defaultLifecycleSettings);
    db.setAuthorizer((code,object)=>code===constants.SQLITE_INSERT&&object==='memory_lifecycle_effective'?constants.SQLITE_DENY:constants.SQLITE_OK);
    assert.throws(()=>projectMemoryLifecycleSettings(store,settings),sqliteFailure(/not authorized/));
    db.setAuthorizer(null);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),[]);assert.equal(db.isTransaction,false);
    db.exec('BEGIN');projectMemoryLifecycleSettings(store,settings);
    assert.deepEqual(storedMemoryLifecycleSettings(store),settings);db.exec('ROLLBACK');
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),[]);
    projectMemoryLifecycleSettings(store,settings);assert.deepEqual(storedMemoryLifecycleSettings(store),settings);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map(row=>row.name),['memory_lifecycle_effective']);
  }finally{db.setAuthorizer(null);if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('Memory runtime plans check only their actual external trigger targets before any DDL',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    for(const installation of [memoryLifecycleSchemaInstallation,memoryPublicationSchemaInstallation]){
      assert.throws(()=>installSchemaPlan(db,[installation]),new RegExp(installation.owner+' schema requires memory object\\(s\\): table:memories'));
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),[]);assert.equal(db.isTransaction,false);
    }
    db.exec('CREATE TABLE memories(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    const before=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    assert.throws(()=>installSchemaPlan(db,[memoryLifecycleSchemaInstallation]),/memory-lifecycle schema requires conversation object\(s\): table:conversations/);
    assert.deepEqual(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),before);assert.equal(db.isTransaction,false);
  }finally{db.close();}
});
