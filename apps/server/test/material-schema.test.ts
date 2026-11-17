import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {materialSchemaInstallation} from '../src/material-schema.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {buildApp} from '../src/app.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
const prerequisites=(db:DatabaseSync)=>db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY); CREATE TABLE asset_references(owner TEXT PRIMARY KEY,hash TEXT NOT NULL)');

test('Material checks actual external owner objects before any installer without activating other domains',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  let invoked=false;
  const plan=[{owner:'generated-first',requires:[],install:()=>{invoked=true;db.exec('CREATE TABLE generated_partial(id TEXT)');}},materialSchemaInstallation];
  assert.throws(()=>installSchemaPlan(db,[{...materialSchemaInstallation,prerequisites:[{owner:'capture',objects:[]}]}]),/material schema prerequisite capture has no objects/);
  assert.throws(()=>installSchemaPlan(db,plan),/material schema requires capture object\(s\): table:captures/);
  assert.equal(invoked,false);assert.deepEqual(schema(db),[]);assert.equal(db.isTransaction,false);
  db.exec("CREATE VIEW captures AS SELECT 'generated' id");
  const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,plan),/table:captures/,'A view with the same name is not a ready capture table');
  assert.deepEqual(schema(db),before);assert.equal(invoked,false);
  db.exec('DROP VIEW captures; CREATE TABLE captures(id TEXT PRIMARY KEY)');
  assert.throws(()=>installSchemaPlan(db,plan),/material schema requires assets object\(s\): table:asset_references/);
  assert.equal(invoked,false);
  db.exec('CREATE TABLE asset_references(owner TEXT PRIMARY KEY,hash TEXT NOT NULL)');
  installSchemaPlan(db,[materialSchemaInstallation]);
  assert.ok(exists(db,'material_heads'));assert.ok(exists(db,'material_fts'));assert.ok(exists(db,'material_index_requests'));
  for(const name of ['settings','memories','execution_steps','material_organizer_inputs','material_memory_requests','material_catalog_generation'])
   assert.equal(exists(db,name),false,`${name} must retain its own activation time`);
 }finally{db.close();}
});

test('rolled-back prerequisite objects cannot authorize the next Material installation',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('BEGIN');prerequisites(db);installSchemaPlan(db,[materialSchemaInstallation]);
  assert.equal(db.isTransaction,true);assert.ok(exists(db,'material_heads'));
  db.exec('ROLLBACK');assert.deepEqual(schema(db),[]);
  assert.throws(()=>installSchemaPlan(db,[materialSchemaInstallation]),/requires capture object/);
  assert.deepEqual(schema(db),[]);prerequisites(db);installSchemaPlan(db,[materialSchemaInstallation]);
  assert.ok(exists(db,'material_heads'));assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

for(const nested of [false,true])test(`native failure in Material's final SQL restores all prior schema/data${nested?' and preserves the outer transaction':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  prerequisites(db);
  db.exec("CREATE TABLE material_index_requests(marker TEXT PRIMARY KEY); INSERT INTO material_index_requests VALUES('retained'); CREATE TABLE generated_outer(value TEXT)");
  if(nested)db.exec("BEGIN; INSERT INTO generated_outer VALUES('before')");
  const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,[materialSchemaInstallation]),/material_index_requests has 1 columns but 6 values were supplied/);
  assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT marker FROM material_index_requests').get()?.marker,'retained');
  assert.equal(db.isTransaction,nested);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");assert.equal(db.prepare('SELECT count(*) n FROM generated_outer').get()?.n,2);}
  db.exec('DROP TABLE material_index_requests');installSchemaPlan(db,[materialSchemaInstallation]);
  assert.ok(exists(db,'material_block_asset_insert'));assert.ok(exists(db,'material_capture_delete'));
  assert.equal(db.prepare('SELECT count(*) n FROM material_index_requests').get()?.n,0);
  const installed=schema(db);installSchemaPlan(db,[materialSchemaInstallation]);assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});

for(const nested of [false,true])test(`lazy catalog SQL failure rolls back its table and seed${nested?' within a savepoint':''} and the same handle retries`,t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-material-catalog-schema-')),store=new Store(directory),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(exists(store.db,'material_catalog_generation'),false);
 store.db.exec("CREATE TABLE material_catalog_order(marker TEXT PRIMARY KEY); INSERT INTO material_catalog_order VALUES('retained'); CREATE TABLE generated_outer(value TEXT)");
 if(nested)store.db.exec("BEGIN; INSERT INTO generated_outer VALUES('before')");
 const before=schema(store.db);
 assert.throws(()=>materials.catalog.generation(),/already a table named material_catalog_order/);
 assert.deepEqual(schema(store.db),before);assert.equal(store.db.prepare('SELECT marker FROM material_catalog_order').get()?.marker,'retained');
 assert.equal(store.db.isTransaction,nested);assert.equal(exists(store.db,'material_catalog_generation'),false);
 if(nested){store.db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");assert.equal(store.db.prepare('SELECT count(*) n FROM generated_outer').get()?.n,2);}
 store.db.exec('DROP TABLE material_catalog_order');assert.equal(materials.catalog.generation(),'0');
 assert.ok(exists(store.db,'material_catalog_delete'));assert.equal(store.db.isTransaction,false);
});

test('lazy catalog remains absent until first use and recovers after that successful first use is rolled back',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-material-catalog-rollback-')),store=new Store(directory),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const before=schema(store.db);assert.equal(exists(store.db,'material_catalog_generation'),false);
 store.db.exec('BEGIN');assert.equal(materials.catalog.generation(),'0');assert.equal(store.db.isTransaction,true);
 store.db.exec('ROLLBACK');assert.deepEqual(schema(store.db),before);
 assert.equal(materials.catalog.generation(),'0');assert.ok(exists(store.db,'material_catalog_insert'));
 assert.equal(store.db.prepare('SELECT count(*) n FROM material_catalog_generation').get()?.n,1);
 const installed=schema(store.db);assert.equal(materials.catalog.generation(),'0');assert.deepEqual(schema(store.db),installed);
});

test('default Host produces current Material evidence from a real source revision and preserves exact reads after restart',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-material-schema-host-')),token='generated-material-schema-owner';
 const config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const dependencies={backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Generated Material schema fixtures never query a model');},close:async()=>{}}};
 let node=await buildApp(config,dependencies);
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 await node.app.ready();assert.equal(exists(node.store.db,'material_catalog_generation'),false);
 const headers={authorization:'Bearer '+token},sourceId='generated-schema-source',externalId='generated-schema-item';
 node.sources.register({id:sourceId,name:'Generated schema source',kind:'custom',deviceId:'generated-schema-device',platform:'import',retention:'archive'});
 const input=(revision:string,text:string)=>({externalId,revision,observedAt:'2026-11-17T00:00:00.000Z',kind:'message',layer:'original',text});
 await node.sources.upsert(sourceId,input('1','Generated first schema statement'));await node.materialOrganizer.tick(20);
 const id=materialId(sourceId,externalId),first=node.materials.get(id);assert.ok(first);
 assert.match(node.materials.read(first.ref).text,/Generated first schema statement/);
 const capture=await node.sources.upsert(sourceId,input('2','Generated current schema statement'));await node.materialOrganizer.tick(20);
 const current=node.materials.get(id);assert.ok(current);assert.notEqual(current.revision,first.revision);
 const anchors=node.materials.evidenceIds(current.ref);assert.ok(anchors.length>0);assert.ok(anchors.every(anchor=>node.materials.isCurrentEvidence(anchor)));
 const get=async(url:string)=>{const response=await node.app.inject({url,headers});assert.equal(response.statusCode,200,response.body);return response.json();};
 assert.deepEqual((await get('/api/materials/'+id)).memorySource,{status:'ready',evidenceIds:anchors});
 assert.equal((await get(`/api/materials/${id}/revisions/${first.revision}`)).memorySource,undefined);
 const read=await get(`/api/materials/${id}/read?length=4000`);assert.equal(read.material.ref,current.ref);assert.match(read.text,/Generated current schema statement/);
 await get('/api/library/catalog?limit=1');assert.ok(exists(node.store.db,'material_catalog_generation'));
 await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();
 assert.equal(node.materials.get(id)?.ref,current.ref);assert.deepEqual(node.materials.evidenceIds(current.ref),anchors);
 assert.equal((await get(`/api/materials/${id}/read?length=4000`)).text,read.text);
 assert.deepEqual((await get('/api/materials/'+id)).memorySource,{status:'ready',evidenceIds:anchors});
 node.store.delete(capture.id);assert.equal(node.materials.get(id),undefined);
 assert.deepEqual(node.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
