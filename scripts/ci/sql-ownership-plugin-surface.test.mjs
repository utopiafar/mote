import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlStatements} from './sql-ownership.mjs';
import {consumerScopes,sharedReads} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const center='apps/server/src/plugin-center.ts',developer='apps/server/src/developer-access.ts',outbound='apps/server/src/plugins/outbound-export-host.ts',schema='apps/server/src/plugin-surface-schema.ts';

test('formal plugin surface owners cover their tables while dynamic and foreign developer SQL stays original debt',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.equal(result.tables.plugin_release_previews.owner,'plugin-release-previews');
 for(const table of ['developer_events','developer_deliveries'])assert.equal(result.tables[table].owner,'developer-access');
 for(const table of ['outbound_export_items','outbound_export_instances'])assert.equal(result.tables[table].owner,'outbound-export');
 assert.deepEqual(result.owners.filter(owner=>[center,developer,outbound,schema].includes(owner.file)).map(owner=>owner.declaration).sort(),['developerAccessSchemaInstallation','outboundExportSchemaInstallation','pluginReleasePreviewsSchemaInstallation']);
 for(const file of [center,developer,outbound,schema])assert.ok(result.coveredFiles.includes(file));
 assert.ok(result.uncoveredFiles.includes(developer));
 assert.ok(!result.uncoveredFiles.includes(center)&&!result.uncoveredFiles.includes(outbound)&&!result.uncoveredFiles.includes(schema));
 for(const scope of ['DeveloperAccessHost.events','DeveloperAccessHost.recordUnsafe','DeveloperAccessHost.sourceKind','metadataHost'])assert.equal(consumerScopes['developer-access.ts']?.[scope],undefined);
 const pending=result.exceptions.filter(issue=>issue.from===developer);
 assert.equal(pending.length,11);
 assert.ok(pending.every(issue=>issue.rule==='sql-uncovered-consumer'&&issue.to==='[owner pending]'&&issue.kind==='coverage'));
 assert.deepEqual([...new Set(pending.map(issue=>issue.scope))].sort(),['DeveloperAccessHost.events','DeveloperAccessHost.recordUnsafe','DeveloperAccessHost.sourceKind','metadataHost']);
 assert.equal(sharedReads.filter(grant=>grant.from===developer).length,0,'the existing source read stays exact debt instead of a new grant');
 assert.equal(result.exceptions.filter(issue=>[center,outbound].includes(issue.from)).length,0,'both fully scoped consumers resolve their original coverage debt');
});

test('production entry rejects plugin surface foreign effects and unregistered installer paths',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-plugin-surface-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 const local=[schema].filter(file=>existsSync(resolve(repository,file))&&!tracked.includes(file));
 for(const file of [...tracked,...local]){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const original=new Map([center,developer,outbound,schema].map(file=>[file,readFileSync(resolve(root,file),'utf8')]));
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const guard=sqlStatements(developer,original.get(developer)).find(statement=>statement.scope==='DeveloperAccessHost.deliveries');assert.ok(guard);
 const cases=[
  [center,original.get(center)+"\nfunction generatedForeignReleaseWrite(db){db.prepare('UPDATE developer_events SET event=event WHERE id=?');}",/sql-cross-owner.*plugin-center.ts.*developer_events.*write/],
  [outbound,original.get(outbound)+"\nfunction generatedForeignPreviewRead(db){db.prepare('SELECT json FROM plugin_release_previews WHERE id=?');}",/sql-cross-owner.*outbound-export-host.ts.*plugin_release_previews.*read/],
  [developer,original.get(developer).replace('deliveries(limit=50){','deliveries(limit=50){this.options.store.db.prepare(\'UPDATE source_connections SET json=json WHERE id=?\');'),/sql-cross-owner.*developer-access.ts.*source_connections.*write/],
  [developer,original.get(developer)+'\nfunction copiedDeliveryRead(db){db.prepare('+guard.expression+');}',/sql-uncovered-consumer.*developer-access.ts/],
  [schema,original.get(schema).replace('function developerAccessSchema(db:DatabaseSync){','function developerAccessSchema(db:DatabaseSync){db.prepare(\'UPDATE source_connections SET json=json WHERE id=?\');'),/sql-schema-maintenance.*source_connections.*update/],
  [schema,original.get(schema)+'\nfunction unregisteredRuntime(db){developerAccessSchema(db);}',/schema installer cannot acquire another runtime call path/],
 ];
 for(const [file,changed,diagnostic]of cases){
  assert.notEqual(changed,original.get(file));writeFileSync(resolve(root,file),changed);
  result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),original.get(file));
 }
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
