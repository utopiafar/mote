import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PrivateSql} from '../src/scope/private-data-sql.js';

test('repeated private SQL keeps preparation bounded while every access rechecks authority and binds its owner',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE owned(user_id TEXT,id TEXT,value INTEGER,PRIMARY KEY(user_id,id));INSERT INTO owned VALUES('A','same',1),('B','same',2)");
 const prepare=db.prepare.bind(db);let preparations=0,checks=0,active=true;
 db.prepare=(...args:Parameters<DatabaseSync['prepare']>)=>{preparations++;return prepare(...args);};
 const query='SELECT value FROM owned WHERE user_id=$user AND id=?';
 for(let index=0;index<64;index++){
  const owner=index%2?'B':'A',sql=new PrivateSql(db,owner,()=>{checks++;assert.ok(active,'retired authority');});
  assert.equal(sql.get(query,'same')!.value,owner==='A'?1:2);
 }
 assert.equal(checks,64,'preparation reuse must not reuse an authorization decision');
 assert.ok(preparations<=2,'64 identical owner-bound reads repeatedly prepare their SQL: '+preparations);
 const a=new PrivateSql(db,'A',()=>{checks++;assert.ok(active,'retired authority');}),b=new PrivateSql(db,'B',()=>{});
 assert.equal(a.get(query),undefined,'an omitted argument cannot retain the preceding caller binding');
 assert.deepEqual(b.all(query),[]);
 a.run('UPDATE owned SET value=? WHERE user_id=$user AND id=?',3,'same');
 assert.equal(a.get(query,'same')!.value,3,'a cached statement cannot cache its earlier row');
 assert.equal(b.get(query,'same')!.value,2,'bindings cannot carry A into an equal B identity');
 const returning='UPDATE owned SET value=value+1 WHERE user_id=$user AND id=? RETURNING value';
 a.run(returning,'same');assert.equal(a.run(returning).changes,0n);assert.equal(a.get(returning,'same')!.value,5,'run bigint metadata cannot change a later get result type');
 active=false;assert.throws(()=>a.get(query,'same'),/retired authority/);
 assert.throws(()=>a.all('SELECT value FROM owned WHERE user_id=$user'),/retired authority/);
 assert.throws(()=>a.run('UPDATE owned SET value=? WHERE user_id=$user AND id=?',4,'same'),/retired authority/);
 assert.equal(b.get(query,'same')!.value,2);
});

test('reused private statements observe a replacement schema and keep fixed pin disposal owner-bound after retirement',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let active=true;
 db.exec("CREATE TABLE owned(user_id TEXT,value INTEGER);INSERT INTO owned VALUES('A',1),('B',2);CREATE TABLE ig_pins(user_id TEXT,id TEXT);INSERT INTO ig_pins VALUES('A','same'),('B','same')");
 const a=new PrivateSql(db,'A',()=>assert.ok(active)),b=new PrivateSql(db,'B',()=>{}),query='SELECT value FROM owned WHERE user_id=$user';
 assert.equal(a.get(query)!.value,1);assert.equal(b.get(query)!.value,2);
 db.exec("DROP TABLE owned;CREATE TABLE owned(user_id TEXT,value INTEGER);INSERT INTO owned VALUES('A',3),('B',4)");
 assert.equal(a.get(query)!.value,3);assert.equal(b.get(query)!.value,4);
 const other=new DatabaseSync(':memory:');t.after(()=>other.close());other.exec("CREATE TABLE owned(user_id TEXT,value INTEGER);INSERT INTO owned VALUES('A',9),('B',10)");
 assert.equal(new PrivateSql(other,'A',()=>{}).get(query)!.value,9,'equal owner and SQL on another database cannot reuse this database statement');
 assert.equal(b.get(query)!.value,4);
 const release=a.pinDisposer('same');active=false;release();
 assert.deepEqual(db.prepare('SELECT user_id FROM ig_pins').all().map(row=>row.user_id),['B']);
 assert.throws(()=>new PrivateSql(db,'B',()=>{}).get('SELECT value FROM owned'),/owner binding/);
});
