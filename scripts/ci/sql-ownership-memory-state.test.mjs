import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {retainedClassificationScopes} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));

test('Memory state production owners and exact reads reject new writes, changed bodies and foreign trigger effects',{timeout:120000},t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-sql-memory-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const files=execFileSync('git',['ls-files','-z','--','apps/server/src'],{cwd:repository,encoding:'utf8'}).split('\0').filter(Boolean);
 for(const file of [...files,'scripts/ci/sql-ownership-map.json','scripts/ci/sql-ownership-baseline.json']){
  mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));
 }
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const map=JSON.parse(readFileSync(resolve(root,'scripts/ci/sql-ownership-map.json'),'utf8'));
 for(const [table,owner] of [['memory_input_authorizations','memory-input-authorization'],['memory_extraction_drafts','memory-extraction-drafts'],['memory_phase_outputs','memory-phase-outputs']])assert.equal(map.tables[table]?.owner,owner);
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8',timeout:120000});
 const positive=run();assert.equal(positive.status,0,positive.stderr);assert.match(positive.stdout,/SQL ownership: \d+ schema owners/);assert.match(positive.stdout,/4 write-unproved pending/);
 assert.deepEqual(retainedClassificationScopes.filter(item=>item.from==='apps/server/src/material-memory-work.ts'),[
  {rule:'sql-uncovered-table',from:'apps/server/src/material-memory-work.ts',to:'memory_input_authorizations',kind:'write',symbol:'4519c685db0ff9e34515bd3054321837fdf0d9477526b80d152e1145d1b7b548',scope:'MaterialMemoryWork.constructor',scopeFingerprint:'2220edebc9aa3497c04ff01e2b53d46e6d96ca81904b97ea16b36b758991ddbe',operation:'delete',completeSql:true},
 ]);
 const phasePath=resolve(root,'apps/server/src/memory-phase-outputs.ts'),phase=readFileSync(phasePath,'utf8');
 const variants=[
  [phasePath,phase.replace('retryReview(batchId:string,ownerAction:boolean){','retryReview(batchId:string,ownerAction:boolean){\n void ownerAction;'),/sql-cross-owner.*memory-phase-outputs.ts.*execution_steps.*read/],
  [phasePath,phase.replace('retryReview(batchId:string,ownerAction:boolean){',"retryReview(batchId:string,ownerAction:boolean){\n this.store.db.prepare('UPDATE execution_steps SET state=state WHERE id=?').run(batchId);"),/sql-cross-owner.*memory-phase-outputs.ts.*execution_steps.*write/],
  [phasePath,phase.replace('DELETE FROM memory_phase_outputs WHERE batch_id=new.id;','DELETE FROM execution_steps WHERE id=new.id;'),/sql-schema-maintenance.*memory-phase-outputs.ts.*execution_steps.*delete/],
 ];
 const draftPath=resolve(root,'apps/server/src/memory-extraction-drafts.ts'),draft=readFileSync(draftPath,'utf8');
 variants.push([draftPath,draft.replace('get(batchId:string,inputHash:string,shared=false):QueryResult|undefined {',"get(batchId:string,inputHash:string,shared=false):QueryResult|undefined {\n this.store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(batchId);"),/sql-cross-owner.*memory-extraction-drafts.ts.*memory_jobs.*read/]);
 const materialPath=resolve(root,'apps/server/src/material-memory-work.ts'),material=readFileSync(materialPath,'utf8');
 variants.push([materialPath,material.replace('this.priorContextChanged=materials.onContextChanged;','void newInputAdmission;this.priorContextChanged=materials.onContextChanged;'),/sql-cross-owner.*material-memory-work.ts.*memory_input_authorizations.*write/]);
 for(const [path,source,expected] of variants){
  const original=readFileSync(path,'utf8');assert.notEqual(source,original,'the production mutation must reach its exact target');
  writeFileSync(path,source);try{const denied=run();assert.equal(denied.status,1,denied.stderr);assert.match(denied.stderr,expected);assert.equal(readFileSync(baselinePath,'utf8'),baseline);}finally{writeFileSync(path,original);}
 }
 const restored=run();assert.equal(restored.status,0,restored.stderr);assert.equal(readFileSync(baselinePath,'utf8'),baseline);
});
