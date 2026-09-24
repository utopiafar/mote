import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {Store} from '../src/store.js';

test('new v2 vaults reopen, while a populated pre-cutover vault is refused',t=>{
  const fresh=mkdtempSync(join(tmpdir(),'mote-v2-vault-'));
  const old=mkdtempSync(join(tmpdir(),'mote-old-vault-'));
  t.after(()=>{rmSync(fresh,{recursive:true,force:true});rmSync(old,{recursive:true,force:true});});
  const first=new Store(fresh);
  assert.equal(first.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'2');first.close();
  const reopened=new Store(fresh);reopened.close();
  const legacy=new DatabaseSync(join(old,'mote.sqlite'));
  legacy.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE captures(id TEXT PRIMARY KEY)');
  legacy.prepare('INSERT INTO captures VALUES(?)').run('generated-old-capture');legacy.close();
  assert.throws(()=>new Store(old),/Legacy Mote vault cannot open/);
  const inspect=new DatabaseSync(join(old,'mote.sqlite'),{readOnly:true});
  assert.equal(inspect.prepare('SELECT id FROM captures').get()?.id,'generated-old-capture');inspect.close();
});
