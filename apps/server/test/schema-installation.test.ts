import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {installVaultSchema,vaultSchemaInstallations} from '../src/vault-schema-installation.js';
import {StoreDatabase} from '../src/sqlite-database.js';
import {StoreError} from '../src/evidence-store.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
function incompatibleCatalog(db:DatabaseSync){
 db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  INSERT INTO settings VALUES('backend_epoch','7'),('generated-fixture','retained');
  CREATE TABLE source_catalog(marker TEXT PRIMARY KEY);
  INSERT INTO source_catalog VALUES('retained');`);
}
function retainedData(db:DatabaseSync){
 assert.equal(db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'7');
 assert.equal(db.prepare("SELECT value FROM settings WHERE key='generated-fixture'").get()?.value,'retained');
 assert.equal(db.prepare('SELECT marker FROM source_catalog').get()?.marker,'retained');
}

test('the complete core plan rejects reversed, missing and duplicate owners before invoking any installer',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  incompatibleCatalog(db);const before=schema(db);
  const invalid:Array<{plan:readonly SchemaInstallation[];error:RegExp}>=[
   {plan:[...vaultSchemaInstallations].reverse(),error:/source-catalog schema requires capture first/},
   {plan:vaultSchemaInstallations.filter(item=>item.owner!=='capture'),error:/perception schema requires missing owner capture/},
   {plan:[...vaultSchemaInstallations,vaultSchemaInstallations[0]],error:/Duplicate schema owner: vault/},
   {plan:[{owner:'generated-cycle',requires:['generated-cycle'],install:()=>assert.fail('Self dependency was installed')}],error:/generated-cycle schema requires generated-cycle first/},
  ];
  for(const {plan,error} of invalid){
   let invoked=false;
   const probe:SchemaInstallation={owner:'generated-probe',requires:[],install:()=>{invoked=true;db.exec('CREATE TABLE generated_half_install(id TEXT)');}};
   assert.throws(()=>installSchemaPlan(db,[probe,...plan]),error);
   assert.equal(invoked,false,'Preflight must check the final owner before running the first installer');
   assert.equal(db.isTransaction,false);assert.deepEqual(schema(db),before);retainedData(db);
  }
 }finally{db.close();}
});

test('a native failure in the final core owner rolls back earlier DDL and seed rows and permits retry',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  incompatibleCatalog(db);const before=schema(db);
  assert.throws(()=>installVaultSchema(db),/no such column: source_id/);
  assert.equal(db.isTransaction,false);assert.deepEqual(schema(db),before);retainedData(db);
  db.exec('DROP TABLE source_catalog');
  installVaultSchema(db);
  assert.equal(db.isTransaction,false);
  assert.equal(db.prepare('SELECT n FROM blob_counts WHERE id=1').get()?.n,0,'The rolled back read-model seed must be installed on retry');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_catalog_directory'").get());
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'7');
  const installed=schema(db);installVaultSchema(db);assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});

test('failed core installation rolls back only its savepoint and leaves the caller transaction usable',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  incompatibleCatalog(db);db.exec("BEGIN; CREATE TABLE generated_outer(id TEXT PRIMARY KEY); INSERT INTO generated_outer VALUES('before')");
  const before=schema(db);
  assert.throws(()=>installVaultSchema(db),/no such column: source_id/);
  assert.equal(db.isTransaction,true);assert.deepEqual(schema(db),before);retainedData(db);
  db.exec("INSERT INTO generated_outer VALUES('after'); COMMIT");
  assert.equal(db.prepare('SELECT count(*) n FROM generated_outer').get()?.n,2);
 }finally{db.close();}
});

test('an outer rollback removes a successful core installation and the next call installs it again',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("CREATE TABLE generated_existing(id TEXT); INSERT INTO generated_existing VALUES('retained')");
  const before=schema(db);
  db.exec('BEGIN');installVaultSchema(db);
  assert.equal(db.isTransaction,true);assert.ok(db.prepare('SELECT n FROM blob_counts WHERE id=1').get());
  db.exec('ROLLBACK');assert.deepEqual(schema(db),before);
  installVaultSchema(db);
  assert.ok(db.prepare('SELECT n FROM blob_counts WHERE id=1').get());
  assert.equal(db.prepare('SELECT id FROM generated_existing').get()?.id,'retained');
  assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

for(const nested of [false,true])test(`SQLite FULL preserves the original 507 error after automatic ${nested?'outer transaction':'transaction'} rollback`,()=>{
 const db=new StoreDatabase(':memory:');
 try{
  db.exec("CREATE TABLE generated_existing(value TEXT); INSERT INTO generated_existing VALUES('retained')");
  const before=schema(db),pages=Number(db.prepare('PRAGMA page_count').get()?.page_count),maximum=Number(db.prepare('PRAGMA max_page_count').get()?.max_page_count);
  db.exec(`PRAGMA max_page_count=${pages+8}`);
  if(nested)db.exec('BEGIN');
  let bytes=1_048_576,original:unknown;
  const plan:readonly SchemaInstallation[]=[
   {owner:'generated-first',requires:[],install:db=>db.exec("CREATE TABLE generated_seed(id TEXT); INSERT INTO generated_seed VALUES('seed'); UPDATE generated_existing SET value='uncommitted'")},
   {owner:'generated-full',requires:['generated-first'],install:db=>{
    db.exec('CREATE TABLE generated_payload(value BLOB)');
    try{db.prepare('INSERT INTO generated_payload VALUES(zeroblob(?))').run(bytes);}catch(error){original=error;throw error;}
   }},
  ];
  assert.throws(()=>installSchemaPlan(db,plan),error=>{
   assert.equal(error,original);assert.ok(error instanceof StoreError);assert.equal(error.statusCode,507);
   assert.equal((error.cause as {errcode:number}).errcode&255,13);return true;
  });
  assert.equal(db.isTransaction,false,'SQLite FULL must have automatically aborted the transaction');
  assert.deepEqual(schema(db),before);assert.equal(db.prepare('SELECT value FROM generated_existing').get()?.value,'retained');
  db.exec(`PRAGMA max_page_count=${maximum}`);bytes=16;
  installSchemaPlan(db,plan);
  assert.equal(db.prepare('SELECT length(value) bytes FROM generated_payload').get()?.bytes,16);
  assert.equal(db.isTransaction,false);
 }finally{db.close();}
});
