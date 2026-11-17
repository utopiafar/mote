import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PluginHost,type HostScope} from '@mote/plugin-host';
import type {PluginLifecycle} from '@mote/plugin-api/contracts';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {UsageLedger} from '../src/usage.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {createObservabilityPlatformFactory,type ObservabilityPlatform} from '../src/plugins/observability-platform.js';
import {buildApp} from '../src/app.js';
import {} from '../src/config.js';

const tokens={requests:1,reportedRequests:1,inputTokens:1000000,outputTokens:100000,totalTokens:1100000,cacheReadTokens:500000,cacheWriteTokens:100000};
const price={provider:'generated',model:'generated-model',currency:'USD',input:2,output:8,cacheRead:0.5,cacheWrite:3};
const lifecycle=():PluginLifecycle=>({prepare(){},start(){},quiesce(){},stop(){},dispose(){}});

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-usage-scope-')),store=new Store(directory),host=new PluginHost({kind:'central',id:randomUUID()});
 const captured:{vault?:ReturnType<typeof createVaultPlatformAssembly>;scope?:HostScope}={};
 const identity=(id:string)=>({host:host.identity,packageId:'generated.usage',installationId:id,instanceId:id,activationId:randomUUID()});
 const owner=await host.install({identity:identity('vault'),contributions:[],factory:context=>{
  const vault=createVaultPlatformAssembly({dataDir:directory},{store});captured.vault=vault;captured.scope=context.scope;
  context.scope.defer(()=>vault.close());
  return {...lifecycle(),prepare:()=>vault.prepare(),stop:()=>vault.close(),dispose:()=>vault.close()};
 }});
 if(!captured.vault||!captured.scope)throw Error('Generated Vault did not start');
 const vault=captured.vault,ownerScope=captured.scope;
 t.after(async()=>{try{await host.close();}finally{store.close();rmSync(directory,{recursive:true,force:true});}});
 const consumer=async(id:string)=>{
  const result:{scope?:HostScope}={};
  const handle=await host.install({identity:identity(id),contributions:[],factory:context=>{result.scope=context.scope;return lifecycle();}});
  if(!result.scope)throw Error('Generated consumer did not start');return {scope:result.scope,handle};
 };
 const observability=async()=>{
  const result:{platform?:ObservabilityPlatform}={};
  const handle=await host.install({identity:identity('observability'),contributions:[{id:'observability-platform',apiVersion:'1'}],
   factory:createObservabilityPlatformFactory({logDirectory:join(directory,'logs'),update:{currentVersion:'0.4.0',runtime:'native'}},
    {usageForScope:scope=>vault.usageForAssembly(ownerScope,scope)},platform=>{result.platform=platform;})});
  if(!result.platform)throw Error('Generated observability did not start');return {platform:result.platform,handle};
 };
 return {directory,store,host,vault,owner,ownerScope,consumer,observability};
}

test('real Vault owner opens usage lazily; sibling views neither expose storage nor repeat schema/recovery',async t=>{
 const f=await fixture(t),a=await f.consumer('a'),b=await f.consumer('b');
 assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='model_usage'").get(),undefined,'Vault preparation alone creates no usage schema');
 let installations=0;const exec=f.store.db.exec;
 f.store.db.exec=function(sql:string){if(sql.includes('CREATE TABLE IF NOT EXISTS model_usage'))installations++;return exec.call(this,sql);};
 const first=f.vault.usageForAssembly(f.ownerScope,a.scope);assert.ok(first instanceof UsageLedger);
 assert.deepEqual(Reflect.ownKeys(first),[]);
 assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(first)).sort(),['constructor','operation','setPrice','start','summary']);
 for(const name of ['store','db','backend','directory','prices','close'])assert.equal(name in first,false,name);
 const running=first.start('generated','generated-model','generated-running');running.update(tokens);
 const second=f.vault.usageForAssembly(f.ownerScope,b.scope),derived=new UsageLedger(first);
 assert.equal(installations,1,'new views share the owner backend, not a new startup');
 const receipt=second.summary(new Date().toISOString().slice(0,10),new Date().toISOString().slice(0,10),'UTC').items[0];
 assert.equal(receipt.status,'running');assert.deepEqual(receipt.tokens,tokens,'opening B did not recover A as a failed run');
 await a.handle.close('disabled');
 assert.throws(()=>derived.operation('missing'),{statusCode:503},'copying a view cannot remove its parent scope');
 assert.throws(()=>running.finish('failed'),{statusCode:503});
 const meterB=second.start('generated','generated-model','b-running');meterB.finish('completed');
 await f.owner.close('disabled');
 assert.throws(()=>second.operation('missing'),{statusCode:503});
 assert.throws(()=>meterB.update(tokens),{statusCode:503});assert.throws(()=>meterB.finish('failed'),{statusCode:503});assert.throws(()=>meterB.discard(),{statusCode:503});
 assert.equal(f.store.db.isOpen,true,'stopping the Vault assembly does not close a borrowed Store');
 assert.equal(f.store.db.prepare('SELECT count(*) count FROM model_usage').get()!.count,2);
});

test('released observability access rejects retained views and meters without stopping sibling usage',async t=>{
 const f=await fixture(t),o=await f.observability(),a=await f.consumer('a'),b=await f.consumer('b');
 const accessA=o.platform.forAssembly(a.scope),accessB=o.platform.forAssembly(b.scope),viewA=accessA.usage,viewB=accessB.usage;
 const start=viewA.start.bind(viewA);
 viewA.start=(...args)=>{
  const meter=start(...args),finish=meter.finish;
  meter.finish=status=>finish(status);
  return meter;
 };
 const meterA=viewA.start('generated','generated-model','a',{operationId:'a'}),meterB=viewB.start('generated','generated-model','b',{operationId:'b'});
 const admitted=accessA.admittedUsage('generated','generated-model','admitted-a');admitted.modelStarted();
 const before=JSON.stringify(f.store.db.prepare('SELECT json FROM model_usage ORDER BY id').all());
 accessA.release();
 for(const write of [()=>viewA.start('generated','generated-model','late'),()=>viewA.setPrice(price),()=>viewA.operation('a'),()=>viewA.summary('2026-11-17','2026-11-17','UTC'),()=>meterA.update(tokens),()=>meterA.finish('failed'),()=>meterA.discard(),()=>admitted.update(tokens),()=>admitted.complete()])assert.throws(write,{statusCode:503});
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT json FROM model_usage ORDER BY id').all()),before);
 await o.handle.quiesce('restart');meterB.update(tokens);assert.equal(meterB.finish('completed').status,'completed');
 assert.equal(viewB.operation('b').total.totalTokens,tokens.totalTokens,'accepted B drains during quiesce');
 await o.handle.close('disabled');
 assert.throws(()=>meterB.finish('failed'),{statusCode:503});assert.throws(()=>viewB.operation('b'),{statusCode:503});
 assert.equal(f.store.db.isOpen,true);
 const stillOwned=f.vault.usageForAssembly(f.ownerScope,b.scope);assert.equal(stillOwned.operation('b').items.length,1,'stopping observability did not close Vault usage');
});

test('a consumer revoked during DTO copying cannot commit a late meter or price write',async t=>{
 const f=await fixture(t),a=await f.consumer('a'),b=await f.consumer('b');
 const first=f.vault.usageForAssembly(f.ownerScope,a.scope),second=f.vault.usageForAssembly(f.ownerScope,b.scope),meter=first.start('generated','generated-model','a');
 const before=JSON.stringify(f.store.db.prepare('SELECT json FROM model_usage').all());
 const lateTokens={...tokens,get inputTokens(){void a.handle.close('disabled');return tokens.inputTokens;}};
 assert.throws(()=>meter.update(lateTokens),{statusCode:503});await a.handle.close('disabled');
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT json FROM model_usage').all()),before);
 const latePrice={...price,get model(){void b.handle.close('disabled');return price.model;}};
 assert.throws(()=>second.setPrice(latePrice),{statusCode:503});await b.handle.close('disabled');
 assert.equal(f.store.db.prepare('SELECT count(*) count FROM model_prices').get()!.count,0);
});

test('bootstrap usage meter feeds actual owner HTTP totals and price snapshots; stopped cached meters cannot write',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-usage-http-')),token='generated-usage-owner-token-0123456789';
 const config={path:join(directory,'mote.yaml'),initialDocument:{version:1,revision:0,storage:{dataDir:directory}},privateCredential:{token,tokenPath:'generated'}};
 const node=await buildApp(config,{backgroundWorker:false});t.after(async()=>{try{await node.app.close();}finally{rmSync(directory,{recursive:true,force:true});}});
 const url=await node.app.listen({host:'127.0.0.1',port:0}),day=new Date().toISOString().slice(0,10),path='/api/usage?from='+day+'&to='+day+'&timeZone=UTC';
 const headers={authorization:'Bearer '+token,'content-type':'application/json'};
 assert.equal((await fetch(url+path)).status,401);
 assert.equal((await fetch(url+'/api/usage/prices',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(price)})).status,401);
 assert.equal(node.store.db.prepare('SELECT count(*) count FROM model_prices').get()!.count,0);
 const priced=await fetch(url+'/api/usage/prices',{method:'PUT',headers,body:JSON.stringify(price)});assert.equal(priced.status,200);
 const ledger:UsageLedger=node.observabilityAssembly.usage,meter=ledger.start('generated','generated-model','generated-http',{operationId:'generated-http',agentId:'generated-agent',moduleId:'generated-module',skillId:null});
 assert.equal((await fetch(url+'/api/usage/prices',{method:'PUT',headers,body:JSON.stringify({...price,input:999})})).status,200);
 meter.update(tokens);assert.equal(meter.finish('completed').estimatedCost,2.15);
 const response=await fetch(url+path,{headers});assert.equal(response.status,200);const summary=await response.json();
 assert.equal(summary.total.runs,1);assert.equal(summary.total.costs.USD,2.15);assert.equal(summary.items[0].attribution.operationId,'generated-http');assert.equal(summary.prices[0].input,999);
 await node.observabilityPlatform.stop('disabled');
 assert.equal((await fetch(url+path,{headers})).status,503);assert.throws(()=>meter.update(tokens),{statusCode:503});assert.throws(()=>meter.discard(),{statusCode:503});
 assert.equal(node.store.db.isOpen,true);assert.equal(node.store.db.prepare('SELECT count(*) count FROM model_usage').get()!.count,1);
});
