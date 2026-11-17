import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {assetSchemaInstallation,archivedFilesSchemaInstallation,evidenceMaterialLineageSchemaInstallation,assetCaptureReferencesInstallation,evidenceDependenciesWithoutMaterialsInstallation,evidenceDependenciesWithMaterialsInstallation} from '../src/asset-evidence-schema.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {installEvidenceDependencies} from '../src/evidence-dependencies.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const table=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const cases:Array<{installation:SchemaInstallation;setup:(db:DatabaseSync)=>void;fault:(db:DatabaseSync)=>void;repair:(db:DatabaseSync)=>void}>=[
 {installation:assetSchemaInstallation,setup:()=>{},fault:db=>db.exec('CREATE TABLE asset_pins_hash(marker)'),repair:db=>db.exec('DROP TABLE asset_pins_hash')},
 {installation:archivedFilesSchemaInstallation,setup:db=>db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)'),fault:db=>db.exec('CREATE INDEX capture_files ON generated_outer(value)'),repair:db=>db.exec('DROP INDEX capture_files')},
 {installation:evidenceMaterialLineageSchemaInstallation,setup:db=>db.exec('CREATE TABLE context_artifacts(id TEXT PRIMARY KEY);CREATE TABLE material_heads(id TEXT PRIMARY KEY,revision TEXT,retired INTEGER)'),fault:db=>db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TRIGGER&&name==='artifact_material_removed'?constants.SQLITE_DENY:constants.SQLITE_OK),repair:db=>db.setAuthorizer(null)},
 {installation:assetCaptureReferencesInstallation,setup:db=>db.exec('CREATE TABLE asset_references(owner TEXT PRIMARY KEY,hash TEXT);CREATE TABLE captures(id TEXT PRIMARY KEY,blob_hash TEXT)'),fault:db=>db.setAuthorizer((code,name)=>code===constants.SQLITE_CREATE_TRIGGER&&name==='asset_captures_update'?constants.SQLITE_DENY:constants.SQLITE_OK),repair:db=>db.setAuthorizer(null)},
 {installation:evidenceDependenciesWithoutMaterialsInstallation,setup:db=>db.exec("CREATE VIEW evidence_dependency_edges AS SELECT 'generated-old' parent_kind"),fault:db=>db.setAuthorizer(code=>code===constants.SQLITE_CREATE_VIEW?constants.SQLITE_DENY:constants.SQLITE_OK),repair:db=>db.setAuthorizer(null)},
];

for(const entry of cases)for(const nested of [false,true])test(`native tail failure restores ${entry.installation.owner}${nested?' and caller transaction/savepoint; outer rollback retries':''}`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;CREATE TABLE generated_outer(value TEXT)');entry.setup(db);entry.fault(db);
  if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
  const before=schema(db);
  assert.throws(()=>installSchemaPlan(db,[entry.installation]),/not authorized|already (a table|an index) named/);assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,nested);
  if(nested){db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);}
  entry.repair(db);installSchemaPlan(db,[entry.installation]);const installed=schema(db);assert.notDeepEqual(installed,before);assert.equal(db.isTransaction,nested);
  if(nested){
   db.exec('ROLLBACK');assert.deepEqual(schema(db),before);entry.repair(db);installSchemaPlan(db,[entry.installation]);assert.deepEqual(schema(db),installed);assert.equal(db.isTransaction,false);
  }
  installSchemaPlan(db,[entry.installation]);assert.deepEqual(schema(db),installed);
 }finally{db.setAuthorizer(null);db.close();}
});

test('asset evidence owners validate actual prerequisites without activating unrelated schemas',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  assert.throws(()=>installSchemaPlan(db,[archivedFilesSchemaInstallation]),/capture object\(s\): table:captures/);assert.deepEqual(schema(db),[]);
  db.exec("CREATE VIEW captures AS SELECT 'generated' id");assert.throws(()=>installSchemaPlan(db,[archivedFilesSchemaInstallation]),/table:captures/);assert.equal(table(db,'file_blobs'),false);db.exec('DROP VIEW captures');
  assert.throws(()=>installSchemaPlan(db,[evidenceMaterialLineageSchemaInstallation]),/table:context_artifacts/);assert.equal(table(db,'artifact_material_inputs'),false);
  installSchemaPlan(db,[assetSchemaInstallation]);assert.equal(table(db,'captures'),false);assert.equal(table(db,'material_heads'),false);assert.equal(table(db,'memories'),false);
  assert.throws(()=>installSchemaPlan(db,[assetCaptureReferencesInstallation]),/capture object\(s\): table:captures/);
 }finally{db.close();}
});

test('dependency view preserves both material variants and forward references across outer rollback',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  installSchemaPlan(db,[evidenceDependenciesWithoutMaterialsInstallation]);const original=schema(db);assert.equal(table(db,'memories'),false);assert.equal(table(db,'material_evidence'),false);
  db.exec('BEGIN');installSchemaPlan(db,[evidenceDependenciesWithMaterialsInstallation]);assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE name='evidence_dependency_edges'").get()!.sql),/FROM material_evidence_dependencies/);db.exec('ROLLBACK');assert.deepEqual(schema(db),original);
  installSchemaPlan(db,[evidenceDependenciesWithMaterialsInstallation]);assert.notDeepEqual(schema(db),original);
 }finally{db.close();}
});

test('asset producer projections reconnect after caller rollback and preserve live references',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-asset-projection-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const db=store.db;assert.equal(table(db,'archived_files'),false);db.exec('BEGIN');new ArchivedFileStore(store);assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='asset_archived_files_update'").get());db.exec('ROLLBACK');assert.equal(table(db,'archived_files'),false);
 const files=new ArchivedFileStore(store),file=files.put({name:'generated.bin',bytes:Buffer.from('Generated live asset')});assert.equal(db.prepare("SELECT hash FROM asset_references WHERE owner=?").get('archive:'+file.id)!.hash,file.hash);assert.equal(db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
});

test('archived asset capture evidence survives restart then deletion removes attachments and read authority',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-asset-evidence-restart-'));let store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 let files=new ArchivedFileStore(store),sources=new SourceStore(store);installEvidenceDependencies(store);
 const bytes=Buffer.from('Generated original evidence bytes'),file=files.put({name:'generated.txt',mimeType:'text/plain',bytes});sources.register({id:'generated-upload',name:'Generated upload',kind:'upload',deviceId:'generated',platform:'import',retention:'archive'});
 const capture=await sources.upsert('generated-upload',{externalId:'generated-entry',revision:'v1',observedAt:'2026-11-17T00:00:00Z',kind:'file',layer:'original',text:'Generated authored evidence',document:{fileId:file.id,timeBasis:'unknown',contentRole:'authored'}});files.attach(capture.id,[file.id]);
 assert.equal(store.evidence([capture.id])[0].provenance?.document?.fileId,file.id);assert.deepEqual(files.read(file.id),bytes);const hash=file.hash;
 store.close();store=new Store(directory);files=new ArchivedFileStore(store);sources=new SourceStore(store);installEvidenceDependencies(store);assert.deepEqual(files.read(file.id),bytes);assert.equal(files.listForCapture(capture.id)[0].hash,hash);assert.equal(store.evidence([capture.id]).length,1);
 store.delete(capture.id);assert.equal(store.evidence([capture.id]).length,0);assert.deepEqual(files.listForCapture(capture.id),[]);assert.throws(()=>files.attach(capture.id,[file.id]),{statusCode:409});assert.equal(store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
 store.close();store=new Store(directory);files=new ArchivedFileStore(store);assert.equal(store.evidence([capture.id]).length,0);assert.deepEqual(files.listForCapture(capture.id),[]);
});
