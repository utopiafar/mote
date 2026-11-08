import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {Store,sha256} from '../src/store.js';

function oldVault(directory:string,epoch?:string){
  const db=new DatabaseSync(join(directory,'mote.sqlite'));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE captures(id TEXT PRIMARY KEY,json TEXT)");
  if(epoch!==undefined)db.prepare('INSERT INTO settings VALUES(?,?)').run('backend_epoch',epoch);
  db.prepare('INSERT INTO captures VALUES(?,?)').run('generated-old-capture','{"ocrText":"Generated retained row"}');
  db.close();
}
const refused=(error:Error&{statusCode?:number})=>error.statusCode===409&&/Backend epoch 7 requires a new empty data directory/.test(error.message);

test('new epoch 7 vaults reopen twice without schema or evidence drift',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-epoch-vault-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let store=new Store(directory);
  const id=randomUUID();
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,ocrText:'Generated epoch evidence'});
  const read=()=>({
    epoch:store.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,
    version:store.db.prepare('PRAGMA user_version').get()?.user_version,
    schema:store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    evidence:store.evidence([id]).map(record=>({id:record.id,ocrText:record.ocrText}))
  });
  const first=read();
  assert.equal(first.epoch,'7');assert.equal(first.version,7);assert.deepEqual(first.evidence,[{id,ocrText:'Generated epoch evidence'}]);
  store.close();
  store=new Store(directory);assert.deepEqual(read(),first);store.close();
  store=new Store(directory);assert.deepEqual(read(),first);store.close();
});

test('an epoch 6 vault is refused without modifying its database or data directory',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-epoch6-vault-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  oldVault(directory,'6');
  const path=join(directory,'mote.sqlite'),before=sha256(readFileSync(path)),entries=readdirSync(directory).sort();
  assert.throws(()=>new Store(directory),refused);
  assert.equal(sha256(readFileSync(path)),before);
  assert.deepEqual(readdirSync(directory).sort(),entries);
});

test('a future epoch 8 vault is refused and never rewritten to the current epoch',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-epoch8-vault-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  oldVault(directory,'8');
  const path=join(directory,'mote.sqlite'),before=sha256(readFileSync(path)),entries=readdirSync(directory).sort();
  assert.throws(()=>new Store(directory),refused);
  assert.equal(sha256(readFileSync(path)),before);
  assert.deepEqual(readdirSync(directory).sort(),entries);
  const inspect=new DatabaseSync(path,{readOnly:true});
  assert.equal(inspect.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,'8');inspect.close();
});

test('populated vaults without an epoch marker and deliberate epoch 4 vaults are refused unchanged',t=>{
  for(const epoch of [undefined,'4']){
    const directory=mkdtempSync(join(tmpdir(),'mote-old-vault-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    oldVault(directory,epoch);
    const path=join(directory,'mote.sqlite'),before=readFileSync(path),entries=readdirSync(directory).sort();
    assert.throws(()=>new Store(directory),refused);
    assert.deepEqual(readFileSync(path),before);
    assert.deepEqual(readdirSync(directory).sort(),entries);
    const inspect=new DatabaseSync(path,{readOnly:true});
    assert.equal(inspect.prepare('SELECT id FROM captures').get()?.id,'generated-old-capture');
    if(epoch!==undefined)assert.equal(inspect.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()?.value,epoch);
    inspect.close();
  }
});
