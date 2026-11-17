import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {ActionCapabilities} from '../src/plugins/action-capabilities.js';
import type {SourceStore} from '../src/sources.js';
import type {Connections} from '../src/connections.js';

function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-capability-schema-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const open=()=>new ActionCapabilities(store,{} as SourceStore,{} as Connections);
 const schema=()=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 return {store,open,schema};
}

test('capability storage installation rolls back partial DDL and retries on the same Store',t=>{
 const f=fixture(t),db=f.store.db;
 db.exec('CREATE TABLE generated_schema_probe(id TEXT); CREATE INDEX action_capability_commands ON generated_schema_probe(id)');
 const before=f.schema();
 assert.throws(f.open,error=>error instanceof Error&&!(error instanceof AggregateError)&&error.message.includes('action_capability_commands'));
 assert.deepEqual(f.schema(),before,'a late native SQLite DDL failure must leave no partial capability tables or parent changes');
 assert.equal(db.isTransaction,false);
 db.exec('DROP INDEX action_capability_commands');f.open();
 for(const name of ['action_device_capabilities','action_capability_grants','action_capability_drafts','action_capability_commands'])assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name)?.type,'table');
 db.prepare('INSERT INTO action_capability_commands VALUES(?,?,?)').run('generated-command','generated-fingerprint','{"generated":true}');
 const installed=f.schema();f.open();assert.deepEqual(f.schema(),installed,'repeat construction preserves existing schema and storage triggers');
 assert.equal(db.prepare('SELECT receipt FROM action_capability_commands WHERE id=?').get('generated-command')?.receipt,'{"generated":true}');
});

test('capability storage installation keeps the caller transaction and can reopen after its rollback',t=>{
 const f=fixture(t),db=f.store.db,before=f.schema();
 db.exec('BEGIN IMMEDIATE');f.open();assert.equal(db.isTransaction,true);
 db.prepare('INSERT INTO action_capability_commands VALUES(?,?,?)').run('generated-rolled-back','generated-fingerprint','{"generated":true}');
 db.exec('ROLLBACK');assert.deepEqual(f.schema(),before,'outer rollback removes this installation and its storage triggers');
 f.open();assert.equal(db.isTransaction,false);
 assert.equal(db.prepare('SELECT count(*) n FROM action_capability_commands').get()?.n,0,'a retried installation does not recover rolled-back command receipts');
 db.prepare('INSERT INTO action_capability_commands VALUES(?,?,?)').run('generated-retained','generated-fingerprint','{"generated":true}');
 f.open();assert.equal(db.prepare('SELECT count(*) n FROM action_capability_commands').get()?.n,1);
});
