import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan} from '../src/schema-installation.js';
import {memorySearchSchemaInstallation} from '../src/memory-search-schema.js';
import {SourceStore} from '../src/sources.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {randomUUID} from 'node:crypto';
import {openMemoryDeletions} from '../src/plugins/memory-deletions.js';
const schema=(store:Store)=>store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
function fixture(t:TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-memory-schema-')),store=new Store(directory);t.after(()=>{if(store.db.isTransaction)store.db.exec('ROLLBACK');store.close();rmSync(directory,{recursive:true,force:true});});return store;}
test('a successful Memory construction rolled back by its caller can install again on the same Store',t=>{
 const store=fixture(t);store.db.exec('BEGIN');new MemoryStore(store);assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_catalog'").get());store.db.exec('ROLLBACK');
 new MemoryStore(store);assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_catalog'").get(),'outer rollback must not leave an in-memory installation receipt');
});

test('rolling back a caller savepoint allows repeated construction without consuming the outer transaction',t=>{
 const store=fixture(t);store.db.exec("CREATE TABLE generated_outer(value TEXT); BEGIN; INSERT INTO generated_outer VALUES('before'); SAVEPOINT generated_caller");
 new MemoryStore(store);store.db.exec('ROLLBACK TO generated_caller; RELEASE generated_caller');
 assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_catalog'").get(),undefined);
 new MemoryStore(store);assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_catalog'").get());assert.equal(store.db.isTransaction,true);
 store.db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");assert.equal(store.db.prepare('SELECT count(*) n FROM generated_outer').get()!.n,2);
});

test('all real external tables are checked before any Memory installer executes',()=>{
 const db=new DatabaseSync(':memory:');try{
  let writes=0;const plan=[{owner:'sentinel',requires:[],install:()=>{writes++;db.exec('CREATE TABLE should_not_exist(id)');}},memorySearchSchemaInstallation];
  for(const name of ['captures','memories','memory_dependencies','memory_provider_evidence_revocations']){
   assert.throws(()=>installSchemaPlan(db,plan),new RegExp('table:'+name));assert.equal(writes,0);
   const before=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
   assert.throws(()=>new MemoryStore({db} as Store),new RegExp('table:'+name));assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(),before);
   db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY,json TEXT,evidence_id TEXT,memory_id TEXT)`);
  }
  installSchemaPlan(db,[memorySearchSchemaInstallation]);assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_scopes'").get());
 }finally{db.close();}
});

test('Memory publication feeds real FTS, catalog and device scopes, then evidence edit and deletion fence consumers',async t=>{
 const store=fixture(t),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated Memory schema source',kind:'custom',deviceId:'generated',platform:'import'});
 const ack=await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated transaction preference for schema search'});
 const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated transaction preference',statement:`Generated preference [${ack.id}]`,uncertainty:'Fixture only',evidenceIds:[ack.id]}]}),citations:[{id:ack.id,capturedAt:'2026-01-01T00:00:00Z',appName:'Fixture',excerpt:''}],trace:[],runId:randomUUID()});
 const saved=memories.extract(result,'fixture').items[0],published=memories.publish(saved.id);
 assert.equal(published.status,'published');assert.deepEqual(memories.page({query:'transaction',deviceId:'generated',status:'published'}).items.map(m=>m.id),[saved.id]);
 assert.equal(memories.page({deviceId:'other'}).items.length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_scopes WHERE memory_id=?').get(saved.id)!.n,1);
 new MemoryStore(store);
 store.db.prepare("UPDATE captures SET json=json_set(json,'$.ocrText','Generated edited evidence') WHERE id=?").run(ack.id);
 assert.equal(memories.page({query:'transaction'}).items.length,0);assert.equal(memories.get(saved.id).status,'stale');
 store.delete(ack.id);assert.throws(()=>memories.get(saved.id),{statusCode:404});
 for(const table of ['memories_fts','memory_catalog','memory_scopes'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0);
 const before=schema(store);new MemoryStore(store);assert.deepEqual(schema(store),before);
});
for(const nested of [false,true])test(`native catalog failure rolls back the whole Memory owner${nested?' and preserves caller transaction':''}`,t=>{
 const store=fixture(t);store.db.exec("CREATE VIEW memory_catalog AS SELECT 'retained' marker; CREATE TABLE generated_outer(value TEXT)");if(nested)store.db.exec("BEGIN; INSERT INTO generated_outer VALUES('before')");const before=schema(store);
 assert.throws(()=>new MemoryStore(store),/views may not be indexed/);assert.deepEqual(schema(store),before,'failed catalog must not retain FTS, triggers or partial owner objects');assert.equal(store.db.isTransaction,nested);
 if(nested){store.db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");assert.equal(store.db.prepare('SELECT count(*) n FROM generated_outer').get()!.n,2);}
 store.db.exec('DROP VIEW memory_catalog');new MemoryStore(store);assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_catalog'").get());
});

for(const nested of [false,true])test(`a failed Memory activation preserves pre-existing C24 schema and data${nested?' inside the caller transaction':''}`,t=>{
 const store=fixture(t);openMemoryDeletions(store,{records:{read:()=>[]}});
 store.db.prepare('INSERT INTO memory_deletions VALUES(?,?)').run('generated-retained','{"generated":"retained"}');
 store.db.exec("CREATE VIEW memory_catalog AS SELECT 'retained' marker; CREATE TABLE generated_outer(value TEXT)");
 if(nested)store.db.exec("BEGIN; INSERT INTO generated_outer VALUES('before')");
 const before=schema(store),data=store.db.prepare('SELECT * FROM memory_deletions').all();
 assert.throws(()=>new MemoryStore(store),/views may not be indexed/);assert.deepEqual(schema(store),before);assert.deepEqual(store.db.prepare('SELECT * FROM memory_deletions').all(),data);assert.equal(store.db.isTransaction,nested);
 if(nested){store.db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");assert.equal(store.db.prepare('SELECT count(*) n FROM generated_outer').get()!.n,2);}
 store.db.exec('DROP VIEW memory_catalog');new MemoryStore(store);assert.deepEqual(store.db.prepare('SELECT * FROM memory_deletions').all(),data);
});
