import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {SOURCE_ITEM_BUILD_COMPONENT,SourceItemRecipeCatalog} from '../src/source-item-recipe.js';

test('ordinary SourceItems pin a declarative recipe for their actual registered source kind',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-item-recipe-')),store=new Store(directory),sources=new SourceStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-upload',name:'Generated upload',kind:'upload',deviceId:'fixture',platform:'import'});
  sources.register({id:'generated-custom',name:'Generated custom',kind:'custom',deviceId:'fixture',platform:'import'});
  const catalog=new SourceItemRecipeCatalog(store,'1');
  const upload=catalog.resolveForSourceId('generated-upload'),custom=catalog.resolveForSourceId('generated-custom');
  assert.equal(upload.recipeId,'mote.source-item.upload');assert.equal(upload.sourceKind,'upload');
  assert.equal(custom.recipeId,'mote.source-item.custom');assert.notEqual(custom.definitionFingerprint,upload.definitionFingerprint);
  assert.match(upload.configFingerprint,/^[a-f0-9]{64}$/);
  assert.ok(upload.componentPins.some(pin=>pin.id==='mote.capture-raw-reader'&&pin.kind==='raw-reader'));
  assert.ok(upload.componentPins.some(pin=>pin.id===SOURCE_ITEM_BUILD_COMPONENT&&pin.kind==='step'&&pin.version==='1'));
  const routes=catalog.routesForSourceId('generated-upload');
  for(const phase of ['pending','partial','ready'])for(const readProjection of ['capture','image','material','segment'])
    assert.ok(routes.some(route=>route.audience==='query'&&route.operation==='ask'&&route.phase===phase&&route.readProjection===readProjection));
  assert.ok(routes.some(route=>route.audience==='memory'&&route.phase==='partial'&&route.readProjection==='material'));
  assert.ok(!routes.some(route=>route.audience==='memory'&&route.readProjection==='capture'));
  assert.equal(catalog.resolveForSourceId('generated-upload').configFingerprint,upload.configFingerprint);
  assert.throws(()=>catalog.resolveForSourceId('missing-source'),/unavailable/);
  catalog.registry.uninstallComponent(SOURCE_ITEM_BUILD_COMPONENT);
  assert.throws(()=>catalog.resolveForSourceId('generated-upload'),/unavailable component/);
  catalog.registry.installComponent({id:SOURCE_ITEM_BUILD_COMPONENT,version:'2',kind:'step'});
  assert.throws(()=>catalog.resolveForSourceId('generated-upload'),/unavailable component/);
});

test('pause, retention and resume preserve accepted work pins; identity drift stales them',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-source-item-recipe-')),store=new Store(directory),sources=new SourceStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-source',name:'Generated source',kind:'upload',deviceId:'fixture',platform:'import'});
  const catalog=new SourceItemRecipeCatalog(store,'1'),before=catalog.resolveForSourceId('generated-source');
  sources.update('generated-source',{name:'Renamed generated source'});
  assert.equal(catalog.resolveForSourceId('generated-source').configFingerprint,before.configFingerprint);
  sources.update('generated-source',{enabled:false});
  const paused=catalog.resolveForSourceId('generated-source');assert.equal(paused.configFingerprint,before.configFingerprint);
  sources.update('generated-source',{retention:'reference'});
  const retained=catalog.resolveForSourceId('generated-source');assert.equal(retained.configFingerprint,before.configFingerprint);
  sources.update('generated-source',{enabled:true});
  assert.equal(catalog.resolveForSourceId('generated-source').configFingerprint,before.configFingerprint);
  const row=store.db.prepare('SELECT json FROM source_connections WHERE id=?').get('generated-source') as {json:string};
  store.db.prepare('UPDATE source_connections SET json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.json),kind:'custom'}),'generated-source');
  const after=catalog.resolveForSourceId('generated-source');
  assert.notEqual(after.recipeId,before.recipeId);assert.notEqual(after.configFingerprint,before.configFingerprint);
  store.db.prepare('DELETE FROM source_connections WHERE id=?').run('generated-source');
  assert.throws(()=>catalog.resolveForSourceId('generated-source'),/unavailable/);
});
