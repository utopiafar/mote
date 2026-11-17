import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkSqlOwnership} from './sql-ownership.mjs';
import {consumerScopes,finiteInstallations,sharedReads,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
const insight='apps/server/src/insight-runs.ts',record='apps/server/src/record-context.ts',schema='apps/server/src/auxiliary-state-schema.ts';

test('auxiliary owners cover their own scopes while Insight cross-owner reads stay pending',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.equal(result.tables.insight_runs.owner,'insight-runs');assert.equal(result.tables.insight_runs.installer,'insightRunsSchemaInstallation');
 assert.equal(result.tables.record_context_declarations.owner,'record-context');assert.equal(result.tables.record_context_declarations.installer,'recordContextSchemaInstallation');
 assert.ok(result.coveredFiles.includes(insight)&&result.uncoveredFiles.includes(insight),'only own-table runtime methods are covered');
 assert.ok(result.coveredFiles.includes(record)&&!result.uncoveredFiles.includes(record));
 assert.ok(result.exceptions.filter(issue=>issue.from===insight).every(issue=>issue.rule==='sql-uncovered-consumer'));
 assert.equal(result.exceptions.filter(issue=>issue.from===record).length,6);
 assert.ok(result.exceptions.filter(issue=>issue.from===record).every(issue=>issue.rule==='sql-cross-owner'&&issue.kind==='read'&&['captures','file_evidence_links'].includes(issue.to)));
 assert.equal(result.retainedClassificationDebt.filter(item=>[insight,record,schema].includes(item.issue.from)).length,0);
 assert.equal(result.pendingRawWrites.filter(issue=>[insight,record,schema].includes(issue.from)).length,0);
 assert.deepEqual(consumerScopes['insight-runs.ts'],{'InsightRuns.save':'insight-runs','InsightRuns.raw':'insight-runs','InsightRuns.list':'insight-runs','InsightRuns.start':'insight-runs'});
 assert.deepEqual(consumerScopes['record-context.ts'],{'RecordContextStore.constructor':'record-context','RecordContextStore.bind':'record-context','RecordContextStore.insert':'record-context','RecordContextStore.identities':'record-context','RecordContextStore.open':'record-context','RecordContextStore.export':'record-context','RecordContextStore.restore':'record-context'});
 const reads=sharedReads.filter(item=>item.from===record);assert.equal(reads.length,6);assert.ok(reads.every(item=>['captures','file_evidence_links'].includes(item.to)&&item.scope&&item.scopeFingerprint&&item.reason));
 assert.ok(finiteInstallations.includes('insightRunsSchemaInstallation'));assert.ok(finiteInstallations.includes('recordContextSchemaInstallation'));
 assert.ok(!schemaMaintenance.some(item=>item.from===schema),'auxiliary installers grant no foreign maintenance effect');
});

test('production entry rejects auxiliary foreign effects, copied reads and raw installer runtime calls',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-auxiliary-state-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 cpSync(resolve(repository,'apps/server/src'),resolve(root,'apps/server/src'),{recursive:true});
 cpSync(resolve(repository,'scripts/ci'),resolve(root,'scripts/ci'),{recursive:true});
 symlinkSync(resolve(repository,'node_modules'),resolve(root,'node_modules'),'dir');
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SQL ownership: 36 schema owners/);assert.match(result.stdout,/125 tables\/views/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const originals=new Map([insight,record,schema].map(file=>[file,readFileSync(resolve(root,file),'utf8')]));
 const cases=[
  [record,originals.get(record).replace('bind(captureId:string,description:string|undefined,duplicate:boolean){',"bind(captureId:string,description:string|undefined,duplicate:boolean){this.store.db.prepare('UPDATE captures SET fingerprint=fingerprint WHERE id=?').run(captureId);"),/sql-cross-owner.*record-context.ts.*captures.*write/],
  [insight,originals.get(insight).replace('private save(run:InsightRun){',"private save(run:InsightRun){this.store.db.prepare('SELECT json FROM insights LIMIT 1').get();"),/sql-cross-owner.*insight-runs.ts.*insights.*read/],
  [record,originals.get(record).replace('SELECT l.parent_id FROM file_evidence_links l',"SELECT l.parent_id FROM settings l"),/sql-cross-owner.*record-context.ts.*settings.*read/],
  [schema,originals.get(schema)+'\nfunction generatedRuntime(db:DatabaseSync){recordContextSchema(db);}',/schema installer cannot acquire another runtime call path/],
  [record,originals.get(record)+"\nfunction generatedUnownedRead(db){db.prepare('SELECT description FROM record_context_declarations LIMIT 1');}",/sql-uncovered-consumer.*record-context.ts/],
 ];
 for(const [file,changed,diagnostic]of cases){
  const original=originals.get(file);assert.notEqual(changed,original);writeFileSync(resolve(root,file),changed);
  result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);assert.equal(readFileSync(baselinePath,'utf8'),baseline);writeFileSync(resolve(root,file),original);
 }
 const restored=run();assert.equal(restored.status,0,restored.stderr);assert.equal(readFileSync(baselinePath,'utf8'),baseline);
});
