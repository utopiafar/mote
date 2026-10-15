import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {buildApp} from '../src/app.js';
import {defaultModelDomain,defaultModelSettings} from '../src/model-settings.js';
import type {UserContext} from '../src/scope/context.js';

const password='Synthetic-M04-durable-password';
const protocol={'x-mote-protocol-version':'2'};
const aKey='synthetic-durable-A-key',bKey='synthetic-durable-B-key',sharedKey='synthetic-durable-shared-key';
const settings=(key:string,model='synthetic-original-model',baseUrl='https://synthetic.invalid/v1')=>({
  ...defaultModelSettings(),provider:'custom',protocol:'openai-completions' as const,reasoningEffort:'auto' as const,
  baseUrl,model,apiKey:key,headers:{'x-synthetic-auth':'synthetic-durable-header-key'},extraBody:{credential:'synthetic-durable-body-key'},
});
const personal=(key:string,model?:string,baseUrl?:string)=>({
  profiles:[{id:'same-profile',name:'Synthetic personal model',settings:settings(key,model,baseUrl)}],
  selections:{chat:{kind:'personal' as const,id:'same-profile'}},
});
const price={provider:'custom',model:'synthetic-original-model',currency:'USD' as const,input:2,output:4,cacheRead:1,cacheWrite:2};
const usage={status:'completed' as const,durationMs:12,tokens:{requests:1,reportedRequests:1,inputTokens:100,outputTokens:10,totalTokens:110,cacheReadTokens:0,cacheWriteTokens:0}};
type Grant={token:string;userId:string};
async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-m04-durable-snapshot-'));
  let node=await buildApp({dataDir:directory});
  const register=()=>node.configuration.registerDomain('fixtureOptions',()=>({
    id:'fixtureOptions',schema:z.object({label:z.string(),restartLimit:z.number()}).strict(),
    defaultValue:{label:'synthetic-default',restartLimit:1},resolve:raw=>raw,
    fields:[{path:'label',effect:'next-request'},{path:'restartLimit',effect:'restart'}],
  }));
  register();
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.accounts!.initialize('durable-admin',password);
  const login=async(username:string):Promise<Grant>=>{
    const response=await node.app.inject({method:'POST',url:'/api/auth/login',headers:protocol,payload:{username,password,mode:'client'}});
    assert.equal(response.statusCode,200,response.body);return response.json();
  };
  const admin=await login('durable-admin');
  const request=(grant:Grant,method:'GET'|'PUT'|'POST',url:string,payload?:unknown)=>node.app.inject({
    method,url,headers:{...protocol,authorization:'Bearer '+grant.token},...(payload===undefined?{}:{payload}),
  });
  for(const username of ['durable-a','durable-b'])assert.equal((await request(admin,'POST','/api/admin/accounts',{username,password})).statusCode,200);
  const a=await login('durable-a'),b=await login('durable-b');
  const context=(grant:Grant)=>node.authority.authenticate(grant.token);
  const service=async(grant:Grant)=>node.configuration.forUser(await context(grant));
  const save=async(grant:Grant,key:string,revision=0,model?:string,baseUrl?:string)=>{
    const response=await request(grant,'PUT','/api/configuration/models',{revision,value:personal(key,model,baseUrl)});
    assert.equal(response.statusCode,200,response.body);assert.ok(!response.body.includes(key));return response.json();
  };
  const shared={...defaultModelDomain(),deployment:settings(sharedKey,'synthetic-shared-model')};
  const publishShared=async(value=shared)=>{
    const response=await request(admin,'PUT','/api/admin/configuration/models',{revision:node.configuration.instance.revision,value});
    assert.equal(response.statusCode,200,response.body);assert.ok(!response.body.includes(sharedKey));
  };
  const restart=async()=>{await node.app.close();node=await buildApp({dataDir:directory});register();};
  const restored=async(grant:Grant,snapshotId:string,operationId:string)=>{
    const result=await node.configuration.restoreLease(await context(grant),snapshotId,operationId);
    assert.ok(result.status==='restored',JSON.stringify(result));return result.lease;
  };
  return {directory,get node(){return node;},a,b,admin,login,context,service,save,request,shared,publishShared,restart,restored};
}

test('real app restart restores the original effective model/configuration/price and deduplicates recovered usage',async t=>{
  const f=await fixture(t);await f.save(f.a,aKey);await f.save(f.b,bKey);
  const service=await f.service(f.a);
  await service.replace('modelPrices',{items:[price]},1);
  await service.replace('fixtureOptions',{label:'synthetic-original-options',restartLimit:99},2);
  const lease=await service.lease('chat','synthetic-recovered-operation');
  const priceLease=await service.lease('chat','synthetic-recovered-pricing');
  assert.equal(lease.id,lease.snapshotId);assert.doesNotMatch(JSON.stringify(lease),/synthetic-durable-.*key/);
  const original=f.node.configuration.recordUsage(lease,usage);
  await f.save(f.a,aKey,3,'synthetic-new-model','https://new-synthetic.invalid/v2');
  await service.replace('modelPrices',{items:[{...price,input:200}]},4);
  await service.replace('fixtureOptions',{label:'synthetic-new-options',restartLimit:100},5);
  const oldContext=await f.context(f.a);await f.restart();
  await assert.rejects(f.node.configuration.restoreLease(oldContext,lease.snapshotId,lease.operationId),{code:'invalid_identity'});
  const recovered=await f.restored(f.a,lease.snapshotId,lease.operationId);
  assert.equal(recovered.id,lease.id);assert.equal(recovered.revision,lease.revision);assert.equal(recovered.model,'synthetic-original-model');
  await f.node.configuration.withModel(recovered,async(model,configuration)=>{
    assert.equal(model.apiKey,aKey);assert.equal(model.model,'synthetic-original-model');assert.equal(model.baseUrl,'https://synthetic.invalid/v1');
    assert.deepEqual(configuration.fixtureOptions,{label:'synthetic-original-options',restartLimit:1});
    assert.deepEqual(configuration.modelPrices,{items:[price]});
  });
  assert.deepEqual(f.node.configuration.recordUsage(recovered,{...usage,durationMs:999}),original);
  const recoveredPricing=await f.restored(f.a,priceLease.snapshotId,priceLease.operationId);
  assert.equal(f.node.configuration.recordUsage(recoveredPricing,usage).estimatedCost,0.00024);
  const again=await (await f.service(f.a)).restoreLease(lease.snapshotId,lease.operationId);
  assert.ok(again.status==='restored');f.node.configuration.recordUsage(again.lease,usage);
  assert.equal((await f.service(f.a)).usage().total.runs,2);assert.equal((await f.service(f.b)).usage().total.runs,0);
  for(const suffix of ['','-wal'])if(existsSync(join(f.directory,'mote.sqlite'+suffix))){
    const bytes=readFileSync(join(f.directory,'mote.sqlite'+suffix));
    for(const key of [aKey,bKey,'synthetic-durable-header-key','synthetic-durable-body-key'])assert.ok(!bytes.includes(Buffer.from(key)));
  }
});

test('durable model snapshots require the same host user and expected operation without disclosing other accounts',async t=>{
  const f=await fixture(t),other=await fixture(t);await f.save(f.a,aKey);
  const context=await f.context(f.a),lease=await (await f.service(f.a)).lease('chat','synthetic-owner-operation');
  assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.b),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'snapshot_unavailable'});
  assert.deepEqual(await f.node.configuration.restoreLease(context,lease.snapshotId,'synthetic-wrong-operation'),{status:'unavailable',reason:'operation_mismatch'});
  await assert.rejects(f.node.configuration.restoreLease({...context} as UserContext,lease.snapshotId,lease.operationId),{code:'invalid_identity'});
  await assert.rejects(f.node.configuration.restoreLease(await other.context(other.a),lease.snapshotId,lease.operationId),{code:'invalid_identity'});
  assert.equal((await f.restored(f.a,lease.snapshotId,lease.operationId)).snapshotId,lease.snapshotId);
});

test('shared withdrawal and identical republication across restart never revive an old durable snapshot',async t=>{
  const f=await fixture(t);await f.publishShared();
  await (await f.service(f.a)).replace('models',{profiles:[],selections:{chat:{kind:'shared',id:'env:deployment'}}},0);
  const lease=await (await f.service(f.a)).lease('chat','synthetic-shared-operation');
  await f.restart();await f.publishShared({...f.shared,deployment:{...f.shared.deployment,model:''}});
  await f.restart();await f.publishShared();
  assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'shared_resource_revoked'});
  const current=await (await f.service(f.a)).lease('chat','synthetic-current-shared');
  assert.equal((await f.restored(f.a,current.snapshotId,current.operationId)).model,'synthetic-shared-model');
});

test('personal credential or profile withdrawal survives restart and identical republication',async t=>{
  for(const withdrawal of ['credential','whitespace','profile'] as const)await t.test(withdrawal,async t=>{
    const f=await fixture(t);await f.save(f.a,aKey);
    const service=await f.service(f.a),lease=await service.lease('chat','synthetic-personal-withdrawal');
    await service.replace('models',withdrawal==='profile'?{profiles:[],selections:{}}:personal(withdrawal==='whitespace'?'   ':''),1);
    await f.restart();await f.save(f.a,aKey,2);
    assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'credentials_revoked'});
    const current=await (await f.service(f.a)).lease('chat','synthetic-republished-personal');
    await f.restored(f.a,current.snapshotId,current.operationId);
  });
});

test('personal key replacement preserves admitted live work but cannot rehydrate the old credential after restart',async t=>{
  const f=await fixture(t);await f.save(f.a,aKey);
  const lease=await (await f.service(f.a)).lease('chat','synthetic-replaced-credential');
  await f.save(f.a,'synthetic-durable-replacement-key',1);
  assert.equal(await f.node.configuration.withModel(lease,async model=>model.apiKey),aKey);
  await f.restart();
  assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'credentials_revoked'});
  await f.save(f.a,aKey,2);await f.restart();
  assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'credentials_revoked'});
  const current=await (await f.service(f.a)).lease('chat','synthetic-after-key-republication');
  await f.restored(f.a,current.snapshotId,current.operationId);
});

test('a valid new password-reset epoch cannot recover an old durable model authorization',async t=>{
  const f=await fixture(t);await f.save(f.a,aKey);await f.save(f.b,bKey);
  const a=await (await f.service(f.a)).lease('chat','synthetic-before-reset'),b=await (await f.service(f.b)).lease('chat','synthetic-B-before-reset');
  await f.node.accounts!.resetPassword(await f.context(f.admin),f.node.authority,f.a.userId,password);
  const fresh=await f.login('durable-a');await f.restart();
  assert.deepEqual(await f.node.configuration.restoreLease(await f.context(fresh),a.snapshotId,a.operationId),{status:'unavailable',reason:'authorization_changed'});
  await f.restored(f.b,b.snapshotId,b.operationId);
});

test('production startup fences snapshots whose durable resource or credential revision became uncertain',async t=>{
  for(const resource of ['shared','personal'] as const)await t.test(resource,async t=>{
    const f=await fixture(t);
    if(resource==='shared'){
      await f.publishShared();
      await (await f.service(f.a)).replace('models',{profiles:[],selections:{chat:{kind:'shared',id:'env:deployment'}}},0);
    }else await f.save(f.a,aKey);
    const lease=await (await f.service(f.a)).lease('chat','synthetic-uncertain-revision');
    const db=new DatabaseSync(join(f.directory,'mote.sqlite'));
    try{
      if(resource==='shared')db.exec('UPDATE model_resource_revision SET revision=revision+1');
      else db.prepare('UPDATE user_model_snapshot_revision SET revision=revision+1 WHERE user_id=?').run(f.a.userId);
    }finally{db.close();}
    await f.restart();
    assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{
      status:'unavailable',reason:resource==='shared'?'shared_resource_revoked':'credentials_revoked',
    });
    const current=await (await f.service(f.a)).lease('chat','synthetic-after-uncertain-revision');
    await f.restored(f.a,current.snapshotId,current.operationId);
  });
});

test('corrupt ciphertext or a lost key is an unavailable durable snapshot without a current-model fallback',async t=>{
  for(const fault of ['ciphertext','key'] as const)await t.test(fault,async t=>{
    const f=await fixture(t);await f.save(f.a,aKey);
    const lease=await (await f.service(f.a)).lease('chat','synthetic-unavailable-snapshot');
    await f.save(f.a,aKey,1,'synthetic-current-model');
    if(fault==='ciphertext'){
      const db=new DatabaseSync(join(f.directory,'mote.sqlite'));
      try{db.prepare('UPDATE user_model_snapshots SET tag=? WHERE user_id=? AND id=?').run(Buffer.alloc(16),f.a.userId,lease.snapshotId);}finally{db.close();}
    }else rmSync(join(f.directory,'configuration','users',f.a.userId,'snapshot-key'));
    assert.deepEqual(await f.node.configuration.restoreLease(await f.context(f.a),lease.snapshotId,lease.operationId),{status:'unavailable',reason:'snapshot_unavailable'});
  });
});

test('portable export omits encrypted snapshots and keys; deleting A leaves B recovery and usage intact',async t=>{
  const f=await fixture(t);await f.save(f.a,aKey);await f.save(f.b,bKey);
  const aContext=await f.context(f.a),a=await (await f.service(f.a)).lease('chat','synthetic-delete-A'),b=await (await f.service(f.b)).lease('chat','synthetic-keep-B');
  f.node.configuration.recordUsage(a,usage);f.node.configuration.recordUsage(b,usage);
  const archive=await f.node.services.forUser(aContext).exportUser('configuration'),encoded=JSON.stringify(archive);
  for(const key of [aKey,bKey,'synthetic-durable-header-key','synthetic-durable-body-key'])assert.ok(!encoded.includes(key));
  assert.doesNotMatch(encoded,/ciphertext|nonce|authTag|snapshot-key|encryptedSnapshots/);
  assert.deepEqual(Object.keys(archive.payload as object).sort(),['credentialsIncluded','document','omittedDomains','usage']);
  await f.node.services.forUser(aContext).deleteUser('configuration','synthetic-delete-configuration');
  const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});
  try{
    assert.equal(db.prepare('SELECT count(*) AS count FROM user_model_snapshots WHERE user_id=?').get(f.a.userId)!.count,0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM user_model_snapshots WHERE user_id=?').get(f.b.userId)!.count,1);
  }finally{db.close();}
  assert.equal(existsSync(join(f.directory,'configuration','users',f.a.userId,'snapshot-key')),false);
  assert.equal(existsSync(join(f.directory,'configuration','users',f.b.userId,'snapshot-key')),true);
  await f.restart();
  const denied=await f.node.configuration.restoreLease(await f.context(f.a),a.snapshotId,a.operationId);
  assert.ok(denied.status==='unavailable');assert.ok(['configuration_deleted','snapshot_unavailable'].includes(denied.reason));
  const recoveredB=await f.restored(f.b,b.snapshotId,b.operationId);
  assert.equal(await f.node.configuration.withModel(recoveredB,async model=>model.apiKey),bKey);
  f.node.configuration.recordUsage(recoveredB,usage);assert.equal((await f.service(f.b)).usage().total.runs,1);
});
