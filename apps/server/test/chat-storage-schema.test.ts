import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {TaskRecords} from '../src/task-records.js';
import {Conversations} from '../src/conversations.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {conversationTurnsSchemaInstallation,queryRunSchemaInstallation,assistantTaskStorageSchemaInstallation} from '../src/chat-storage-schema.js';

function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-chat-storage-schema-')),store=new Store(directory);let engine:ExecutionEngine|undefined;
 t.after(async()=>{await engine?.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const schema=()=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 return {store,schema,parents(){engine=new ExecutionEngine(store);new TaskRecords(store);return {engine,conversations:new Conversations(store)};}};
}

test('chat storage stages check real parents before DDL and roll back a native late failure for same-handle retry',t=>{
 const f=fixture(t),db=f.store.db,before=f.schema();
 assert.throws(()=>installSchemaPlan(db,[assistantTaskStorageSchemaInstallation]),/assistant-task-storage schema requires conversation-turn-storage object\(s\): table:conversation_turns/);
 assert.deepEqual(f.schema(),before,'missing owners cannot leave the first child table');
 const {engine,conversations}=f.parents(),conversation=conversations.create(),message=conversations.receive({conversationId:conversation.id,question:'Generated stored owner text'});
 db.exec('CREATE TABLE generated_chat_schema_probe(id TEXT); CREATE INDEX assistant_task_turns ON generated_chat_schema_probe(id)');const parents=f.schema();
 assert.throws(()=>installSchemaPlan(db,[assistantTaskStorageSchemaInstallation]),error=>error instanceof Error&&!(error instanceof AggregateError)&&error.message.includes('assistant_task_turns'));
 assert.deepEqual(f.schema(),parents,'both child tables roll back while the real parent owners remain intact');assert.equal(engine.closed,false);assert.equal(db.isTransaction,false);
 db.exec('DROP INDEX assistant_task_turns');installSchemaPlan(db,[assistantTaskStorageSchemaInstallation,queryRunSchemaInstallation]);
 const installed=f.schema();installSchemaPlan(db,[assistantTaskStorageSchemaInstallation,queryRunSchemaInstallation,conversationTurnsSchemaInstallation]);assert.deepEqual(f.schema(),installed);
 assert.equal(conversations.message(message.id).question,'Generated stored owner text');assert.equal(conversations.message(message.id).status,'accepted');assert.equal(engine.closed,false);
});

test('conversation and query storage plans preserve an outer transaction and retry without cached installation state',t=>{
 const f=fixture(t),db=f.store.db,before=f.schema(),plan=[conversationTurnsSchemaInstallation,queryRunSchemaInstallation];
 db.exec('BEGIN IMMEDIATE');installSchemaPlan(db,plan);assert.equal(db.isTransaction,true);
 db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run('generated-rollback','generated-hash','{"generated":true}');
 db.exec('ROLLBACK');assert.deepEqual(f.schema(),before);
 installSchemaPlan(db,plan);assert.equal(db.isTransaction,false);assert.equal(db.prepare('SELECT count(*) n FROM query_runs').get()?.n,0);
 db.prepare('INSERT INTO query_runs VALUES(?,?,?)').run('generated-retained','generated-hash','{"generated":true}');installSchemaPlan(db,plan);
 assert.equal(db.prepare('SELECT json FROM query_runs WHERE id=?').get('generated-retained')?.json,'{"generated":true}');
});
