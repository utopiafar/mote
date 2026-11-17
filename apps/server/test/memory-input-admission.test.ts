import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {MemoryInputAdmission} from '../src/memory-input-admission.js';

function fixture(t:TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'mote-input-admission-rollback-'));
  const store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const admission=new MemoryInputAdmission(store,new MemoryStore(store));
  const write=(key:string,value:string)=>store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,value);
  const read=(key:string)=>store.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  return {db:store.db,admission,write,read};
}

test('input admission preserves the original SQLite failure after SQLite has already rolled back',t=>{
  const f=fixture(t);
  f.write('generated.existing','original');
  let original:unknown;
  assert.throws(()=>f.admission.withCurrent([],()=>{
    f.write('generated.pending','must roll back');
    try {
      // SQLite's ROLLBACK conflict policy ends the whole transaction before throwing.
      f.db.prepare('INSERT OR ROLLBACK INTO settings(key,value) VALUES(?,?)').run('generated.existing','replacement');
    } catch(error) {
      original=error;
      assert.equal(f.db.isTransaction,false);
      throw error;
    }
  }),error=>{
    assert.ok(original instanceof Error);
    assert.match(original.message,/UNIQUE constraint failed: settings.key/);
    assert.equal(error,original,'a redundant ROLLBACK must not replace the real database failure');
    return true;
  });
  assert.equal(f.db.isTransaction,false);
  assert.equal(f.read('generated.pending'),undefined);
  assert.equal(f.read('generated.existing'),'original');
  assert.equal(f.admission.withCurrent([],()=>{f.write('generated.retry','committed');return 'complete';}),'complete');
  assert.equal(f.read('generated.retry'),'committed');
  assert.equal(f.db.isTransaction,false);
});

test('input admission rolls back its still-active transaction without replacing the callback failure',t=>{
  const f=fixture(t),failure=new Error('Generated owner command failure');
  for(let attempt=0;attempt<2;attempt++) {
    assert.throws(()=>f.admission.withCurrent([],()=>{f.write('generated.pending','must roll back');throw failure;}),error=>error===failure);
    assert.equal(f.db.isTransaction,false);
    assert.equal(f.read('generated.pending'),undefined);
  }
});

test('input admission leaves a borrowed transaction under the caller ownership after failure',t=>{
  const f=fixture(t),failure=new Error('Generated inner command failure');
  f.db.exec('BEGIN IMMEDIATE');
  try {
    f.write('generated.outer','outer');
    assert.throws(()=>f.admission.withCurrent([],()=>{f.write('generated.inner','inner');throw failure;}),error=>error===failure);
    assert.equal(f.db.isTransaction,true);
    assert.equal(f.read('generated.outer'),'outer');
    assert.equal(f.read('generated.inner'),'inner');
  } finally {if(f.db.isTransaction)f.db.exec('ROLLBACK');}
  assert.equal(f.read('generated.outer'),undefined);
  assert.equal(f.read('generated.inner'),undefined);
});

test('261 frozen ranges validate every fingerprint against one current original snapshot per guard',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-input-fingerprint-')),store=new Store(directory),memories=new MemoryStore(store),admission=new MemoryInputAdmission(store,memories);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const receipt=await store.ingest({id:randomUUID(),deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-11-01T00:00:00Z',durationMs:0,ocrText:'Generated original snapshot. '.repeat(1000)});
 const fingerprint=memoryEvidenceFingerprint(memories.readCurrentEvidence([receipt.id])[0]),expected=Array.from({length:261},()=>({id:receipt.id,fingerprint}));
 const read=memories.readCurrentEvidence.bind(memories);let originalReads=0;
 t.mock.method(memories,'readCurrentEvidence',ids=>read(ids).map(record=>{const text=record.ocrText;Object.defineProperty(record,'ocrText',{get:()=>{originalReads++;return text;}});return record;}));
 assert.deepEqual(admission.admit([receipt.id],undefined,undefined,[],expected),{});
 assert.equal(originalReads,1,'a guard must hash a current original once rather than once per frozen range');
 assert.throws(()=>admission.admit([receipt.id],undefined,undefined,[],[...expected,{id:receipt.id,fingerprint:'0'.repeat(64)}]),/Memory evidence changed/,'a conflicting later pin must still be checked');
 assert.equal(originalReads,2,'a later guard must obtain a fresh snapshot');
 store.delete(receipt.id);assert.throws(()=>admission.admit([receipt.id],undefined,undefined,[],expected),/Memory evidence changed/,'deleted originals never reuse a previous guard snapshot');
});
