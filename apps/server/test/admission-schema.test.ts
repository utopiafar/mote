import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure} from '@mote/shared';
import {providerAdmissionSchemaInstallation,processorAdmissionSchemaInstallation} from '../src/admission-schema.js';
import {installSchemaPlan} from '../src/schema-installation.js';
import {ProcessorAdmission} from '../src/processor-admission.js';
import {ProviderAdmission} from '../src/provider-admission.js';
import {Store} from '../src/store.js';

const object=(db:DatabaseSync,name:string)=>db.prepare('SELECT type,name FROM sqlite_master WHERE name=?').get(name);
const settings={protocol:'openai-completions' as const,provider:'custom',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'generated-private-key',headers:{'X-Fixture':'generated-private-header'}};

test('a native provider DDL failure rolls back the new table and retries on the same handle',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec("BEGIN IMMEDIATE; CREATE TABLE generated_caller(value TEXT); INSERT INTO generated_caller VALUES('before'); CREATE TABLE provider_cooldown_expiry(generated TEXT)");
  assert.throws(()=>installSchemaPlan(db,[providerAdmissionSchemaInstallation]),/there is already a table named provider_cooldown_expiry/);
  assert.equal(object(db,'provider_cooldowns'),undefined,'the first DDL statement must roll back with the failed index');
  assert.deepEqual({...object(db,'provider_cooldown_expiry')},{type:'table',name:'provider_cooldown_expiry'});
  assert.equal(db.isTransaction,true,'the caller transaction survives the nested install failure');
  db.exec("INSERT INTO generated_caller VALUES('after'); COMMIT");
  assert.deepEqual(db.prepare('SELECT value FROM generated_caller').all().map(row=>row.value),['before','after']);
  db.exec('DROP TABLE provider_cooldown_expiry');
  installSchemaPlan(db,[providerAdmissionSchemaInstallation]);
  assert.deepEqual({...object(db,'provider_cooldowns')},{type:'table',name:'provider_cooldowns'});
  assert.deepEqual({...object(db,'provider_cooldown_expiry')},{type:'index',name:'provider_cooldown_expiry'});
 }finally{db.close();}
});

for(const {name,installation,table,index} of [
 {name:'processor',installation:processorAdmissionSchemaInstallation,table:'processor_cooldowns'},
 {name:'provider',installation:providerAdmissionSchemaInstallation,table:'provider_cooldowns',index:'provider_cooldown_expiry'},
]){
 test(`an outer caller savepoint rollback removes the ${name} schema and the same handle reinstalls it`,()=>{
  const db=new DatabaseSync(':memory:');
  try{
   db.exec('BEGIN IMMEDIATE; SAVEPOINT generated_caller');
   installSchemaPlan(db,[installation]);
   assert.ok(object(db,table));if(index)assert.ok(object(db,index));
   assert.equal(db.isTransaction,true);
   db.exec('ROLLBACK TO generated_caller; RELEASE generated_caller');
   assert.equal(object(db,table),undefined);if(index)assert.equal(object(db,index),undefined);
   installSchemaPlan(db,[installation]);
   assert.ok(object(db,table));if(index)assert.ok(object(db,index));
   db.exec('COMMIT');
   assert.equal(db.isTransaction,false);
   installSchemaPlan(db,[installation]);
   assert.ok(object(db,table));if(index)assert.ok(object(db,index));
  }finally{db.close();}
 });
}

test('the two admission constructors install only their own schema and keep the existing cooldown behavior',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-admission-schema-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 assert.equal(object(store.db,'processor_cooldowns'),undefined);assert.equal(object(store.db,'provider_cooldowns'),undefined);
 let now=10000;
 const processor=new ProcessorAdmission(store,()=>now),endpoint='http://127.0.0.1:19009';
 assert.ok(object(store.db,'processor_cooldowns'));assert.equal(object(store.db,'provider_cooldowns'),undefined,'ProcessorAdmission must not activate provider admission');
 await assert.rejects(processor.run(endpoint,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',executionStarted:false});}),e=>e instanceof ProviderFailure&&e.details.executionStarted===false);
 assert.throws(()=>processor.check(endpoint),ProviderFailure);
 const provider=new ProviderAdmission(store,()=>now);
 assert.deepEqual({...object(store.db,'provider_cooldowns')},{type:'table',name:'provider_cooldowns'});
 assert.deepEqual({...object(store.db,'provider_cooldown_expiry')},{type:'index',name:'provider_cooldown_expiry'});
 await assert.rejects(provider.run(settings,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:12000});}),ProviderFailure);
 assert.throws(()=>provider.check(settings),ProviderFailure);
 assert.deepEqual(provider.snapshot(),{coolingDown:1,nextEligibleAt:22000});
 now=22000;
 assert.equal(await new ProviderAdmission(store,()=>now).run(settings,async()=>42),42);
 assert.equal(await new ProcessorAdmission(store,()=>now).run(endpoint,async()=>42),42);
});
