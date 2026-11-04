import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Store} from '../../server/src/store';
import {SourceStore} from '../../server/src/sources';
import {EvidenceReader} from '../../server/src/evidence-reader';
import {createContextQuery} from '../../server/src/plugins/query-context';
import {registerContextRoutes} from '../../server/src/context-routes';
import {centralContentPage} from '../src/content-library';
import {defaultConfig} from '../src/config';

test('real capture search HTTP contract preserves legal generic sources and device-scoped pagination',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-desktop-search-contract-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store),reader=new EvidenceReader(store,sources),app=Fastify();
 const config={...defaultConfig(),serverUrl:'https://fixture.invalid',token:'generated-content-contract-owner'};
 const savedFetch=globalThis.fetch;
 try {
  registerContextRoutes(app,createContextQuery(store,sources,reader));
  const ids=new Set<string>();
  for(let i=0;i<34;i++){
   const id=randomUUID();ids.add(id);await store.ingest({id,deviceId:config.deviceId,deviceName:'Generated Mac',platform:'macos',source:(['event','metric','memory','note'] as const)[i%4],capturedAt:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),durationMs:0,appName:'Generated context',ocrText:'ContractNeedle '+i,privacy:{excluded:false,redacted:false,mode:'none'}});
  }
  await store.ingest({id:randomUUID(),deviceId:'other-device',deviceName:'Other generated device',platform:'macos',source:'event',capturedAt:'2026-10-02T00:00:00Z',durationMs:0,appName:'Generated other context',ocrText:'ContractNeedle foreign',privacy:{excluded:false,redacted:false,mode:'none'}});
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,config.serverUrl);assert.equal(url.pathname,'/api/context/search');assert.equal(url.searchParams.get('deviceId'),config.deviceId);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+config.token);const response=await app.inject({method:'GET',url:url.pathname+url.search,headers:Object.fromEntries(new Headers(init?.headers))});return new Response(response.body,{status:response.statusCode,headers:response.headers as Record<string,string>});};
  const pages=[];let cursor:string|undefined;
  do{const page=await centralContentPage(config,cursor,'ContractNeedle');assert.ok(page.items.length<=30);pages.push(...page.items);cursor=page.nextCursor;}while(cursor);
  assert.equal(pages.length,34);assert.deepEqual(new Set(pages.map(row=>row.key.slice(8))),ids);assert.deepEqual(new Set(pages.map(row=>row.source)),new Set(['event','metric','memory','note']));
 }finally{globalThis.fetch=savedFetch;await app.close();store.close();await rm(directory,{recursive:true,force:true});}
});
