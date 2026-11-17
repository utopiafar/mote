import test from 'node:test';
import assert from 'node:assert/strict';
import {constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {DelegationStore} from '../src/delegation-store.js';
import {DelegationRuntime} from '../src/delegation-runtime.js';
import {ExecutionEngine} from '../src/execution-engine.js';

const catalog=(store:Store)=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(store:Store,name:string)=>Boolean(store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
const sourceTable='delegation_source_context_dependencies';

for(const nested of [false,true])for(const existing of [false,true])test(`late journal DDL failure restores ${existing?'an existing trigger and private rows':'the unopened journal'}${nested?' inside a caller savepoint':''}`,t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-delegation-journal-schema-')),store=new Store(directory),db=store.db;
 const history=store.installContextHistoryInvalidation;let historyCalls=0;
 t.after(()=>{db.setAuthorizer(null);if(db.isTransaction)db.exec('ROLLBACK');store.installContextHistoryInvalidation=history;store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(exists(store,'delegation_works'),false);assert.equal(exists(store,sourceTable),false);
 if(existing){const journal=new DelegationStore(store);db.prepare('INSERT INTO delegation_works VALUES(?,?)').run('generated-existing','{}');journal.savePayload('generated-existing',{message:'Generated private input'});}
 store.installContextHistoryInvalidation=function(){historyCalls++;return Reflect.apply(history,this,[]);};
 if(nested)db.exec("BEGIN;INSERT INTO settings VALUES('generated-before','before');SAVEPOINT generated_caller");
 const before=catalog(store),payload=existing?db.prepare('SELECT * FROM delegation_payloads').all():undefined;
 db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TRIGGER&&name==='delegation_original_deleted'?constants.SQLITE_DENY:constants.SQLITE_OK);
 assert.throws(()=>new DelegationStore(store),/not authorized/);db.setAuthorizer(null);
 assert.deepEqual(catalog(store),before);assert.equal(db.isTransaction,nested);assert.equal(historyCalls,0,'history invalidation stays after the completed journal phase');assert.equal(exists(store,sourceTable),false);
 if(existing)assert.deepEqual(db.prepare('SELECT * FROM delegation_payloads').all(),payload);
 const journal=new DelegationStore(store);assert.equal(historyCalls,1);const installed=catalog(store);
 assert.ok(exists(store,'delegation_original_deleted'));assert.equal(installed.filter(row=>row.type==='table'&&String(row.name).startsWith('delegation_')).length,7);assert.equal(exists(store,sourceTable),false,'opening the journal never installs the later runtime extension');
 new DelegationStore(store);assert.equal(historyCalls,2);assert.deepEqual(catalog(store),installed);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 if(existing)assert.deepEqual(journal.payload('generated-existing'),{message:'Generated private input'});
 if(nested){
  db.exec('ROLLBACK TO generated_caller;RELEASE generated_caller');assert.deepEqual(catalog(store),before);assert.equal(db.prepare("SELECT value FROM settings WHERE key='generated-before'").get()?.value,'before');
  db.exec('ROLLBACK');new DelegationStore(store);assert.deepEqual(catalog(store),installed);assert.equal(exists(store,sourceTable),false);
 }
});

for(const nested of [false,true])test(`runtime extension failure preserves the installed journal and borrowed executor${nested?' across caller rollback':''}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-delegation-runtime-schema-')),store=new Store(directory),db=store.db,engine=new ExecutionEngine(store);
 let runtime:DelegationRuntime|undefined,configured=0,siblingRuns=0,historyCalls=0;
 const configure=engine.configurePool,history=store.installContextHistoryInvalidation;
 t.after(async()=>{db.setAuthorizer(null);if(db.isTransaction)db.exec('ROLLBACK');await runtime?.close();engine.configurePool=configure;store.installContextHistoryInvalidation=history;await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(exists(store,'delegation_works'),false);assert.equal(exists(store,sourceTable),false);
 const journal=new DelegationStore(store);db.prepare('INSERT INTO delegation_works VALUES(?,?)').run('generated-existing','{}');journal.savePayload('generated-existing',{message:'Generated private input'});
 const sibling=engine.register({kind:'generated.delegation-sibling',pool:'generated.delegation-sibling',concurrency:()=>1,validate:()=>true,execute:async()=>{siblingRuns++;return {};},commit(){}});
 engine.configurePool=function(...args){if(args[0]==='delegated-agents')configured++;return Reflect.apply(configure,this,args);};
 store.installContextHistoryInvalidation=function(){historyCalls++;return Reflect.apply(history,this,[]);};
 if(nested)db.exec("BEGIN;INSERT INTO settings VALUES('generated-before','before');SAVEPOINT generated_caller");
 const before=catalog(store),payload=db.prepare('SELECT * FROM delegation_payloads').all();
 db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TABLE&&name===sourceTable?constants.SQLITE_DENY:constants.SQLITE_OK);
 assert.throws(()=>new DelegationRuntime(store,engine,{autoPump:false}),/not authorized/);db.setAuthorizer(null);
 assert.deepEqual(catalog(store),before);assert.deepEqual(db.prepare('SELECT * FROM delegation_payloads').all(),payload);assert.equal(db.isTransaction,nested);assert.equal(configured,0);assert.equal(historyCalls,1,'the earlier journal and capture-history phase retains its original runtime entry');assert.equal(engine.closed,false);
 runtime=new DelegationRuntime(store,engine,{autoPump:false});const installed=catalog(store);assert.ok(exists(store,sourceTable));assert.equal(configured,1);assert.deepEqual(journal.payload('generated-existing'),{message:'Generated private input'});
 assert.deepEqual(db.prepare('PRAGMA foreign_key_list(delegation_source_context_dependencies)').all().map(row=>row.table),['delegation_works']);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 await runtime.close();runtime=undefined;assert.equal(engine.closed,false);
 if(nested){
  db.exec('ROLLBACK TO generated_caller;RELEASE generated_caller');assert.deepEqual(catalog(store),before);assert.equal(db.prepare("SELECT value FROM settings WHERE key='generated-before'").get()?.value,'before');
  runtime=new DelegationRuntime(store,engine,{autoPump:false});await runtime.close();runtime=undefined;db.exec('ROLLBACK');assert.equal(exists(store,sourceTable),false);assert.deepEqual(journal.payload('generated-existing'),{message:'Generated private input'});
 }
 runtime=new DelegationRuntime(store,engine,{autoPump:false});assert.deepEqual(catalog(store),installed);await runtime.close();runtime=undefined;
 const id='generated-delegation-sibling-'+nested;engine.enqueue('generated-delegation-sibling','generated.delegation-sibling',{}, {id});await engine.drain([id]);assert.equal(engine.get(id)?.state,'succeeded');assert.equal(siblingRuns,1);assert.equal(engine.closed,false);await sibling();
});
