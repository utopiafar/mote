import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {gmailSyncState} from '../src/connectors/gmail-state.js';
import {larkDocumentState} from '../src/connectors/lark-state.js';
import {mcpImportState} from '../src/connectors/mcp-import-state.js';
import {initializeRecordingMedia,recordingState} from '../src/connectors/recording-state.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const exists=(db:DatabaseSync,name:string)=>Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name));

test('source state installers retain separate activation, including early recording media before archives',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  initializeRecordingMedia({db});assert.ok(exists(db,'recording_media'));
  for(const name of ['recording_exports','recording_cursors','gmail_sync_members','lark_document_sync','mcp_import_manifests','archived_files'])assert.equal(exists(db,name),false);
  const before=schema(db);assert.throws(()=>recordingState({db,isCurrentEvidence:()=>true},{attach:()=>{}}),/recording-sync schema requires archived-files object/);assert.deepEqual(schema(db),before);
  gmailSyncState({db});assert.ok(exists(db,'gmail_sync_members'));assert.equal(exists(db,'lark_document_sync'),false);
  larkDocumentState({db},'generated-account','generated-source','generated-scope');assert.ok(exists(db,'lark_document_sync'));
  assert.throws(()=>mcpImportState({db}),/mcp-import schema requires source object/);assert.equal(exists(db,'source_connections'),false);
  db.exec('CREATE TABLE source_connections(id TEXT PRIMARY KEY)');mcpImportState({db});assert.ok(exists(db,'mcp_import_manifests'));
 }finally{db.close();}
});

for(const nested of [false,true])test(`recording state native SQL failure preserves its earlier media stage${nested?' and caller savepoint':''}, then retries`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  initializeRecordingMedia({db});db.exec("CREATE TABLE archived_files(id TEXT PRIMARY KEY); CREATE TABLE generated_fixture(value TEXT); INSERT INTO generated_fixture VALUES('retained'); CREATE INDEX recording_cursors ON generated_fixture(value)");
  if(nested)db.exec("BEGIN; SAVEPOINT generated_caller; INSERT INTO generated_fixture VALUES('before')");
  const before=schema(db);assert.throws(()=>recordingState({db,isCurrentEvidence:()=>true},{attach:()=>{}}),/already an index named recording_cursors/);
  assert.deepEqual(schema(db),before);assert.equal(exists(db,'recording_exports'),false);assert.equal(db.isTransaction,nested);
  if(nested)db.exec("INSERT INTO generated_fixture VALUES('after'); RELEASE generated_caller; COMMIT");
  assert.equal(db.prepare('SELECT count(*) n FROM generated_fixture').get()?.n,nested?3:1);
  db.exec('DROP INDEX recording_cursors');const state=recordingState({db,isCurrentEvidence:()=>true},{attach:()=>{}});
  state.advanceCursor('generated-source','epoch-one','2026-11-17T00:00:00Z',123);assert.equal(state.cursor('generated-source','epoch-one')?.full_at,123);
  const installed=schema(db);db.exec('BEGIN');state.advanceCursor('generated-source','epoch-two','2026-11-18T00:00:00Z',0);db.exec('ROLLBACK');
  assert.equal(state.cursor('generated-source','epoch-two'),undefined);assert.equal(state.cursor('generated-source','epoch-one')?.full_at,123);
  recordingState({db,isCurrentEvidence:()=>true},{attach:()=>{}});assert.deepEqual(schema(db),installed);
 }finally{db.close();}
});
