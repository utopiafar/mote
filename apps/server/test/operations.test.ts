import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {ExecutionEngine,type ExecutionHandler} from '../src/execution-engine.js';
import {Operations,registerOperations} from '../src/operations.js';
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
test('pre-projection databases recover current file and independent perception generations without losing history',async t=>{
 const {store,start,operations}=fixture(t,true);store.db.exec(`CREATE TABLE execution_steps(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,kind TEXT NOT NULL,pool TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,fence TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE execution_operation_steps(operation_id TEXT NOT NULL,step_id TEXT NOT NULL REFERENCES execution_steps(id) ON DELETE CASCADE,PRIMARY KEY(operation_id,step_id));`);
 const add=(id:string,operation:string,kind:string,input:unknown,state:string,error:string|null=null)=>{store.db.prepare('INSERT INTO execution_steps(id,operation_id,kind,pool,input,state,error,created_at,updated_at) VALUES(?,?,?,\'fixture\',?,?,?,?,?)').run(id,operation,kind,JSON.stringify(input),state,error,100,200);store.db.prepare('INSERT INTO execution_operation_steps VALUES(?,?)').run(operation,id);};
 add('old','file:a','files.pipeline',{revision:'old'},'cancelled');add('old-child','file:a','file-step.abc',{},'failed');add('new','file:a','files.pipeline',{revision:'new'},'succeeded');add('new-child','file:a','file-step.def',{},'succeeded');add('summary','file:a','files.summary',{revision:'new'},'blocked','summary_disabled');
 add('ocr-old','capture:a','perception.ocr',{kind:'ocr',configRevision:'old'},'cancelled');add('semantic','capture:a','perception.semantic',{kind:'semantic',configRevision:'semantic'},'succeeded');add('ocr-new','capture:a','perception.ocr',{kind:'ocr',configRevision:'new'},'succeeded');start();
 assert.equal(operations.detail('file:a').operation.state,'succeeded');assert.equal(operations.detail('file:a').operation.total,3);assert.equal(operations.detail('file:a').operation.notScheduled,1);assert.equal(operations.detail('file:a').steps.length,5);
 assert.equal(operations.detail('capture:a').operation.state,'succeeded');assert.equal(operations.detail('capture:a').operation.total,2);assert.equal(operations.detail('capture:a').steps.length,3);
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
 // Simulate the old persisted counter projection, leaving source receipts intact.
 store.db.prepare("DELETE FROM settings WHERE key='operation-optional-terminal-v2'").run();store.db.prepare("UPDATE operation_progress SET failed=1 WHERE id='query:complete'").run();
 const restored=new ExecutionEngine(store);await restored.close();assert.equal(operations.detail('query:complete').operation.state,'succeeded');assert.equal(operations.detail('query:complete').operation.optionalIssues,1);
 engine.retry(optional);await engine.drain([optional]);detail=operations.detail('query:complete');assert.equal(detail.operation.optionalIssues,0);assert.equal(detail.operation.counts.succeeded,2);assert.equal(operations.detail('embedding:standalone').operation.state,'succeeded');
});
