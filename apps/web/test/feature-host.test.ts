import test from 'node:test';
import assert from 'node:assert/strict';
import {WebFeatureHost} from '../src/features/host.js';
import {FeatureRegistry} from '@mote/shared';
test('scoped web features reject duplicates, isolate disposal and preserve safe fallback',async()=>{
  const host=new WebFeatureHost(),value={kind:'fixture.document',schemaVersion:1,representation:'markdown'};
  try{
    const first=await host.install({id:'fixture.one',version:'1',components:[]},[{surface:'page',entry:{id:'fixture',featureId:'fixture.one',render:()=>null}},{surface:'renderer',entry:{id:'special',...value,render:()=>null}}]);
    const second=await host.install({id:'fixture.two',version:'1',components:[]},[{surface:'panel',entry:{id:'extra',...value,render:()=>null}}]);
    assert.ok(host.page('fixture'));assert.equal(host.views('renderer',value).length,1);
    assert.equal(host.views('renderer',{...value,schemaVersion:2}).length,0);
    await first.dispose();assert.equal(host.page('fixture'),undefined);assert.equal(host.views('renderer',value).length,0);assert.equal(host.views('panel',value).length,1);
    await second.dispose();assert.equal(host.registry.inventory().capabilities.length,0);
  }finally{await host.close();}
});
test('registry pins descriptors and disposal cannot remove a newer registration',()=>{
  const registry=new FeatureRegistry<number>(),manifest={id:'fixture',version:'1',components:[]};
  const dispose=registry.install(manifest);manifest.version='mutated';assert.equal(registry.inventory().features[0].version,'1');
  const descriptor={id:'read',version:'1',surface:'data' as const};const remove=registry.register('fixture',descriptor,1);
  assert.throws(()=>registry.register('fixture',descriptor,2),/already registered/);remove();
  registry.register('fixture',descriptor,2);remove();assert.equal(registry.get('read'),2);dispose();assert.equal(registry.get('read'),undefined);
});
test('dependency removal revokes dependent capabilities and reinstall restores them',()=>{
 const registry=new FeatureRegistry<number>();registry.install({id:'fixture',version:'1',components:[]});
 registry.register('fixture',{id:'view',version:'1',surface:'renderer',requires:['reader']},2);
 assert.equal(registry.get('view'),undefined);assert.equal(registry.inventory().capabilities[0].reason,'dependency_unavailable');
 const remove=registry.register('fixture',{id:'reader',version:'1',surface:'data'},1);assert.equal(registry.get('view'),2);remove();assert.equal(registry.get('view'),undefined);
 registry.register('fixture',{id:'reader',version:'1',surface:'data'},3);assert.equal(registry.get('view'),2);
});
