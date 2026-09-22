import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {QueryRuns} from '../src/query-runs.js';
import {InsightRuns} from '../src/insight-runs.js';
import {Operations} from '../src/operations.js';
import {ImportStore} from '../src/imports.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {linkOperationParent} from '../src/operation-projection.js';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'mote-operation-runs-')),store=new Store(directory),executor=new ExecutionEngine(store);t.after(async()=>{await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,executor,operations:new Operations(store)};}

test('queries share engine state, expire while queued, and reject late completion after cancellation',async t=>{
 const {store,executor,operations}=fixture(t),runs=new QueryRuns(store,{executor,concurrency:()=>1});
 let release!:()=>void,started=false,secondCalls=0;
 const first=randomUUID(),second=randomUUID();
 runs.start(first,{question:'generated private question'},async()=>{started=true;await new Promise<void>(resolve=>release=resolve);return {conversationId:'late-private-result',turnId:randomUUID()};});
 await turn();assert.equal(started,true);assert.equal(operations.detail(`query:${first}`).operation.state,'running');
 runs.start(second,{question:'queued fixture'},async()=>{secondCalls++;return {conversationId:randomUUID(),turnId:randomUUID()};},{timeoutMs:10});
 assert.equal(runs.get(second).execution?.status,'queued');await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(runs.get(second).status,'failed');assert.equal(runs.get(second).error?.code,'timeout');assert.equal(operations.detail(`query:${second}`).operation.state,'failed');assert.equal(secondCalls,0);
 runs.cancel(first);release();await runs.close();assert.equal(runs.get(first).status,'cancelled');assert.equal(runs.get(first).conversationId,undefined);
 assert.equal(operations.detail(`query:${first}`).operation.state,'cancelled');assert.doesNotMatch(JSON.stringify(operations.page())+JSON.stringify(operations.detail(`query:${first}`)),/private/);
 assert.deepEqual(store.db.prepare('SELECT input FROM execution_steps WHERE kind LIKE ?').all('query.run.%').map(row=>JSON.parse(String(row.input)).runId).sort(),[first,second].sort());
});

test('legacy query and insight receipts migrate once without replaying work or losing historical dates',async t=>{
 const {store,executor,operations}=fixture(t),at='2025-08-18T00:00:00.000Z';
 store.db.exec('CREATE TABLE query_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE insight_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,json TEXT NOT NULL)');
 for(const [table,id,status] of [['query_runs','old-done','completed'],['query_runs','old-running','running'],['insight_runs','old-report','completed']])store.db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(id,'generated-hash',JSON.stringify({id,status,createdAt:at,updatedAt:at,events:[],scope:{}}));
 const queries=new QueryRuns(store,{executor}),insights=new InsightRuns(store,{executor});await executor.tick();
 assert.equal(queries.get('old-running').error?.code,'interrupted');assert.equal(operations.detail('query:old-running').operation.state,'failed');assert.equal(operations.detail('query:old-done').operation.state,'succeeded');assert.equal(insights.get('old-report').operationId,'insight:old-report');
 assert.equal(Number(store.db.prepare('SELECT created_at FROM execution_steps WHERE id=?').get('query:old-done')!.created_at),Date.parse(at));assert.equal(operations.page().items.length,3);
 await queries.close();await insights.close();
});

test('one import links originals to later engine work and generation changes atomically',async t=>{
 const {store,executor,operations}=fixture(t),sources=new SourceStore(store),files=new ArchivedFileStore(store),imports=new ImportStore(store,files,sources,{executor});
 const job=await imports.create({processing:'automatic',files:[{name:'generated-one.txt',dataBase64:Buffer.from('Generated first original').toString('base64')},{name:'generated-two.txt',dataBase64:Buffer.from('Generated second original').toString('base64')}]});
 const completed=await imports.prepare(job.id);assert.equal(completed.status,'completed');assert.equal(completed.captureIds.length,2);const operation=`import:${job.id}`;
 assert.equal(operations.detail(operation).operation.counts.succeeded,2);
 executor.register({kind:'fixture.capture',pool:'generated',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
 const capture=completed.captureIds[0],old=executor.enqueue(`capture:${capture}`,'fixture.capture',{revision:'old'},{generation:{slot:'ocr',version:'old'},initial:{state:'failed',attempts:1,availableAt:0,error:'generated_failure'}});
 assert.equal(operations.detail(operation).operation.state,'failed');const change=operations.page().changeCursor;
 store.db.exec('BEGIN');const rolledBack=executor.enqueue(`file:${completed.captureIds[1]}`,'fixture.capture',{rollback:true});store.db.exec('ROLLBACK');assert.equal(executor.get(rolledBack),undefined);assert.deepEqual(operations.changes(change).ids,[]);
 const current=executor.enqueue(`capture:${capture}`,'fixture.capture',{revision:'new'},{generation:{slot:'ocr',version:'new'}});await executor.drain([current]);
 const detail=operations.detail(operation);assert.equal(detail.operation.state,'succeeded');assert.equal(detail.operation.counts.succeeded,3);assert.equal(detail.steps.find(step=>step.id===old)?.current,false);assert.equal(detail.steps.find(step=>step.id===current)?.current,true);
 assert.throws(()=>linkOperationParent(store,`capture:${capture}`,operation),/cycle/);
 assert.equal(imports.get(job.id).operationId,operation);
});

test('insight cancellation fences results and close after engine shutdown does not strand waiters',async t=>{
 const {store,executor,operations}=fixture(t),runs=new InsightRuns(store,{executor});let release!:()=>void,signal!:AbortSignal;
 const id=randomUUID();runs.start(id,{},async(_observe,current)=>{signal=current;await new Promise<void>(resolve=>release=resolve);return {answer:'Generated late report',citations:[],trace:[],runId:randomUUID()};});await turn();
 await executor.close();await runs.close();assert.equal(signal.aborted,true);assert.equal(runs.get(id).error?.code,'interrupted');assert.equal(operations.detail(`insight:${id}`).operation.state,'failed');release();await turn();assert.equal(runs.get(id).resultRunId,undefined);
});


test('a second connection cannot interrupt or claim live owner interactive work',async t=>{
 const {store,executor,operations}=fixture(t),first=new QueryRuns(store,{executor,concurrency:()=>1});
 let release!:()=>void,calls=0;const running=randomUUID(),queued=randomUUID();
 first.start(running,{},async()=>{await new Promise<void>(resolve=>release=resolve);return {conversationId:randomUUID(),turnId:randomUUID()};});
 first.start(queued,{},async()=>{calls++;return {conversationId:randomUUID(),turnId:randomUUID()};});await turn();
 const otherStore=new Store(store.directory),otherEngine=new ExecutionEngine(otherStore),other=new QueryRuns(otherStore,{executor:otherEngine});
 await otherEngine.tick();assert.equal(other.get(running).status,'running');assert.equal(other.get(queued).execution?.status,'queued');assert.equal(calls,0);assert.equal(operations.detail(`query:${running}`).operation.state,'running');
 release();await first.close();assert.equal(calls,1);assert.equal(other.get(queued).status,'completed');await other.close();await otherEngine.close();otherStore.close();
});
