import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSchemaPlan} from '../src/schema-installation.js';
import {sourceArchiveSchemaInstallation,sourceContextSchemaInstallation,sourcePipelineSchemaInstallation} from '../src/source-state-schema.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {SourceArchive} from '../src/source-archive.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {testScope} from './fixtures/plugin-scope.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const prerequisites=(db:DatabaseSync)=>db.exec('CREATE TABLE source_connections(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
const installations=[
 {installation:sourceArchiveSchemaInstallation,last:'source_archive_recovery_groups',first:'source_archive_sizes'},
 {installation:sourceContextSchemaInstallation,last:'source_context_declarations',first:'source_context_declarations'},
 {installation:sourcePipelineSchemaInstallation,last:'source_pipeline_config',first:'source_pipeline_bindings'},
];

test('source context checks its actual source parent before any installation; independent source owners activate alone',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  let entered=false;
  const prefix={owner:'generated-prefix',requires:[],install:(db:DatabaseSync)=>{entered=true;db.exec('CREATE TABLE generated_partial(value)');}};
  assert.throws(()=>installSchemaPlan(db,[prefix,sourceContextSchemaInstallation]),/source-context schema requires source object\(s\): table:source_connections/);
  assert.equal(entered,false);assert.deepEqual(schema(db),[]);
  db.exec("CREATE VIEW source_connections AS SELECT 'generated' id");const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,[prefix,sourceContextSchemaInstallation]),/table:source_connections/);assert.deepEqual(schema(db),before);assert.equal(entered,false);
  db.exec('DROP VIEW source_connections; BEGIN');prerequisites(db);installSchemaPlan(db,[sourceContextSchemaInstallation]);db.exec('ROLLBACK');
  assert.deepEqual(schema(db),[]);assert.throws(()=>installSchemaPlan(db,[sourceContextSchemaInstallation]),/table:source_connections/);
  installSchemaPlan(db,[sourceArchiveSchemaInstallation]);assert.ok(exists(db,'source_archive_heads'));assert.equal(exists(db,'source_connections'),false);assert.equal(exists(db,'asset_references'),false);
  assert.equal(exists(db,'source_pipeline_work'),false);installSchemaPlan(db,[sourcePipelineSchemaInstallation]);assert.ok(exists(db,'source_pipeline_work'));
  assert.equal(exists(db,'source_context_declarations'),false);
  for(const name of ['captures','material_heads','memory_input_authorizations','settings'])assert.equal(exists(db,name),false);
 }finally{db.close();}
});

for(const {installation,last,first} of installations)for(const nested of [false,true])test(`native final DDL failure rolls back ${installation.owner}${nested?' while preserving caller transaction and savepoint':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON');prerequisites(db);
  db.exec(`CREATE TABLE generated_outer(value TEXT); CREATE INDEX ${last} ON generated_outer(value)`);
  if(nested)db.exec("BEGIN; INSERT INTO generated_outer VALUES('before'); SAVEPOINT generated_caller");
  const before=schema(db),plan=[{owner:'generated-prefix',requires:[],install:(db:DatabaseSync)=>db.exec('CREATE TABLE generated_partial(value)')},installation];
  assert.throws(()=>installSchemaPlan(db,plan),new RegExp('there is already an index named '+last));
  assert.deepEqual(schema(db),before);assert.equal(exists(db,first),false);assert.equal(db.isTransaction,nested);
  if(nested){
   db.exec("INSERT INTO generated_outer VALUES('after'); ROLLBACK TO generated_caller; RELEASE generated_caller");
   assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);
  }
  db.exec(`DROP INDEX ${last}`);installSchemaPlan(db,plan);assert.ok(exists(db,first));assert.ok(exists(db,last));assert.equal(db.isTransaction,nested);
  if(nested){
   db.exec('ROLLBACK');assert.equal(exists(db,first),false);assert.equal(exists(db,'generated_partial'),false);
   assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(last));
   db.exec(`DROP INDEX ${last}`);installSchemaPlan(db,plan);assert.ok(exists(db,first));assert.equal(db.isTransaction,false);
  }
  const installed=schema(db);installSchemaPlan(db,[installation]);assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});

test('source constructors retain activation boundaries without installing pipeline state early',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-state-boundary-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(exists(store.db,'source_archive_sizes'),false);assert.equal(exists(store.db,'source_context_declarations'),false);assert.equal(exists(store.db,'source_pipeline_work'),false);
 new SourceStore(store);assert.ok(exists(store.db,'source_context_declarations'));assert.equal(exists(store.db,'source_archive_sizes'),false);
 new SourceArchive(store);assert.ok(exists(store.db,'source_archive_sizes'));assert.equal(exists(store.db,'source_pipeline_work'),false);
});

test('source intake archive and pending Material publication survive scope withdrawal and restart under their accepted identity',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-source-state-restart-'));
 let store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],testScope(t));await runtime.ready;
 t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
 let sources=new SourceStore(store,runtime);
 sources.register({id:'generated-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos',retention:'archive'});
 const context=sources.updateContext('generated-coding',{expectedVersion:0,description:'Generated owner source context'});
 const item={externalId:'generated-event',revision:'1',observedAt:'2026-11-17T00:00:00.000Z',kind:'message',layer:'snapshot',text:'Generated restart intake.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:'generated-event',role:'user',attribution:'human',part:0,parts:1}}};
 const scope=sources.getSource('generated-coding').syncScopeVersion??0,receipt=await sources.upsert('generated-coding',item);
 const version=String(store.db.prepare('SELECT version_key FROM source_archive_versions').get()!.version_key),work=store.db.prepare('SELECT * FROM source_pipeline_work').get()!;
 assert.equal(runtime.archive.readVersion('generated-coding',version)?.text,item.text);assert.equal(materials.list().items.length,0);
 sources.resetCoverage('generated-coding');assert.throws(()=>sources.assertSyncScope('generated-coding',scope),{statusCode:409});
 await runtime.close();store.close();store=new Store(directory);materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin],testScope(t));await runtime.ready;sources=new SourceStore(store,runtime);
 assert.equal(sources.contexts.current('generated-coding').fingerprint,context.fingerprint);assert.throws(()=>sources.assertSyncScope('generated-coding',scope),{statusCode:409});
 assert.equal(runtime.archive.readVersion('generated-coding',version)?.text,item.text);assert.equal(store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint,work.archive_checkpoint);
 await runtime.tick();const material=materials.list().items[0];assert.ok(material);assert.match(materials.read(material.ref).text,/Generated restart intake/);
 assert.equal((await sources.upsert('generated-coding',item)).id,receipt.id);assert.equal(store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,1);
});
