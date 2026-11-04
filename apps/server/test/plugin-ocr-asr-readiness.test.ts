import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import type {ConfigService} from '../src/config-service.js';
import {MediaAssets,type MediaRole} from '../src/media-assets.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createOcrAsrReadiness,createOcrAsrReadinessFactory,ocrAsrReadinessDeclaration} from '../src/plugins/ocr-asr-readiness.js';
import {FeatureScope} from '../src/features/index.js';
import {mediaPreparationFeature} from '../src/features/media.js';

class FixtureAssets extends MediaAssets {
  installed=false;installs=0;
  override ready(_role:MediaRole){return this.installed;}
  override async installAsync(_role:MediaRole,_source?:'auto'|'official'|'mirror',signal?:AbortSignal){signal?.throwIfAborted();this.installs++;this.installed=true;}
}

async function fixture(t:Parameters<Parameters<typeof test>[1]>[0],runtime:'native'|'docker'='docker'){
  const root=await mkdtemp(join(tmpdir(),'mote-ocr-readiness-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const assets=new FixtureAssets(join(root,'models')),listeners=new Set<()=>void>();
  let document:Record<string,unknown>={media:{fixture:1},server:{runtime}};
  const configService={document:()=>structuredClone(document),onChange:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}} as unknown as ConfigService;
  const port=19000+Math.floor(Math.random()*1000),media={modelDirectory:assets.root,python:process.execPath,workerToken:'generated-readiness-worker',ocrPort:port,asrPort:port,ocrEndpoint:`http://127.0.0.1:${port}/ocr`,asrEndpoint:`http://127.0.0.1:${port}/transcribe`};
  return {root,assets,listeners,configService,media,runtime,change(){document={...document,media:{fixture:2}};for(const listener of listeners)listener();}};
}

async function settled(port:{status(role:MediaRole):Promise<{state:string}>},role:MediaRole){
  for(let index=0;index<200;index++){const status=await port.status(role);if(['ready','failed','cancelled','unsupported'].includes(status.state))return status;await delay(5);}
  throw Error('Generated readiness did not settle');
}

test('quiesce fences preparation, stop closes it, and a fresh activation reuses the same model directory',async t=>{
  const f=await fixture(t);f.assets.installed=true;
  const service=createOcrAsrReadiness({runtime:f.runtime,media:f.media,assets:f.assets,configService:f.configService,fetch:async()=>Response.json({ocr:true})});
  t.after(()=>service.close());await service.prepare();service.start();
  await service.port.start('ocr');assert.equal((await settled(service.port,'ocr')).state,'ready');
  service.quiesce('disabled');assert.throws(()=>service.port.start('ocr'),{statusCode:503});
  assert.equal((await service.port.status('ocr')).error,'configuration_changed');
  await service.stop('disabled');assert.throws(()=>service.port.status('ocr'),{statusCode:503});
  await service.prepare();service.start();await service.port.start('ocr');assert.equal((await settled(service.port,'ocr')).state,'ready');
  assert.equal(f.listeners.size,1,'reactivation replaces rather than duplicates the configuration listener');
  await service.close();assert.equal(f.listeners.size,0);assert.throws(()=>service.port.status('ocr'),{statusCode:503});
});

test('a media configuration change aborts in-flight native preparation and cannot publish a late ready state',async t=>{
  const f=await fixture(t,'native');let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const service=createOcrAsrReadiness({runtime:f.runtime,media:f.media,assets:f.assets,configService:f.configService,prepare:async options=>{signal=options.signal;entered();await held;options.signal.throwIfAborted();return{python:process.execPath};}});
  t.after(()=>service.close());await service.prepare();service.start();await service.port.start('ocr');await started;
  f.change();assert.equal(signal?.aborted,true);release();await service.stop('disabled');
  assert.equal(f.assets.installs,0);assert.equal(f.listeners.size,0);
  assert.throws(()=>service.port.status('ocr'),{statusCode:503});await service.close();
});

test('a failed prepare closes the partial runtime and removes its configuration listener',async t=>{
  const f=await fixture(t),failure=Error('Generated readiness prepare failure');
  const service=createOcrAsrReadiness({runtime:f.runtime,media:f.media,assets:f.assets,configService:new Proxy(f.configService,{get(target,property,receiver){if(property==='document')return()=>{throw failure;};return Reflect.get(target,property,receiver);}})});
  await assert.rejects(service.prepare(),failure);assert.equal(f.listeners.size,0);assert.throws(()=>service.port.status('ocr'),{statusCode:503});
  await service.close();
});


test('media routes return 503 while stopped and recover without another registration',async t=>{
 const f=await fixture(t);f.assets.installed=true;
 const service=createOcrAsrReadiness({runtime:f.runtime,media:f.media,assets:f.assets,configService:f.configService,fetch:async()=>Response.json({ocr:true})});
 const host=new PluginHost({kind:'central',id:'generated-readiness-host'}),app=Fastify(),scope=new FeatureScope();let binding:import('@mote/plugin-api/contracts').ServiceBinding|undefined;
 t.after(async()=>{await app.close();await host.close();});
 const handle=await host.install({identity:{host:host.identity,packageId:'generated.media.readiness',installationId:'generated-install',instanceId:'generated-readiness',activationId:'generated-activation'},contributions:[ocrAsrReadinessDeclaration],factory:createOcrAsrReadinessFactory(service,value=>{binding=value.readiness;})});
 const lease=await host.acquire(centralServices.mediaReadiness,binding!);assert.equal(lease.value.phase,'active');
 mediaPreparationFeature({connections:{assertActive(){}},credential:()=>undefined,mediaRange:{parse:(value:unknown)=>value},store:{mediaActivity:()=>({generated:true})},mediaPreparation:()=>service.port}).mount(app,scope);
 assert.equal((await app.inject({url:'/api/media-activity'})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/api/media-preparation/ocr',payload:{}})).statusCode,202);
 assert.equal((await settled(service.port,'ocr')).state,'ready');
 service.quiesce('disabled');assert.equal((await app.inject({method:'POST',url:'/api/media-preparation/ocr',payload:{}})).statusCode,503);
 await service.stop('disabled');assert.equal((await app.inject({url:'/api/media-preparation'})).statusCode,503);assert.equal((await app.inject({url:'/api/media-activity'})).statusCode,503);
 await service.prepare();service.start();assert.equal((await app.inject({url:'/api/media-preparation'})).statusCode,200);assert.equal((await app.inject({url:'/api/media-activity'})).statusCode,200);
 await lease.release();await handle.close('disabled');assert.equal((await app.inject({url:'/api/media-preparation'})).statusCode,503);
});
