import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PrivateSql} from '../src/scope/private-data-sql.js';

test('fresh authority after reopening a DatabaseSync object cannot inherit finalized private statements',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-sql-connection-review-'));
 const db=new DatabaseSync(join(directory,'generated.sqlite'));
 t.after(()=>{if(db.isOpen)db.close();rmSync(directory,{recursive:true,force:true});});
 db.exec("CREATE TABLE owned(user_id TEXT,id TEXT,value INTEGER,PRIMARY KEY(user_id,id));INSERT INTO owned VALUES('A','same',1),('B','same',2)");
 let oldCurrent=true;
 const oldA=new PrivateSql(db,'A',()=>assert.ok(oldCurrent,'retired authority'));
 const query='SELECT value FROM owned WHERE user_id=$user AND id=?';
 const list='SELECT value FROM owned WHERE user_id=$user ORDER BY id',update='UPDATE owned SET value=value+? WHERE user_id=$user AND id=?';
 assert.equal(oldA.get(query,'same')!.value,1);
 assert.equal(oldA.all(list)[0].value,1);assert.equal(oldA.run(update,1,'same').changes,1n);
 oldCurrent=false;db.close();db.open();
 db.exec("UPDATE owned SET value=9 WHERE user_id='A'");
 assert.throws(()=>oldA.get(query,'same'),/retired authority/);
 const freshA=new PrivateSql(db,'A',()=>{}),freshB=new PrivateSql(db,'B',()=>{});
 assert.equal(freshA.get(query,'same')!.value,9);
 assert.equal(freshB.get(query,'same')!.value,2);
 assert.equal(freshB.all(list)[0].value,2);assert.equal(freshA.run(update,1,'same').changes,1n);
 assert.equal(freshA.get(query,'same')!.value,10);assert.equal(freshB.get(query,'same')!.value,2);
});

test('cached private statements preserve SQL failures and reject revoked or closed access without retrying preparation',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>{if(db.isOpen)db.close();});
 db.exec("CREATE TABLE owned(user_id TEXT,value INTEGER);INSERT INTO owned VALUES('A',1)");
 let current=true,preparations=0;
 const prepare=db.prepare.bind(db);db.prepare=(...args:Parameters<DatabaseSync['prepare']>)=>{preparations++;return prepare(...args);};
 const sql=new PrivateSql(db,'A',()=>assert.ok(current,'retired authority')),query='SELECT value FROM owned WHERE user_id=$user';
 assert.equal(sql.get(query)!.value,1);assert.equal(preparations,1);
 current=false;assert.throws(()=>sql.get(query),/retired authority/);assert.equal(preparations,1);
 current=true;db.exec('DROP TABLE owned');assert.throws(()=>sql.get(query),/no such table/);assert.equal(preparations,1);
 db.close();assert.throws(()=>sql.get(query),{code:'ERR_INVALID_STATE'});assert.equal(preparations,1);
});
