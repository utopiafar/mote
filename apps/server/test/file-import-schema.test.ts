import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {fileDiarizationOverridesSchemaInstallation,fileSummaryPagesSchemaInstallation,fileSemanticWithdrawalsSchemaInstallation,fileProcessingMediaIntentsSchemaInstallation,mediaExecutionCallsSchemaInstallation} from '../src/file-processing-schema.js';
import {importAttributionSchemaInstallation,importIntakeOverridesSchemaInstallation,importUploadsSchemaInstallation} from '../src/import-schema.js';

const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));
const catalog=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

test('file processing installers refuse missing external owners and retry the same plan after rollback',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)');
  const before=catalog(db);
  assert.throws(()=>installSchemaPlan(db,[fileDiarizationOverridesSchemaInstallation]),/file schema requires file object\(s\): table:file_versions/);
  assert.deepEqual(catalog(db),before,'a missing owner installs no partial file table');
  db.exec('CREATE TABLE file_versions(capture_id TEXT PRIMARY KEY)');
  for(const installation of [fileDiarizationOverridesSchemaInstallation,fileSummaryPagesSchemaInstallation,fileSemanticWithdrawalsSchemaInstallation,mediaExecutionCallsSchemaInstallation])installSchemaPlan(db,[installation]);
  for(const name of ['file_diarization_overrides','file_summary_pages','file_semantic_withdrawals','file_semantic_calls','media_execution_instance','media_execution_calls','media_execution_pending'])assert.equal(exists(db,name),true,name);
  db.exec('BEGIN IMMEDIATE');
  installSchemaPlan(db,[fileProcessingMediaIntentsSchemaInstallation]);
  assert.equal(exists(db,'media_model_intents'),true);
  db.exec('ROLLBACK');
  assert.equal(exists(db,'media_model_intents'),false,'caller rollback also retires an accepted nested installation');
  installSchemaPlan(db,[fileProcessingMediaIntentsSchemaInstallation]);
  assert.equal(exists(db,'media_model_intents'),true,'the same handle installs again after rollback');
 }finally{db.close();}
});

test('file processing plans roll back the whole group on a late real failure',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY); CREATE TABLE file_versions(capture_id TEXT PRIMARY KEY)');
  const failure=new Error('Generated late schema failure');
  const failing={owner:'generated-failure',requires:[],install(){throw failure;}} as const satisfies SchemaInstallation;
  assert.throws(()=>installSchemaPlan(db,[fileSummaryPagesSchemaInstallation,failing]),failure);
  assert.equal(exists(db,'file_summary_pages'),false,'the earlier owner was rolled back with the plan');
  installSchemaPlan(db,[fileSummaryPagesSchemaInstallation]);
  assert.equal(exists(db,'file_summary_pages'),true);
 }finally{db.close();}
});

test('import owners keep upload staging independent and require captures before attribution or intake overrides',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  installSchemaPlan(db,[importUploadsSchemaInstallation]);
  assert.equal(exists(db,'import_uploads'),true);assert.equal(exists(db,'import_upload_parts'),true);
  assert.throws(()=>installSchemaPlan(db,[importAttributionSchemaInstallation]),/import schema requires capture object\(s\): table:captures/);
  assert.throws(()=>installSchemaPlan(db,[importIntakeOverridesSchemaInstallation]),/import schema requires capture object\(s\): table:captures/);
  assert.equal(exists(db,'import_owner_declarations'),false);assert.equal(exists(db,'image_intake_overrides'),false);
  db.exec('CREATE TABLE captures(id TEXT PRIMARY KEY)');
  for(const installation of [importAttributionSchemaInstallation,importIntakeOverridesSchemaInstallation])installSchemaPlan(db,[installation]);
  for(const name of ['import_owner_declarations','capture_import_declarations','capture_import_declarations_parent','capture_import_declaration_removed','image_intake_overrides'])assert.equal(exists(db,name),true,name);
  db.exec('DROP TRIGGER capture_import_declaration_removed; DROP TABLE capture_import_declarations; DROP TABLE import_owner_declarations');
  db.exec('BEGIN');
  installSchemaPlan(db,[importAttributionSchemaInstallation]);
  db.exec('ROLLBACK');
  assert.equal(exists(db,'import_owner_declarations'),false,'an outer rollback leaves no cached installation receipt');
  installSchemaPlan(db,[importAttributionSchemaInstallation]);
  assert.equal(exists(db,'import_owner_declarations'),true);
 }finally{db.close();}
});
