import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlStatements} from './sql-ownership.mjs';
import {sharedReads} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const control='apps/server/src/plugins/plugin-control-store.ts',state='apps/server/src/plugins/instance-state.ts';

test('formal plugin-state owners cover their independent tables and one exact Source condition read',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 for(const table of ['plugin_center','plugin_commands','plugin_control_receipts','plugin_build_instances'])assert.equal(result.tables[table].owner,'plugin-control');
 assert.equal(result.tables.plugin_instance_state.owner,'plugin-instance-state');
 assert.ok([control,state].every(file=>result.coveredFiles.includes(file)&&!result.uncoveredFiles.includes(file)));
 const exceptions=result.exceptions.filter(issue=>[control,state].includes(issue.from));
 assert.equal(exceptions.length,1);assert.equal(exceptions[0].to,'source_connections');assert.equal(exceptions[0].kind,'read');assert.equal(exceptions[0].scope,'InstanceState.write');
 const grant=sharedReads.find(item=>item.from===state);assert.equal(grant.symbol,exceptions[0].symbol);assert.equal(grant.scopeFingerprint,exceptions[0].scopeFingerprint);
});

test('production entry rejects plugin-state foreign writes, moved/copied reads and raw installer runtime calls',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-plugin-state-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const controlPath=resolve(root,control),statePath=resolve(root,state),controlSource=readFileSync(controlPath,'utf8'),stateSource=readFileSync(statePath,'utf8');
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const guard=sqlStatements(state,stateSource).find(statement=>statement.fingerprint===sharedReads.find(item=>item.from===state).symbol);assert.ok(guard);
 const cases=[
  [control,controlSource+"\nfunction generatedForeignStateWrite(db){db.prepare('UPDATE plugin_instance_state SET revision=revision+1');}",/sql-cross-owner.*plugin-control-store.ts.*plugin_instance_state.*write/],
  [state,stateSource+"\nfunction generatedForeignControlWrite(db){db.prepare('UPDATE plugin_center SET revision=revision+1');}",/sql-cross-owner.*instance-state.ts.*plugin_center.*write/],
  [state,stateSource+"\nfunction generatedForeignSourceWrite(db){db.prepare('UPDATE source_connections SET json=json WHERE id=?');}",/sql-cross-owner.*instance-state.ts.*source_connections.*write/],
  [state,stateSource.replace('private write(','private movedWrite('),/sql-cross-owner.*instance-state.ts.*source_connections.*read/],
  [state,stateSource+'\nfunction copiedSourceRead(db){db.prepare('+guard.expression+');}',/sql-cross-owner.*instance-state.ts.*source_connections.*read/],
  [control,controlSource+'\nfunction unregisteredRuntime(db){pluginControlSchema(db);}',/schema installer cannot acquire another runtime call path/],
  [control,controlSource.replace('function pluginControlSchema(db:DatabaseSync){','function pluginControlSchema(db:DatabaseSync){db.prepare(\'UPDATE source_connections SET json=json WHERE id=?\');'),/sql-schema-maintenance.*source_connections.*update/],
 ];
 for(const [file,changed,diagnostic]of cases){
  const original=file===control?controlSource:stateSource;assert.notEqual(changed,original);writeFileSync(resolve(root,file),changed);
  result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),original);
 }
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
