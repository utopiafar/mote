import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkSqlOwnership,sqlStatements} from './sql-ownership.mjs';
import {consumerScopes,sharedReads,schemaMaintenance} from './sql-ownership-policy.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url)),cli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
const archive='apps/server/src/source-archive.ts',context='apps/server/src/source-context.ts',pipeline='apps/server/src/source-pipelines.ts',schema='apps/server/src/source-state-schema.ts';

test('Source state owners cover proved scopes while regex, revocation, forgetting and the original joint publisher stay pending',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 for(const table of ['source_archive_sizes','source_archive_indexed_sources','source_archive_groups','source_archive_versions','source_archive_heads','source_archive_batches','source_archive_recovery_groups'])assert.equal(result.tables[table].owner,'source-archive');
 assert.equal(result.tables.source_context_declarations.owner,'source-context');
 for(const table of ['source_pipeline_bindings','source_pipeline_work','source_pipeline_config'])assert.equal(result.tables[table].owner,'source-pipeline');
 assert.ok(result.uncoveredFiles.includes(archive));assert.ok(result.uncoveredFiles.includes(pipeline));
 assert.equal(consumerScopes['source-archive.ts']['SourceArchive.physicalFiles'],undefined);
 assert.equal(consumerScopes['source-pipelines.ts']['SourcePipelineRuntime.revoke'],undefined);assert.equal(consumerScopes['source-pipelines.ts']['SourcePipelineRuntime.forget'],undefined);
 assert.ok(result.exceptions.some(issue=>issue.from===archive&&issue.scope==='SourceArchive.physicalFiles'&&issue.rule==='sql-uncovered-consumer'));
 assert.equal(result.exceptions.filter(issue=>issue.from===pipeline&&['SourcePipelineRuntime.revoke','SourcePipelineRuntime.forget'].includes(issue.scope)).length,11);
 const legacy=result.retainedClassificationDebt.find(item=>item.issue.from===context&&item.issue.scope==='SourceContextStore.set');
 assert.equal(legacy.originalRule,'sql-uncovered-table');assert.equal(legacy.issue.to,'source_context_declarations');assert.equal(legacy.issue.operation,'insert');assert.equal(legacy.issue.completeSql,true);
 assert.equal(legacy.issue.symbol,'8a86d33da7db56ad9b600ff5c33089ed8af48f7fda5134b4607d4ef267d5a274');assert.equal(legacy.issue.scopeFingerprint,'32606ba9704638f033d828f7b0ba3aa84230c420a913ea7850973d8df6b673d8');
 const reads=sharedReads.filter(item=>[pipeline,context].includes(item.from));assert.equal(reads.length,9);assert.ok(reads.every(item=>item.to==='source_connections'&&item.scope&&item.scopeFingerprint&&item.reason));
 assert.ok(!schemaMaintenance.some(item=>item.from===schema),'Source prerequisites grant no foreign maintenance effect');
});

test('production entry rejects Source foreign effects and mutations of pending or scoped read identities',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-source-state-ownership-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'}),original=new Map([archive,context,pipeline,schema].map(file=>[file,readFileSync(resolve(root,file),'utf8')]));
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Architecture boundaries passed/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baseline=readFileSync(baselinePath,'utf8');
 const revoke=sqlStatements(pipeline,original.get(pipeline)).find(statement=>statement.scope==='SourcePipelineRuntime.revoke');assert.ok(revoke);
 const cases=[
  [archive,original.get(archive).replace('hasSource(sourceId:string):boolean {','hasSource(sourceId:string):boolean {this.store.db.prepare(\'UPDATE source_connections SET json=json WHERE id=?\');'),/sql-cross-owner.*source-archive.ts.*source_connections.*write/],
  [pipeline,original.get(pipeline).replace('private projectWork(step:ExecutionStep){','private projectWork(step:ExecutionStep){this.store.db.prepare(\'UPDATE execution_steps SET fence=NULL WHERE id=?\');'),/sql-cross-owner.*source-pipelines.ts.*execution_steps.*write/],
  [schema,original.get(schema).replace('function sourceContextSchema(db:DatabaseSync){','function sourceContextSchema(db:DatabaseSync){db.prepare(\'UPDATE source_connections SET json=json WHERE id=?\');'),/sql-schema-maintenance.*source_connections.*update/],
  [context,original.get(context).replace('    const patch=sourceContextUpdateSchema.parse(input),current=this.current(sourceId);','    const generatedIdentity=true;void generatedIdentity;\n    const patch=sourceContextUpdateSchema.parse(input),current=this.current(sourceId);'),/sql-cross-owner.*source-context.ts.*source_context_declarations.*write/],
  [pipeline,original.get(pipeline).replace('private validWork(step:ExecutionStep){','private validWork(step:ExecutionStep){const generatedReadScope=true;void generatedReadScope;'),/sql-cross-owner.*source-pipelines.ts.*source_connections.*read/],
  [archive,original.get(archive)+"\nfunction unownedArchiveQuery(db){db.prepare('SELECT id FROM source_archive_heads');}",/sql-uncovered-consumer.*source-archive.ts/],
  [pipeline,original.get(pipeline)+'\nfunction copiedRevocation(db){db.prepare('+revoke.expression+');}',/sql-uncovered-consumer.*source-pipelines.ts/],
  [schema,original.get(schema)+'\nfunction unregisteredRuntime(db){sourcePipelineSchema(db);}',/schema installer cannot acquire another runtime call path/],
 ];
 for(const [file,changed,diagnostic]of cases){assert.notEqual(changed,original.get(file));writeFileSync(resolve(root,file),changed);result=run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,diagnostic);writeFileSync(resolve(root,file),original.get(file));}
 assert.equal(readFileSync(baselinePath,'utf8'),baseline);result=run();assert.equal(result.status,0,result.stderr);
});
