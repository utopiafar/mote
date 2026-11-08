import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {InsightRuns} from '../src/insight-runs.js';
import {Operations} from '../src/operations.js';
import {ImportStore} from '../src/imports.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {linkOperationParent} from '../src/operation-projection.js';
import {safeError} from '../src/diagnostics.js';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'mote-operation-runs-')),store=new Store(directory),executor=new ExecutionEngine(store);t.after(async()=>{await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,executor,operations:new Operations(store)};}

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

test('reopening the same vault installs each operation projection trigger once and keeps progress exact',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-operation-projection-'));
 let store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const triggers=['operation_link_added','operation_link_changed','operation_link_removed','operation_step_changed','operation_step_removed','operation_memory_changed','operation_memory_removed','operation_changed','operation_created','operation_changes_bounded','operation_child_added','operation_child_changed','operation_child_removed'];
 const progress=()=>store.db.prepare("SELECT total,waiting,not_scheduled FROM operation_progress WHERE id='generated:projection'").get();
 for(let open=1;open<=3;open++){
  const executor=new ExecutionEngine(store);
  for(const name of triggers)assert.equal(Number(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.n),1,`${name} must be installed once`);
  assert.equal(store.db.prepare("SELECT 1 FROM settings WHERE key='operation-projection-version'").get(),undefined);
  if(open===1){
   executor.register({kind:'fixture.projection',pool:'generated',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
   executor.enqueue('generated:projection','fixture.projection',{});
  }
  assert.deepEqual({...progress()},{total:1,waiting:1,not_scheduled:0});
  await executor.close();
  if(open<3){store.close();store=new Store(directory);}
 }
});

test('insight cancellation fences results and close after engine shutdown does not strand waiters',async t=>{
 const {store,executor,operations}=fixture(t),runs=new InsightRuns(store,{executor});let release!:()=>void,signal!:AbortSignal;
 const id=randomUUID();runs.start(id,{},async(_observe,current)=>{signal=current;await new Promise<void>(resolve=>release=resolve);return {answer:'Generated late report',citations:[],trace:[],runId:randomUUID()};});await turn();
 await executor.close();await runs.close();assert.equal(signal.aborted,true);assert.equal(runs.get(id).error?.code,'interrupted');assert.equal(operations.detail(`insight:${id}`).operation.state,'failed');release();await turn();assert.equal(runs.get(id).resultRunId,undefined);
});
