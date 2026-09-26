import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryInputAuthorization} from '../src/memory-input-authorization.js';

test('receipt grants are immutable, scoped, transactional and recover only their own job',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-input-grants-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  new SourceStore(store).register({id:'source',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  let enabled=false;const grants=new MemoryInputAuthorization(store,()=>enabled);
  const transaction=<T>(run:()=>T)=>{store.db.exec('BEGIN IMMEDIATE');try{const result=run();store.db.exec('COMMIT');return result;}catch(error){store.db.exec('ROLLBACK');throw error;}};
  const input={sourceId:'source',inputKey:'generated-raw'};
  assert.throws(()=>grants.receive(input),/receive transaction/);
  transaction(()=>grants.receive(input));enabled=true;
  transaction(()=>grants.receive(input));
  assert.equal(grants.available('source','generated-raw'),false,'repeated delivery does not change a denied receipt');
  const next={sourceId:'source',inputKey:'new-raw'};
  transaction(()=>{grants.receive({...next,scope:'personal'});grants.receive({...next,scope:'coding'});});
  assert.equal(grants.available('source','new-raw'),false,'one scope cannot authorize an unselected scope');
  assert.equal(transaction(()=>grants.claim('source','new-raw','personal-job','personal')),true);
  assert.equal(transaction(()=>grants.claim('source','new-raw','another-job','personal')),false);
  assert.equal(transaction(()=>grants.claim('source','new-raw','coding-job','coding')),true,'one strategy does not consume another strategy scope');
  const recovered=new MemoryInputAuthorization(store,()=>enabled);
  assert.equal(recovered.available('source','new-raw','personal-job','personal'),true);
  assert.equal(recovered.available('source','new-raw','coding-job','personal'),false);
  store.db.exec('BEGIN IMMEDIATE');grants.receive({sourceId:'source',inputKey:'rolled-back'});store.db.exec('ROLLBACK');
  assert.equal(grants.available('source','rolled-back'),false);
  store.logicalBytes();assert.ok(Number(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='memory_input_authorizations'").get()!.bytes)>0);
  store.db.prepare('DELETE FROM source_connections WHERE id=?').run('source');
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_input_authorizations').get()!.n,0,'source erasure propagates to grants');
  assert.equal(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='memory_input_authorizations'").get()!.bytes,0);
});

test('capture erasure removes the receipt grant and rollback cannot leave a paid authorization',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-capture-grants-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const grants=new MemoryInputAuthorization(store,()=>true),sources=new SourceStore(store,undefined,grants);
  sources.register({id:'source',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  const input={externalId:'original',revision:'1',observedAt:'2020-01-01T00:00:00Z',text:'Generated original',kind:'message',layer:'original'};
  await assert.rejects(sources.upsert('source',input,undefined,()=>{throw Error('Generated commit rejection');}),/Generated commit rejection/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_input_authorizations').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
  const received=await sources.upsert('source',input);
  assert.equal(grants.available('source',received.id),true);
  store.delete(received.id);
  assert.equal(grants.available('source',received.id),false);
});

test('receipt authorization metadata obeys the shared vault quota',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-grant-quota-')),options={maxStorageBytes:1_000_000},store=new Store(directory,options);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  new SourceStore(store).register({id:'source',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  const grants=new MemoryInputAuthorization(store,()=>true);
  options.maxStorageBytes=store.logicalBytes();store.db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>grants.receive({sourceId:'source',inputKey:'over-quota'}),/Vault storage limit/);
  store.db.exec('ROLLBACK');assert.equal(grants.available('source','over-quota'),false);
});
