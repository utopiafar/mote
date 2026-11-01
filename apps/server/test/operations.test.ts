import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';
import {Operations,registerOperations} from '../src/operations.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {memorySchema} from '../src/memory-schema.js';
import {registerMemoryRoutes} from '../src/memory-routes.js';
import {ContextTreeRegistry} from '../src/context-trees.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
const handler:ExecutionHandler={kind:'fixture',pool:'fixture',concurrency:()=>2,validate:()=>true,execute:async()=>null,commit:()=>{}};
function fixture(t:any,legacy=false){const dir=mkdtempSync(join(tmpdir(),'mote-operations-')),store=new Store(dir);let engine:ExecutionEngine;
 if(!legacy){engine=new ExecutionEngine(store);engine.register(handler);}
 t.after(async()=>{await engine?.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,get engine(){return engine;},start(){engine=new ExecutionEngine(store);return engine;},operations:new Operations(store)};
}
test('400 dated operations paginate without rescanning evidence and report committed changes only',async t=>{
 const {store,engine,operations}=fixture(t);const ids:string[]=[];
 for(let i=0;i<400;i++)ids.push(engine.enqueue('file:'+i,'fixture',{date:new Date(Date.UTC(2024,0,1+i)).toISOString(),privateText:'never return this'}));
 const first=operations.page({limit:37});assert.equal(first.items.length,37);
 let cursor=first.nextCursor,all=first.items.map(v=>v.id);while(cursor){const page=operations.page({cursor,limit:37});all.push(...page.items.map(v=>v.id));cursor=page.nextCursor;}
 assert.equal(all.length,400);assert.equal(new Set(all).size,400);
 store.db.exec('BEGIN');store.db.prepare("UPDATE execution_steps SET state='failed' WHERE id=?").run(ids[0]);store.db.exec('ROLLBACK');assert.deepEqual(operations.changes(first.changeCursor).ids,[]);
 await engine.drain(ids);assert.equal(operations.page({state:'waiting'}).items.length,0);assert.equal(operations.detail('file:0').operation.state,'succeeded');
 let since=first.changeCursor,changed=new Set<string>();do{const page=operations.changes(since);page.ids.forEach(id=>changed.add(id));since=page.cursor;if(!page.hasMore)break;}while(true);assert.equal(changed.size,400);
 assert.doesNotMatch(JSON.stringify(operations.detail('file:0')),/never return this|privateText/);
 store.db.prepare('DELETE FROM execution_steps WHERE id=?').run(ids[0]);assert.equal(operations.page({limit:100}).items.some(v=>v.id==='file:0'),false);assert.throws(()=>operations.detail('file:0'),/not found/);
 assert.deepEqual(operations.changes(Number.MAX_SAFE_INTEGER),{ids:[],cursor:operations.page().changeCursor,reset:true,hasMore:false});
});
test('new generations retire obsolete failure counts, retain history and distinguish unscheduled optional work',async t=>{
 const {engine,operations}=fixture(t);const gen=(version:string)=>({generation:{slot:'pipeline',version}});
 const old=engine.enqueue('file:a','fixture',{revision:1},gen('1'));engine.cancel(old);
 const next=engine.enqueue('file:a','fixture',{revision:2},gen('2'));
 engine.enqueue('file:a','fixture',{summary:true},{...gen('2'),optional:true,initial:{state:'blocked',attempts:0,availableAt:0,error:'summary_disabled'}});
 await engine.drain([next]);let detail=operations.detail('file:a');assert.equal(detail.operation.state,'succeeded');assert.equal(detail.operation.total,2);assert.equal(detail.operation.notScheduled,1);assert.equal(detail.operation.counts.cancelled,0);assert.equal(detail.steps.find(s=>s.id===old)!.current,false);
 const shared=engine.enqueue('file:b','fixture',{shared:true},{id:'shared'});engine.enqueue('file:c','fixture',{shared:true},{id:'shared'});await engine.drain([shared]);for(const id of ['file:b','file:c'])assert.equal(operations.detail(id).operation.counts.succeeded,1);
 const skipped=engine.enqueue('file:d','fixture',{},{optional:true,initial:{state:'blocked',attempts:0,availableAt:0,error:'summary_disabled'}});assert.equal(operations.detail('file:d').operation.state,'skipped');engine.retry(skipped);await engine.drain([skipped]);assert.equal(operations.detail('file:d').operation.notScheduled,0);assert.equal(operations.detail('file:d').operation.state,'succeeded');
});
test('operations routes are read-only, bounded and reject collector credentials',async t=>{
 const {engine,operations}=fixture(t);engine.enqueue('file:a','fixture',{secret:'private provider input'});const app=Fastify();t.after(()=>app.close());registerOperations(app,operations,req=>req.headers.authorization==='Bearer collector');
 for(const url of ['/api/operations','/api/operations/changes','/api/operations/file%3Aa']){assert.equal((await app.inject({url,headers:{authorization:'Bearer collector'}})).statusCode,403);const res=await app.inject({url});assert.equal(res.statusCode,200);assert.doesNotMatch(res.body,/private provider input/);}
 assert.equal((await app.inject({url:'/api/operations/file%3Aa',method:'POST'})).statusCode,404);
});

test('optional failures retain actual receipts without failing required work across replay and rollback',async t=>{
 const {store,engine,operations}=fixture(t);
 const required=engine.enqueue('query:complete','fixture',{required:true});await engine.drain([required]);
 const optional=engine.enqueue('query:complete','fixture',{vector:true},{id:'optional-vector',optional:true,initial:{state:'failed',attempts:1,availableAt:0,error:'provider_unavailable'}});
 let detail=operations.detail('query:complete');assert.equal(detail.operation.state,'succeeded');assert.equal(detail.operation.notScheduled,0);assert.equal(detail.operation.optionalIssues,1);assert.equal(detail.operation.counts.failed,0);
 assert.equal(detail.steps.find(s=>s.id===optional)?.state,'failed');assert.equal(detail.steps.find(s=>s.id===optional)?.reason,'provider_unavailable');assert.equal(detail.steps.find(s=>s.id===optional)?.attempts,1);
 engine.enqueue('embedding:standalone','fixture',{vector:true},{id:optional});assert.equal(operations.detail('embedding:standalone').operation.state,'failed');
 store.db.exec('BEGIN');engine.retry(optional);assert.equal(operations.detail('query:complete').operation.optionalIssues,0);store.db.exec('ROLLBACK');assert.equal(operations.detail('query:complete').operation.optionalIssues,1);
 // Reopening the current engine preserves counters without historical replay.
 const restored=new ExecutionEngine(store);await restored.close();assert.equal(operations.detail('query:complete').operation.state,'succeeded');assert.equal(operations.detail('query:complete').operation.optionalIssues,1);
 engine.retry(optional);await engine.drain([optional]);detail=operations.detail('query:complete');assert.equal(detail.operation.optionalIssues,0);assert.equal(detail.operation.counts.succeeded,2);assert.equal(operations.detail('embedding:standalone').operation.state,'succeeded');
});

test('optional configuration faults are not normal skips; confirmation and actual task kinds remain readable',async t=>{
 const {engine,operations}=fixture(t);
 engine.enqueue('file:optional-config','fixture',{},{optional:true,initial:{state:'blocked',attempts:0,availableAt:0,error:'processor_not_configured'}});
 assert.equal(operations.detail('file:optional-config').operation.notScheduled,0);assert.equal(operations.detail('file:optional-config').operation.optionalIssues,1);assert.equal(operations.detail('file:optional-config').steps[0].notScheduled,false);
 engine.enqueue('import:confirm','fixture',{},{initial:{state:'blocked',attempts:0,availableAt:0,error:'awaiting_confirmation'}});assert.equal(operations.detail('import:confirm').operation.waitingReason,'awaiting_confirmation');assert.equal(operations.page({kind:'import'}).items[0].waitingReason,'awaiting_confirmation');
 const step=engine.enqueue('memory:context','fixture',{});engine.cancel(step,true,'authority_changed');assert.equal(operations.detail('memory:context').steps[0].reason,'authority_changed');
 const app=Fastify();t.after(()=>app.close());registerOperations(app,operations,()=>false);for(const kind of ['recording-sync','material-organizer','memory-provider-reconcile'])assert.equal((await app.inject({url:'/api/operations?kind='+kind})).statusCode,200);
});

test('a pending descendant cannot hide an unknown issued-call outcome',async t=>{
 const {engine,operations}=fixture(t);engine.enqueue('file:unknown-pending','fixture',{parent:true},{initial:{state:'blocked',attempts:1,availableAt:0,error:'processor_response_unknown'}});engine.enqueue('file:unknown-pending','fixture',{child:true},{initial:{state:'waiting',attempts:1,availableAt:Number.MAX_SAFE_INTEGER,error:'provider_unavailable'}});
 const current=operations.detail('file:unknown-pending').operation;assert.equal(current.state,'waiting');assert.equal(current.waitingReason,'processor_response_unknown');assert.equal(operations.page({kind:'file'}).items[0].waitingReason,'processor_response_unknown');
});


test('205-step detail batches dependency reads without changing per-step limits or pagination',async t=>{
 const {store,engine,operations}=fixture(t);
 const dependencies=Array.from({length:125},(_,i)=>engine.enqueue('file:dependency-fixture','fixture',{i},{id:'dependency-'+String(124-i).padStart(3,'0')}));
 const expected=new Map<string,string[]>();
 for(let i=0;i<205;i++){
  const selected=dependencies.slice(0,[0,1,99,100,125][i%5]);
  const id=engine.enqueue('file:batch-fixture','fixture',{i},{dependencies:selected,initial:{state:'blocked',attempts:0,availableAt:0,error:'awaiting_confirmation'}});
  expected.set(id,[...selected].sort().slice(0,100));
 }
 const prepare=store.db.prepare.bind(store.db),reads:string[][]=[];
 const spy=t.mock.method(store.db,'prepare',(sql:string)=>{const statement=prepare(sql);if(sql.includes('FROM execution_dependencies')){const all=statement.all.bind(statement);statement.all=((...args:any[])=>{reads.push(JSON.parse(String(args[0])));return all(...args);}) as typeof statement.all;}return statement;});
 for(const limit of [1,50,100,205,600]){
  let cursor=0;const seen:string[]=[];
  do{reads.length=0;const page=operations.detail('file:batch-fixture',cursor,limit);assert.equal(reads.length,Math.ceil(page.steps.length/100));assert.deepEqual(reads.flat(),page.steps.map(s=>s.id));assert.ok(reads.every(batch=>batch.length<=100));
   for(const step of page.steps){assert.deepEqual(step.dependencies,expected.get(step.id));assert.equal(step.state,'blocked');assert.equal(step.attempts,0);seen.push(step.id);}
   cursor=page.nextCursor??0;
  }while(cursor);
  assert.deepEqual(seen,[...expected.keys()]);
 }
 reads.length=0;assert.deepEqual(operations.detail('file:batch-fixture',Number.MAX_SAFE_INTEGER).steps,[]);assert.equal(reads.length,0);spy.mock.restore();
 const app=Fastify();t.after(()=>app.close());registerOperations(app,operations,req=>req.headers.authorization==='Bearer collector');
 const response=await app.inject({url:'/api/operations/file%3Abatch-fixture?limit=100'});assert.equal(response.statusCode,200);for(const step of response.json().steps)assert.deepEqual(step.dependencies,expected.get(step.id));
 assert.equal((await app.inject({url:'/api/operations/file%3Abatch-fixture',headers:{authorization:'Bearer collector'}})).statusCode,403);
});

test('real memory mutations publish memory change ids through the operations endpoint',async t=>{
 const {store,operations}=fixture(t),memories=new MemoryStore(store),at='2026-10-12T00:00:00Z';
 const evidenceId=randomUUID();await store.ingest({id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'message',capturedAt:at,durationMs:0,appId:'generated',appName:'Generated',ocrText:'Generated topic input original.',privacy:{excluded:false,redacted:false,mode:'none'}});
 const seed=(title:string)=>{const memory=memorySchema.parse({id:randomUUID(),version:1,title,statement:'Generated topic input body.',uncertainty:'Generated only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:at,evidenceIds:[evidenceId],evidence:[],model:'fixture',runId:'fixture',fingerprint:memoryEvidenceFingerprint(store.evidence([evidenceId])[0]),admission:{layer:'memory',reason:'Generated',scope:'Generated fixture',attribution:'observed'}});store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(memory.id,at,JSON.stringify(memory));store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(memory.id,evidenceId);return memory;};
 const app=Fastify();t.after(()=>app.close());
 // Only delete/correct reach the memory store; the remaining route dependencies
 // stay unused behind the production registrations.
 registerMemoryRoutes(app,{memories,store} as Parameters<typeof registerMemoryRoutes>[1]);registerOperations(app,operations,()=>false);
 const changed=async()=>((await app.inject({url:'/api/operations/changes?since=0'})).json() as {ids:string[]}).ids;
 const deleted=seed('Generated deleted topic input');
 assert.equal((await app.inject({url:'/api/memories/'+deleted.id,method:'DELETE'})).statusCode,200);
 assert.ok((await changed()).includes('memory:'+deleted.id),'the real delete route emits a memory change id');
 const corrected=seed('Generated corrected topic input');
 assert.equal((await app.inject({url:'/api/memories/'+corrected.id+'/correct',method:'POST',payload:{version:1,title:'Generated corrected title',statement:'Generated corrected statement.'}})).statusCode,200);
 assert.ok((await changed()).includes('memory:'+corrected.id),'the real correct route emits a memory change id');
 const staled=seed('Generated stale topic input');
 store.invalidateSemanticEvidence(evidenceId);
 assert.equal(memories.get(staled.id).status,'stale');
 assert.ok((await changed()).includes('memory:'+staled.id),'evidence retirement emits a memory change id for staled inputs');
 const removed=seed('Generated removed topic input');
 store.delete(evidenceId);
 assert.throws(()=>memories.get(removed.id),/not found/);
 assert.ok((await changed()).includes('memory:'+removed.id),'evidence deletion emits a memory change id for removed inputs');
});

test('catalog transitions publish context-trees change ids through the operations endpoint',async t=>{
 const {store,engine,operations}=fixture(t),memories=new MemoryStore(store);
 const app=Fastify();t.after(()=>app.close());registerOperations(app,operations,()=>false);
 let cursor=0;const changed=async()=>{const page=(await app.inject({url:'/api/operations/changes?since='+cursor})).json() as {ids:string[];cursor:number};cursor=page.cursor;return page.ids;};
 const registry=new ContextTreeRegistry();
 const earlyDispose=registry.register({id:'fixture',version:'1',label:'Generated',nodes:[{id:'one',label:'One',select:{}}]});
 registry.initializeAutomatic(store,{memoryAsync:async()=>undefined,assertMemoryReadable:()=>{},memories});
 assert.equal((await changed()).some(id=>id.startsWith('context-trees:')),false,'construction-time contributions predate any reader');
 earlyDispose();assert.ok((await changed()).includes('context-trees:registry'),'disposing a pre-initialization contribution emits after binding');
 const dispose=registry.register({id:'plugin',version:'1',label:'Generated plugin tree',nodes:[{id:'one',label:'One',select:{}}]});
 assert.ok((await changed()).includes('context-trees:registry'),'registering a contributed tree emits a catalog change');
 dispose();assert.ok((await changed()).includes('context-trees:registry'),'disposing a contributed tree emits a catalog change');
 const removeClassifier=registry.automatic!.register({id:'fixture.classifier',version:'1',classify:async()=>({trees:[]})});
 assert.ok((await changed()).includes('context-trees:classifier'),'classifier registration emits a catalog change');
 assert.throws(()=>registry.automatic!.register({id:'fixture.classifier',version:'1',classify:async()=>({trees:[]})}),/Duplicate topic classifier/);
 assert.deepEqual(await changed(),[],'a rejected registration must not announce a catalog change');
 removeClassifier();assert.ok((await changed()).includes('context-trees:classifier'),'classifier disposal emits a catalog change');
 removeClassifier();assert.deepEqual(await changed(),[],'repeated cleanup is not another classifier transition');
 const bindings=new MemoryBindings(store,memories,new MemoryAutomation(store),{} as never,engine);
 (bindings as unknown as {saveBinding:(binding:{planId:string;generation:number})=>void}).saveBinding({planId:'mote.builtin',generation:2});
 assert.ok((await changed()).includes('context-trees:provider'),'provider binding activation emits a catalog change');
 const prepare=store.db.prepare.bind(store.db),fault=t.mock.method(store.db,'prepare',(sql:string)=>{
  if(sql==='INSERT INTO operation_changes(operation_id) VALUES(?)')throw Error('Generated live notification failure');
  return prepare(sql);
 });
 assert.throws(()=>registry.register({id:'generated.failure',version:'1',label:'Generated failure',nodes:[{id:'one',label:'One',select:{}}]}),/Generated live notification failure/,'live notification errors must propagate');
 const classifier={id:'generated.failure',version:'1',classify:async()=>({trees:[]})};
 assert.throws(()=>registry.automatic!.register(classifier),/Generated live notification failure/);
 assert.equal(registry.automatic!.state().state,'unavailable','failed registration must not strand an active classifier');
 fault.mock.restore();
 const retry=registry.automatic!.register(classifier);
 assert.equal(registry.automatic!.state().state,'ready','the same classifier identity remains retryable after a notification fault');
 assert.ok((await changed()).includes('context-trees:classifier'));
 retry();assert.equal(registry.automatic!.state().state,'unavailable');
});

test('real Memory phase children expose stable extraction and review kinds without their private inputs',async t=>{
 const {store,engine,operations}=fixture(t),operationId='memory:phase-display',ids:string[]=[];
 for(const [index,phase] of ['extract','review','future-phase',undefined].entries()){
  const id='memory-phase:'+String(index+1).repeat(64);ids.push(id);let output:unknown;
  await engine.runStep({id,operationId,kind:'memory.phase',pool:'fixture',input:{...(phase?{phase}:{}),privateText:'PRIVATE_MEMORY_DRAFT',token:'PRIVATE_PROVIDER_TOKEN'},signal:new AbortController().signal,validate:()=>true,
   execute:async()=>({saved:true}),commit:value=>{output=value;},read:()=>output,project:()=>{}});
 }
 const sql:string[]=[];const prepare=store.db.prepare.bind(store.db);
 const spy=t.mock.method(store.db,'prepare',(statement:string)=>{sql.push(statement);return prepare(statement);});
 const detail=operations.detail(operationId);spy.mock.restore();
 assert.deepEqual(detail.steps.map(step=>step.kind),['memory.extract','memory.review','memory.phase.'+ids[2],'memory.phase.'+ids[3]]);
 assert.ok(detail.steps.every(step=>step.state==='succeeded'&&step.attempts===1));
 assert.doesNotMatch(JSON.stringify(detail),/PRIVATE_MEMORY_DRAFT|PRIVATE_PROVIDER_TOKEN|privateText|future-phase|"phase"|"input"/);
 const projection=sql.find(statement=>statement.includes('FROM execution_operation_steps o JOIN execution_steps'))!;
 assert.ok(projection.includes("CASE WHEN e.kind LIKE 'memory.phase.%' THEN json_extract(e.input,'$.phase') END AS phase"));assert.ok(!projection.includes('e.*'));assert.ok(!projection.includes('e.input AS'));
});
