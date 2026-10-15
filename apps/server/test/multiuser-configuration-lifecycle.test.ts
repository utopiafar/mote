import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {parse,stringify} from 'yaml';
import {z} from 'zod';
import {buildApp} from '../src/app.js';
import {ConfigService} from '../src/config-service.js';
import {defaultModelSettings} from '../src/model-settings.js';
import {LifecycleAuthority,type LifecyclePurpose} from '../src/scope/lifecycle.js';
import {openScopeStorage} from '../src/scope/storage.js';
import type {Configurations} from '../src/scope/configuration.js';

const password='Synthetic-M04-lifecycle-password';
async function fixture(t:TestContext,register?:(configuration:Configurations)=>void){
  const directory=mkdtempSync(join(tmpdir(),'mote-m04-lifecycle-'));
  const storage=openScopeStorage(directory),deploymentId=storage.deploymentId;storage.close();
  const grants=new Map<string,{deploymentId:string;userId:string;domain:string;operationId:string;purpose:LifecyclePurpose}>(),revoked=new Set<string>();
  const control=new LifecycleAuthority(deploymentId,{verify:async token=>grants.get(token),isCurrent:context=>!revoked.has(context.operationId)});
  const node=await buildApp({dataDir:directory},{lifecycleAuthority:control});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  register?.(node.configuration);
  await node.accounts!.initialize('lifecycle-admin',password);
  const adminGrant=await node.accounts!.login('lifecycle-admin',password,'127.0.0.1','client',86_400_000),admin=await node.authority.authenticate(adminGrant.token);
  const context=async(username:string)=>{const grant=await node.accounts!.login(username,password,'127.0.0.1','client',86_400_000);return node.authority.authenticate(grant.token);};
  for(const username of ['lifecycle-a','lifecycle-b'])await node.accounts!.createAccount(admin,node.authority,{username,password,administrator:false});
  const a=await context('lifecycle-a'),b=await context('lifecycle-b');
  const configuration=(key:string)=>({profiles:[{id:'same-profile',name:'Synthetic lifecycle profile',settings:{...defaultModelSettings(),provider:'custom',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',model:'synthetic-model',apiKey:key}}],selections:{chat:{kind:'personal',id:'same-profile'}}});
  const save=async(subject= a,key='synthetic-lifecycle-A-key')=>node.configuration.forUser(subject).replace('models',configuration(key),0);
  const grant=async(purpose:LifecyclePurpose,operationId:string,userId=a.userId)=>{
    grants.set(operationId,{deploymentId,userId,domain:'configuration',operationId,purpose});return control.authorize(operationId);
  };
  const file=(userId=a.userId)=>join(directory,'configuration','users',userId,'mote.yaml');
  return {node,directory,a,b,admin,save,grant,revoked,file};
}

test('restore refuses credential-bearing YAML left by an interrupted deletion',async t=>{
  const f=await fixture(t);await f.save();await f.save(f.b,'synthetic-lifecycle-B-key');
  const archive=await f.node.services.forUser(f.a).exportUser('configuration'),before=readFileSync(f.file()),bBefore=readFileSync(f.file(f.b.userId));
  // Fault injection models a crash after the durable tombstone but before file
  // removal. It deliberately preserves the real product-created private YAML.
  const db=new DatabaseSync(join(f.directory,'mote.sqlite'));
  try{db.prepare('UPDATE user_configuration_state SET generation=generation+1,deleted=1 WHERE user_id=?').run(f.a.userId);}finally{db.close();}
  const restore=await f.grant('restore','restore-interrupted-delete');
  await assert.rejects(f.node.services.forLifecycle(restore).run(archive),{code:'config_conflict'});
  assert.deepEqual(readFileSync(f.file()),before);assert.deepEqual(readFileSync(f.file(f.b.userId)),bBefore);
  await assert.rejects(f.node.configuration.forUser(f.a).view(),{code:'invalid_identity'});
  assert.ok(!JSON.stringify(archive).includes('synthetic-lifecycle-A-key'));
});

test('duplicate usage receipts are rejected before any restore file or state is published',async t=>{
  const f=await fixture(t);await f.save();await f.save(f.b,'synthetic-lifecycle-B-key');
  const lease=await f.node.configuration.forUser(f.a).lease('chat','synthetic-usage');
  f.node.configuration.recordUsage(lease,{status:'completed',durationMs:3});
  const archive=await f.node.services.forUser(f.a).exportUser('configuration'),payload=archive.payload as {usage:unknown[]};
  payload.usage.push(structuredClone(payload.usage[0]));
  const bBefore=readFileSync(f.file(f.b.userId));
  await f.node.services.forLifecycle(await f.grant('delete','delete-before-invalid-restore')).run();
  await assert.rejects(f.node.services.forLifecycle(await f.grant('restore','restore-duplicate-receipts')).run(archive),{code:'config_invalid'});
  assert.equal(existsSync(f.file()),false);assert.equal(existsSync(join(f.file(),'..')),false);
  assert.deepEqual(readFileSync(f.file(f.b.userId)),bBefore);
  await assert.rejects(f.node.configuration.forUser(f.a).view(),{code:'invalid_identity'});
});

test('same-user restore and delete serialize while the sibling user remains unchanged',async t=>{
  const f=await fixture(t);await f.save();await f.save(f.b,'synthetic-lifecycle-B-key');
  const archive=await f.node.services.forUser(f.a).exportUser('configuration'),bBefore=readFileSync(f.file(f.b.userId));
  await f.node.services.forLifecycle(await f.grant('delete','initial-delete')).run();
  const restore=await f.grant('restore','restore-before-delete'),remove=await f.grant('delete','delete-after-restore');
  await Promise.all([f.node.services.forLifecycle(restore).run(archive),f.node.services.forLifecycle(remove).run()]);
  assert.equal(existsSync(f.file()),false);
  await assert.rejects(f.node.configuration.forUser(f.a).view(),{code:'invalid_identity'});
  const removeAgain=await f.grant('delete','delete-before-restore'),restoreAgain=await f.grant('restore','restore-after-delete');
  await Promise.all([f.node.services.forLifecycle(removeAgain).run(),f.node.services.forLifecycle(restoreAgain).run(archive)]);
  const restored=parse(readFileSync(f.file(),'utf8'));
  assert.equal(restored.models.profiles[0].settings.apiKey,'');
  assert.deepEqual(readdirSync(join(f.file(),'..')),['mote.yaml']);
  assert.deepEqual(readFileSync(f.file(f.b.userId)),bBefore);
});

test('revoked restore authorization cannot publish a prepared staging file',async t=>{
  const f=await fixture(t);await f.save();
  const archive=await f.node.services.forUser(f.a).exportUser('configuration');
  await f.node.services.forLifecycle(await f.grant('delete','delete-before-revoked-restore')).run();
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
  const initialize=ConfigService.prototype.initialize;
  t.mock.method(ConfigService.prototype,'initialize',function(this:ConfigService){
    const result=initialize.call(this);
    if(!basename(this.path).startsWith('.restore-'))return result;
    return result.then(async view=>{entered();await blocked;return view;});
  });
  const restore=await f.grant('restore','revoked-prepared-restore'),pending=f.node.services.forLifecycle(restore).run(archive);
  await started;f.revoked.add(restore.operationId);release();
  await assert.rejects(pending,{code:'invalid_identity'});
  assert.equal(existsSync(f.file()),false);
  assert.deepEqual(readdirSync(join(f.file(),'..')),[]);
  await assert.rejects(f.node.configuration.forUser(f.a).view(),{code:'invalid_identity'});
});

test('registered public configuration domains round-trip through the same domain schemas',async t=>{
  const f=await fixture(t,configuration=>configuration.registerDomain('fixturePublic',()=>({
    id:'fixturePublic',schema:z.object({label:z.string().min(1).default('synthetic-default')}).strict(),
    defaultValue:{label:'synthetic-default'},fields:[{path:'label',effect:'next-request'}],resolve:raw=>raw,
  })));
  await f.save();await f.node.configuration.forUser(f.a).replace('fixturePublic',{label:'synthetic-restored-extension'},1);
  const archive=await f.node.services.forUser(f.a).exportUser('configuration');
  await f.node.services.forLifecycle(await f.grant('delete','delete-public-extension')).run();
  const missing=structuredClone(archive),missingPayload=missing.payload as {document:Record<string,unknown>};delete missingPayload.document.fixturePublic;
  await assert.rejects(f.node.services.forLifecycle(await f.grant('restore','restore-missing-public-extension')).run(missing),{code:'config_invalid'});
  assert.equal(existsSync(f.file()),false);
  const unknown=structuredClone(archive);(unknown.payload as {document:Record<string,unknown>}).document.unknownPlugin={label:'synthetic-undeclared-domain'};
  await assert.rejects(f.node.services.forLifecycle(await f.grant('restore','restore-unknown-public-extension')).run(unknown),{code:'config_invalid'});
  assert.equal(existsSync(f.file()),false);
  const wrongDomain=structuredClone(archive);Object.assign(wrongDomain,{domain:'another-domain'});
  await assert.rejects(async()=>f.node.services.forLifecycle(await f.grant('restore','restore-wrong-domain')).run(wrongDomain),{code:'invalid_identity'});
  assert.equal(existsSync(f.file()),false);
  await f.node.services.forLifecycle(await f.grant('restore','restore-public-extension')).run(archive);
  const restored=await f.node.configuration.forUser(f.a).view();
  assert.deepEqual(restored.domains.find(domain=>domain.id==='fixturePublic')!.effective,{label:'synthetic-restored-extension'});
  assert.ok(!readFileSync(f.file(),'utf8').includes('synthetic-lifecycle-A-key'));
});

test('revoked export grants cannot leave a watcher able to publish ordinary plugin configuration',async t=>{
  let publications=0;
  const f=await fixture(t,configuration=>configuration.registerDomain('fixturePublic',()=>({
    id:'fixturePublic',schema:z.object({value:z.number().int()}).strict(),defaultValue:{value:0},
    resolve:raw=>raw,prepare:()=>({apply:()=>{},publish:()=>{publications++;},rollback:()=>{publications--;}}),
  })));
  await f.save();f.node.accounts!.disable(f.admin,f.node.authority,f.a.userId,true);
  const authorization=await f.grant('export','temporary-disabled-export');
  await f.node.services.forLifecycle(authorization).run();
  const before=publications;f.revoked.add(authorization.operationId);
  const document=parse(readFileSync(f.file(),'utf8'));document.fixturePublic.value=1;
  writeFileSync(f.file(),stringify(document));
  await delay(500);
  assert.equal(publications,before);
  await assert.rejects(async()=>f.node.services.forLifecycle(authorization).run(),{code:'invalid_identity'});
});
