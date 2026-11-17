import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {MemoryPhaseOutputs,memoryPhaseOutputsSchemaInstallation} from '../src/memory-phase-outputs.js';
import {MemoryExtractionDrafts,memoryExtractionDraftsSchemaInstallation} from '../src/memory-extraction-drafts.js';
import {MemoryInputAuthorization,memoryInputAuthorizationSchemaInstallation} from '../src/memory-input-authorization.js';
const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const entries=[{installation:memoryPhaseOutputsSchemaInstallation,table:'memory_phase_outputs',collision:'memory_phase_batch'}, {installation:memoryExtractionDraftsSchemaInstallation,table:'memory_extraction_drafts',collision:'memory_drafts_shared'}, {installation:memoryInputAuthorizationSchemaInstallation,table:'memory_input_authorizations',collision:'memory_input_authorizations_capture'}] as const;

test('Memory state owners reject missing real prerequisite objects before their own DDL',()=>{
 const db=new DatabaseSync(':memory:');try{for(const entry of entries){assert.throws(()=>installSchemaPlan(db,[entry.installation]),new RegExp(entry.installation.owner+' schema requires'));assert.deepEqual(schema(db),[]);assert.equal(db.isTransaction,false);}}finally{db.close();}
});

for(const entry of entries)test(`${entry.installation.owner} late index failure preserves caller data and retries its real installer`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-state-schema-')),store=new Store(directory),engine=new ExecutionEngine(store);
 try{
  store.db.exec(`CREATE TABLE ${entry.collision}(marker TEXT PRIMARY KEY); INSERT INTO ${entry.collision} VALUES('retained'); BEGIN; SAVEPOINT generated_caller; INSERT INTO settings VALUES('generated-before','retained')`);
  const before=schema(store.db);
  const construct=()=>entry.table==='memory_phase_outputs'?new MemoryPhaseOutputs(store,engine):entry.table==='memory_extraction_drafts'?new MemoryExtractionDrafts(store):new MemoryInputAuthorization(store);
  assert.throws(construct,/already a table named/);assert.deepEqual(schema(store.db),before);assert.equal(store.db.isTransaction,true);
  assert.equal(store.db.prepare(`SELECT marker FROM ${entry.collision}`).get()?.marker,'retained');
  assert.equal(store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(entry.table),undefined);
  store.db.exec("INSERT INTO settings VALUES('generated-after','usable'); RELEASE generated_caller; COMMIT");assert.equal(store.db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'generated-%'").get()?.n,2);
  store.db.exec(`DROP TABLE ${entry.collision}`);construct();assert.ok(store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(entry.table));
  for(const other of entries)if(other!==entry)assert.equal(store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(other.table),undefined,'A state installer must not activate its sibling');
 }finally{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('outer rollback permits original Memory state handles to consume real reinstalled tables and revoke their own grant',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-state-retry-')),store=new Store(directory),engine=new ExecutionEngine(store),sources=new SourceStore(store);
 try{
  sources.register({id:'generated-memory-state',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
  const capture=await sources.upsert('generated-memory-state',{externalId:'one',revision:'1',observedAt:'2026-11-17T00:00:00Z',kind:'message',layer:'original',text:'Generated authorized input'});
  const before=schema(store.db);store.db.exec('BEGIN');
  const phase=new MemoryPhaseOutputs(store,engine),draft=new MemoryExtractionDrafts(store),authorization=new MemoryInputAuthorization(store,()=>true);
  store.db.exec('ROLLBACK');assert.deepEqual(schema(store.db),before);
  for(const entry of entries)installSchemaPlan(store.db,[entry.installation]);
  assert.equal(phase.read('generated-absent','generated-input'),undefined);assert.equal(draft.get('generated-absent','generated-input'),undefined);
  store.db.exec('BEGIN');authorization.receive({sourceId:'generated-memory-state',inputKey:'one',captureId:capture.id});store.db.exec('COMMIT');
  store.db.exec('BEGIN');assert.equal(authorization.claim('generated-memory-state','one','generated-job'),true);store.db.exec('COMMIT');
  authorization.assertClaimed({sourceId:'generated-memory-state',inputKey:'one',scope:'memory.default'},'generated-job');
  authorization.forgetSource('generated-memory-state');assert.throws(()=>authorization.assertClaimed({sourceId:'generated-memory-state',inputKey:'one',scope:'memory.default'},'generated-job'),/unavailable/);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'7');assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
