import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Context} from '@deepseek-ai/cordis';
import {buildContextEnvelope,type ContextReader} from '@mote/agent';
import {register} from '../src/features/agent-view.js';
import {ServerFeatureHost} from '../src/feature-host.js';
import {contextIndex} from '../src/context-index.js';
import type {Store} from '../src/store.js';
import type {SourceStore} from '../src/sources.js';
import type {FeatureServices} from '../src/feature-services.js';

test('root catalog avoids corpus scans; source and layer cursors allow complete bounded browsing',()=>{
 const store={archive:{stats(){throw Error('First screen must not count the corpus');}}} as unknown as Store;
 const sources={listSources:()=>Array.from({length:29},(_,i)=>({id:String(i).padStart(2,'0'),name:'Generated '+i,kind:'file',deviceId:i===28?'other':'fixture'}))} as unknown as SourceStore;
 const memory={page:()=>({items:[],nextCursor:'next-memory'})};
 const root=contextIndex(store,memory,sources);assert.equal(root.entries.length,3);assert.equal(root.nextCursor,null);
 const ids:string[]=[];let cursor:string|undefined;
 do{const page=contextIndex(store,memory,sources,{path:'/context/sources',deviceId:'fixture',limit:6,cursor});ids.push(...page.entries.map(e=>(e as {id:string}).id));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(ids.length,28);assert.equal(new Set(ids).size,28);
 assert.equal(contextIndex(store,memory,sources,{path:'/context/memory'}).nextCursor,'next-memory');
 assert.throws(()=>contextIndex(store,memory,sources,{path:'/context/sources',deviceId:'other',cursor:Buffer.from(JSON.stringify({path:'/context/sources',deviceId:'fixture',after:'06'})).toString('base64url')}),/Invalid directory cursor/);
});

test('Cordis Agent view preview shares the envelope, keeps scope, pages originals and revokes on disposal',async()=>{
 const app=Fastify(),root=new Context(),host=new ServerFeatureHost(root,app),calls:unknown[]=[];
 const record={id:'generated-evidence',capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',ocrText:'A'.repeat(4000)+'B'.repeat(4000)+'C'};
 const memory={id:'generated-memory',title:'Generated lead',statement:'Generated statement',uncertainty:'Generated uncertainty',createdAt:'2026-10-01T00:00:00Z',status:'published',tier:'consolidated'};
 const reader={memories:async(args:Record<string,unknown>)=>{calls.push(args);return {items:[memory],nextCursor:null,...(args.includeEvidence?{sourceSpans:[{record,offset:4000,length:20}]}:{})};},sourceItems:async()=>({items:[record],nextCursor:null}),evidence:async(args:Record<string,unknown>)=>{calls.push(args);return args.deviceId==='other'?[]:[record];},contextTools:()=>[]} as unknown as ContextReader;
 const diagnostics={snapshot:()=>({lastSeq:0,agentTrace:{enabled:false}}),events:()=>({items:[],nextSeq:0,oldestSeq:null})} as unknown as FeatureServices['diagnostics'];
 try{
  await host.install({id:'mote.agent-view',version:'1',components:[]},child=>register(child,{archiveReader:reader,diagnostics}));
  const input={question:'Generated question',deviceId:'fixture',after:'2026-09-30T00:00:00Z',before:'2026-10-02T00:00:00Z',timeZone:'Asia/Shanghai'};
  const response=await app.inject({method:'POST',url:'/api/agent-view/startup',payload:input});assert.equal(response.statusCode,200,response.body);
  const preview=response.json();assert.equal(preview.modelCalls,0);assert.equal(preview.context.untrustedMemoryLeads.length,1);assert.equal(preview.context.untrustedMemoryLeads[0].statement,memory.statement);
  assert.deepEqual(preview.context,buildContextEnvelope({...input,contextTime:preview.context.currentTime,openingMemories:preview.context.untrustedMemoryLeads},[]));
  assert.ok(calls.every((c:any)=>c.deviceId==='fixture'&&c.after===input.after&&c.before===input.before));
  const text=await app.inject('/api/agent-view/evidence?id=generated-evidence&deviceId=fixture&offset=4000&length=4000');assert.equal(text.statusCode,200);assert.equal(text.json().items[0].ocrText,'B'.repeat(4000));assert.equal(text.json().items[0].textRange.nextOffset,8000);
  assert.deepEqual((await app.inject('/api/agent-view/evidence?id=generated-evidence&deviceId=other')).json().items,[]);
  const sourcePage=(await app.inject('/api/agent-view/source-items?sourceId=fixture')).json();assert.equal(sourcePage.items[0].preview.length,400);assert.equal(sourcePage.items[0].ocrText,undefined);
  const proof=(await app.inject('/api/agent-view/memories?id=generated-memory&includeEvidence=true')).json().sourceSpans[0];assert.equal(proof.record.ocrText,'B'.repeat(20));assert.equal(proof.offset,0);
  assert.equal((await app.inject('/api/agent-view/evidence?id=generated-evidence&length=4001')).statusCode,500); // Standalone Fastify has no host Zod error handler.
  await host.dispose('mote.agent-view');assert.equal((await app.inject({method:'POST',url:'/api/agent-view/startup',payload:input})).statusCode,503);assert.equal(host.registry.list().length,0);
 }finally{await host.close();await root.fiber.dispose();await app.close();}
});
