import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../../server/src/store';
import {SourceStore} from '../../server/src/sources';
import {registerSourceRoutes} from '../../server/src/source-routes';
import {centralSourceContentPage} from '../src/content-library';
import {defaultConfig} from '../src/config';
import {DEFAULT_SOURCE_OPTIONS} from '../src/source-types';
import {SourceContextOutbox} from '../src/source-context-outbox';
import {TransportFailure,httpFailure} from '../src/support';
import type {SourceRequest} from '../src/source-types';

test('owner source-context route preserves exact text, retry identity, conflicts and private persistence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-context-contract-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),app=Fastify(),id='local-ff0dca9c-dc56-4f25-b35a-aac044731313';
 let denied=false,drop=false;const calls:unknown[]=[];
 try{
  sources.register({id,name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'snapshot',enabled:true});
  app.setErrorHandler((error,req,res)=>res.status((error as {statusCode?:number;status?:number}).status??(error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  registerSourceRoutes(app,{sources,credential:()=>denied?{} as never:undefined,sourceOwner:(_req,id)=>{sources.getSource(id);},layers:{} as never,evidenceReader:{} as never,ingress:{} as never,connections:{assertActive(){}} as never});
  const request:SourceRequest=async(path,body,method)=>{calls.push({path,body,method});const response=await app.inject({method,url:path,payload:body});if(response.statusCode>=400)throw new TransportFailure('Generated route failure',httpFailure(response.statusCode),response.statusCode);if(drop&&method==='PATCH'){drop=false;throw Error('Generated lost ACK');}return response.json();};
  const signal=new AbortController().signal,path=join(directory,'binding-one','contexts.json');let outbox=new SourceContextOutbox(path);await outbox.initialize();
  assert.deepEqual((await outbox.read(id,request,signal)).snapshot,{sourceId:id,version:0,description:''});
  const description='Generated author statement\n<script>literal only</script> 🧑🏽‍💻';await outbox.stage(id,{expectedVersion:0,description});drop=true;await assert.rejects(outbox.flush(id,request,signal));assert.equal(sources.contexts.current(id).description,description);assert.equal(outbox.get(id).pending?.expectedVersion,0);
  outbox=new SourceContextOutbox(path);await outbox.initialize();assert.equal(outbox.get(id).pending?.description,description);await outbox.flush(id,request,signal);assert.equal(outbox.pending(id),false);assert.equal(sources.contexts.current(id).version,1);
  await outbox.stage(id,{expectedVersion:1,description:'Generated local edit'});sources.updateContext(id,{expectedVersion:1,description:'Generated other owner edit'});await assert.rejects(outbox.flush(id,request,signal));assert.equal(outbox.get(id).conflict,true);assert.equal(outbox.get(id).snapshot.description,'Generated other owner edit');assert.equal(outbox.get(id).pending?.description,'Generated local edit');
  const before=calls.length;await assert.rejects(outbox.flush(id,request,signal));assert.equal(calls.length,before,'Conflicts never retry by overwriting the newly observed version');
  await outbox.stage(id,{expectedVersion:2,description:'Generated reviewed edit'});denied=true;await assert.rejects(outbox.flush(id,request,signal));assert.equal(outbox.get(id).pending?.description,'Generated reviewed edit');assert.equal((await outbox.read(id,request,signal)).error,'denied');denied=false;await outbox.flush(id,request,signal);
  const other=new SourceContextOutbox(join(directory,'binding-two','contexts.json'));await other.initialize();assert.equal(other.pending(id),false);assert.equal(other.get(id).snapshot.description,'');
  await outbox.checkpointTo(join(directory,'reauthorized','contexts.json'));const reauthorized=new SourceContextOutbox(join(directory,'reauthorized','contexts.json'));await reauthorized.initialize();assert.equal(reauthorized.get(id).snapshot.description,'Generated reviewed edit');
  assert.equal(JSON.stringify(sources.getSource(id)).includes('Generated reviewed edit'),false,'Private description is absent from public source metadata');
  await outbox.stage(id,{expectedVersion:3,description:''});await outbox.flush(id,request,signal);assert.equal(sources.contexts.current(id).description,'');
 }finally{await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});


test('source archive HTTP rows are consumed with exact identities, pagination and source/device boundaries',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-source-archive-contract-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),app=Fastify(),originalFetch=globalThis.fetch;
 const id='local-ff0dca9c-dc56-4f25-b35a-aac044731313',deviceId='generated-device',definition={id,name:'Generated local folder',kind:'local-files',deviceId,platform:'macos' as const,retention:'snapshot' as const,enabled:true};let denied=false;
 try{
  sources.register(definition);sources.register({...definition,id:id+'other',deviceId:'another-device'});
  for(let i=0;i<31;i++)await sources.upsert(id,{externalId:String(i),revision:'v1',title:'Generated '+i,text:'Exact text '+i,observedAt:'2026-10-01T10:00:00.000Z',kind:'file',layer:'snapshot'});
  await sources.upsert(id+'other',{externalId:'other',revision:'v1',title:'Other device',text:'Must stay elsewhere',observedAt:'2026-10-01T10:00:00.000Z',kind:'file',layer:'snapshot'});
  app.setErrorHandler((error,req,res)=>res.status((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  registerSourceRoutes(app,{sources,credential:()=>undefined,sourceOwner:(_req,sourceId)=>{if(denied)throw Object.assign(Error('Denied'),{statusCode:403});sources.getSource(sourceId);},layers:{} as never,evidenceReader:{} as never,ingress:{} as never,connections:{} as never});
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const response=await app.inject({url:url.pathname+url.search,method:'GET',headers:init?.headers as Record<string,string>});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
  const config={...defaultConfig(),serverUrl:'http://127.0.0.1:1',token:'generated-owner',deviceId},source={...DEFAULT_SOURCE_OPTIONS,...definition},page=await centralSourceContentPage(config,source);assert.equal(page.items.length,30);assert.ok(page.nextCursor);assert.ok(page.items.every(row=>row.key.startsWith('capture:')&&row.source==='file'&&row.sourceName===definition.name));const second=await centralSourceContentPage(config,source,page.nextCursor);assert.equal(second.items.length,1);assert.equal(new Set([...page.items,...second.items].map(item=>item.key)).size,31);assert.equal(JSON.stringify(page).includes('Must stay elsewhere'),false);
  denied=true;assert.deepEqual(await centralSourceContentPage(config,source),{items:[],authorizationDenied:true});
 }finally{globalThis.fetch=originalFetch;await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('processed snapshot metadata rows render in the Mac archive page for both read permissions',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-snapshot-page-contract-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),app=Fastify(),originalFetch=globalThis.fetch;
 const id='local-ff0dca9c-dc56-4f25-b35a-aac044731313',deviceId='generated-device',definition={id,name:'Generated snapshot folder',kind:'local-files',deviceId,platform:'macos' as const,retention:'snapshot' as const,enabled:true};
 try{
  sources.register(definition);
  const fileIndex={version:1 as const,fileId:'generated-file',contentVersion:'f'.repeat(64),mode:'index' as const,coverage:'full' as const,parser:'text.utf8',status:'ready' as const,totalCharacters:633,offset:0,length:633,maxIndexCharacters:8000,allowRead:false};
  const item={externalId:'file:generated-metadata',revision:'v1',observedAt:'2026-11-03T00:00:00.000Z',title:'Generated snapshot',text:'',kind:'file' as const,layer:'snapshot' as const,mimeType:'text/plain',document:{fileId:'generated-file',contentRole:'other',timeBasis:'unknown',fileIndex}};
  await sources.upsert(id,item);
  await sources.upsert(id,{...item,externalId:'file:generated-metadata-readable',revision:'v2',document:{...item.document,fileIndex:{...fileIndex,allowRead:true}}});
  app.setErrorHandler((error,req,res)=>res.status((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  registerSourceRoutes(app,{sources,credential:()=>undefined,sourceOwner:(_req,sourceId)=>{sources.getSource(sourceId);},layers:{} as never,evidenceReader:{} as never,ingress:{} as never,connections:{} as never});
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const response=await app.inject({url:url.pathname+url.search,method:'GET',headers:init?.headers as Record<string,string>});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});};
  const config={...defaultConfig(),serverUrl:'http://127.0.0.1:1',token:'generated-owner',deviceId},source={...DEFAULT_SOURCE_OPTIONS,...definition},page=await centralSourceContentPage(config,source);
  assert.equal(page.items.length,2);
  assert.ok(page.items.every(row=>row.key.startsWith('capture:')&&row.source==='file'&&row.sourceName===definition.name));
 }finally{globalThis.fetch=originalFetch;await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('desktop capture-channel outbox consumes actual device context routes without changing original bytes',async()=>{
 const {LocalSourceManager}=await import('../src/source-manager');
 const directory=await mkdtemp(join(tmpdir(),'mote-capture-context-contract-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),app=Fastify(),deviceId='generated-mac-context';let manager:InstanceType<typeof LocalSourceManager>|undefined;
 const input={id:'6245e812-27d0-4da0-bbf3-5abbbeedc25a',deviceId,deviceName:'Generated Mac',platform:'macos' as const,source:'activity' as const,capturedAt:'2026-10-29T08:00:00.000Z',durationMs:1000,appId:'dev.mote.generated',appName:'Generated Notes',privacy:{excluded:false as const,redacted:false,mode:'none' as const,collection:'activity' as const}};
 try{
  await store.ingest(input);const original=store.db.prepare('SELECT json FROM captures WHERE id=?').get(input.id)!.json;
  app.setErrorHandler((error,_req,res)=>res.status((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  registerSourceRoutes(app,{sources,credential:()=>undefined,sourceOwner:()=>{},layers:{} as never,evidenceReader:{} as never,ingress:{} as never,connections:{} as never});await app.listen({port:0,host:'127.0.0.1'});
  manager=new LocalSourceManager(join(directory,'desktop'),{...defaultConfig(),deviceId,serverUrl:app.server.address()&&'http://127.0.0.1:'+(app.server.address() as {port:number}).port,token:'generated-context-owner',syncMode:'manual',syncPaused:true},'/never-native-helper',true);await manager.initialize();
  const empty=await manager.captureContext('activity');assert.equal(empty.snapshot.version,0);await manager.saveCaptureContext('activity',{expectedVersion:0,description:'Generated source-wide declaration'});assert.equal(manager.pendingStats().pendingUpdates,1);await manager.flushPending(new AbortController().signal);assert.equal((await manager.captureContext('activity')).pending?.description,'Generated source-wide declaration');await manager.setSyncPaused(false);await manager.flushPending(new AbortController().signal);
  const accepted=await manager.captureContext('activity');assert.equal(accepted.snapshot.description,'Generated source-wide declaration');assert.equal(accepted.snapshot.version,1);assert.equal(accepted.pending,undefined);assert.equal((await manager.captureContext('screen')).snapshot.description,'');assert.equal(store.db.prepare('SELECT json FROM captures WHERE id=?').get(input.id)!.json,original);
  await manager.saveCaptureContext('activity',{expectedVersion:1,description:''});await manager.flushPending(new AbortController().signal);assert.equal((await manager.captureContext('activity')).snapshot.description,'');
 }finally{await manager?.close();await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});
