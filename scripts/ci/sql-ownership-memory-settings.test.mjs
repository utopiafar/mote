import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlAccesses,sqlStatements} from './sql-ownership.mjs';
import {consumerScopes,consumers,sharedReads,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
const schema='apps/server/src/memory-settings-schema.ts',adapter='apps/server/src/memory-adapters.ts',recipe='apps/server/src/memory-recipe-settings.ts';
const providerHash='40b6c33bd81c77fc5a120a499800dc46533c520afff96a676c0db7e0c1050b86',recipeHash='825836adf1ba682e5a0fc616831bec7d7c6854b644598316f45c6f388b07364b';

test('Memory settings owners keep exact installers, own scopes, Source reads and original DDL hashes',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.deepEqual(result.tables.memory_provider_configurations,{owner:'memory-provider-configurations',file:schema,installer:'memoryProviderConfigurationsSchemaInstallation'});
 assert.deepEqual(result.tables.memory_recipe_settings,{owner:'memory-recipe-settings',file:schema,installer:'memoryRecipeSettingsSchemaInstallation'});
 assert.equal(consumers[recipe.slice('apps/server/src/'.length)],'memory-recipe-settings');
 assert.deepEqual(consumerScopes['memory-adapters.ts'],{'MemoryAdapters.erasePreparedEvidence':'memory-provider-configurations'});
 assert.deepEqual(sharedReads.filter(item=>item.from===recipe).map(({to,symbol,scope})=>({to,symbol,scope})),[
  {to:'source_connections',symbol:'def4469d98bdf5ba5cb7229cddb238f11d8c2f07ed6ba26ea704df320fb1086c',scope:'MemoryRecipeSettings.sourceDefault'},
  {to:'source_connections',symbol:'e419071df7f985c66e1b34bb6eacf5f186d94c309ce5fff1d135b751440a6494',scope:'MemoryRecipeSettings.source'},
 ]);
 assert.ok(!schemaMaintenance.some(item=>[schema,adapter,recipe].includes(item.from)));
 const ddl=sqlStatements(schema,readFileSync(resolve(repository,schema),'utf8')).filter(statement=>statement.sink);
 assert.deepEqual(ddl.map(statement=>statement.fingerprint),[providerHash,recipeHash]);
 assert.deepEqual(sqlAccesses(ddl[0].values[0]).created,[{type:'table',name:'memory_provider_configurations'}]);
 assert.deepEqual(sqlAccesses(ddl[1].values[0]).created,[{type:'table',name:'memory_recipe_settings'}]);
 assert.ok(sqlAccesses(ddl[1].values[0]).accesses.every(access=>access.table==='memory_recipe_settings'),'the forward Source FK is not runtime Source data authority');
 assert.equal(result.issues.filter(item=>item.from===adapter).length,6);assert.ok(result.issues.filter(item=>item.from===adapter).every(item=>item.scope==='MemoryAdapters.configuration'));
 assert.ok(result.coveredFiles.includes(adapter));assert.ok(result.uncoveredFiles.includes(adapter),'the dynamic configuration path remains pending coverage');
 assert.ok(result.coveredFiles.includes(recipe));assert.ok(!result.uncoveredFiles.includes(recipe));
});

test('Memory settings production owners reject unowned constructor DDL, foreign writes and moved Source reads',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-sql-memory-settings-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const files=execFileSync('git',['ls-files','-z','--','apps/server/src'],{cwd:repository,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const file of [...files,'scripts/ci/sql-ownership-map.json','scripts/ci/sql-ownership-baseline.json']){
  mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));
 }
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8'),run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8',timeout:120000});
 const positive=run();assert.equal(positive.status,0,positive.stderr);
 assert.match(positive.stdout,/40 schema owners \+ 1 scoped projection owner\(s\) \+ 3 existing construction owner\(s\), 132 tables\/views/);
 assert.match(positive.stdout,/PARTIAL coverage: 150 files with pending consumers, 153 referenced relations pending, 233 unproved SQL statements/);
 assert.match(positive.stdout,/2543 concrete existing exceptions/);
 const adapterPath=resolve(root,adapter),recipePath=resolve(root,recipe),adapterSource=readFileSync(adapterPath,'utf8'),recipeSource=readFileSync(recipePath,'utf8');
 const variants=[
  [adapterPath,adapterSource.replace('async erasePreparedEvidence(evidenceIds:readonly string[]){',"async erasePreparedEvidence(evidenceIds:readonly string[]){this.plugins.store.db.prepare('DELETE FROM source_connections WHERE id=?').run('generated');"),/sql-cross-owner.*memory-adapters.ts.*source_connections.*write/],
  [adapterPath,adapterSource+"\nfunction generatedConfigurationRead(db){db.prepare('SELECT json FROM memory_provider_configurations');}",/sql-uncovered-consumer.*memory-adapters.ts.*\[owner pending\]/],
  [adapterPath,adapterSource.replace('installSchemaPlan(plugins.store.db,[memoryProviderConfigurationsSchemaInstallation]);',"plugins.store.db.exec('CREATE TABLE IF NOT EXISTS memory_provider_configurations(id TEXT PRIMARY KEY,json TEXT NOT NULL);');installSchemaPlan(plugins.store.db,[memoryProviderConfigurationsSchemaInstallation]);"),/sql-uncovered-consumer.*memory-adapters.ts/],
  [recipePath,recipeSource.replace("if(!source)return 'default';","if(!source)return 'default';this.store.db.prepare('DELETE FROM source_connections WHERE id=?').run(sourceId);"),/sql-cross-owner.*memory-recipe-settings.ts.*source_connections.*write/],
  [recipePath,recipeSource.replace("if(!source)return 'default';","if(!source)return 'default';/* generated scope drift */"),/sql-cross-owner.*memory-recipe-settings.ts.*source_connections.*read/],
 ];
 for(const [path,source,expected] of variants){
  const original=readFileSync(path,'utf8');assert.notEqual(source,original,'the production mutation must reach its exact target');
  writeFileSync(path,source);try{const denied=run();assert.equal(denied.status,1,denied.stderr);assert.match(denied.stderr,expected);assert.equal(readFileSync(baselinePath,'utf8'),baseline);}finally{writeFileSync(path,original);}
 }
 const restored=run();assert.equal(restored.status,0,restored.stderr);assert.equal(readFileSync(baselinePath,'utf8'),baseline);
});
