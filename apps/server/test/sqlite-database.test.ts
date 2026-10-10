import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {StoreDatabase} from '../src/sqlite-database.js';

function index(db:DatabaseSync){
 db.exec("CREATE VIRTUAL TABLE fixture_fts USING fts5(text,content='',contentless_delete=1,tokenize='trigram'); CREATE TABLE fixture_state(id INTEGER PRIMARY KEY,state TEXT); INSERT INTO fixture_state VALUES(1,'waiting')");
 const insert=db.prepare('INSERT INTO fixture_fts(rowid,text) VALUES(?,?)');
 for(let i=1;i<=3000;i++)insert.run(i,'Generated searchable fixture '+i);
}

test('store writes preserve FTS internal rowids without changing ordinary query and receipt numbers',()=>{
 const db=new StoreDatabase(':memory:');
 try{
  index(db);
  const update=db.prepare("UPDATE fixture_state SET state='failed' WHERE id=?"),remove=db.prepare('DELETE FROM fixture_fts WHERE rowid=?');
  remove.run(1);const deleted=remove.run(2);
  assert.equal(deleted.changes,1);assert.equal(typeof deleted.lastInsertRowid,'bigint');
  assert.ok(deleted.lastInsertRowid>BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(update.run(1).changes,1);assert.equal(update.run(999).changes,0);
  const returning=db.prepare('UPDATE fixture_state SET state=? WHERE id=1 RETURNING id,state');
  assert.equal(returning.run('succeeded').changes,1);
  assert.deepEqual({...returning.get('waiting')},{id:1,state:'waiting'});
  const query=db.prepare('SELECT id FROM fixture_state');
  assert.equal(query.get()!.id,1);assert.equal(query.all()[0]!.id,1);assert.equal([...query.iterate()][0]!.id,1);
 }finally{db.close();}
});

test('write receipts retain exact integer boundaries and explicit BigInt reads survive success and errors',()=>{
 const db=new StoreDatabase(':memory:');
 try{
  db.exec('CREATE TABLE fixture(id INTEGER PRIMARY KEY,value INTEGER UNIQUE)');
  const statement=db.prepare('INSERT INTO fixture VALUES(?,?) RETURNING id,value');
  for(const [i,id] of [BigInt(Number.MIN_SAFE_INTEGER)-1n,BigInt(Number.MIN_SAFE_INTEGER),BigInt(Number.MAX_SAFE_INTEGER),BigInt(Number.MAX_SAFE_INTEGER)+1n].entries()){
   const receipt=statement.run(id,i);
   assert.equal(receipt.changes,1);
   assert.equal(receipt.lastInsertRowid,i===1||i===2?Number(id):id);
  }
  assert.throws(()=>statement.run(1,0),/UNIQUE constraint/);
  assert.equal(statement.get(1,10)!.value,10);
  statement.setReadBigInts(true);
  assert.equal(statement.run(2,11).changes,1n);
  assert.throws(()=>statement.run(3,11),/UNIQUE constraint/);
  assert.equal(statement.get(3,12)!.id,3n);
  statement.setReadBigInts(false);
  assert.equal(statement.run(4,13).changes,1);
  assert.equal(statement.get(5,14)!.id,5);
  const named=db.prepare('UPDATE fixture SET value=$value WHERE id=$id');
  assert.equal(named.run({id:5,value:15}).changes,1);
  assert.throws(()=>db.prepare('SELECT max(id) id FROM fixture').get(),{code:'ERR_OUT_OF_RANGE'},'query overflow remains explicit');
 }finally{db.close();}
});
