import test from 'node:test';
import assert from 'node:assert/strict';
import {constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {BackgroundModelAuthorization} from '../src/background-model-authorization.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {testVault} from './fixtures/plugin-runtime-vault.js';

const schema=(store:Store)=>store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
const exists=(store:Store,name:string)=>Boolean(store.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-background-schema-')),store=new Store(directory);
 const controls:BackgroundModelAuthorization[]=[];
 t.after(()=>{store.db.setAuthorizer(null);for(const control of controls)control.close();if(store.db.isTransaction)store.db.exec('ROLLBACK');store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,open(){const control=new BackgroundModelAuthorization(store,()=>[]);controls.push(control);return control;}};
}
function denyLastTable(store:Store){
 store.db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TABLE&&name==='background_model_step_authority'?constants.SQLITE_DENY:constants.SQLITE_OK);
}

for(const nested of [false,true])test(`background constructor last-table denial rolls back its owner${nested?' within a caller savepoint':''}`,t=>{
 const f=fixture(t),{store}=f,db=store.db;
 db.exec('CREATE TABLE generated_outer(value TEXT)');
 if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
 const before=schema(store);denyLastTable(store);
 assert.throws(()=>f.open(),{errcode:23});db.setAuthorizer(null);
 assert.deepEqual(schema(store),before);assert.equal(db.isTransaction,nested);assert.equal(exists(store,'background_model_authorization'),false);
 if(nested){db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);}
 const control=f.open(),installed=schema(store);
 assert.deepEqual(control.view(),{revision:0,state:'off',excludedSourceIds:[]});assert.equal(db.isTransaction,nested);
 assert.equal(db.prepare('SELECT count(*) n FROM background_model_authorization').get()?.n,1);
 assert.equal(exists(store,'material_heads'),false);assert.equal(exists(store,'assistant_routines'),false);
 if(nested){db.exec('ROLLBACK');assert.deepEqual(schema(store),before);assert.deepEqual(f.open().view(),control.view());assert.deepEqual(schema(store),installed);}
 assert.deepEqual(f.open().view(),control.view());assert.deepEqual(schema(store),installed);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

for(const nested of [false,true])test(`background constructor seed denial preserves the existing schema${nested?' and caller transaction':''}`,t=>{
 const f=fixture(t),{store}=f,db=store.db;
 db.exec("CREATE TABLE background_model_authorization(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);CREATE TRIGGER generated_seed_refusal BEFORE INSERT ON background_model_authorization BEGIN SELECT RAISE(ABORT,'generated seed refusal');END;CREATE TABLE generated_outer(value TEXT)");
 if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
 const before=schema(store);assert.throws(()=>f.open(),/generated seed refusal/);
 assert.deepEqual(schema(store),before);assert.equal(db.isTransaction,nested);
 assert.equal(db.prepare('SELECT count(*) n FROM background_model_authorization').get()?.n,0);assert.equal(exists(store,'background_model_work'),false);
 if(nested){db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);}
 db.exec('DROP TRIGGER generated_seed_refusal');assert.deepEqual(f.open().view(),{revision:0,state:'off',excludedSourceIds:[]});
 if(nested){db.exec('ROLLBACK');assert.deepEqual(schema(store),before);db.exec('DROP TRIGGER generated_seed_refusal');assert.deepEqual(f.open().view(),{revision:0,state:'off',excludedSourceIds:[]});}
 assert.equal(db.prepare('SELECT count(*) n FROM background_model_authorization').get()?.n,1);
});

test('authorization prepare publishes control only after schema and singleton installation succeed',async t=>{
 const f=fixture(t),{store}=f,options={ownerToken:'generated-owner'};
 const vault=await testVault(store,store.directory),dependencies={vault,availableModelConnections:()=>[]};
 t.after(()=>vault.close());
 const failed=createAuthorizationPlatform(options,dependencies);t.after(()=>failed.close());const before=schema(store);denyLastTable(store);
 await assert.rejects(failed.prepare(),{errcode:23});store.db.setAuthorizer(null);
 assert.deepEqual(schema(store),before);assert.throws(()=>failed.assembly,{code:'authorization_unavailable',statusCode:503});
 const platform=createAuthorizationPlatform(options,dependencies);t.after(()=>platform.close());
 assert.throws(()=>platform.assembly,{code:'authorization_unavailable',statusCode:503});await platform.prepare();
 assert.deepEqual(platform.assembly.modelAuthorization.view(),{revision:0,state:'off',excludedSourceIds:[]});assert.equal(platform.assembly.connections,undefined);
 assert.equal(exists(store,'background_model_step_authority'),true);assert.equal(exists(store,'material_heads'),false);
});
