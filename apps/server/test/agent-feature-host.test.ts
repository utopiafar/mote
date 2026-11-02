import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import type {ContextReader,ContextRecord} from '@mote/agent';
import {installAgentFeatures} from '../src/agent-feature-host.js';

test('feature unload rejects an in-flight reader result and new reads while a sibling remains usable',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void,reads=0;
  const started=new Promise<void>(done=>{entered=done;});
  const implementation:ContextReader={
    search:()=>{reads++;entered();return new Promise<ContextRecord[]>(done=>{release=done;});},
    timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[{id:'generated-sibling-device'}],
  };
  const host=await installAgentFeatures(root,implementation),reading=host.reader.search({query:'generated'});
  const refused=assert.rejects(reading,{statusCode:503});await started;
  await host.dispose('mote.context');
  release([{id:'11111111-1111-4111-8111-111111111111',capturedAt:'2026-11-01T00:00:00Z',appName:'Generated fixture',ocrText:'Generated late original must not be disclosed.'}]);
  await refused;
  await assert.rejects(host.reader.search({query:'generated after unload'}),{statusCode:503});assert.equal(reads,1);
  assert.deepEqual(await host.reader.devices(),[{id:'generated-sibling-device'}]);
});

test('a replacement registration cannot revive a read issued to the disposed provider instance',async t=>{
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const read=()=>{entered();return new Promise<ContextRecord[]>(done=>{release=done;});};
  const host=await installAgentFeatures(root,{search:read,timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const reading=host.reader.search({}),refused=assert.rejects(reading,{statusCode:503});await started;
  await host.dispose('mote.context');
  const descriptor={id:'agent:search',version:'1',surface:'agent' as const};
  const uninstall=host.registry.install({id:'mote.context',version:'1',components:[descriptor]});t.after(uninstall);
  const unregister=host.registry.register('mote.context',descriptor,read);t.after(unregister);
  release([]);await refused;
});

test('registered descriptors bind actual feature identity and stop an in-flight scoped read on unload',async t=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const {pinContextTools,contextToolSnapshot}=await import('../../../packages/agent/dist/tool-contributions.js');
  const root=new Context();t.after(()=>root.fiber.dispose());
  let entered!:()=>void,release!:(records:ContextRecord[])=>void;
  const started=new Promise<void>(done=>{entered=done;});
  const host=await installAgentFeatures(root,{search:()=>{entered();return new Promise(done=>{release=done;});},timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const input=pinContextTools({question:'Generated registry lifecycle',hostContextToolMode:'all-native'},host.reader),snapshot=contextToolSnapshot(input);
  const pin=snapshot.entries.find(tool=>tool.name==='search_context')!;assert.ok(pin);
  const bridge=await startBridge(host.reader,input);t.after(()=>bridge.close());
  const pending=bridge.prepareDelivery('search_context',{query:'Generated'},new AbortController().signal),refused=assert.rejects(pending,{reason:'tool_failure'});
  await started;await host.dispose('mote.context');await refused;
  assert.equal(bridge.records.size,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
  assert.throws(()=>snapshot.assertActive(pin));
  const next=contextToolSnapshot(pinContextTools({question:'Generated next run'},host.reader));
  assert.ok(!next.entries.some(tool=>['search_context','timeline','evidence'].includes(tool.name)));
  release([]);
});

test('registered descriptors from external owner use the same run registry and cannot forge an original receipt',async t=>{
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const root=new Context();t.after(()=>root.fiber.dispose());
  const host=await installAgentFeatures(root,{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]});
  const fiber=host.registerTools('generated.external',[{apiVersion:'1',name:'generated_metadata',version:'1',description:'Generated plugin metadata',fields:{},kind:'metadata',exposure:'catalog',requires:[],parse:args=>args,execute:()=>({source:'untrusted_personal_context',data:[{id:'11111111-1111-4111-8111-111111111111',ocrText:'Generated claimed original'}]})}]);await fiber;
  const bridge=await startBridge(host.reader,{question:'Generated external'},8);t.after(()=>bridge.close());const signal=new AbortController().signal;
  const discovery=await bridge.prepareDelivery('capability_discover',{name:'generated_metadata'},signal);discovery.confirm();discovery.discard();
  const call={name:'generated_metadata',version:'1',argumentsJson:'{}'},staged=await bridge.prepareDelivery('capability_execute',call,signal);
  assert.equal(bridge.records.size,0);staged.confirm();staged.discard();assert.equal(bridge.records.size,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
  await host.dispose('generated.external');await assert.rejects(bridge.prepareDelivery('capability_execute',call,signal),{reason:'tool_failure'});
});
