import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {DatabaseSync} from 'node:sqlite';
import {buildApp} from '../src/app.js';
import {defaultModelDomain,defaultModelSettings} from '../src/model-settings.js';
import type {UserConfigurationService,ModelLease} from '../src/scope/configuration.js';
import {LifecycleAuthority} from '../src/scope/lifecycle.js';

const password='Synthetic-M04-account-password';
const protocol={'x-mote-protocol-version':'2'};
const settings=(key:string,model='synthetic-model')=>({...defaultModelSettings(),provider:'custom',protocol:'openai-completions' as const,reasoningEffort:'auto' as const,baseUrl:'https://synthetic.invalid/v1',model,apiKey:key});
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-m04-'));
 const node=await buildApp({dataDir:directory});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.accounts!.initialize('synthetic-admin',password);
 const login=async(username:string,mode:'client'|'web'='client')=>{const r=await node.app.inject({method:'POST',url:'/api/auth/login',headers:protocol,payload:{username,password,mode}});assert.equal(r.statusCode,200,r.body);return {r,...r.json()};};
 const admin=await login('synthetic-admin');
 const header=(grant:any)=>grant.token?{...protocol,authorization:'Bearer '+grant.token}:{...protocol,cookie:String(grant.r.headers['set-cookie']).split(';')[0],'x-mote-session-id':grant.credentialId,'x-mote-csrf':grant.csrfToken};
 const request=(grant:any,method:any,url:string,payload?:unknown)=>node.app.inject({method,url,headers:header(grant),...(payload===undefined?{}:{payload})});
 for(const username of ['synthetic-a','synthetic-b'])assert.equal((await request(admin,'POST','/api/admin/accounts',{username,password})).statusCode,200);
 const a=await login('synthetic-a','web'),b=await login('synthetic-b','web');
 const context=async(g:any)=>node.authority.authenticate(g.token??String(g.r.headers['set-cookie']).split(';')[0].split('=')[1]);
 const service=async(g:any)=>node.services.forUser(await context(g)).get<UserConfigurationService>('configuration');
 const config=(key:string,model='synthetic-model')=>({profiles:[{id:'same-profile',name:'Synthetic personal',settings:settings(key,model)}],selections:{chat:{kind:'personal',id:'same-profile'}}});
 const save=async(g:any,key:string,revision=0,model='synthetic-model')=>request(g,'PUT','/api/configuration/models',{revision,value:config(key,model)});
 const file=(g:any)=>join(directory,'configuration','users',g.userId,'mote.yaml');
 const shared={...defaultModelDomain(),deployment:settings('synthetic-shared-key','shared-model')};
 assert.equal((await request(admin,'PUT','/api/admin/configuration/models',{revision:0,value:shared})).statusCode,200);
 return {directory,node,login,admin,a,b,header,request,service,context,config,save,file,shared};
}

test('production page API and per-user files share schema, CAS, watcher and credential redaction',async t=>{
 const f=await fixture(t);
 for(const [g,key] of [[f.a,'synthetic-A-key'],[f.b,'synthetic-B-key']] as const){
  const r=await f.save(g,key);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().revision,1);assert.ok(!r.body.includes(key));
  assert.equal(statSync(f.file(g)).mode&0o777,0o600);assert.equal(statSync(join(f.file(g),'..')).mode&0o777,0o700);
 }
 assert.equal((await f.save(f.a,'synthetic-A-new-key',0)).statusCode,409);
 const aService=await f.service(f.a),bBefore=await (await f.service(f.b)).view();
 const invalid={...f.config('synthetic-A-key'),server:{port:9999}};
 assert.equal((await f.request(f.a,'PUT','/api/configuration/models',{revision:1,value:invalid})).statusCode,400);
 const doc=parse(readFileSync(f.file(f.a),'utf8'));doc.models.server={port:9999};writeFileSync(f.file(f.a),stringify(doc));
 assert.equal((await f.request(f.a,'POST','/api/configuration/reload',{})).statusCode,400);
 assert.equal((await aService.view()).revision,1);
 delete doc.models.server;doc.models.profiles[0].settings.model='file-change';writeFileSync(f.file(f.a),stringify(doc));
 const loaded=await f.request(f.a,'POST','/api/configuration/reload',{});assert.equal(loaded.statusCode,200,loaded.body);assert.equal(loaded.json().revision,2);
 doc.revision=1;doc.models.profiles[0].settings.model='stale-file';writeFileSync(f.file(f.a),stringify(doc));
 assert.equal((await f.request(f.a,'POST','/api/configuration/reload',{})).statusCode,409);
 assert.deepEqual(await (await f.service(f.b)).view(),bBefore);
 const view=await f.request(f.a,'GET','/api/configuration');assert.doesNotMatch(view.body,/synthetic-[AB]-key|synthetic-shared-key/);
 assert.equal(view.json().configFile,'user-config:mote.yaml');
});

test('ordinary users cannot edit instance fields, choose another user, read shared credentials or replace shared transport',async t=>{
 const f=await fixture(t);await f.save(f.a,'synthetic-A-key');await f.save(f.b,'synthetic-B-key');
 for(const domain of ['server','storage','execution','connectors','plugins'])assert.equal((await f.request(f.a,'PATCH','/api/configuration',{revision:1,patches:{[domain]:{port:1234}}})).statusCode,400);
 assert.equal((await f.request(f.a,'GET','/api/admin/configuration/models')).statusCode,403);
 assert.equal((await f.request(f.a,'PUT','/api/admin/configuration/models',{revision:1,value:f.shared})).statusCode,403);
 for(const g of [f.a,f.admin])assert.equal((await f.request(g,'GET','/api/configuration?userId='+f.b.userId)).statusCode,401);
 const forged=await f.node.app.inject({url:'/api/configuration',headers:{...f.header(f.a),'x-user-id':f.b.userId}});assert.equal(forged.statusCode,401);
 assert.equal((await f.request(f.admin,'GET','/api/configuration/'+f.b.userId)).statusCode,503);
 const view=await f.request(f.a,'GET','/api/models');assert.equal(view.statusCode,200);assert.doesNotMatch(view.body,/synthetic-(B|shared)-key/);
 assert.deepEqual(view.json().shared.map((r:any)=>Object.keys(r).sort()),[['id','model','name','provider','readOnly'].sort()]);
 const shared={profiles:[],selections:{chat:{kind:'shared',id:'env:deployment'}}};
 assert.equal((await f.request(f.a,'PUT','/api/configuration/models',{revision:1,value:shared})).statusCode,200);
 for(const field of ['baseUrl','apiKey','settings','model','headers']){
  const changed=structuredClone(shared);Object.assign(changed.selections.chat,{[field]:field==='baseUrl'?'https://attacker.invalid':{}});
  assert.equal((await f.request(f.a,'PUT','/api/configuration/models',{revision:2,value:changed})).statusCode,400);
 }
 const env=f.config('${MOTE_M04_SHARED_FIXTURE}');process.env.MOTE_M04_SHARED_FIXTURE='synthetic-env-secret';t.after(()=>delete process.env.MOTE_M04_SHARED_FIXTURE);
 const denied=await f.request(f.a,'PUT','/api/configuration/models',{revision:2,value:env});assert.equal(denied.statusCode,400);assert.ok(!denied.body.includes('synthetic-env-secret'));
});

test('two users pin different in-flight configurations; usage and host leases cannot cross accounts or silently fall back',async t=>{
 const f=await fixture(t);await f.save(f.a,'synthetic-A-key');await f.save(f.b,'synthetic-B-key');
 const a=await f.service(f.a),b=await f.service(f.b),aLease=await a.lease('chat','same-operation'),bLease=await b.lease('chat','same-operation');
 assert.equal((await f.request(f.a,'GET','/api/models/selection/memory')).statusCode,503);
 assert.ok(!JSON.stringify(aLease).includes('synthetic-A-key'));assert.notEqual(aLease.userId,bLease.userId);
 await f.save(f.a,'synthetic-A-new',1,'new-A-model');
 assert.equal(await f.node.configuration.withModel(aLease,async s=>s.apiKey),'synthetic-A-key');
 assert.equal(await f.node.configuration.withModel(bLease,async s=>s.apiKey),'synthetic-B-key');
 assert.equal((await a.lease('chat','next-operation')).model,'new-A-model');
 const input={status:'completed' as const,durationMs:12,tokens:{requests:1,reportedRequests:1,inputTokens:10,outputTokens:4,totalTokens:14,cacheReadTokens:0,cacheWriteTokens:0}};
 f.node.configuration.recordUsage(aLease,input);f.node.configuration.recordUsage(aLease,input);f.node.configuration.recordUsage(bLease,{...input,tokens:{...input.tokens,inputTokens:5,totalTokens:9}});
 const usageA=await f.request(f.a,'GET','/api/usage'),usageB=await f.request(f.b,'GET','/api/usage');assert.equal(usageA.json().total.runs,1);assert.equal(usageA.json().total.inputTokens,10);assert.equal(usageB.json().total.inputTokens,5);assert.doesNotMatch(usageA.body,/synthetic-.*key/);
 assert.throws(()=>f.node.configuration.recordUsage({...aLease,userId:f.b.userId} as ModelLease,input),{code:'invalid_identity'});
 await assert.rejects(f.node.configuration.withModel(aLease,async()=>{throw Error('synthetic-A-key provider-response');}),{code:'config_unavailable'});
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});try{assert.ok(!JSON.stringify(db.prepare('SELECT * FROM user_model_usage').all()).includes('synthetic-A-key'));}finally{db.close();}
});

test('shared resource withdrawal fences old leases and explicit selection never falls back to a personal resource',async t=>{
 const f=await fixture(t),a=await f.service(f.a);
 await a.replace('models',{profiles:[],selections:{chat:{kind:'shared',id:'env:deployment'}}},0);
 const lease=await a.lease('chat','shared-operation');assert.equal(await f.node.configuration.withModel(lease,async s=>s.apiKey),'synthetic-shared-key');
 const changed={...f.shared,deployment:{...f.shared.deployment,model:''}};
 assert.equal((await f.request(f.admin,'PUT','/api/admin/configuration/models',{revision:1,value:changed})).statusCode,200);
 assert.throws(()=>f.node.configuration.assertLease(lease));await assert.rejects(a.lease('chat','new-operation'),{code:'scope_unavailable'});
 assert.equal((await f.request(f.admin,'PUT','/api/admin/configuration/models',{revision:2,value:f.shared})).statusCode,200);
 assert.throws(()=>f.node.configuration.assertLease(lease),{code:'invalid_identity'});
 const current=await a.lease('chat','republished-operation');f.node.configuration.assertLease(current);
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 const late=f.node.configuration.withModel(current,async()=>{entered();await blocked;return 'synthetic-late-result';});await started;
 await f.request(f.admin,'PUT','/api/admin/configuration/models',{revision:3,value:changed});
 await f.request(f.admin,'PUT','/api/admin/configuration/models',{revision:4,value:f.shared});release();
 await assert.rejects(late,{code:'invalid_identity'});assert.throws(()=>f.node.configuration.recordUsage(current,{status:'completed',durationMs:1}),{code:'invalid_identity'});
 f.node.configuration.assertLease(await a.lease('chat','after-republication'));
});

test('logout preserves admitted account work; disable/reset and deletion fence late model results and usage',async t=>{
 const f=await fixture(t);await f.save(f.a,'synthetic-A-key');await f.save(f.b,'synthetic-B-key');
 const a=await f.service(f.a),b=await f.service(f.b),lease=await a.lease('chat','late-operation'),bLease=await b.lease('chat','B-operation');
 assert.equal((await f.request(f.a,'POST','/api/auth/logout',{})).statusCode,200);f.node.configuration.assertLease(lease);
 const again=await f.login('synthetic-a');
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);
 const pending=f.node.configuration.withModel(lease,async()=>{entered();await wait;return 'late synthetic model result';});await started;
 assert.equal((await f.request(f.admin,'PATCH','/api/admin/accounts/'+again.userId,{disabled:true})).statusCode,200);release();await assert.rejects(pending,{code:'invalid_identity'});
 assert.throws(()=>f.node.configuration.recordUsage(lease,{status:'completed',durationMs:1}),{code:'invalid_identity'});f.node.configuration.assertLease(bLease);
 await f.request(f.admin,'PATCH','/api/admin/accounts/'+again.userId,{disabled:false});
 const restored=await f.login('synthetic-a');assert.equal((await f.service(restored)).view instanceof Function,true);assert.equal((await (await f.service(restored)).view()).revision,1);
 const current=await (await f.service(restored)).lease('chat','delete-operation');
 await f.node.services.forUser(await f.context(restored)).deleteUser('configuration','synthetic-delete');
 assert.throws(()=>f.node.configuration.assertLease(current),{code:'invalid_identity'});assert.equal((await f.request(restored,'GET','/api/configuration')).statusCode,401);f.node.configuration.assertLease(bLease);
});

test('configuration lifecycle export excludes credentials; delete and restore validate ownership and are repeatable',async t=>{
 const f=await fixture(t);await f.save(f.a,'synthetic-A-key');await f.save(f.b,'synthetic-B-key');
 const a=f.node.services.forUser(await f.context(f.a)),b=f.node.services.forUser(await f.context(f.b));
 const archive=await a.exportUser('configuration'),bBefore=readFileSync(f.file(f.b));assert.ok(!JSON.stringify(archive).includes('synthetic-A-key'));assert.ok(!JSON.stringify(archive).includes('synthetic-B-key'));assert.ok(!JSON.stringify(archive).includes('synthetic-shared-key'));
 await assert.rejects(async()=>b.restoreUser('configuration',archive,'wrong-target'),{code:'invalid_identity'});
 await a.deleteUser('configuration','delete-A');await a.deleteUser('configuration','delete-A');
 const broken=structuredClone(archive);broken.version=999;await assert.rejects(a.restoreUser('configuration',broken,'restore-A'),{code:'config_invalid'});
 await a.restoreUser('configuration',archive,'restore-A');await a.restoreUser('configuration',archive,'restore-A');
 assert.deepEqual(readFileSync(f.file(f.b)),bBefore);assert.equal((await (await f.service(f.a)).view()).revision,0);
 await assert.rejects((await f.service(f.a)).lease('chat','after-restore'),{code:'scope_unavailable'});
 const saved=parse(readFileSync(f.file(f.a),'utf8'));assert.equal(saved.models.profiles[0].settings.apiKey,'');
});

test('pinned prices and per-user usage survive restart without reviving host lease objects',async t=>{
 const f=await fixture(t);await f.save(f.a,'synthetic-A-key');await f.save(f.b,'synthetic-B-key');
 const a=await f.service(f.a),b=await f.service(f.b),price={provider:'custom',model:'synthetic-model',currency:'USD',input:2,output:4,cacheRead:1,cacheWrite:2};
 await a.replace('modelPrices',{items:[price]},1);
 const lease=await a.lease('chat','persistent-operation');
 await a.replace('modelPrices',{items:[{...price,input:200}]},2);
 const receipt=f.node.configuration.recordUsage(lease,{status:'completed',durationMs:12,tokens:{requests:1,reportedRequests:1,inputTokens:100,outputTokens:10,totalTokens:110,cacheReadTokens:0,cacheWriteTokens:0}});
 assert.equal(receipt.estimatedCost,0.00024);assert.equal(b.usage().total.runs,0);
 await f.node.app.close();const restarted=await buildApp({dataDir:f.directory});
 try{
  const credential=(g:any)=>String(g.r.headers['set-cookie']).split(';')[0].split('=')[1];
  const aContext=await restarted.authority.authenticate(credential(f.a)),bContext=await restarted.authority.authenticate(credential(f.b));
  assert.equal(restarted.configuration.forUser(aContext).usage().total.runs,1);assert.equal(restarted.configuration.forUser(bContext).usage().total.runs,0);
  assert.equal((await restarted.configuration.forUser(aContext).view()).revision,3);
  assert.throws(()=>restarted.configuration.assertLease(lease),{code:'invalid_identity'});
 }finally{await restarted.app.close();}
});
