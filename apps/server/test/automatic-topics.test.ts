import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import type {TopicAuthority} from '../src/automatic-topics.js';
const at='2026-10-01T10:00:00.000Z';
async function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-auto-topics-'));
 const config:Config={dataDir,token:'generated-topics-owner-token-1234567890',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const start=async()=>{const n=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No real model');},close:async()=>{}}});await n.app.ready();return n;};
 let n=await start();const headers={authorization:'Bearer '+config.token};
 t.after(async()=>{await n.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const seed=async(text:string)=>{const id=randomUUID();assert.equal((await n.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'fixture',deviceName:'Generated',platform:'android',capturedAt:at,text}})).statusCode,201);
 const r=fixtureMemoryResult(n.memories,{answer:JSON.stringify({memories:[{title:text,statement:text+' ['+id+']',uncertainty:'Synthetic evidence, not a user fact',evidenceIds:[id]}]}),citations:[{id,capturedAt:at,appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()});const saved=n.memories.extract(r,'fixture').items[0];return n.memories.publish(saved.id);};
 const api=async(path:string)=>{const r=await n.app.inject({url:path,headers});assert.equal(r.statusCode,200,r.body);return r.json();};
 return {get n(){return n;},seed,api,headers,restart:async()=>{await n.app.close();n=await start();}};
}
const authority=(controller=new AbortController()):TopicAuthority=>({admissionId:'original-generated-admission',signal:controller.signal,assertCurrent:()=>{controller.signal.throwIfAborted();}});
const output=(ids:string[])=>({trees:[{id:'projects',label:'Generated project topics',nodes:[{id:'planning',label:'Generated planning',memoryIds:ids},{id:'review',label:'Generated review',memoryIds:ids.slice(0,1)}]},{id:'practices',label:'Generated practice topics',nodes:[{id:'checklists',label:'Generated checklists',memoryIds:ids.slice(0,1)}]}]});

test('generated classification persists multi-tree references without copying Memory and resumes exact admitted operation',async t=>{
 const f=await fixture(t),a=await f.seed('Synthetic checklist proposal'),b=await f.seed('Synthetic review plan');let calls=0;
 const classifier={id:'fixture',version:'1',classify:async()=>{calls++;return output([a.id,b.id]);}};
 f.n.featureServices.contextTrees.automatic!.register(classifier);
 const count=f.n.store.db.prepare('SELECT count(*) n FROM memories').get()!.n;
 const input={operationId:'operation-one',classifierId:'fixture',memoryIds:[a.id,b.id]};
 await f.n.featureServices.contextTrees.automatic!.classify(input,authority());
 const catalog=await f.api('/api/context-trees'),trees=catalog.items.filter((x:any)=>x.id.startsWith('auto.'));assert.equal(trees.length,2);
 for(const tree of trees){const page=await f.api(`/api/context-trees/${tree.id}/nodes/${tree.nodes[1]?.id??tree.nodes[0].id}`);assert.deepEqual(page.items.map((x:any)=>x.id),[a.id]);}
 assert.equal(f.n.store.db.prepare('SELECT count(*) n FROM memories').get()!.n,count);
 const stored=String(f.n.store.db.prepare('SELECT json FROM context_topic_batches').get()!.json);assert.ok(!stored.includes(a.statement));assert.ok(!stored.includes(a.uncertainty));
 await f.restart();f.n.featureServices.contextTrees.automatic!.register(classifier);
 await f.n.featureServices.contextTrees.automatic!.classify(input,authority());assert.equal(calls,1,'restart and duplicate delivery do not call model again');
 assert.deepEqual((await f.api('/api/context-trees')).items, catalog.items);
 await assert.rejects(f.n.featureServices.contextTrees.automatic!.classify(input,{...authority(),admissionId:'different-admission'}),/identity conflict/);
});

test('deleting an unassigned input hides every derived label, surviving references cannot keep it alive',async t=>{
 const f=await fixture(t),a=await f.seed('Synthetic member'),b=await f.seed('Synthetic contextual input');const service=f.n.featureServices.contextTrees.automatic!;
 service.register({id:'fixture',version:'1',classify:async()=>output([a.id])});
 await service.classify({operationId:'delete-dependency',classifierId:'fixture',memoryIds:[a.id,b.id]},authority());
 const tree=(await f.api('/api/context-trees')).items.find((x:any)=>x.id.startsWith('auto.'));assert.ok(tree);
 f.n.memories.delete(b.id);
 assert.equal((await f.api('/api/context-trees')).items.some((x:any)=>x.id.startsWith('auto.')),false);
 assert.equal((await f.n.app.inject({url:`/api/context-trees/${tree.id}/nodes/planning`,headers:f.headers})).statusCode,404);
 assert.equal(f.n.memories.get(a.id).statement,a.statement);
});

test('late model output after stop, input mutation or classifier disposal never publishes labels',async t=>{
 for(const action of ['stop','delete','dispose'] as const){
  const f=await fixture(t),a=await f.seed('Synthetic late result '+action),service=f.n.featureServices.contextTrees.automatic!,controller=new AbortController();
  let release!:(value:unknown)=>void,started!:()=>void;const begun=new Promise<void>(r=>started=r);
  const dispose=service.register({id:'fixture',version:'1',classify:async()=>{started();return new Promise(r=>release=r);}});
  const run=service.classify({operationId:'late-'+action,classifierId:'fixture',memoryIds:[a.id]},authority(controller));await begun;
  if(action==='stop')controller.abort();else if(action==='delete')f.n.memories.delete(a.id);else dispose();
  release(output([a.id]));await assert.rejects(run);
  assert.equal(f.n.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
 }
});

test('empty output is durable success; unknown IDs, cycles, duplicate references and network errors are retryable failures',async t=>{
 const f=await fixture(t),a=await f.seed('Synthetic empty case'),service=f.n.featureServices.contextTrees.automatic!;let mode='empty',calls=0;
 service.register({id:'fixture',version:'1',classify:async()=>{calls++;if(mode==='offline')throw Error('fixture offline');if(mode==='empty')return {trees:[]};const result=output([a.id]);if(mode==='unknown')result.trees[0].nodes[0].memoryIds=[randomUUID()];if(mode==='duplicate')result.trees[0].nodes[0].memoryIds=[a.id,a.id];if(mode==='cycle')(result.trees[0].nodes[0] as any).parentId='planning';return result;}});
 const input={operationId:'empty',classifierId:'fixture',memoryIds:[a.id]};await service.classify(input,authority());await service.classify(input,authority());assert.equal(calls,1);
 for(mode of ['unknown','duplicate','cycle','offline'])await assert.rejects(service.classify({...input,operationId:'bad'},authority()));
 assert.equal(f.n.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
 mode='valid';await service.classify({...input,operationId:'bad'},authority());assert.equal((await service.trees()).length,2);
});

test('concurrent duplicate work, unavailable classifiers and invalid original admission do not invoke another model',async t=>{
 const f=await fixture(t),a=await f.seed('Synthetic concurrent input'),service=f.n.featureServices.contextTrees.automatic!;
 const input={operationId:'concurrent',classifierId:'fixture',memoryIds:[a.id]};await assert.rejects(service.classify(input,authority()),/unavailable/);
 let release!:(value:unknown)=>void,started!:()=>void,calls=0;const begun=new Promise<void>(r=>started=r);
 service.register({id:'fixture',version:'1',classify:async()=>{calls++;started();return new Promise(r=>release=r);}});
 await assert.rejects(service.classify(input,{...authority(),assertCurrent:()=>{throw Error('epoch revoked');}}),/epoch revoked/);
 const run=service.classify(input,authority());await begun;await assert.rejects(service.classify(input,authority()),/already running/);release(output([a.id]));await run;assert.equal(calls,1);
});


test('pagination preserves exact membership; correction invalidates labels and unauthorized HTTP cannot list them',async t=>{
 const f=await fixture(t),a=await f.seed('Synthetic first page'),b=await f.seed('Synthetic second page'),service=f.n.featureServices.contextTrees.automatic!;
 service.register({id:'fixture',version:'1',classify:async()=>output([a.id,b.id])});
 await service.classify({operationId:'pages',classifierId:'fixture',memoryIds:[a.id,b.id]},authority());
 const tree=(await service.trees())[0],base=`/api/context-trees/${tree.id}/nodes/planning?limit=1`;
 const first=await f.api(base);assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=await f.api(base+'&cursor='+encodeURIComponent(first.nextCursor));assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);
 assert.equal((await f.n.app.inject({url:'/api/context-trees'})).statusCode,401);
 await f.n.memories.correct(b.id,{version:b.version,title:'Synthetic correction',statement:'Synthetic owner correction',uncertainty:'fixture'});
 assert.deepEqual(await service.trees(),[]);
 assert.equal((await f.n.app.inject({url:base+'&cursor='+encodeURIComponent(first.nextCursor),headers:f.headers})).statusCode,404);
});
