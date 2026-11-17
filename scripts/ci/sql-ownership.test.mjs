import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,appendFileSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {nonSqlCalls,importedHelpers,storageConstructions} from './sql-ownership-policy.mjs';
import * as policy from './sql-ownership-policy.mjs';
import {spawnSync,execFileSync} from 'node:child_process';
import {sqlAccesses,sqlStatements,ownershipInventory,checkSqlOwnership,issueKey} from './sql-ownership.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
const architectureCli=fileURLToPath(new URL('./architecture.mjs',import.meta.url));
// Frozen original 0b69 statements, including their original enclosing bodies.
const originalPendingWrites=[
 {symbol:'27b6a3fef209a72d4c9948043b844600def67489e72967085d22ffefd8d8dfff',scope:'EvidenceStore.invalidateConversationAnswers',scopeFingerprint:'6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0',to:'conversation_turns',knownRawTargetOwner:'conversation-turn-storage'},
 {symbol:'6dc7d5da2aae87bc877b4a581e069faf9f1fcb91726833c4e4cf9c8407266f23',scope:'EvidenceStore.installContextHistoryInvalidation',scopeFingerprint:'f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0',to:'conversation_turns',knownRawTargetOwner:'conversation-turn-storage'},
 {symbol:'b340e894b67fac3c9910715ca8dfadeb92492285fb9f1751372247435b551ebd',scope:'EvidenceStore.invalidateConversationAnswers',scopeFingerprint:'6e2e4efe1ac8041556affb8d01b7282696584fb354237e821709df85db30aea0',to:'conversation_turns',knownRawTargetOwner:'conversation-turn-storage'},
 {symbol:'28af07719a5d788f47a7da12619447756846cb0eec3442aa3e68f639855ba287',scope:'EvidenceStore.installContextHistoryInvalidation',scopeFingerprint:'f797f6e69796dbd65bee11aa68eba1b28ad94b26ea774970d81d2db5dba2c4b0',to:'query_runs',knownRawTargetOwner:'query-run-storage'},
];
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

test('CTEs shadow only unqualified reads, never schema-qualified relations or DML targets',()=>{
 assert.deepEqual(sqlAccesses('WITH settings AS (SELECT 1) SELECT * FROM settings').accesses,[]);
 for(const sql of ['WITH settings AS (SELECT 1) SELECT value FROM main.settings','WITH "settings" AS (SELECT 1) SELECT value FROM main."settings"'])assert.deepEqual(sqlAccesses(sql).accesses,[{table:'settings',kind:'read'}]);
 for(const sql of ['WITH settings AS (SELECT 1) DELETE FROM main.settings','WITH settings AS (SELECT 1) DELETE FROM settings','WITH settings AS (SELECT 1) UPDATE settings SET value=?','WITH settings AS (SELECT 1) INSERT INTO main.settings VALUES(?)'])assert.deepEqual(sqlAccesses(sql).accesses,[{table:'settings',kind:'write'}]);
});

test('computed prepare and exec methods use finite immutable lexical constants to retain unknown SQL boundaries',t=>{
 for(const source of ["const method='prepare';db[method](sql);","const prefix='pre';const method=(prefix+'pare') as const;const alias=method;db[alias](sql);","const method=flag?'prepare':'exec';db[method](sql);"]){
  const statements=sqlStatements('generated.ts',source);assert.equal(statements.length,1);assert.deepEqual(statements[0].values,['__dynamic__']);
 }
 const f=fixture(t);f.write('apps/server/src/consumer.ts',"const method='prepare';function read(db,sql){return db[method](sql);}");assert.deepEqual(rules(f.check()),['sql-dynamic']);
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

test('named consumer scopes and scoped shared reads cannot move authority to another method',t=>{
 const f=fixture(t);delete f.configuration.consumers['consumer.ts'];f.configuration.consumerScopes={'consumer.ts':{read:'one'}};
 const source="function read(db){db.prepare('SELECT * FROM other_rows');}";f.write('apps/server/src/consumer.ts',source);
 const issue=f.check().violations[0];f.configuration.sharedReads=[{from:issue.from,to:issue.to,symbol:issue.symbol,scope:issue.scope,scopeFingerprint:issue.scopeFingerprint,reason:'Generated bounded read'}];assert.deepEqual(rules(f.check()),[]);
 f.write('apps/server/src/consumer.ts',source.replace('function read','function moved'));assert.deepEqual(rules(f.check()),['sql-uncovered-consumer']);assert.equal(f.check().stale.length,1);
 f.configuration.consumerScopes['consumer.ts'].moved='one';assert.deepEqual(rules(f.check()),['sql-cross-owner'],'an identical SQL argument in a changed scope does not reuse the read grant');
 f.write('apps/server/src/consumer.ts',source+"\nfunction unrelated(db){db.prepare('SELECT * FROM own_rows');}");assert.deepEqual(rules(f.check()),['sql-uncovered-consumer']);
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
 assert.equal(result.owners.length,44);assert.equal(Object.keys(result.tables).length,132);
 assert.deepEqual(result.owners.filter(owner=>owner.owner==='actions').map(owner=>owner.declaration),['actionsSchemaInstallation','actionsExecutionSchemaInstallation','actionsRetirementSchemaInstallation']);
 for(const table of ['action_meta','action_proposals','action_semantic_checkpoints','action_targets','action_jobs','action_chunk_changes'])assert.deepEqual(result.tables[table],{owner:'actions',file:'apps/server/src/actions-schema.ts',installer:'actionsSchemaInstallation'});
 assert.ok(result.coveredFiles.includes('apps/server/src/material-index.ts'));
 assert.ok(result.coveredFiles.includes('apps/server/src/evidence-store.ts'));
 assert.ok(result.uncoveredFiles.includes('apps/server/src/execution-engine.ts'));
 assert.equal(result.tables.execution_steps.owner,'execution');assert.ok(result.dynamicStatements>0);
 assert.ok(result.retainedClassificationDebt.length>0);assert.equal(result.nonSqlCalls.length,4);
 assert.equal(result.tables.assistant_task_runtime.owner,'assistant-task-runtime');assert.equal(result.owners.filter(owner=>owner.construction).length,3);
 assert.deepEqual(result.pendingRawWrites.map(({symbol,scope,scopeFingerprint,to,knownRawTargetOwner})=>({symbol,scope,scopeFingerprint,to,knownRawTargetOwner})),originalPendingWrites);
 assert.ok(result.pendingRawWrites.every(issue=>issue.rule==='sql-unproved-relation'&&issue.kind==='write'&&issue.completeSql===false),'known raw targets do not authorize these unproved writes');
 const projection=result.owners.find(owner=>owner.feature==='mote.activity');
 assert.equal(projection.objects.filter(object=>object.type==='table').length,9);
 assert.equal(projection.objects.filter(object=>object.type==='trigger').length,13);
 assert.ok(result.coveredFiles.includes(projection.file));assert.ok(result.uncoveredFiles.includes(projection.file),'only constructor and retirement scopes are covered');
 const map=JSON.parse(readFileSync(resolve(repository,'scripts/ci/sql-ownership-map.json'),'utf8'));
 assert.deepEqual(map,{owners:result.owners,tables:result.tables});
});

test('original unproved writes need their exact pending witness and raw construction, and never become write grants',()=>{
 const baseline=JSON.parse(readFileSync(resolve(repository,'scripts/ci/sql-ownership-baseline.json'),'utf8'));
 for(const configuration of [{...policy,retainedClassificationScopes:policy.retainedClassificationScopes.filter(item=>item.classification!=='write-unproved-pending')},{...policy,storageConstructions:policy.storageConstructions.map(item=>item.owner==='query-run-storage'?{...item,owner:'changed-query-run-storage'}:item)}]){
  const result=checkSqlOwnership(repository,{configuration,baseline});assert.ok(result.violations.some(issue=>issue.rule==='sql-cross-owner'&&issue.kind==='write'&&originalPendingWrites.some(original=>original.symbol===issue.symbol)));assert.ok(result.pendingRawWrites.length<4);
 }
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

test('literal method and arrow installers keep only direct db construction and fully proved private string builders',t=>{
 const f=fixture(t);f.configuration.finiteInstallations=['oneInstallation'];
 for(const member of ["install(db){schema(db);}","install:db=>{schema(db);}"]){
  const source=`export const oneInstallation={owner:'one',${member}};function schema(db){const insert=(value)=>\`INSERT INTO own_rows VALUES('\${value}')\`;db.exec('CREATE TABLE own_rows(id TEXT)');db.exec(insert('generated'));}`;
  f.write('apps/server/src/one.ts',source);assert.deepEqual(rules(f.check()),[]);assert.equal(f.check().tables.own_rows.owner,'one');
  f.write('apps/server/src/one.ts',source.replace("db.exec(insert('generated'));","db.exec(insert('generated'));publish(insert);"));assert.ok(rules(f.check()).includes('sql-uncovered-consumer'),'a string builder cannot escape into runtime authority');
  f.write('apps/server/src/one.ts',source+'function runtime(db){schema(db);}');assert.throws(()=>f.check(),/another call path/);
  f.write('apps/server/src/one.ts',source+'oneInstallation.install(db);');assert.throws(()=>f.check(),/inline installer cannot escape/);
  f.write('apps/server/src/one.ts',source.replace('schema(db);','(()=>schema(db))();'));assert.throws(()=>f.check(),/no visible SQL/);
 }
});

test('a non-SQL registration callback needs the exact local type, binding, complete call and scope proof',()=>{
 const proof=nonSqlCalls[0],source=readFileSync(resolve(repository,proof.from),'utf8'),evidence=[];
 const original=sqlStatements(proof.from,source,{nonSqlProofs:[proof],nonSqlEvidence:evidence});assert.equal(evidence.length,1);assert.equal(original.filter(statement=>statement.scope===proof.scope).length,0);
 const call='entry.prepare?.(clone(value), clone(value))';
 for(const changed of [source.replace(call,"entry.prepare?.('SELECT value FROM settings', clone(value))"),source.replace('const entry: RegisteredDomain = { ...domain,','const entry: RegisteredDomain = { ...database,'),source.replace(call,call+';candidate = await '+call)]){
  const rejected=[];const statements=sqlStatements(proof.from,changed,{nonSqlProofs:[proof],nonSqlEvidence:rejected});assert.equal(rejected.length,0);assert.ok(statements.some(statement=>statement.scope===proof.scope),'changed callbacks remain subject to sink checks');
 }
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE settings(value TEXT);INSERT INTO settings VALUES('generated-proof-value')");const entry=db;assert.equal(entry.prepare('SELECT value FROM settings').get().value,'generated-proof-value');}finally{db.close();}
});

test('Task prepare adapters require their imported class binding and exact implementation, and keep nested database sinks visible',()=>{
 const proofs=nonSqlCalls.filter(proof=>proof.kind==='class-method'),sources=new Map(proofs.flatMap(proof=>[proof.from,proof.definitionFile]).map(file=>[file,readFileSync(resolve(repository,file),'utf8')]));
 assert.equal(proofs.length,3);
 for(const proof of proofs){
  const source=sources.get(proof.from),evidence=[];
  sqlStatements(proof.from,source,{nonSqlProofs:[proof],nonSqlEvidence:evidence,sourceTexts:sources});assert.equal(evidence.length,1);
  const call=proof.receiver==='this.questions'?'this.questions.prepare(this.steering?.prepare(input,this.steeringWork(task.id))??input,this.questionWork(task.id))':proof.receiver==='this.steering'?'this.steering?.prepare(input,this.steeringWork(task.id))':'assistantTasks.prepare(input)';
  assert.ok(source.includes(call));
  for(const changed of [source.replace(call,call.replace('input',"'SELECT value FROM settings'")),source.replace(call,'('+call+','+call+')'),source+'\nfunction generatedDatabaseReceiver(db,sql){const sameName=db;return sameName.prepare(sql);}']){
   const rejected=[],statements=sqlStatements(proof.from,changed,{nonSqlProofs:[proof],nonSqlEvidence:rejected,sourceTexts:sources});assert.equal(rejected.length,0);assert.ok(statements.some(statement=>statement.values.includes('__dynamic__')||statement.values.some(value=>value.includes('SELECT value FROM settings'))));
  }
  const changedSources=new Map(sources);changedSources.set(proof.definitionFile,sources.get(proof.definitionFile)+'\nexport const changedImplementation=true;');const rejected=[];
  sqlStatements(proof.from,source,{nonSqlProofs:[proof],nonSqlEvidence:rejected,sourceTexts:changedSources});assert.equal(rejected.length,0);
 }
 const db=new DatabaseSync(':memory:');try{db.exec("CREATE TABLE settings(value TEXT);INSERT INTO settings VALUES('generated-task-receiver')");const assistantTasks=db;assert.equal(assistantTasks.prepare('SELECT value FROM settings').get().value,'generated-task-receiver');}finally{db.close();}
});

test('the imported retirement helper proves only its exact literal constructor call and rejects alias, definition and argument changes',()=>{
 const proof=importedHelpers[0],source=readFileSync(resolve(repository,proof.from),'utf8'),definition=readFileSync(resolve(repository,proof.definitionFile),'utf8'),sources=new Map([[proof.definitionFile,definition]]);
 const options={finiteScopes:[proof.scope],importedHelpers:[proof],sourceTexts:sources};
 const statements=sqlStatements(proof.from,source,options),statement=statements.find(item=>item.scope===proof.scope&&item.sink&&item.values.some(value=>value.includes('CREATE TABLE')));
 assert.ok(statement.values.every(value=>!value.includes('__dynamic__')));assert.ok(statement.values[0].includes("UPDATE task_records SET state='stale'"));
 assert.ok(statements.some(item=>item.scope==='AssistantTasks.retire'&&item.values.includes('__dynamic__')),'runtime calls do not inherit constructor proof');
 for(const changed of [source+'\nconst escapedRetirement=retireTaskRecordsSql;',source.replace("retireTaskRecordsSql('SELECT task_id FROM assistant_task_turns WHERE turn_id=old.id AND conversation_id=old.conversation_id')",'retireTaskRecordsSql(selection)'),source.replace('retireTaskRecordsSql,taskEvidenceIds','retireTaskRecordsSql as renamedRetirement,taskEvidenceIds')])assert.throws(()=>sqlStatements(proof.from,changed,options),/imported SQL helper/);
 const changedSources=new Map([[proof.definitionFile,definition.replace('UPDATE task_records SET', 'UPDATE captures SET')]]);assert.throws(()=>sqlStatements(proof.from,source,{...options,sourceTexts:changedSources}),/exact pure definition/);
});

test('existing storage claims bind only actual DDL sinks and their production construction paths',t=>{
 for(const construction of storageConstructions){
  const f=fixture(t),target='apps/server/src/'+construction.file,source=readFileSync(resolve(repository,target),'utf8');f.write(target,source);
  for(const call of construction.calls)f.write(call.from,readFileSync(resolve(repository,call.from),'utf8'));
  const helpers=importedHelpers.filter(proof=>proof.from===target);for(const proof of helpers)f.write(proof.definitionFile,readFileSync(resolve(repository,proof.definitionFile),'utf8'));
  const configuration={installations:{},consumers:{},sharedReads:[],storageConstructions:[construction],importedHelpers:helpers};
  let inventory=ownershipInventory(f.root,configuration);assert.equal(inventory.owners.length,1);assert.equal(inventory.owners[0].construction,true);assert.ok(inventory.uncoveredFiles.includes(target),'the rest of this storage module remains pending');
  f.write(target,source.replace('CREATE TABLE IF NOT EXISTS','CREATE TABLE IF NOT EXISTS changed_'));assert.throws(()=>ownershipInventory(f.root,configuration),/exact constructor and proved DDL sink/);f.write(target,source);
  const call=construction.calls[0],caller=readFileSync(resolve(repository,call.from),'utf8'),className=construction.scope.split('.')[0];
  f.write(call.from,caller+'\nfunction anotherConstruction(db){return new '+className+'(db);}');assert.throws(()=>ownershipInventory(f.root,configuration),/exact production call path/);
  f.write(call.from,caller+'\nconst escapedConstructor='+className+';');assert.throws(()=>ownershipInventory(f.root,configuration),/cannot escape/);f.write(call.from,caller);
  for(const addition of ['\nexport function generatedExtraConstruction(db){return new '+className+'(db);}','\nconst aliasedConstructor='+className+';','\npublishConstructor('+className+');','\nclass GeneratedChild extends '+className+' {}']){
   f.write(target,source+addition);assert.throws(()=>ownershipInventory(f.root,configuration),/storage constructor.*(?:call path|cannot escape)/);
  }
  f.write(target,source+'\nfunction unrelatedShadow('+className+'){return new '+className+'();}');assert.equal(ownershipInventory(f.root,configuration).owners.length,1,'a same-spelled local parameter is not the production class binding');
  f.write(target,source+"\nfunction unrelatedRuntime(db){db.prepare('DELETE FROM settings');}");inventory=ownershipInventory(f.root,configuration);assert.ok(inventory.issues.some(issue=>issue.from===target&&issue.scope==='unrelatedRuntime'&&issue.rule==='sql-uncovered-consumer'));
 }
});

test('actual CLI rejects an inserted cross-owner query in a copy of the production source, permits the existing shared model, and cleans up',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-sql-production-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 // Copy tracked code/config only, never profiles, dependencies or user data.
 const tracked=execFileSync('git',['ls-files','-z','--','apps','packages','scripts','*.json'],{cwd:repository,encoding:'utf8'}).split('\0').filter(file=>/\.(?:[cm]?[jt]sx?|json)$/.test(file));
 for(const file of tracked){mkdirSync(resolve(root,file,'..'),{recursive:true});copyFileSync(resolve(repository,file),resolve(root,file));}

 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 const architecture=()=>spawnSync(process.execPath,[architectureCli],{cwd:root,encoding:'utf8'});
 let result=architecture();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PARTIAL coverage/);assert.match(result.stdout,/Architecture boundaries passed/);
 assert.match(result.stdout,/4 write-unproved pending/);
 const baselinePath=resolve(root,'scripts/ci/sql-ownership-baseline.json'),baselineSource=readFileSync(baselinePath,'utf8');
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
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/imported SQL helper requires its exact pure definition/);
 // The total entry rejects the changed imported module first. Independently
 // retain the original concrete maintenance-effect assertion at its installer.
 assert.ok(ownershipInventory(root,{...policy,importedHelpers:[],storageConstructions:storageConstructions.filter(item=>item.owner!=='assistant-task-storage')}).issues.some(issue=>issue.rule==='sql-schema-maintenance'&&issue.from.endsWith('/task-evidence.ts')&&issue.to==='memories'&&issue.kind==='update'));
 writeFileSync(evidencePath,evidenceSource);
 const searchPath=resolve(root,'apps/server/src/memory-search-schema.ts'),searchSource=readFileSync(searchPath,'utf8');
 writeFileSync(searchPath,searchSource+'\nfunction generatedRuntime(db:DatabaseSync){memoryCatalog(db);}');result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/schema db helper cannot inherit installer authority/);writeFileSync(searchPath,searchSource);
 const connectorPath=resolve(root,'apps/server/src/connectors/gmail-state.ts'),connectorSource=readFileSync(connectorPath,'utf8');
 writeFileSync(connectorPath,connectorSource.replace("db.exec('CREATE TABLE", "db.prepare('UPDATE captures SET json=json WHERE id=?');db.exec('CREATE TABLE"));result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-schema-maintenance.*captures.*update/);writeFileSync(connectorPath,connectorSource);
 const configPath=resolve(root,'apps/server/src/config-service.ts'),configSource=readFileSync(configPath,'utf8'),configCall='entry.prepare?.(clone(value), clone(value))';
 for(const changed of [configSource+'\nexport function generatedSqliteReceiver(db,sql){const entry=db;return entry.prepare(sql);}',configSource.replace(configCall,"entry.prepare?.('SELECT value FROM settings', clone(value))"),configSource.replace(configCall,configCall+';candidate = await '+configCall)]){
  writeFileSync(configPath,changed);result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-uncovered-consumer.*config-service.ts/);
 }
 writeFileSync(configPath,configSource);
 const taskPath=resolve(root,'apps/server/src/assistant-tasks.ts'),taskSource=readFileSync(taskPath,'utf8');
 writeFileSync(taskPath,taskSource+'\nexport function generatedSqliteTask(db){const assistantTasks=db;return assistantTasks.prepare(\'SELECT value FROM settings\').get();}');
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-uncovered-consumer.*assistant-tasks.ts/);writeFileSync(taskPath,taskSource);
 const steeringPath=resolve(root,'apps/server/src/assistant-task-steering.ts'),steeringSource=readFileSync(steeringPath,'utf8');
 writeFileSync(steeringPath,steeringSource+"\nfunction generatedForeignWrite(db){db.prepare('UPDATE captures SET json=json WHERE id=?');}");
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner.*assistant-task-steering.ts.*captures.*write/);
 writeFileSync(steeringPath,steeringSource.replace('private messages(id:string)','private movedMessages(id:string)'));
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner.*assistant-task-steering.ts.*conversation_turns.*read/);writeFileSync(steeringPath,steeringSource);
 const retirementPath=resolve(root,'apps/server/src/task-evidence.ts'),retirementSource=readFileSync(retirementPath,'utf8');
 writeFileSync(retirementPath,retirementSource.replace('UPDATE task_records SET', 'UPDATE captures SET'));
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/imported SQL helper requires its exact pure definition/);writeFileSync(retirementPath,retirementSource);
 writeFileSync(taskPath,taskSource+'\nconst escapedRetirement=retireTaskRecordsSql;');result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/imported SQL helper cannot alias or escape/);writeFileSync(taskPath,taskSource);
 const conversationsCaller=resolve(root,'apps/server/src/plugins/conversations.ts'),conversationsSource=readFileSync(conversationsCaller,'utf8');
 writeFileSync(conversationsCaller,conversationsSource+'\nfunction generatedConstruction(db){return new Conversations(db);}');
 result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/storage constructor requires its exact production call path/);writeFileSync(conversationsCaller,conversationsSource);
 const historyFile='apps/server/src/evidence-store.ts',historyPath=resolve(root,historyFile),historySource=readFileSync(historyPath,'utf8'),historyStatements=sqlStatements(historyFile,historySource);
 for(const sample of originalPendingWrites){
  const statement=historyStatements.find(item=>item.fingerprint===sample.symbol);assert.ok(statement);assert.equal(statement.scope,sample.scope);assert.equal(statement.scopeFingerprint,sample.scopeFingerprint);
  const changed=statement.expression[0]+'/* generated SQL mutation */'+statement.expression.slice(1);writeFileSync(historyPath,historySource.replace(statement.expression,changed));
  result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/sql-(?:cross-owner|dynamic|unproved-relation).*evidence-store.ts/);assert.ok(!ownershipInventory(root).pendingRawWrites.some(issue=>issue.symbol===sample.symbol));
  t.diagnostic('Frozen unknown-write '+sample.symbol+' rejects its SQL mutation through the total CLI');
 }
 const originalStatement=historyStatements.find(item=>item.fingerprint===originalPendingWrites[0].symbol),queryStatement=historyStatements.find(item=>item.fingerprint===originalPendingWrites[3].symbol);
 const historyMutations=[
  ['scope',historySource.replace('  invalidateConversationAnswers(evidenceIds?:string[]','  movedConversationAnswers(evidenceIds?:string[]')],
  ['occurrence',historySource.replace('      const conversationParameters=[...parameters];','      const conversationParameters=[...parameters];\n      this.db.prepare('+originalStatement.expression+');')],
  ['target',historySource.replace(queryStatement.expression,queryStatement.expression.replaceAll('query_runs','conversation_turns'))],
  ['fully proved update',historySource.replace(originalStatement.expression,"'UPDATE conversation_turns SET json=json WHERE id=?'")],
 ];
 for(const [name,changed]of historyMutations){assert.notEqual(changed,historySource);writeFileSync(historyPath,changed);result=architecture();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/evidence-store.ts/);if(name==='fully proved update')assert.match(result.stderr,/sql-cross-owner.*evidence-store.ts.*conversation_turns.*write/);t.diagnostic('Frozen unknown-write '+name+' mutation rejects through the total CLI');}
 writeFileSync(historyPath,historySource);
 for(const construction of storageConstructions.filter(item=>['conversation-turn-storage','query-run-storage'].includes(item.owner))){
  const path=resolve(root,'apps/server/src/'+construction.file),source=readFileSync(path,'utf8');writeFileSync(path,source.replace('CREATE TABLE IF NOT EXISTS','CREATE TABLE IF NOT EXISTS changed_'));
  result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/storage construction requires its exact constructor and proved DDL sink/);writeFileSync(path,source);
 }
 const rawPath=resolve(root,'apps/server/src/conversations.ts'),rawSource=readFileSync(rawPath,'utf8');
 for(const addition of ['\nexport function generatedExtraConstruction(db){return new Conversations(db);}','\nconst aliasedConstructor=Conversations;','\npublishConstructor(Conversations);','\nclass GeneratedChild extends Conversations {}']){
  writeFileSync(rawPath,rawSource+addition);result=architecture();assert.equal(result.status,1);assert.match(result.stderr,/storage constructor.*(?:call path|cannot escape)/);
 }
 writeFileSync(rawPath,rawSource);
 assert.equal(readFileSync(baselinePath,'utf8'),baselineSource,'negative cases never edit the production debt ledger');
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
