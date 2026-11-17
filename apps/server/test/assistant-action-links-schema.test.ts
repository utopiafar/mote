import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {TodoStore} from '../src/todos.js';
import {createAssistantActions} from '../src/assistant-actions.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {actionsSchemaInstallation} from '../src/actions-schema.js';

function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-link-schema-')),store=new Store(directory),todos=new TodoStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const inactive=new Proxy({},{get(){throw Error('Link installation must not activate a runtime port');}});
 type Args=Parameters<typeof createAssistantActions>;
 const open=()=>createAssistantActions(store,inactive as Args[1],inactive as Args[2],todos,inactive as Args[4]);
 const schema=()=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 return {store,open,schema,parents(){new FileStore(store,new SourceStore(store));installSchemaPlan(store.db,[actionsSchemaInstallation]);}};
}

test('assistant Action links check their existing owners and roll back a native late DDL failure before retry',t=>{
 const f=fixture(t),db=f.store.db,before=f.schema();
 assert.throws(f.open,/actions schema requires actions object\(s\): table:action_proposals/);assert.deepEqual(f.schema(),before);
 f.parents();db.exec('CREATE TABLE assistant_action_links_matter(id TEXT)');const parents=f.schema();
 assert.throws(f.open,error=>error instanceof Error&&!(error instanceof AggregateError)&&error.message.includes('assistant_action_links_matter'));
 assert.deepEqual(f.schema(),parents,'a failed index must roll back the earlier link table without changing its parent owners');assert.equal(db.isTransaction,false);
 assert.equal(db.prepare("SELECT 1 FROM storage_ledger_meters WHERE name='assistant_action_links'").get(),undefined);
 db.exec('DROP TABLE assistant_action_links_matter');f.open();const installed=f.schema();f.open();assert.deepEqual(f.schema(),installed);
 assert.equal(db.prepare("SELECT plugin FROM storage_ledger_meters WHERE name='assistant_action_links'").get()?.plugin,'assistant-action-links');
});

test('assistant Action links preserve the caller transaction and recreate their meter after an outer rollback',t=>{
 const f=fixture(t);f.parents();const db=f.store.db,before=f.schema();
 db.exec('BEGIN IMMEDIATE');f.open();f.store.logicalBytes();assert.equal(db.isTransaction,true);
 assert.ok(db.prepare("SELECT 1 FROM storage_ledger WHERE name='assistant_action_links'").get());
 db.exec('ROLLBACK');assert.deepEqual(f.schema(),before);
 assert.equal(db.prepare("SELECT 1 FROM storage_ledger_meters WHERE name='assistant_action_links'").get(),undefined);
 f.open();f.store.logicalBytes();const installed=f.schema();f.open();f.store.logicalBytes();assert.deepEqual(f.schema(),installed);
 assert.ok(db.prepare("SELECT 1 FROM storage_ledger WHERE name='assistant_action_links'").get());assert.equal(db.isTransaction,false);
});
