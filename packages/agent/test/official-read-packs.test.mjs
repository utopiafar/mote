import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../dist/tools/registry.js';
import {installReadPacks} from '../dist/tools/official-read-packs.js';

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
