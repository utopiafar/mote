import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PluginHost,type HostScope} from '@mote/plugin-host';
import type {PluginLifecycle,ServiceBinding,ServiceLease} from '@mote/plugin-api/contracts';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {createObservabilityPlatformFactory} from '../src/plugins/observability-platform.js';
import {centralServices,type UsageRecording} from '../src/plugins/central-contracts.js';

const tokens={requests:1,reportedRequests:1,inputTokens:1000000,outputTokens:100000,totalTokens:1100000,cacheReadTokens:500000,cacheWriteTokens:100000};
const price={provider:'generated',model:'generated-model',currency:'USD',input:2,output:8,cacheRead:0.5,cacheWrite:3};
const life=():PluginLifecycle=>({prepare(){},start(){},quiesce(){},stop(){},dispose(){}});

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-usage-meter-lease-')),store=new Store(directory),host=new PluginHost({kind:'central',id:randomUUID()});
 const identity=(id:string)=>({host:host.identity,packageId:'generated.usage-meter',installationId:id,instanceId:id,activationId:randomUUID()});
 let vault:ReturnType<typeof createVaultPlatformAssembly>,vaultScope:HostScope,binding:ServiceBinding;
 t.after(async()=>{try{await host.close();}finally{store.close();rmSync(directory,{recursive:true,force:true});}});
 await host.install({identity:identity('vault'),contributions:[],factory:context=>{
  vault=createVaultPlatformAssembly({dataDir:directory},{store});vaultScope=context.scope;context.scope.defer(()=>vault.close());
  return {...life(),prepare:()=>vault.prepare(),stop:()=>vault.close(),dispose:()=>vault.close()};
 }});
 const factory=createObservabilityPlatformFactory({logDirectory:join(directory,'logs'),update:{currentVersion:'0.4.0',runtime:'native'}},{usageForScope:scope=>vault.usageForAssembly(vaultScope,scope)});
 const observability=await host.install({identity:identity('observability'),contributions:[{id:'observability-platform',apiVersion:'1'}],factory:context=>factory({...context,
  provide:(...args)=>{const value=context.provide(...args);if(args[1].id===centralServices.usage.id)binding=value;return value;},
 })});
 const consumer=async(id:string,signal?:AbortSignal)=>{
  let lease:ServiceLease<UsageRecording>;
  const handle=await host.install({identity:identity(id),contributions:[],requires:[binding],factory:async context=>{
   lease=await context.services.acquire(centralServices.usage,binding,signal);return life();
  }});
  return {handle,lease:lease!};
 };
 return {store,host,observability,consumer,get vault(){return vault!;},get vaultScope(){return vaultScope!;}};
}

test('ordinary usage meters reject all writes after their lease or consumer closes while sibling pins drain',async t=>{
 const f=await fixture(t),released=await f.consumer('released'),closed=await f.consumer('closed'),sibling=await f.consumer('sibling');
 f.vault.usageForAssembly(f.vaultScope,f.vaultScope).setPrice(price);
 const start=released.lease.value.start;
 const a=start('generated','generated-model','released',{operationId:'released'}),c=closed.lease.value.start('generated','generated-model','closed',{operationId:'closed'}),b=sibling.lease.value.start('generated','generated-model','sibling',{operationId:'sibling'});
 for(const meter of [a,b,c])assert.equal(Object.isFrozen(meter),true);
 const rows=()=>f.store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.attribution.operationId') IN ('released','closed') ORDER BY id").all();
 const before=rows();await released.lease.release();await closed.handle.close('disabled');
 assert.throws(()=>start('generated','generated-model','late'),{code:'stale_scope'});
 for(const meter of [a,c])for(const invoke of [()=>meter.update(tokens),()=>meter.finish('completed'),()=>meter.discard()])assert.throws(invoke,{code:'stale_scope'});
 assert.deepEqual(rows(),before,'revoked meters leave actual SQLite receipts byte-for-byte unchanged');
 await f.observability.quiesce('restart');assert.equal(sibling.lease.signal.aborted,false);
 b.update(tokens);assert.equal(b.finish('completed').estimatedCost,2.15);assert.equal(sibling.lease.value.operation('sibling').total.totalTokens,tokens.totalTokens);
 assert.equal(f.store.db.isOpen,true);assert.deepEqual(rows(),before);
});

test('ordinary usage preserves its lease fence through attribution and token DTO copying',async t=>{
 const f=await fixture(t),start=await f.consumer('start'),update=await f.consumer('update'),sibling=await f.consumer('sibling');
 const attribution={get operationId(){void start.lease.release();return 'generated-revoked-start';}};
 assert.throws(()=>start.lease.value.start('generated','generated-model','start',attribution),{code:'stale_scope'});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,0);
 const meter=update.lease.value.start('generated','generated-model','update',{operationId:'update'});
 const before=f.store.db.prepare('SELECT json FROM model_usage').all();
 const lateTokens={...tokens,get inputTokens(){void update.handle.close('disabled');return tokens.inputTokens;}};
 assert.throws(()=>meter.update(lateTokens),{code:'stale_scope'});await update.handle.close('disabled');
 assert.throws(()=>meter.finish('failed'),{code:'stale_scope'});assert.throws(()=>meter.discard(),{code:'stale_scope'});
 assert.deepEqual(f.store.db.prepare('SELECT json FROM model_usage').all(),before);
 const b=sibling.lease.value.start('generated','generated-model','sibling');b.update(tokens);assert.equal(b.finish('completed').status,'completed');
 assert.equal(f.store.db.isOpen,true);
});

test('an explicit acquisition signal revokes only its ordinary usage meters',async t=>{
 const f=await fixture(t),controller=new AbortController(),cancelled=await f.consumer('cancelled',controller.signal),sibling=await f.consumer('sibling');
 const meter=cancelled.lease.value.start('generated','generated-model','cancelled',{operationId:'cancelled'}),before=f.store.db.prepare('SELECT json FROM model_usage').all();
 controller.abort();
 for(const invoke of [()=>meter.update(tokens),()=>meter.finish('completed'),()=>meter.discard()])assert.throws(invoke,{code:'cancelled'});
 assert.deepEqual(f.store.db.prepare('SELECT json FROM model_usage').all(),before);
 const b=sibling.lease.value.start('generated','generated-model','sibling');assert.equal(b.finish('completed').status,'completed');assert.equal(f.store.db.isOpen,true);
});
