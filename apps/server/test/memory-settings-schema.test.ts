import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,constants} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {MemoryAdapters} from '../src/memory-adapters.js';
import {MemoryRecipeSettings} from '../src/memory-recipe-settings.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {RANGE_SELECTION_CODING_RECIPE} from '../src/memory-range-selection-policy.js';
import type {PluginCenter} from '../src/plugin-center.js';
import type {ModelSettingsStore} from '../src/model-settings.js';
import {memoryProviderConfigurationsSchemaInstallation,memoryRecipeSettingsSchemaInstallation} from '../src/memory-settings-schema.js';

const schema=(db:DatabaseSync)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const table=(db:DatabaseSync,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const deny=(db:DatabaseSync,name:string)=>db.setAuthorizer((code,object)=>code===constants.SQLITE_CREATE_TABLE&&object===name?constants.SQLITE_DENY:constants.SQLITE_OK);
const owners=[
 {name:'Memory provider configurations',installation:memoryProviderConfigurationsSchemaInstallation,table:'memory_provider_configurations'},
 {name:'Memory recipe settings',installation:memoryRecipeSettingsSchemaInstallation,table:'memory_recipe_settings'},
] as const;

test('Memory settings owners install only their exact table and keep the recipe Source FK',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  installSchemaPlan(db,[memoryProviderConfigurationsSchemaInstallation]);
  assert.equal(table(db,'memory_provider_configurations'),true);assert.equal(table(db,'memory_recipe_settings'),false);
  installSchemaPlan(db,[memoryRecipeSettingsSchemaInstallation]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(memory_provider_configurations)').all(),[]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(memory_recipe_settings)').all().map(row=>({table:row.table,from:row.from,to:row.to,on_delete:row.on_delete})),[{table:'source_connections',from:'source_id',to:'id',on_delete:'CASCADE'}]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

for(const nested of [false,true])for(const owner of owners)test(`${owner.name} failed DDL restores its exact catalog${nested?' inside a caller savepoint':''} and retries the same handle`,()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;CREATE TABLE generated_outer(value TEXT)');
  if(nested)db.exec("BEGIN;INSERT INTO generated_outer VALUES('before');SAVEPOINT generated_caller");
  const before=schema(db);deny(db,owner.table);
  assert.throws(()=>installSchemaPlan(db,[owner.installation]),/not authorized/);
  assert.deepEqual(schema(db),before);assert.equal(db.isTransaction,nested);assert.equal(table(db,owner.table),false);
  if(nested){
   db.exec("INSERT INTO generated_outer VALUES('after');ROLLBACK TO generated_caller;RELEASE generated_caller");
   assert.deepEqual(db.prepare('SELECT value FROM generated_outer').all().map(row=>row.value),['before']);
   db.exec('ROLLBACK');
  }
  db.setAuthorizer(null);
  db.exec('BEGIN');installSchemaPlan(db,[owner.installation]);assert.equal(table(db,owner.table),true);db.exec('ROLLBACK');
  assert.equal(table(db,owner.table),false);
  installSchemaPlan(db,[owner.installation]);const installed=schema(db);
  assert.notDeepEqual(installed,before);assert.equal(table(db,owner.table),true);assert.equal(db.isTransaction,false);
  installSchemaPlan(db,[owner.installation]);assert.deepEqual(schema(db),installed);
 }finally{db.setAuthorizer(null);db.close();}
});

test('the real MemoryAdapters constructor installs before storage registration and retries its Store',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-settings-adapters-')),store=new Store(directory),storage=t.mock.method(store,'registerStorage',()=>{});
 const plugins={store} as unknown as PluginCenter,models={} as ModelSettingsStore;
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 deny(store.db,'memory_provider_configurations');
 assert.throws(()=>new MemoryAdapters(join(directory,'plugins/instances'),plugins,models),/not authorized/);
 assert.equal(table(store.db,'memory_provider_configurations'),false);assert.equal(storage.mock.callCount(),0);assert.equal(store.db.isTransaction,false);
 store.db.setAuthorizer(null);
 const adapters=new MemoryAdapters(join(directory,'plugins/instances'),plugins,models);
 try{
  assert.equal(table(store.db,'memory_provider_configurations'),true);
  assert.equal(storage.mock.callCount(),1);assert.equal(storage.mock.calls[0].arguments[0],'memory-provider-adapters');
  store.db.prepare('INSERT INTO memory_provider_configurations VALUES(?,?)').run('generated',JSON.stringify({namespace:{ownerId:'generated-owner',instanceId:'generated-instance',bindingRevision:1},package:{view:{id:'generated.package',source:{digest:'generated'}},manifest:{capabilities:[]}},instance:{id:'generated-instance',packageId:'generated.package'},identity:'generated'}));
  await adapters.erasePreparedEvidence(['generated-evidence']);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_provider_configurations').get()?.n,1);
 }finally{await adapters.close();}
});

test('the real MemoryRecipeSettings constructor installs, seeds defaults and cascades only its source override',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-settings-recipes-')),store=new Store(directory),sources=new SourceStore(store),strategies=new MemoryStrategies();
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-memory-settings',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 deny(store.db,'memory_recipe_settings');
 assert.throws(()=>new MemoryRecipeSettings(store,strategies),/not authorized/);
 assert.equal(table(store.db,'memory_recipe_settings'),false);
 store.db.setAuthorizer(null);
 const settings=new MemoryRecipeSettings(store,strategies);
 assert.equal(table(store.db,'memory_recipe_settings'),true);
 assert.deepEqual(store.db.prepare('SELECT id FROM memory_recipe_settings ORDER BY id').all().map(row=>row.id),['capture-default','default','lark-docs-default']);
 assert.deepEqual(settings.selection().map(binding=>binding.recipe.id),['mote.personal-memory']);
 settings.configure({sourceId:'generated-memory-settings',recipes:[RANGE_SELECTION_CODING_RECIPE]});
 assert.deepEqual(settings.selection('generated-memory-settings').map(binding=>binding.recipe.id),['mote.coding-memory']);
 assert.deepEqual(settings.selection().map(binding=>binding.recipe.id),['mote.personal-memory']);
 store.db.prepare('DELETE FROM source_connections WHERE id=?').run('generated-memory-settings');
 assert.equal(store.db.prepare("SELECT count(*) n FROM memory_recipe_settings WHERE source_id='generated-memory-settings'").get()?.n,0);
 assert.deepEqual(settings.selection().map(binding=>binding.recipe.id),['mote.personal-memory']);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
