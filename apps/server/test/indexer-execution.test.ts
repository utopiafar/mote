import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {Indexer} from '../src/indexer.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ExecutionEngine} from '../src/execution-engine.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const vector=()=>new Response(JSON.stringify({data:[{embedding:[1,0]}],usage:{prompt_tokens:12,total_tokens:12}}),{status:200});
const config={embeddingModel:'generated',embeddingBaseUrl:'http://127.0.0.1:9/v1',embeddingApiKey:'generated'};
function fixture(t:TestContext,fetcher:(input:RequestInit)=>Promise<Response>,operationId?:()=>string|undefined){const directory=mkdtempSync(join(tmpdir(),'mote-indexer-execution-')),store=new Store(directory,{embeddingEnabled:true}),sources=new SourceStore(store),files=new FileStore(store,sources);let now=Date.now();const engine=new ExecutionEngine(store,()=>now),attribution:string[]=[],indexer=new Indexer(store,config,undefined,files,input=>{attribution.push(input.operationId!);assert.ok(store.db.prepare("SELECT 1 FROM execution_steps WHERE operation_id=? AND state='running'").get(input.operationId!));return {finish(){}};},{executor:engine,operationId});const extra:(()=>Promise<unknown>)[]=[];t.mock.method(globalThis,'fetch',async(_url:any,input:any)=>fetcher(input));t.after(async()=>{for(const close of extra.reverse())await close();await indexer.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});sources.register({id:'fixture',name:'Generated only',kind:'custom',deviceId:'fixture',platform:'import'});const add=()=>sources.upsert('fixture',{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated private indexing text needle'});return {store,sources,files,engine,indexer,extra,attribution,add,advance:(ms:number)=>now+=ms};}

test('indexed file chunks share the real file Operation and persistent inputs contain no original text',async t=>{
 const f=fixture(t,async()=>vector());f.sources.register({id:'files',name:'Generated files',kind:'local-files',deviceId:'fixture',platform:'import',retention:'archive'});const bytes=Buffer.from('Generated private original');const session=f.files.begin({sourceId:'files',item:{externalId:'one.txt',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});f.files.part(session.uploadId,0,bytes,()=>{});const ack=await f.files.commit(session.uploadId,()=>{}),artifact=randomUUID();f.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifact,ack.id,'text',new Date().toISOString(),'fixture','{}');
 for(let n=0;n<2;n++)f.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,NULL,NULL,?,?)').run(randomUUID(),artifact,ack.id,'Generated private chunk '+n,'{}');await f.indexer.tick();assert.equal(f.attribution.length,2);assert.deepEqual(new Set(f.attribution),new Set(['file:'+ack.id]));assert.equal(f.files.pendingIndex(config.embeddingModel).length,0);const rows=f.store.db.prepare("SELECT input,state FROM execution_steps WHERE kind='embedding.file'").all();assert.equal(rows.length,2);assert.ok(rows.every(row=>row.state==='succeeded'&&!String(row.input).includes('Generated private')));
});

test('another host cancellation forbids a late vector and discovery cannot automatically replay it',async t=>{
 const entered=deferred(),release=deferred();let calls=0;const f=fixture(t,async()=>{calls++;entered.resolve();await release.promise;return vector();}),other=new ExecutionEngine(f.store);f.extra.push(()=>other.close());const record=await f.add(),running=f.indexer.tick();await entered.promise;const step=f.store.db.prepare("SELECT id FROM execution_steps WHERE kind='embedding.capture'").get()!;other.cancel(String(step.id));release.resolve();await running;assert.equal(f.store.db.prepare('SELECT embedding FROM captures WHERE id=?').get(record.id)!.embedding,null);assert.equal(f.store.evidence([record.id])[0].indexingStatus,'failed');await f.indexer.tick();assert.equal(calls,1);f.indexer.retry();await f.indexer.tick();assert.equal(calls,2);assert.equal(f.store.evidence([record.id])[0].indexingStatus,'indexed');
});

test('embedding Retry-After persists while authentication waits for explicit retry',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'Retry-After':'60'}}):calls===2?new Response('{}',{status:401}):vector();});await f.add();await f.indexer.tick();const id=String(f.store.db.prepare("SELECT id FROM execution_steps WHERE kind='embedding.capture'").get()!.id);assert.equal(f.engine.get(id)?.state,'waiting');assert.equal(f.engine.get(id)?.error,'rate_limited');await f.indexer.tick();assert.equal(calls,1);f.advance(60001);await f.indexer.tick();assert.equal(f.engine.get(id)?.state,'blocked');assert.equal(f.engine.get(id)?.error,'provider_authentication');await f.indexer.tick();assert.equal(calls,2);f.indexer.retry();await f.indexer.tick();assert.equal(f.engine.get(id)?.state,'succeeded');
});

test('temporary query embeddings attach to the parent without storing questions and queued work degrades promptly',async t=>{
 const entered=deferred(),release=deferred(),parent='query:'+randomUUID();let calls=0;const f=fixture(t,async()=>{calls++;if(calls===1){entered.resolve();await release.promise;}return vector();},()=>parent);await f.add();f.engine.register({kind:'generated-query',pool:'generated-query',concurrency:()=>1,validate:()=>true,execute:async()=>true,commit:()=>{}});f.engine.enqueue(parent,'generated-query',{});await f.engine.tick();
 const first=f.indexer.search({query:'needle'});await entered.promise;const began=Date.now(),second=await f.indexer.search({query:'Generated private question',deviceId:'fixture'});assert.ok(Date.now()-began<1200);assert.equal(second.retrieval.degraded,true);assert.equal(calls,1);release.resolve();await first;const rows=f.store.db.prepare("SELECT operation_id,input,state FROM execution_steps WHERE kind LIKE 'embedding.query.%'").all();assert.equal(rows.length,2);assert.ok(rows.every(row=>row.operation_id===parent&&!String(row.input).includes('needle')&&!String(row.input).includes('private question')));assert.ok(rows.some(row=>row.state==='failed'));assert.deepEqual(f.attribution,[parent]);
});

test('shutdown preserves an admitted background embedding for another indexer to finish once',async t=>{
 const entered=deferred();let calls=0;const f=fixture(t,async input=>{calls++;if(calls===1){entered.resolve();return new Promise<Response>((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(Error('synthetic shutdown')),{once:true}));}return vector();});const record=await f.add(),running=f.indexer.tick();await entered.promise;await f.indexer.close();await running;const id=String(f.store.db.prepare("SELECT id FROM execution_steps WHERE kind='embedding.capture'").get()!.id);assert.equal(f.engine.get(id)?.state,'waiting');f.advance(1100);const next=new Indexer(f.store,config,undefined,f.files,undefined,{executor:f.engine});f.extra.push(()=>next.close());await next.tick();assert.equal(calls,2);assert.equal(f.store.evidence([record.id])[0].indexingStatus,'indexed');assert.equal(f.engine.get(id)?.attempts,2);
});

test('a failed optional vector lookup keeps the completed parent successful and exposes the reason',async t=>{
 const parent='query:'+randomUUID(),f=fixture(t,async()=>new Response('{}',{status:503}),()=>parent);await f.add();f.engine.register({kind:'generated-query',pool:'generated-query',concurrency:()=>1,validate:()=>true,execute:async()=>true,commit:()=>{}});f.engine.enqueue(parent,'generated-query',{});await f.engine.tick();const result=await f.indexer.search({query:'needle'});assert.equal(result.retrieval.degraded,true);assert.equal(result.length,1);const row=f.store.db.prepare("SELECT state,error FROM execution_steps WHERE kind LIKE 'embedding.query.%'").get()!;assert.equal(row.state,'failed');assert.equal(row.error,'provider_unavailable');assert.equal(f.store.db.prepare('SELECT state FROM operation_progress WHERE id=?').get(parent)!.state,'succeeded');
});


test('a standalone lookup records its deadline as failure and external cancellation remains cancelled',async t=>{
 const f=fixture(t,async()=>new Promise<Response>(()=>{}));
 await assert.rejects(f.indexer.embed('Generated slow question',25));
 let row=f.store.db.prepare("SELECT id,operation_id,state,error FROM execution_steps WHERE kind LIKE 'embedding.query.%' ORDER BY rowid DESC").get()!;
 assert.equal(row.state,'failed');assert.equal(row.error,'embedding_timeout');assert.equal(f.store.db.prepare('SELECT state FROM operation_progress WHERE id=?').get(row.operation_id)!.state,'failed');
 const controller=new AbortController(),pending=f.indexer.embed('Generated cancelled question',1000,controller.signal);controller.abort();await assert.rejects(pending);
 row=f.store.db.prepare("SELECT id,operation_id,state,error FROM execution_steps WHERE kind LIKE 'embedding.query.%' ORDER BY rowid DESC").get()!;assert.equal(row.state,'cancelled');assert.equal(row.error,'cancelled');
});
