import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,appendFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {sqlAccesses,sqlStatements,ownershipInventory,checkSqlOwnership,issueKey} from './sql-ownership.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
const architectureCli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'mote-sql-owner-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const write=(file,text)=>{mkdirSync(resolve(root,file,'..'),{recursive:true});writeFileSync(resolve(root,file),text);};
 const configuration={installations:{'one.ts':['oneInstallation'],'two.ts':['twoInstallation']},consumers:{'consumer.ts':'one'},sharedReads:[]};
 write('apps/server/src/one.ts',"export const oneInstallation={owner:'one',install:one}; function one(db){db.exec('CREATE TABLE own_rows(id TEXT)');}");
 write('apps/server/src/two.ts',"export const twoInstallation={owner:'two',install:two}; function two(db){db.exec('CREATE TABLE other_rows(id TEXT)');}");
 write('apps/server/src/consumer.ts',"db.prepare('SELECT * FROM own_rows');");
 return {root,write,configuration,check:(baseline=[])=>checkSqlOwnership(root,{configuration,baseline})};
}
const rules=result=>result.violations.map(issue=>issue.rule);

test('SQL relation lexer distinguishes strings, comments, quoted names, CTE aliases, comma joins and nested reads',()=>{
 const sql=`WITH RECURSIVE visible(id) AS (SELECT id FROM "own_rows" WHERE note='FROM fake_rows'),
  other AS NOT MATERIALIZED (SELECT id FROM main.[other_rows])
  SELECT 'JOIN nonexistent' FROM visible v, other o WHERE EXISTS(SELECT 1 FROM \`deep_rows\` d)
  /* UPDATE fake_rows SET id=1 */ -- FROM hidden_rows
 `;
 assert.deepEqual(sqlAccesses(sql).accesses,[{table:'own_rows',kind:'read'},{table:'other_rows',kind:'read'},{table:'deep_rows',kind:'read'}]);
 assert.deepEqual(sqlAccesses('SELECT * FROM "from" JOIN "update" ON 1').accesses,[{table:'from',kind:'read'},{table:'update',kind:'read'}]);
 assert.deepEqual(sqlAccesses('SELECT * FROM external.own_rows').accesses,[{table:'external.own_rows',kind:'read'}]);
 assert.deepEqual(sqlAccesses('SELECT value FROM json_each(?)').accesses,[]);
 assert.deepEqual(sqlAccesses('SELECT * FROM material_fts(?)').accesses,[{table:'material_fts',kind:'read'}]);
 assert.deepEqual(sqlAccesses('SELECT * FROM 秘密').accesses,[{table:'秘密',kind:'read'}]);
 assert.ok(sqlAccesses('WITH settings AS (SELECT 1) SELECT * FROM settings; SELECT * FROM settings;').accesses.some(x=>x.table==='settings'));
 assert.ok(sqlAccesses('SELECT * FROM (WITH settings AS (SELECT 1) SELECT * FROM settings), settings;').accesses.some(x=>x.table==='settings'));
 assert.ok(sqlAccesses('SELECT * FROM settings WHERE EXISTS(WITH settings AS (SELECT 1) SELECT * FROM settings)').accesses.some(x=>x.table==='settings'));
});

test('writes, trigger effects and insert-select reads retain their individual access kinds',()=>{
 const accesses=sqlAccesses(`INSERT OR REPLACE INTO own_rows SELECT * FROM other_rows;
  UPDATE own_rows SET id=(SELECT id FROM deep_rows); DELETE FROM other_rows;
  CREATE TRIGGER relay AFTER INSERT ON own_rows BEGIN UPDATE deep_rows SET id=new.id; END;`).accesses;
 assert.ok(accesses.some(x=>x.table==='own_rows'&&x.kind==='write'));
 assert.ok(accesses.some(x=>x.table==='other_rows'&&x.kind==='read'));
 assert.ok(accesses.some(x=>x.table==='other_rows'&&x.kind==='write'));
 assert.ok(accesses.some(x=>x.table==='deep_rows'&&x.kind==='write'));
 const subscription=sqlAccesses('CREATE TEMP TRIGGER changed AFTER UPDATE ON memory_jobs BEGIN UPDATE memory_jobs SET json=json; END;').accesses;
 assert.ok(subscription.some(x=>x.table==='memory_jobs'&&x.kind==='observe'));
 assert.ok(subscription.some(x=>x.table==='memory_jobs'&&x.kind==='write'),'source DML inside a TEMP trigger remains a write');
});

test('AST proves immutable finite SQL, catches shadowed/dynamic arguments and follows local sink aliases',()=>{
 const source="const table='own_rows'; const sql=`SELECT * FROM ${table}`; const run=db.prepare; run(sql); function uncertain(table){db['prepare'](`SELECT * FROM ${table}`);} db.prepare(flag?'DELETE FROM own_rows':'DELETE FROM other_rows'); wrapper('SELECT * FROM other_rows');";
 const statements=sqlStatements('generated.ts',source);
 assert.ok(statements.some(x=>x.values.includes('SELECT * FROM own_rows')));
 assert.ok(statements.some(x=>x.values.includes('SELECT * FROM __dynamic__')));
 assert.ok(statements.some(x=>x.values.includes('DELETE FROM own_rows')&&x.values.includes('DELETE FROM other_rows')));
 assert.ok(statements.some(x=>x.values.includes('SELECT * FROM other_rows')));
 const before=sqlStatements('generated.ts',"const sql='SELECT * FROM own_rows'; db.prepare(sql);").at(0).fingerprint;
 const after=sqlStatements('generated.ts',"const sql='SELECT * FROM other_rows'; db.prepare(sql);").at(0).fingerprint;
 assert.notEqual(before,after,'constant contents, not just the identifier, are fingerprinted');
 assert.ok(sqlStatements('generated.ts',"const table='own_rows'; function read({table}){db.prepare(`SELECT * FROM ${table}`);}").some(x=>x.values.includes('SELECT * FROM __dynamic__')));
 assert.ok(sqlStatements('generated.ts','const run=db.prepare.bind(db); run(sql);').some(x=>x.values.includes('__dynamic__')));
 assert.throws(()=>sqlStatements('generated.ts','const = ;'),/generated.ts/);
 assert.throws(()=>sqlAccesses("SELECT * FROM own_rows /*"),/Unclosed SQL comment/);
});

test('generated owners and exact shared reads do not authorize new reads or any writes',t=>{
 const f=fixture(t);assert.deepEqual(rules(f.check()),[]);
 f.write('apps/server/src/consumer.ts',"db.prepare('SELECT * FROM other_rows');");
 const issue=f.check().violations[0];assert.equal(issue.rule,'sql-cross-owner');assert.equal(issue.kind,'read');
 f.configuration.sharedReads=[{from:issue.from,to:issue.to,symbol:issue.symbol,reason:'Generated read projection'}];
 assert.deepEqual(rules(f.check()),[]);
 f.write('apps/server/src/consumer.ts',"db.prepare('SELECT * FROM other_rows'); db.prepare('SELECT id FROM other_rows');");
 assert.deepEqual(rules(f.check()),['sql-cross-owner']);
 f.write('apps/server/src/consumer.ts',"db.prepare('UPDATE other_rows SET id=?');");
 assert.deepEqual(rules(f.check()),['sql-cross-owner']);assert.equal(f.check().violations[0].kind,'write');assert.equal(f.check().stale.length,1);
 f.configuration.sharedReads[0].kind='write';assert.throws(()=>f.check(),/only grant reads/);
});

test('uncovered files, unknown tables and dynamic SQL are concrete debt and a copied statement fails',t=>{
 const f=fixture(t);
 f.write('apps/server/src/new.ts',"db.prepare('SELECT * FROM own_rows');");
 f.write('apps/server/src/consumer.ts',"db.prepare('SELECT * FROM pending_rows'); db.prepare(sql);");
 const initial=f.check();assert.deepEqual(new Set(rules(initial)),new Set(['sql-uncovered-consumer','sql-uncovered-table','sql-dynamic']));
 assert.deepEqual(initial.uncoveredFiles,['apps/server/src/new.ts']);assert.ok(initial.uncoveredTables.includes('pending_rows'));
 const baseline=initial.violations.map(issue=>({...issue,reason:'Generated existing debt'}));
 assert.deepEqual(rules(f.check(baseline)),[]);
 f.write('apps/server/src/new.ts',"db.prepare('SELECT * FROM own_rows'); db.prepare('SELECT * FROM own_rows');");
 assert.deepEqual(rules(f.check(baseline)),['sql-uncovered-consumer'],'an identical copied SQL call is new debt');
 f.write('apps/server/src/new.ts','export {};');assert.equal(f.check(baseline).stale.length,1);
 assert.throws(()=>f.check([...baseline,baseline[0]]),/unique statement fingerprint/);
});

test('changes to an unresolved helper body cannot reuse its dynamic SQL exception',t=>{
 const f=fixture(t);f.write('apps/server/src/consumer.ts','function read(sql){return db.prepare(sql);}');
 const baseline=f.check().violations.map(issue=>({...issue,reason:'Generated unresolved helper'}));
 f.write('apps/server/src/consumer.ts','function read(sql){sql=transform(sql);return db.prepare(sql);}');
 assert.ok(rules(f.check(baseline)).includes('sql-dynamic'));
});

test('real production inventory and generated map stay in sync with explicit partial coverage',()=>{
 const result=checkSqlOwnership(repository);assert.deepEqual(result.violations,[]);assert.deepEqual(result.stale,[]);
 assert.equal(result.owners.length,20);assert.equal(Object.keys(result.tables).length,90);
 assert.ok(result.coveredFiles.includes('apps/server/src/material-index.ts'));
 assert.ok(result.coveredFiles.includes('apps/server/src/evidence-store.ts'));
 assert.ok(result.uncoveredFiles.includes('apps/server/src/execution-engine.ts'));
 assert.equal(result.tables.execution_steps.owner,'execution');assert.ok(result.dynamicStatements>0);
 assert.ok(result.retainedClassificationDebt.length>0);
 const projection=result.owners.find(owner=>owner.feature==='mote.activity');
 assert.equal(projection.objects.filter(object=>object.type==='table').length,9);
 assert.equal(projection.objects.filter(object=>object.type==='trigger').length,13);
 assert.ok(result.coveredFiles.includes(projection.file));assert.ok(result.uncoveredFiles.includes(projection.file),'only constructor and retirement scopes are covered');
 const map=JSON.parse(readFileSync(resolve(repository,'scripts/ci/sql-ownership-map.json'),'utf8'));
 assert.deepEqual(map,{owners:result.owners,tables:result.tables});
});

test('zero-argument lifecycle prepare has no SQL but the same method with SQL remains checked',()=>{
 assert.deepEqual(sqlStatements('generated.ts','service.prepare();'),[]);
 assert.equal(sqlStatements('generated.ts',"service.prepare('SELECT * FROM settings');").length,1);
});

test('projection helper proofs track SQL dependencies and mutation, not unrelated constructor work',()=>{
 const source="const states={ready:1,done:-1}; const rank=(value)=>`CASE ${value} ${Object.entries(states).map(([name,value])=>`WHEN '${name}' THEN ${value}`).join(' ')} END`; const columns=(ref)=>`${ref}.id,${rank(`${ref}.state`)}`; class Projection {constructor(){db.prepare(`SELECT ${columns('p')} FROM own_rows p`);}}";
 const options={finiteScopes:['Projection.constructor']};
 const before=sqlStatements('generated.ts',source,options).find(x=>x.scope==='Projection.constructor');
 assert.ok(!before.values[0].includes('__dynamic__'));assert.match(before.values[0],/WHEN 'done' THEN -1/);
 const unrelated=sqlStatements('generated.ts',source.replace('constructor(){','constructor(){const admitted=true;void admitted;'),options).find(x=>x.scope==='Projection.constructor');
 assert.equal(unrelated.fingerprint,before.fingerprint);
 const changed=sqlStatements('generated.ts',source.replace('`${ref}.id,','`(SELECT id FROM other_rows),${ref}.id,'),options).find(x=>x.scope==='Projection.constructor');
 assert.notEqual(changed.fingerprint,before.fingerprint);assert.ok(sqlAccesses(changed.values[0]).accesses.some(x=>x.table==='other_rows'));
 const mutation=sqlStatements('generated.ts',source+'states.done=2;',options).find(x=>x.scope==='Projection.constructor');
 assert.ok(mutation.values.some(sql=>sql.includes('__dynamic__')),'mutated const objects cannot be treated as finite facts');
 const aliased=sqlStatements('generated.ts',source+'const alias=states;alias.done=2;',options).find(x=>x.scope==='Projection.constructor');
 assert.ok(aliased.values.some(sql=>sql.includes('__dynamic__')));
 const escaped=sqlStatements('generated.ts',source+'unknownMutation(states);',options).find(x=>x.scope==='Projection.constructor');
 assert.ok(escaped.values.some(sql=>sql.includes('__dynamic__')));
});

test('finite installer strings prove array maps, pure return functions and correlated iteration without granting fragments',t=>{
 const f=fixture(t);f.configuration.finiteInstallations=['oneInstallation'];
 f.write('apps/server/src/one.ts',"export const oneInstallation={owner:'one',install:one}; const columns=['first','second']; function suffix(value){return `${value} TEXT`;} function one(db){db.exec(`CREATE TABLE own_rows(${columns.map(name=>suffix(name)).join(',')})`);for(const table of ['own_rows','other_rows'])db.exec(`CREATE TRIGGER ${table}_changed AFTER UPDATE ON ${table} BEGIN SELECT 1; END;`);}");
 const result=f.check(),effects=result.violations.filter(x=>x.rule==='sql-schema-maintenance');
 assert.equal(effects.length,1);assert.equal(effects[0].to,'other_rows');assert.equal(effects[0].kind,'observe');
 assert.deepEqual(effects[0].sourceRelations,['other_rows']);
 assert.deepEqual(sqlStatements('generated.ts',"function one(db){for(const table of ['a','b'])db.exec(`CREATE TRIGGER ${table}_changed AFTER UPDATE ON ${table} BEGIN SELECT 1; END;`);}",{finiteScopes:['one']}).find(x=>x.sink).values,[
  'CREATE TRIGGER a_changed AFTER UPDATE ON a BEGIN SELECT 1; END;', 'CREATE TRIGGER b_changed AFTER UPDATE ON b BEGIN SELECT 1; END;',
 ]);
});

test('schema maintenance is exact to SQL operation, relation, installer and direct db helper path',t=>{
 const f=fixture(t);f.configuration.finiteInstallations=['oneInstallation'];
 const original="export const oneInstallation={owner:'one',install:one};function one(db){helper(db);}function helper(db){db.exec('CREATE TABLE own_rows(id TEXT); CREATE TRIGGER sync AFTER UPDATE ON own_rows BEGIN UPDATE other_rows SET id=new.id; END;');}";
 f.write('apps/server/src/one.ts',original);
 const issue=f.check().violations.find(x=>x.rule==='sql-schema-maintenance');assert.equal(issue.kind,'update');assert.deepEqual(issue.callPath,['oneInstallation','one','helper']);
 f.configuration.schemaMaintenance=[{...issue,reason:'Generated schema maintenance'}];assert.deepEqual(rules(f.check()),[]);
 for(const changed of [original.replace('UPDATE other_rows SET id=new.id','DELETE FROM other_rows'),original.replace('UPDATE other_rows','UPDATE missing_rows')]){
  f.write('apps/server/src/one.ts',changed);assert.ok(rules(f.check()).includes('sql-schema-maintenance'));
 }
 f.write('apps/server/src/one.ts',original.replace('helper(db);','helper(db);helper(db);'));assert.throws(()=>f.check(),/one concrete construction call/);
 const duplicate=original.replace(" END;');", " END;');db.exec('CREATE TABLE own_rows(id TEXT); CREATE TRIGGER sync AFTER UPDATE ON own_rows BEGIN UPDATE other_rows SET id=new.id; END;');");
 f.write('apps/server/src/one.ts',duplicate);assert.ok(rules(f.check()).includes('sql-schema-maintenance'),'copied maintenance SQL is another occurrence');
 f.write('apps/server/src/one.ts',original+'function runtime(db){helper(db);}');assert.throws(()=>f.check(),/another call path/);
 f.write('apps/server/src/one.ts',original+'function runtime(db){one(db);}');assert.throws(()=>f.check(),/installer cannot acquire another runtime call path/);
 f.write('apps/server/src/one.ts',original+'const alias=helper;');assert.throws(()=>f.check(),/another call path/);
 f.write('apps/server/src/one.ts',original.replace('helper(db);','db=externalDb;helper(db);'));assert.throws(()=>f.check(),/schema db parameter/);
 f.write('apps/server/src/one.ts',original.replace('helper(db);','const alias=db;helper(alias);'));assert.throws(()=>f.check(),/schema db parameter/);
 f.write('apps/server/src/one.ts',original.replace('helper(db);','(()=>helper(db))();'));assert.throws(()=>f.check(),/no visible SQL/);
 f.write('apps/server/src/one.ts',original.replace("db.exec('CREATE TABLE", "db.exec(externalSql);db.exec('CREATE TABLE"));assert.throws(()=>f.check(),/must be static/);
});

test('owner registration retains only witnessed exact unresolved debt and rejects new scope, occurrence, table and operation',t=>{
 const f=fixture(t);delete f.configuration.installations['two.ts'];
 f.write('apps/server/src/consumer.ts',"function read(db){db.prepare('SELECT * FROM other_rows');}");
 const issue=f.check().violations.find(x=>x.rule==='sql-uncovered-table'),baseline=[{...issue,reason:'Generated existing unresolved relation'}];
 f.configuration.installations['two.ts']=['twoInstallation'];
 assert.ok(rules(f.check(baseline)).includes('sql-cross-owner'),'no scope witness means no classification fallback');
 const refined=f.check(baseline).violations.find(x=>x.rule==='sql-cross-owner');
 f.configuration.retainedClassificationScopes=[{...refined,operation:undefined}];assert.ok(rules(f.check(baseline)).includes('sql-cross-owner'),'an unknown operation cannot be refined');
 f.configuration.retainedClassificationScopes=[refined];
 assert.deepEqual(rules(f.check(baseline)),[]);assert.equal(f.check(baseline).retainedClassificationDebt.length,1);
 const baselineBytes=JSON.stringify(baseline);
 for(const source of ["function read(db){db.prepare('UPDATE other_rows SET id=?');}","function read(db){db.prepare('SELECT * FROM own_rows');}","function moved(db){db.prepare('SELECT * FROM other_rows');}","function read(db){db.prepare('SELECT * FROM other_rows');db.prepare('SELECT * FROM other_rows');}"]){
  f.write('apps/server/src/consumer.ts',source);const result=f.check(baseline);assert.ok(result.violations.length||result.stale.length);assert.equal(result.retainedClassificationDebt.length,0);
 }
 assert.equal(JSON.stringify(baseline),baselineBytes);
});

test('actual CLI rejects an inserted cross-owner query in a copy of the production source, permits the existing shared model, and cleans up',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-sql-production-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 // Copy tracked code/config only, never profiles, dependencies or user data.
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}

 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 const architecture=()=>spawnSync(process.execPath,[architectureCli],{cwd:root,encoding:'utf8'});
 let result=architecture();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PARTIAL coverage/);assert.match(result.stdout,/Architecture boundaries passed/);
 const mapPath=resolve(root,'scripts/ci/sql-ownership-map.json'),map=readFileSync(mapPath,'utf8');
 writeFileSync(mapPath,'{}');result=run();assert.equal(result.status,1);assert.match(result.stderr,/map is stale/);writeFileSync(mapPath,map);
 const projectionPath=resolve(root,'apps/server/src/activity-memory-index.ts'),projectionSource=readFileSync(projectionPath,'utf8');
 const constructor='constructor(private store:Store){';
 writeFileSync(projectionPath,projectionSource.replace(constructor,constructor+'\n const generatedAdmission=true;void generatedAdmission;'));
 result=run();assert.equal(result.status,0,result.stderr);
 writeFileSync(projectionPath,projectionSource.replace(constructor,constructor+"\n store.db.prepare('UPDATE memory_jobs SET json=json WHERE id=?');"));
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner.*activity-memory-index.ts.*memory_jobs.*write/);
 writeFileSync(projectionPath,projectionSource.replace('FROM ${from}json_each','FROM settings hidden,${from}json_each'));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner.*activity-memory-index.ts.*settings/);
 writeFileSync(projectionPath,projectionSource.replace('"activity_memory_source_insert",','"foreign_trigger",'));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-uncovered-table.*foreign_trigger/);
 writeFileSync(projectionPath,projectionSource.replace('CREATE TABLE IF NOT EXISTS activity_memory_jobs(', 'CREATE TABLE IF NOT EXISTS changed_projection_jobs('));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/map is stale/);
 writeFileSync(projectionPath,projectionSource+'\nretireActivityMemorySubscriptions({} as Store, computedSchema as any);');
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/requires a proved literal schema argument/);
 writeFileSync(projectionPath,projectionSource+'\nconst escapedRetirement=retireActivityMemorySubscriptions;');
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/cannot escape its checked call boundary/);
 writeFileSync(projectionPath,projectionSource);
 const activationPath=resolve(root,'apps/server/src/plugins/activity-services.ts'),activationSource=readFileSync(activationPath,'utf8');
 writeFileSync(activationPath,activationSource.replace("featureId:'mote.activity'","featureId:'mote.changed'"));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/actual production feature activation/);writeFileSync(activationPath,activationSource);
 const operationsPath=resolve(root,'apps/server/src/operation-projection.ts'),operationsSource=readFileSync(operationsPath,'utf8');
 writeFileSync(operationsPath,operationsSource+'\nfunction generatedRuntimeCaller(db:DatabaseSync){installOperationHierarchy(db);}');
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/schema db helper cannot inherit installer authority/);
 writeFileSync(operationsPath,operationsSource.replace('DELETE FROM execution_operation_steps WHERE step_id=old.id','DELETE FROM execution_steps WHERE id=old.id'));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-schema-maintenance.*execution_steps.*delete/);
 writeFileSync(operationsPath,operationsSource);
 const evidencePath=resolve(root,'apps/server/src/task-evidence.ts'),evidenceSource=readFileSync(evidencePath,'utf8');
 writeFileSync(evidencePath,evidenceSource.replace('UPDATE task_records SET','UPDATE memories SET'));
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-schema-maintenance.*memories.*update/);writeFileSync(evidencePath,evidenceSource);
 const target=resolve(root,'apps/server/src/material-index.ts'),original=readFileSync(target,'utf8');
 appendFileSync(target,"\nfunction generatedOwnershipNegative(db){db.prepare('SELECT value FROM settings WHERE key=?');}\n");
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner: apps\/server\/src\/material-index.ts.*settings/);
 writeFileSync(target,original);result=run();assert.equal(result.status,0,result.stderr);
 appendFileSync(target,'\nfunction generatedDynamicNegative(db,sql){db.prepare(sql); }\n');
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-dynamic.*material-index.ts/);writeFileSync(target,original);
 appendFileSync(target,"\nfunction generatedOwnRead(db){db.prepare('SELECT id FROM material_heads LIMIT 1');}\n");
 result=run();assert.equal(result.status,0,result.stderr);
 const unexpected=resolve(root,'apps/server/src/generated-new-consumer.ts');writeFileSync(unexpected,"db.prepare('SELECT id FROM material_heads');\n");
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-uncovered-consumer.*generated-new-consumer/);
});
