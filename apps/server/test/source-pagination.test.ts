import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {registerSourceRoutes} from '../src/source-routes.js';
import {createSourceControl} from '../src/source-runtime-storage.js';

test('source routes accept their own cursor without changing source or device scope',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-source-pagination-')),store=new Store(directory),sources=new SourceStore(store),app=Fastify();
 const definition={id:'generated-source',name:'Generated folder',kind:'local-files',deviceId:'generated-device',platform:'macos' as const,retention:'snapshot' as const,enabled:true};
 try{
  sources.register(definition);sources.register({...definition,id:'other-source',deviceId:'other-device'});
  for(let i=0;i<31;i++)await sources.upsert(definition.id,{externalId:String(i),revision:'v1',title:'Generated '+i,text:'Exact text '+i,observedAt:'2026-10-01T10:00:00.000Z',kind:'file',layer:'snapshot'});
  await sources.upsert('other-source',{externalId:'other',revision:'v1',title:'Other device',text:'Out of scope',observedAt:'2026-10-01T10:00:00.000Z',kind:'file',layer:'snapshot'});
  registerSourceRoutes(app,{sources:createSourceControl(sources),fileCatalog:()=>{throw new Error('not used');},credential:()=>undefined,sourceOwner:(_req,id)=>{sources.getSource(id);},layers:{} as never,connections:{} as never});
  const path='/api/sources/'+definition.id+'/items?deviceId='+definition.deviceId+'&limit=30',first=await app.inject(path);assert.equal(first.statusCode,200);const page=first.json();assert.equal(page.items.length,30);assert.ok(page.nextCursor.length>100);
  const second=await app.inject(path+'&cursor='+encodeURIComponent(page.nextCursor));assert.equal(second.statusCode,200);const last=second.json();assert.equal(last.items.length,1);assert.equal(last.nextCursor,null);assert.equal(new Set([...page.items,...last.items].map(item=>item.captureId)).size,31);assert.ok([...page.items,...last.items].every(item=>item.sourceId===definition.id));
  const other=await app.inject('/api/sources/'+definition.id+'/items?deviceId=other-device');assert.deepEqual(other.json().items,[]);
  const invalid=await app.inject(path+'&cursor='+encodeURIComponent('a'.repeat(4097)));assert.notEqual(invalid.statusCode,200);
 }finally{await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});
