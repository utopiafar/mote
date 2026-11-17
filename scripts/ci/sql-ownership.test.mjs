import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sqlAccesses,sqlStatements,ownershipInventory,checkSqlOwnership} from './sql-ownership.mjs';

const repository=fileURLToPath(new URL('../..',import.meta.url));
const cli=fileURLToPath(new URL('./sql-ownership.mjs',import.meta.url));
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
 assert.equal(result.owners.length,14);assert.equal(Object.keys(result.tables).length,66);
 assert.ok(result.coveredFiles.includes('apps/server/src/material-index.ts'));
 assert.ok(result.coveredFiles.includes('apps/server/src/evidence-store.ts'));
 assert.ok(result.uncoveredFiles.includes('apps/server/src/execution-engine.ts'));
 assert.ok(result.uncoveredTables.includes('execution_steps'));assert.ok(result.dynamicStatements>0);
 const map=JSON.parse(readFileSync(resolve(repository,'scripts/ci/sql-ownership-map.json'),'utf8'));
 assert.deepEqual(map,{owners:result.owners,tables:result.tables});
});

test('actual CLI rejects an inserted cross-owner query in a copy of the production source, permits the existing shared model, and cleans up',t=>{
 const root=mkdtempSync(join(tmpdir(),'mote-sql-production-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 cpSync(resolve(repository,'apps/server/src'),resolve(root,'apps/server/src'),{recursive:true});
 cpSync(resolve(repository,'scripts/ci'),resolve(root,'scripts/ci'),{recursive:true});
 const run=()=>spawnSync(process.execPath,[cli],{cwd:root,encoding:'utf8'});
 let result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PARTIAL coverage/);
 const mapPath=resolve(root,'scripts/ci/sql-ownership-map.json'),map=readFileSync(mapPath,'utf8');
 writeFileSync(mapPath,'{}');result=run();assert.equal(result.status,1);assert.match(result.stderr,/map is stale/);writeFileSync(mapPath,map);
 const target=resolve(root,'apps/server/src/material-index.ts'),original=readFileSync(target,'utf8');
 appendFileSync(target,"\nfunction generatedOwnershipNegative(db){db.prepare('SELECT value FROM settings WHERE key=?');}\n");
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-cross-owner: apps\/server\/src\/material-index.ts.*settings/);
 writeFileSync(target,original);result=run();assert.equal(result.status,0,result.stderr);
 appendFileSync(target,"\nfunction generatedOwnRead(db){db.prepare('SELECT id FROM material_heads LIMIT 1');}\n");
 result=run();assert.equal(result.status,0,result.stderr);
 const unexpected=resolve(root,'apps/server/src/generated-new-consumer.ts');writeFileSync(unexpected,"db.prepare('SELECT id FROM material_heads');\n");
 result=run();assert.equal(result.status,1);assert.match(result.stderr,/sql-uncovered-consumer.*generated-new-consumer/);
});
