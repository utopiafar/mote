import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlStatements,sqlAccesses} from './sql-ownership.mjs';
import {consumerScopes,sharedReads,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const schema='apps/server/src/memory-input-plans-schema.ts',consumer='apps/server/src/memory-input-plans.ts';

test('InputPlans has one exact installer and only its existing put/get/list SQL scopes',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.equal(result.tables.memory_input_plans.owner,'memory-input-plans');assert.equal(result.tables.memory_input_plans.installer,'memoryInputPlansSchemaInstallation');
 assert.deepEqual(consumerScopes['memory-input-plans.ts'],{'MemoryInputPlans.list':'memory-input-plans','MemoryInputPlans.get':'memory-input-plans','MemoryInputPlans.put':'memory-input-plans'});
 const ddl=sqlStatements(schema,readFileSync(resolve(repository,schema),'utf8')).find(statement=>statement.sink);assert.equal(ddl.scope,'memoryInputPlansSchemaInstallation.install');
 assert.deepEqual(sqlAccesses(ddl.values[0]).created,[{type:'table',name:'memory_input_plans'},{type:'index',name:'memory_input_plans_job'},{type:'index',name:'memory_input_plans_material'}]);
 assert.ok(sqlAccesses(ddl.values[0]).accesses.every(access=>access.table==='memory_input_plans'),'forward FKs are not parent-table data authority');
 assert.ok(!sharedReads.some(item=>[schema,consumer].includes(item.from)));assert.ok(!schemaMaintenance.some(item=>[schema,consumer].includes(item.from)));
});

test('production entry rejects InputPlans parent writes, unowned scopes and raw installer escape',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-input-plans-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'}),schemaPath=resolve(root,schema),consumerPath=resolve(root,consumer),schemaSource=readFileSync(schemaPath,'utf8'),consumerSource=readFileSync(consumerPath,'utf8');
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const cases=[
  [consumer,consumerSource.replace('put(plan:ManualMemoryInputPlan){','put(plan:ManualMemoryInputPlan){this.store.db.prepare(\'DELETE FROM material_heads WHERE id=?\');'),/sql-cross-owner.*memory-input-plans.ts.*material_heads.*write/],
  [schema,schemaSource.replace('install(db){','install(db){db.prepare(\'DELETE FROM material_heads WHERE id=?\');'),/sql-schema-maintenance.*material_heads.*delete/],
  [consumer,consumerSource+"\nfunction unownedPlanRead(db){db.prepare('SELECT json FROM memory_input_plans WHERE id=?');}",/sql-uncovered-consumer.*memory-input-plans.ts/],
  [schema,schemaSource+'\nconst escapedInstaller=memoryInputPlansSchemaInstallation.install;',/inline installer cannot escape its registered declaration/],
 ];
 for(const[file,changed,diagnostic]of cases){const original=file===schema?schemaSource:consumerSource;assert.notEqual(changed,original);writeFileSync(resolve(root,file),changed);result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),original);}
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
