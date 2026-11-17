import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {Connections} from '../src/connections.js';
import {SourceStore} from '../src/sources.js';
import {DeveloperAccessHost} from '../src/developer-access.js';
import {MaterialStore} from '../src/materials.js';
import {OutboundExportHost} from '../src/plugins/outbound-export-host.js';
import {installSchemaPlan,type SchemaInstallation} from '../src/schema-installation.js';
import {pluginReleasePreviewsSchemaInstallation,developerAccessSchemaInstallation,outboundExportSchemaInstallation} from '../src/plugin-surface-schema.js';

type ExpectedObject={type:'table'|'index';name:string;fingerprint:string};
const owners:readonly {label:string;installation:SchemaInstallation;objects:readonly ExpectedObject[]}[]=[
 {label:'plugin release previews',installation:pluginReleasePreviewsSchemaInstallation,objects:[
  {type:'table',name:'plugin_release_previews',fingerprint:'03ac5956678aa20b3290f5d056fb273d92b724b03b1c184c711b5cb818918565'},
 ]},
 {label:'developer access',installation:developerAccessSchemaInstallation,objects:[
  {type:'index',name:'developer_deliveries_endpoint',fingerprint:'4b1ee2f7885a6b85f82b9888daf0c7df4a6d5b5f715e02590d0b4a3285850147'},
  {type:'index',name:'developer_deliveries_pending',fingerprint:'a9ebed377fe67b0f26ff73fc5994a65d0a29e0cecbd58bedae4f2529edb41f19'},
  {type:'index',name:'developer_events_source',fingerprint:'cc1647461abe97f131e15736528c276c15d633df199a84fcd7131f0700050009'},
  {type:'index',name:'developer_events_type',fingerprint:'1892198cce18c0885e3a3b593e314d132c05688aa7e7e147b99ebb8e560df53c'},
  {type:'table',name:'developer_deliveries',fingerprint:'e785cc61c838188aa3b15268a7fa769cf4894b6aa46bd9ac4d41fb3f3a1d4e8b'},
  {type:'table',name:'developer_events',fingerprint:'baa845bacb9940d2cac46937f430c206dd48a12f42beec8a29ea8f0b26c752c9'},
 ]},
 {label:'outbound export',installation:outboundExportSchemaInstallation,objects:[
  {type:'table',name:'outbound_export_instances',fingerprint:'283942b8196f66d33fff5c755d4c13425f7922c134ad73f44cdc053fe8e902a4'},
  {type:'table',name:'outbound_export_items',fingerprint:'fcd68aeffe3324abceaaa27bca9512fa367c80afd3faa3b0ee52fc1a37bb9184'},
 ]},
];
const objectNames=owners.map(owner=>owner.objects.map(object=>object.name));
const row=(db:DatabaseSync,name:string)=>db.prepare('SELECT type,name FROM sqlite_master WHERE name=?').get(name);
const rows=(db:DatabaseSync,names:readonly string[])=>db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(()=>'?').join(',')}) ORDER BY type,name`).all(...names).map(value=>({type:String(value.type),name:String(value.name),fingerprint:createHash('sha256').update(String(value.sql)).digest('hex')}));
const installed=(db:DatabaseSync,objects:readonly ExpectedObject[])=>objects.map(({type,name})=>({type,name})).filter(object=>db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(object.type,object.name));
const expected=(owner:typeof owners[number])=>owner.objects.map(({type,name,fingerprint})=>({type,name,fingerprint}));
const direct=owner=>{const db=new DatabaseSync(':memory:');try{installSchemaPlan(db,[owner.installation]);return rows(db,objectNames[owners.indexOf(owner)]!);}finally{db.close();}};
const otherObjects=index=>objectNames.filter((_,position)=>position!==index).flat();
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');

for(const [index,owner] of owners.entries())test(`the ${owner.label} owner installs its exact objects and retries on the same handle`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  installSchemaPlan(db,[owner.installation]);
  assert.deepEqual(rows(db,objectNames[index]!),expected(owner),'the owner installs only its declared tables and indexes');
  assert.deepEqual(rows(db,otherObjects(index)),[],'a surface owner never installs another owner schema');
  installSchemaPlan(db,[owner.installation]);
  assert.deepEqual(rows(db,objectNames[index]!),expected(owner),'IF NOT EXISTS preserves the installed objects');
 }finally{db.close();}
});

for(const [index,owner] of owners.entries())test(`outer savepoint rollback removes the ${owner.label} schema and the same handle reinstalls it`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('BEGIN IMMEDIATE; SAVEPOINT generated_caller');
  installSchemaPlan(db,[owner.installation]);
  assert.deepEqual(rows(db,objectNames[index]!),expected(owner));
  assert.equal(db.isTransaction,true);
  db.exec('ROLLBACK TO generated_caller; RELEASE generated_caller');
  assert.deepEqual(rows(db,objectNames[index]!),[]);
  installSchemaPlan(db,[owner.installation]);
  assert.deepEqual(rows(db,objectNames[index]!),expected(owner));
  db.exec('COMMIT');
  assert.equal(db.isTransaction,false);
  installSchemaPlan(db,[owner.installation]);
  assert.deepEqual(rows(db,objectNames[index]!),expected(owner));
 }finally{db.close();}
});

test('a late developer-access DDL failure rolls back the whole group, preserves the caller savepoint and retries',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("BEGIN IMMEDIATE; CREATE TABLE generated_caller(value TEXT); INSERT INTO generated_caller VALUES('before'); SAVEPOINT generated_caller; CREATE TABLE developer_deliveries_endpoint(generated TEXT)");
  assert.throws(()=>installSchemaPlan(db,[developerAccessSchemaInstallation]),/there is already a table named developer_deliveries_endpoint/);
  assert.deepEqual(installed(db,owners[1]!.objects),[],'the earlier tables and indexes must roll back with the last index');
  assert.deepEqual({...row(db,'developer_deliveries_endpoint')},{type:'table',name:'developer_deliveries_endpoint'});
  assert.equal(db.isTransaction,true,'the caller transaction and savepoint survive the nested install failure');
  db.exec("INSERT INTO generated_caller VALUES('after'); DROP TABLE developer_deliveries_endpoint");
  installSchemaPlan(db,[developerAccessSchemaInstallation]);
  assert.deepEqual(rows(db,objectNames[1]!),expected(owners[1]!));
  db.exec('COMMIT');
  assert.deepEqual(db.prepare('SELECT value FROM generated_caller ORDER BY rowid').all().map(value=>value.value),['before','after']);
  installSchemaPlan(db,[developerAccessSchemaInstallation]);
  assert.deepEqual(rows(db,objectNames[1]!),expected(owners[1]!));
 }finally{db.close();}
});

test('a top-level outbound-export DDL failure leaves no partial table and the same handle retries',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE generated_holder(value TEXT); CREATE INDEX outbound_export_instances ON generated_holder(value)');
  assert.throws(()=>installSchemaPlan(db,[outboundExportSchemaInstallation]),/there is already an index named outbound_export_instances/);
  assert.deepEqual(installed(db,owners[2]!.objects),[],'the first table must not survive the failed second statement');
  assert.equal(db.isTransaction,false);
  db.exec('DROP INDEX outbound_export_instances');
  installSchemaPlan(db,[outboundExportSchemaInstallation]);
  assert.deepEqual(rows(db,objectNames[2]!),expected(owners[2]!));
  installSchemaPlan(db,[outboundExportSchemaInstallation]);
  assert.deepEqual(rows(db,objectNames[2]!),expected(owners[2]!));
 }finally{db.close();}
});

test('PluginCenter installs release previews at its constructor and resolve uses that exact table',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-plugin-surface-center-')),store=new Store(directory);
 const plugins=new PluginCenter(store,new ExecutionEngine(store),new GitHubPluginReleases(join(directory,'packages'),async url=>{throw Error('generated transport must stay unused: '+url);},repoRoot));
 t.after(async()=>{await plugins.close();store.close();rmSync(directory,{recursive:true,force:true});});
 assert.deepEqual(rows(store.db,objectNames[0]!),direct(owners[0]!),'the constructor installs the same release-preview objects as the owner');
 assert.deepEqual(rows(store.db,[...objectNames[1]!,...objectNames[2]!]),[],'PluginCenter does not install another surface owner');
 const preview=await plugins.resolve({repository:'mote/official-markdown-export',tag:'v0.1.0'});
 assert.equal(preview.installable,true);
 const stored=store.db.prepare('SELECT json FROM plugin_release_previews WHERE id=?').get(preview.id) as {json:string}|undefined;
 assert.ok(stored,'resolve writes the preview consumed by install');
 assert.equal(JSON.parse(String(stored.json)).preview.id,preview.id);
});

test('DeveloperAccessHost installs its tables at its constructor and inventory reads deliveries',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-plugin-surface-developer-')),store=new Store(directory);
 const connections=new Connections(store,new SourceStore(store)),host=new DeveloperAccessHost({store,connections});
 t.after(async()=>{await host.close();store.close();rmSync(directory,{recursive:true,force:true});});
 assert.deepEqual(rows(store.db,objectNames[1]!),direct(owners[1]!),'the constructor installs the same developer-access objects as the owner');
 assert.deepEqual(rows(store.db,[...objectNames[0]!,...objectNames[2]!]),[],'DeveloperAccessHost does not install another surface owner');
 assert.deepEqual(host.inventory().deliveries,[],'inventory reads the empty delivery table without starting a timer or network work');
});

test('OutboundExportHost installs its tables at its constructor and status reads the instance cursor',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-plugin-surface-outbound-')),store=new Store(directory);
 const materials=new MaterialStore(store),host=new OutboundExportHost({store,materials,repoRoot,dataDir:directory,home:homedir(),sourceKind:()=>undefined,intervalMs:3_600_000});
 t.after(async()=>{await host.close();store.close();rmSync(directory,{recursive:true,force:true});});
 assert.deepEqual(rows(store.db,objectNames[2]!),direct(owners[2]!),'the constructor installs the same outbound-export objects as the owner');
 assert.deepEqual(rows(store.db,[...objectNames[0]!,...objectNames[1]!]),[],'OutboundExportHost does not install another surface owner');
 assert.deepEqual(host.status('generated-instance'),{instanceId:'generated-instance',active:false,targetConfigured:false,scopeSourceIds:[],lastSyncAt:undefined,lastError:undefined,exported:0,conflicts:[],issues:['outbound_target_not_configured','outbound_scope_empty']});
});
