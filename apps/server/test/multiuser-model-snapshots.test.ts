import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {chmodSync,copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ModelSnapshots,ModelSnapshotError} from '../src/scope/model-snapshots.js';

const execute=promisify(execFile),deploymentId='synthetic-snapshot-deployment',a='synthetic-a',b='synthetic-b';
const payload=(user:string)=>({version:1,settings:{apiKey:'synthetic-'+user+'-api-key',headers:{Authorization:'Bearer synthetic-'+user+'-header'},extraBody:{credential:'synthetic-'+user+'-body'}},configuration:{models:{profiles:[{id:'same-profile',settings:{apiKey:'synthetic-'+user+'-snapshot-key'}}]}},price:{input:1,output:2},reference:{kind:'personal',id:'same-profile'}});
const unavailable=(work:()=>unknown)=>assert.throws(work,(error:unknown)=>error instanceof ModelSnapshotError&&error.code==='model_snapshot_unavailable'&&error.message==='model_snapshot_unavailable'&&!Object.hasOwn(error,'cause'));

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-model-snapshot-')),database=join(directory,'mote.sqlite');
  let db:DatabaseSync|undefined,store:ModelSnapshots|undefined;
  const close=()=>{store?.close();store=undefined;db?.close();db=undefined;};
  const reopen=()=>{db=new DatabaseSync(database);db.exec('PRAGMA busy_timeout=10000');store=new ModelSnapshots({directory,db,deploymentId});};
  const key=(userId:string)=>join(directory,'configuration','users',userId,'snapshot-key');
  t.after(()=>{close();rmSync(directory,{recursive:true,force:true});});reopen();
  return {directory,database,key,close,reopen,get db(){return db!;},get store(){return store!;}};
}

test('encrypted host snapshots survive reopened SQLite and storage instances without plaintext credentials',t=>{
  const f=fixture(t),original=payload(a),id=f.store.save(a,original),second=f.store.save(a,original),bId=f.store.save(b,payload(b));
  assert.notEqual(id,second);assert.notEqual(id,bId);assert.equal(readFileSync(f.key(a)).length,32);
  for(const userId of [a,b]){assert.equal(statSync(f.key(userId)).mode&0o777,0o600);assert.equal(statSync(join(f.key(userId),'..')).mode&0o777,0o700);assert.equal(statSync(f.key(userId)).nlink,1);}
  const rows=f.db.prepare('SELECT * FROM user_model_snapshots').all();
  const raw=readFileSync(f.database);
  for(const userId of [a,b])for(const secret of [payload(userId).settings.apiKey,payload(userId).settings.headers.Authorization,payload(userId).settings.extraBody.credential,payload(userId).configuration.models.profiles[0]!.settings.apiKey]){
    assert.equal(raw.includes(Buffer.from(secret)),false);assert.equal(JSON.stringify(rows).includes(secret),false);
    for(const row of rows)assert.equal(Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from(secret)),false);
  }
  original.settings.apiKey='changed-after-save';const key=readFileSync(f.key(a));f.close();f.reopen();
  assert.deepEqual(f.store.read(a,id),payload(a));assert.deepEqual(f.store.read(b,bId),payload(b));assert.deepEqual(readFileSync(f.key(a)),key);
  const read=f.store.read(a,id) as ReturnType<typeof payload>;read.settings.apiKey='changed-returned-copy';assert.deepEqual(f.store.read(a,id),payload(a));
  assert.equal(f.store.read(b,id),undefined);assert.equal(f.store.read(a,bId),undefined);assert.equal(f.store.read(a,'not-a-snapshot-id'),undefined);
  const missing=join(f.directory,'configuration','users','never-created');assert.equal(f.store.read('never-created',id),undefined);assert.equal(existsSync(missing),false);
});

test('GCM authentication binds deployment, user and snapshot id independently and rejects tampering',t=>{
  const f=fixture(t),id=f.store.save(a,payload(a)),other=f.store.save(a,payload('other'));
  // Force a shared synthetic encryption key, so the cross-user test proves AAD
  // user binding independently of users normally having different local keys.
  mkdirSync(join(f.key(b),'..'),{recursive:true,mode:0o700});copyFileSync(f.key(a),f.key(b));
  const bId=f.store.save(b,payload(b)),row=f.db.prepare('SELECT * FROM user_model_snapshots WHERE user_id=? AND id=?').get(a,id)!;
  const overwrite=(sourceUser:string,sourceId:string)=>f.db.prepare('UPDATE user_model_snapshots SET (key_hash,nonce,ciphertext,tag)=(SELECT key_hash,nonce,ciphertext,tag FROM user_model_snapshots WHERE user_id=? AND id=?) WHERE user_id=? AND id=?').run(sourceUser,sourceId,a,id);
  const restore=()=>f.db.prepare('UPDATE user_model_snapshots SET key_hash=?,nonce=?,ciphertext=?,tag=? WHERE user_id=? AND id=?').run(row.key_hash,row.nonce,row.ciphertext,row.tag,a,id);
  overwrite(a,other);unavailable(()=>f.store.read(a,id));restore();
  overwrite(b,bId);unavailable(()=>f.store.read(a,id));restore();
  const wrongDeployment=new ModelSnapshots({directory:f.directory,db:f.db,deploymentId:'different-synthetic-deployment'});
  unavailable(()=>wrongDeployment.read(a,id));wrongDeployment.close();
  const bytes=Buffer.from(row.ciphertext as Uint8Array);bytes[0]^=1;
  f.db.prepare('UPDATE user_model_snapshots SET ciphertext=? WHERE user_id=? AND id=?').run(bytes,a,id);unavailable(()=>f.store.read(a,id));restore();
  f.db.prepare('UPDATE user_model_snapshots SET tag=? WHERE user_id=? AND id=?').run(randomBytes(16),a,id);unavailable(()=>f.store.read(a,id));restore();
  assert.deepEqual(f.store.read(a,id),payload(a));assert.deepEqual(f.store.read(b,bId),payload(b));
});

test('missing, truncated or replaced keys never regenerate keys for existing snapshot rows',t=>{
  const f=fixture(t),id=f.store.save(a,payload(a)),key=readFileSync(f.key(a));
  unlinkSync(f.key(a));unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));assert.equal(existsSync(f.key(a)),false);
  writeFileSync(f.key(a),Buffer.alloc(8),{mode:0o600});unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));assert.equal(readFileSync(f.key(a)).length,8);
  writeFileSync(f.key(a),randomBytes(32));const wrong=readFileSync(f.key(a));unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));assert.deepEqual(readFileSync(f.key(a)),wrong);
  writeFileSync(f.key(a),key);assert.deepEqual(f.store.read(a,id),payload(a));assert.equal(f.db.prepare('SELECT count(*) n FROM user_model_snapshots WHERE user_id=?').get(a)!.n,1);
});

test('key symlinks, hardlinks and substituted user directories fail closed without touching another user key',t=>{
  const f=fixture(t),id=f.store.save(a,payload(a)),bId=f.store.save(b,payload(b)),aKey=readFileSync(f.key(a)),bKey=readFileSync(f.key(b));
  unlinkSync(f.key(a));symlinkSync(f.key(b),f.key(a));unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));assert.deepEqual(readFileSync(f.key(b)),bKey);
  unlinkSync(f.key(a));writeFileSync(f.key(a),aKey,{mode:0o600});const linked=join(f.directory,'synthetic-key-link');linkSync(f.key(a),linked);
  unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));unlinkSync(linked);assert.deepEqual(f.store.read(a,id),payload(a));
  const user=join(f.key(a),'..'),moved=join(f.directory,'synthetic-moved-user');
  renameSync(user,moved);symlinkSync(moved,user);
  unavailable(()=>f.store.read(a,id));unavailable(()=>f.store.save(a,payload('late')));
  assert.deepEqual(f.store.read(b,bId),payload(b));assert.deepEqual(readFileSync(f.key(b)),bKey);
});

test('snapshots enforce private modes and deletion affects only the selected host owner',t=>{
  const f=fixture(t),id=f.store.save(a,payload(a)),bId=f.store.save(b,payload(b)),bKey=readFileSync(f.key(b));
  chmodSync(f.key(a),0o644);chmodSync(join(f.key(a),'..'),0o755);assert.deepEqual(f.store.read(a,id),payload(a));
  assert.equal(statSync(f.key(a)).mode&0o777,0o600);assert.equal(statSync(join(f.key(a),'..')).mode&0o777,0o700);
  f.store.deleteUser(a);assert.equal(f.store.read(a,id),undefined);assert.deepEqual(f.store.read(b,bId),payload(b));assert.deepEqual(readFileSync(f.key(b)),bKey);
  // Directory/key removal belongs to the configuration manager after it fences
  // the account generation. The low-level store only erases scoped ciphertext.
  assert.equal(existsSync(f.key(a)),true);
});

test('invalid owners, serialization failures and closed stores expose only a fixed safe error',t=>{
  const f=fixture(t);
  for(const owner of ['../other','/absolute','',null as unknown as string]){unavailable(()=>f.store.save(owner,payload(a)));unavailable(()=>f.store.read(owner,'id'));unavailable(()=>f.store.deleteUser(owner));}
  const circular:{apiKey:string;self?:unknown}={apiKey:'synthetic-error-private-key'};circular.self=circular;unavailable(()=>f.store.save(a,circular));
  assert.equal(f.db.prepare('SELECT count(*) n FROM user_model_snapshots').get()!.n,0);
  f.store.close();unavailable(()=>f.store.save(a,payload(a)));unavailable(()=>f.store.read(a,'id'));unavailable(()=>f.store.deleteUser(a));assert.equal(f.db.prepare('SELECT 1 value').get()!.value,1);
});

test('savepoints preserve a caller transaction and concurrent processes share exactly one durable user key',async t=>{
  const f=fixture(t);f.db.exec('BEGIN IMMEDIATE');const rolledBack=f.store.save('transaction-user',payload(a));f.db.exec('ROLLBACK');assert.equal(f.store.read('transaction-user',rolledBack),undefined);
  assert.equal(existsSync(f.key(a)),false);f.close();
  const source=new URL('../src/scope/model-snapshots.ts',import.meta.url).href;
  const script=(label:string)=>`
    import {DatabaseSync} from 'node:sqlite';
    import {ModelSnapshots} from ${JSON.stringify(source)};
    const db=new DatabaseSync(${JSON.stringify(f.database)});db.exec('PRAGMA busy_timeout=10000');
    const store=new ModelSnapshots({directory:${JSON.stringify(f.directory)},db,deploymentId:${JSON.stringify(deploymentId)}});
    const id=store.save(${JSON.stringify(a)},{apiKey:${JSON.stringify('synthetic-concurrent-'+label)}});store.close();db.close();process.stdout.write(JSON.stringify({id}));
  `;
  const outputs=await Promise.all(['A','B','C'].map(label=>execute(process.execPath,['--import','tsx','--input-type=module','-e',script(label)],{timeout:15000,maxBuffer:4096})));
  f.reopen();assert.equal(readFileSync(f.key(a)).length,32);
  for(let index=0;index<outputs.length;index++){const {id}=JSON.parse(outputs[index]!.stdout);assert.deepEqual(f.store.read(a,id),{apiKey:'synthetic-concurrent-'+['A','B','C'][index]});}
  assert.equal(f.db.prepare('SELECT count(*) n FROM user_model_snapshots WHERE user_id=?').get(a)!.n,3);assert.equal(statSync(f.key(a)).nlink,1);
});

