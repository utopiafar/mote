import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../dist/tools/registry.js';
import {installReadPacks,resolveReadTool} from '../dist/tools/official-read-packs.js';

const descriptor=name=>({apiVersion:'1',name,version:'1',description:'Generated metadata',fields:{},kind:'metadata',exposure:'catalog',requires:[],parse:args=>args,execute:()=>({generated:true})});
const lifetime=()=>{const controller=new AbortController();return {controller,lease:{signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();}}};};

test('failed pack assembly rolls back its registrations while preserving an existing sibling pin',()=>{
  const registry=new ToolRegistry(),{lease}=lifetime();registry.register(descriptor('sibling'),lease);
  const sibling=registry.snapshot([{name:'sibling',version:'1'}]);
  assert.throws(()=>installReadPacks(registry,[{descriptors:[descriptor('new_originals')],lifecycle:lease},{descriptors:[descriptor('sibling')],lifecycle:lease}]),{code:'duplicate_tool'});
  assert.deepEqual(registry.registered(),[{name:'sibling',version:'1'}]);sibling.assertActive(sibling.entries[0]);
});

test('pack disposal retires its pins without aborting a shared provider or its sibling',()=>{
  const registry=new ToolRegistry(),{controller,lease}=lifetime();registry.register(descriptor('sibling'),lease);
  const close=installReadPacks(registry,[{descriptors:[descriptor('owned')],lifecycle:lease}]);
  const snapshot=registry.snapshot([{name:'owned',version:'1'},{name:'sibling',version:'1'}]);
  close();close();assert.equal(controller.signal.aborted,false);
  assert.throws(()=>snapshot.assertActive(snapshot.entries[0]),{code:'stale_tool_pin'});snapshot.assertActive(snapshot.entries[1]);
});

test('a scope revoked during preparation cannot leave a partly advertised pack',()=>{
  const registry=new ToolRegistry(),controller=new AbortController(),cause=Error('Generated scope revoked');let checks=0;
  const lifecycle={signal:controller.signal,assertCurrent(){if(++checks===2)controller.abort(cause);controller.signal.throwIfAborted();}};
  assert.throws(()=>installReadPacks(registry,[{descriptors:[descriptor('generated_pending')],lifecycle}]),error=>error===cause);
  assert.deepEqual(registry.registered(),[]);
});

test('catalog dispatch requires parent discovery and the exact version before reaching a handler',async()=>{
  const registry=new ToolRegistry(),{lease}=lifetime();let calls=0;
  registry.register({...descriptor('generated_catalog'),execute:()=>{calls++;return null;}},lease);
  const snapshot=registry.snapshot([{name:'generated_catalog',version:'1'}]),discovered=new Set();
  for(const options of [{discovered},{discovered,catalogVersion:'1'}])assert.throws(()=>resolveReadTool(snapshot,'generated_catalog',options),{code:'invalid_tool_arguments'});
  discovered.add('generated_catalog');
  assert.throws(()=>resolveReadTool(snapshot,'generated_catalog',{discovered,catalogVersion:'2'}),{code:'invalid_tool_arguments'});
  assert.equal(calls,0);
  const invocation=resolveReadTool(snapshot,'generated_catalog',{discovered,catalogVersion:'1'});
  await invocation.execute({},{tool:invocation.identity,scope:{},signal:lease.signal,assertCurrent:lease.assertCurrent,read:async()=>{throw Error('Unreachable');},actionCatalog:()=>{throw Error('Unreachable');},progress:()=>{throw Error('Unreachable');}});
  assert.equal(calls,1);
});

test('explicit Host direct mode does not bypass stale-registration checks or alter discovery',()=>{
  const registry=new ToolRegistry(),{lease}=lifetime(),remove=registry.register(descriptor('generated_catalog'),lease);
  const snapshot=registry.snapshot([{name:'generated_catalog',version:'1'}]),discovered=new Set();
  resolveReadTool(snapshot,'generated_catalog',{discovered,allowDirectCatalog:true});assert.equal(discovered.size,0);
  remove();assert.throws(()=>resolveReadTool(snapshot,'generated_catalog',{discovered,allowDirectCatalog:true}),{code:'stale_tool_pin'});
});
