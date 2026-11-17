import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {StoreDatabase} from '../src/sqlite-database.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {storageLedgerSchemaInstallation} from '../src/storage-ledger.js';
import {vaultSchemaInstallations,vaultStorageLedgerInstallations} from '../src/vault-schema-installation.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

test('Vault ledger DDL is a declared second stage and the real Store keeps its original meter lifecycle',async t=>{
  assert.deepEqual(vaultStorageLedgerInstallations,[storageLedgerSchemaInstallation]);
  assert.equal(vaultSchemaInstallations.some(item=>item===storageLedgerSchemaInstallation),false,'the core Vault stage must not install the ledger early');
  const directory=mkdtempSync(join(tmpdir(),'mote-ledger-stage-'));
  const store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const db=store.db;
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_ledger'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_ledger_meters'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='ledger_captures_insert'").get());
  const before=store.logicalBytes();
  const id=randomUUID();
  await store.ingest({id,deviceId:'generated-ledger',deviceName:'Generated ledger',platform:'import',capturedAt:new Date().toISOString(),source:'note',durationMs:0,ocrText:'Generated ledger row'});
  assert.ok(store.logicalBytes()>before,'the real Store still meters the committed capture');
  assert.ok(Number(db.prepare("SELECT bytes FROM storage_ledger WHERE name='captures'").get()!.bytes)>0);
});

test('a failed post-ledger stage rolls back its outer savepoint and the same handle retries the Vault ledger stage',()=>{
  const db=new StoreDatabase(':memory:');
  try{
    const before=schema(db);
    db.exec('BEGIN');
    assert.throws(()=>installSchemaPlan(db,[storageLedgerSchemaInstallation,{
      owner:'generated-fail',requires:[],
      install:handle=>{handle.exec('CREATE TABLE generated_half_install(id TEXT)');throw Error('generated ledger tail failure');},
    }]),/generated ledger tail failure/);
    assert.equal(db.isTransaction,true,'the caller transaction remains usable');
    assert.deepEqual(schema(db),before,'the failed stage rolls back its savepoint, including the ledger tables');
    installSchemaPlan(db,[storageLedgerSchemaInstallation]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_ledger'").get());
    db.exec('COMMIT');
    assert.equal(db.isTransaction,false);
  }finally{db.close();}
});
