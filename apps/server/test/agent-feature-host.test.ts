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
