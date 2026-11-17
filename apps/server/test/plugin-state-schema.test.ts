import {testPluginControl} from './fixtures/plugin-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {type PluginControlStore} from '../src/plugins/plugin-control-store.js';
import {pluginControlSchemaInstallation} from '../src/plugin-control-storage.js';
import {installInstanceStateSchema,instanceStateSchemaInstallation} from '../src/plugin-instance-state-storage.js';
const schema=(store:Store)=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(store:Store,name:string)=>Boolean(store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name));
function fixture(t:{after:(fn:()=>void)=>void}){const directory=mkdtempSync(join(tmpdir(),'mote-plugin-state-schema-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}

test('plugin control and instance state keep independent installation closures',t=>{
 const store=fixture(t);installSchemaPlan(store.db,[instanceStateSchemaInstallation]);
 assert.ok(exists(store,'plugin_instance_state'));assert.equal(exists(store,'plugin_center'),false);
 store.db.exec('DROP TABLE plugin_instance_state');testPluginControl(store);
 assert.equal(exists(store,'plugin_instance_state'),false);
 assert.equal(store.db.prepare('SELECT revision FROM plugin_center WHERE id=1').get()?.revision,1);
 installInstanceStateSchema(store);const installed=schema(store);testPluginControl(store);installInstanceStateSchema(store);assert.deepEqual(schema(store),installed);
});

for(const nested of [false,true])test(`real control seed failure preserves inputs and retries${nested?' inside the caller transaction':''}`,t=>{
 const store=fixture(t);store.db.exec("CREATE TABLE plugin_center(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); CREATE TRIGGER generated_seed_failure BEFORE INSERT ON plugin_center BEGIN SELECT RAISE(ABORT,'generated seed refusal'); END");
 if(nested)store.db.exec("BEGIN; SAVEPOINT generated_caller; INSERT INTO settings VALUES('generated-retained','before')");
 const before=schema(store);assert.throws(()=>testPluginControl(store),/generated seed refusal/);assert.deepEqual(schema(store),before);assert.equal(store.db.isTransaction,nested);
 assert.equal(store.db.prepare('SELECT count(*) n FROM plugin_center').get()?.n,0);assert.equal(exists(store,'plugin_commands'),false);
 if(nested){store.db.exec("INSERT INTO settings VALUES('generated-after','after'); RELEASE generated_caller; COMMIT");assert.equal(store.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'generated-%'").get()?.n,2);}
 store.db.exec('DROP TRIGGER generated_seed_failure');const control=testPluginControl(store);assert.equal(control.revision(),1);
});

test('late control DDL failure rolls back the seed and the earlier tables',t=>{
 const store=fixture(t);store.db.exec("CREATE INDEX plugin_build_instances ON settings(key)");
 const before=schema(store);assert.throws(()=>testPluginControl(store),/already an index named plugin_build_instances/i);assert.deepEqual(schema(store),before);assert.equal(exists(store,'plugin_center'),false);
 store.db.exec('DROP INDEX plugin_build_instances');testPluginControl(store);assert.ok(exists(store,'plugin_control_receipts'));
});

test('outer rollback permits both real entry points to reinstall without cached success',t=>{
 const store=fixture(t),before=schema(store);store.db.exec('BEGIN');testPluginControl(store);installInstanceStateSchema(store);const installed=schema(store);store.db.exec('ROLLBACK');assert.deepEqual(schema(store),before);
 const control=testPluginControl(store);installInstanceStateSchema(store);assert.equal(control.revision(),1);assert.ok(exists(store,'plugin_instance_state'));assert.deepEqual(schema(store),installed,'Ledger triggers must also reinstall after the outer rollback');
 assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'7');assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.ok(Number.isFinite(store.logicalBytes()));
});
