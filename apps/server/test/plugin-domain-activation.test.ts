import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serviceContract} from '@mote/plugin-api/contracts';
import {PluginHost,PluginHostError} from '@mote/plugin-host';
import {createDomainActivations,type CentralDomainPlugin} from '../src/domain-activation.js';

function gate(){
  let release!:()=>void;
  return {promise:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};
}
type Hooks={quiesce?:()=>void|Promise<void>;stop?:()=>void|Promise<void>;dispose?:()=>void|Promise<void>};
async function fixture(t:test.TestContext,hooks:Hooks={},unblock=()=>{}){
  const host=new PluginHost({kind:'central',id:randomUUID()});
  t.after(async()=>{unblock();await host.close();});
  const counts={provider:{quiesce:0,stop:0,dispose:0,release:0},consumer:{quiesce:0,stop:0,dispose:0,release:0}};
  const contract=serviceContract<{ready():boolean}>('generated.lifecycle-input','1');
  const providerId='generated-lifecycle-provider',consumerId='generated-lifecycle-consumer';
  const provider:CentralDomainPlugin={
    contribution:{id:providerId,version:'1.0.0',runtime:'host',surface:'data'},declaration:{id:providerId,apiVersion:'1'},replacement:'hot',
    activation:{featureId:'mote.'+providerId,requires:{},create(context){
      context.scope.defer(()=>{counts.provider.release++;});
      return {
        prepare(){},start(){context.provide(providerId,contract,{ready:()=>true});},
        quiesce(){counts.provider.quiesce++;},stop(){counts.provider.stop++;},dispose(){counts.provider.dispose++;},
        route:{id:'mote.'+providerId,mount(){}},
      };
    }},
  };
  const consumer:CentralDomainPlugin={
    contribution:{id:consumerId,version:'1.0.0',runtime:'host',surface:'data'},declaration:{id:consumerId,apiVersion:'1'},replacement:'hot',
    activation:{featureId:'mote.'+consumerId,requires:{input:{provider:providerId,service:contract}},async create(context,bindings){
      const input=await context.services.acquire(contract,bindings.input!);
      context.scope.defer(async()=>{counts.consumer.release++;await input.release();});
      return {
        prepare(){assert.ok(input.value.ready());},start(){},
        quiesce(){counts.consumer.quiesce++;return hooks.quiesce?.();},
        stop(){counts.consumer.stop++;return hooks.stop?.();},
        dispose(){counts.consumer.dispose++;return hooks.dispose?.();},
        route:{id:'mote.'+consumerId,mount(){}},
      };
    }},
  };
  const domains=await createDomainActivations(host,[provider,consumer],['mote.'+providerId,'mote.'+consumerId]).activate();
  return {domains,counts,host};
}
const cleaned={provider:{quiesce:1,stop:1,dispose:1,release:1},consumer:{quiesce:1,stop:1,dispose:1,release:1}};
const contains=(error:unknown,expected:unknown):boolean=>error===expected||error instanceof AggregateError&&error.errors.some(value=>contains(value,expected));

test('quiesce joins an in-flight close and repeated calls retain the same successful result',async t=>{
  const entered=gate(),released=gate();
  const {domains,counts,host}=await fixture(t,{async stop(){entered.release();await released.promise;}},released.release);
  const closing=domains.close();
  assert.equal(domains.close(),closing);
  await entered.promise;
  assert.equal(domains.quiesce(),closing,'quiesce must join closing instead of revisiting a stopping handle');
  released.release();await closing;
  assert.equal(domains.close(),closing);assert.equal(domains.quiesce(),closing);
  await Promise.all([domains.close(),domains.quiesce()]);
  assert.deepEqual(counts,cleaned);assert.equal(host.snapshot().contributions.length,0);
});

test('close joins in-flight quiescence before disposing a required provider and consumer',async t=>{
  const entered=gate(),released=gate();
  const {domains,counts}=await fixture(t,{async quiesce(){entered.release();await released.promise;}},released.release);
  const quiescing=domains.quiesce();
  assert.equal(domains.quiesce(),quiescing);
  await entered.promise;
  const closing=domains.close();
  assert.equal(domains.close(),closing);assert.equal(domains.quiesce(),closing);
  assert.equal(counts.consumer.stop,0,'closing must wait for the accepted quiesce pass');
  released.release();await Promise.all([quiescing,closing]);
  assert.deepEqual(counts,cleaned);
});

test('quiesce and close retain genuine lifecycle failures while releasing every owner',async t=>{
  for(const stage of ['quiesce','dispose'] as const)await t.test(stage,async t=>{
    // A real hook error with the same code as an already released handle must
    // remain observable; the registry cannot suppress errors by code.
    const failure=new PluginHostError('stale_scope');
    const {domains,counts,host}=await fixture(t,{[stage]:()=>{throw failure;}});
    if(stage==='quiesce')await assert.rejects(domains.quiesce(),error=>contains(error,failure));
    const closing=domains.close();
    await assert.rejects(closing,error=>contains(error,failure));
    assert.equal(domains.close(),closing);assert.equal(domains.quiesce(),closing);
    await assert.rejects(domains.quiesce(),error=>contains(error,failure));
    assert.deepEqual(counts,cleaned,'failure cannot skip another owner or repeat resource cleanup');
    assert.equal(host.snapshot().contributions.length,0);
  });
});
