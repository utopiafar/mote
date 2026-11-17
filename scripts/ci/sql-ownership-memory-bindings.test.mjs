import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlAccesses,sqlStatements} from './sql-ownership.mjs';
import {consumerScopes,sharedReads,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const schema='apps/server/src/memory-binding-schema.ts',consumer='apps/server/src/memory-bindings.ts';

test('Memory binding has one exact installer, only four owned tables and precise existing read scopes',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 for(const table of ['memory_plan_binding','memory_preparation','memory_binding_commands','memory_provider_receipts'])assert.deepEqual(result.tables[table],{owner:'memory-binding',file:schema,installer:'memoryBindingSchemaInstallation'});
 assert.deepEqual(consumerScopes['memory-bindings.ts'],{
  'MemoryBindings.constructor':'memory-binding','MemoryBindings.binding':'memory-binding','MemoryBindings.saveBinding':'memory-binding',
  'MemoryBindings.preparation':'memory-binding','MemoryBindings.savePreparation':'memory-binding','MemoryBindings.currentRecords':'memory-binding',
  'MemoryBindings.command':'memory-binding','MemoryBindings.copy':'memory-binding',
 });
 const reads=sharedReads.filter(item=>item.from===consumer);assert.equal(reads.length,1);assert.equal(reads[0].to,'memories');assert.equal(reads[0].symbol,'22416992d875335bee538032d88d19478dd210e3c1d492e8e24beb0c0e5d5d31');assert.equal(reads[0].scope,'MemoryBindings.currentRecords');
 assert.ok(!schemaMaintenance.some(item=>item.from===schema||item.from===consumer),'the four tables install no triggers or foreign lifecycle effects');
 const ddl=sqlStatements(schema,readFileSync(resolve(repository,schema),'utf8')).find(statement=>statement.sink);
 assert.equal(ddl.scope,'memoryBindingSchemaInstallation.install');
 assert.equal(ddl.fingerprint,'beef44738f9046e2930e7217adc4646de6eddd905d7ef050501de4957fa34f4e','the original DDL literal is unchanged');
 assert.deepEqual(sqlAccesses(ddl.values[0]).created,[{type:'table',name:'memory_plan_binding'},{type:'table',name:'memory_preparation'},{type:'table',name:'memory_binding_commands'},{type:'table',name:'memory_provider_receipts'}]);
 assert.deepEqual(sqlAccesses(ddl.values[0]).accesses,['memory_plan_binding','memory_preparation','memory_binding_commands','memory_provider_receipts'].map(table=>({table,kind:'write'})),'the original tables declare no foreign keys');
 const debt=readFileSync(resolve(repository,'scripts/ci/sql-ownership-baseline.json'),'utf8').split('\n').find(line=>line.includes('"from":"apps/server/src/memory-bindings.ts"'));
 const entry=JSON.parse(debt.replace(/,$/,''));
 assert.deepEqual(entry.symbols,['13d1250e7d5c4d6f42e35d13273b61a077184856e3c70db3f1d65bce1953190b','8c53bd3085316d84c1e1de9f7b53ac8648870d4bf7bee705f5f65948439a1cdf','cdf828428954274715c1e41ea6294010f96d0c7140f8c4ccd93822cce3bc983b','e2a53e62b2a652c6d340d8d8493aad33058ba82e3b7ccc7461dbb966b4c46e66'],'the existing dynamic snapshot debt keeps its original fingerprints');
 assert.equal(result.exceptions.filter(issue=>issue.from===consumer&&issue.scope==='MemoryBindings.retainSnapshot').length,4);
 assert.deepEqual(result.exceptions.filter(issue=>issue.from===consumer&&issue.scope==='MemoryBindings.currentRecords').map(issue=>[issue.rule,issue.to,issue.kind]),[['sql-cross-owner','memories','read']],'the exact canonical-body read is a shared read, not a whole-file exemption');
 assert.equal(result.exceptions.filter(issue=>issue.from===consumer).length,5);
});

test('production entry rejects Memory binding foreign writes, new reads, unowned scopes and raw installer escape',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-memory-binding-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'}),schemaPath=resolve(root,schema),consumerPath=resolve(root,consumer),schemaSource=readFileSync(schemaPath,'utf8'),consumerSource=readFileSync(consumerPath,'utf8');
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const cases=[
  [consumer,consumerSource.replace('private saveBinding(value:Binding){','private saveBinding(value:Binding){this.store.db.prepare(\'UPDATE memories SET json=json WHERE id=?\');'),/sql-cross-owner.*memory-bindings.ts.*memories.*write/],
  [consumer,consumerSource.replace('binding():Binding{','binding():Binding{this.store.db.prepare(\'SELECT json FROM memories ORDER BY id\');'),/sql-cross-owner.*memory-bindings.ts.*memories.*read/],
  [consumer,consumerSource+"\nfunction unownedBindingRead(db){db.prepare('SELECT json FROM memory_plan_binding WHERE id=1');}",/sql-uncovered-consumer.*memory-bindings.ts/],
  [schema,schemaSource.replace('install(db){','install(db){db.prepare(\'DELETE FROM memories WHERE id=?\');'),/sql-schema-maintenance.*memory-binding-schema.ts.*memories.*delete/],
  [schema,schemaSource+'\nconst escapedBindingInstaller=memoryBindingSchemaInstallation.install;',/inline installer cannot escape its registered declaration/],
 ];
 for(const[file,changed,diagnostic]of cases){const original=file===schema?schemaSource:consumerSource;assert.notEqual(changed,original);writeFileSync(resolve(root,file),changed);result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),original);}
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
