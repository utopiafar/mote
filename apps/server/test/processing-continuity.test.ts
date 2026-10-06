import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ProcessingRuntime,type ProcessingLane} from '../src/processing-runtime.js';
import {removeRetiredBudgetState,resumeRetiredBudgetWork} from '../src/retired-budget-migration.js';
import {UsageLedger} from '../src/usage.js';
import {linkOperationParent} from '../src/operation-projection.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';

const lanes:ProcessingLane[]=['extract','aggregate','semantic','memory'];
const observation=(text='Generated evidence')=>({id:randomUUID(),deviceId:'generated',deviceName:'Generated',platform:'import',capturedAt:'2026-10-05T00:00:00Z',durationMs:0,source:'note',appName:'Fixture',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-continuity-')),store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;
}

test('semantic and memory lanes continue beyond both former daily allowances across midnight',async t=>{
  const store=fixture(t);let now=Date.parse('2026-10-05T23:59:59Z');
  const runtime=new ProcessingRuntime(store,[],{semantic:{concurrency:2},memory:{concurrency:2}},()=>now);t.after(()=>runtime.close());
  const record=observation('G'.repeat(12000));await store.ingest(record);
  const calls={semantic:0,memory:0},active={semantic:0,memory:0},peak={semantic:0,memory:0};
  for(const lane of ['semantic','memory'] as const){
    runtime.registry.register({id:'fixture.'+lane,version:'1',lane,async process(input){
      calls[lane]++;active[lane]++;peak[lane]=Math.max(peak[lane],active[lane]);
      assert.equal(input.observations[0].ocrText.length,12000);await new Promise(resolve=>setImmediate(resolve));active[lane]--;
      return [{kind:'generated',text:'Complete',metadata:{}}];
    }});
    for(let index=0;index<105;index++)runtime.enqueue([{name:'s',processor:'fixture.'+lane,inputs:[record.id],config:{index}}]);
  }
  for(let i=0;i<10&&calls.semantic+calls.memory<210;i++)await runtime.tick();
  assert.deepEqual(calls,{semantic:105,memory:105});assert.deepEqual(peak,{semantic:2,memory:2});
  assert.equal(store.db.prepare("SELECT count(*) n FROM processing_jobs WHERE state!='succeeded'").get()!.n,0);
  now+=2000;
  runtime.enqueue([{name:'next',processor:'fixture.semantic',inputs:[record.id],config:{index:105}}]);await runtime.tick();assert.equal(calls.semantic,106);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='processing_usage'").get(),undefined);
});

test('upgrade removes allowance state, keeps usage and prices, and preserves explicitly paused lanes',async t=>{
  const store=fixture(t),usage=new UsageLedger(store);
  const price={provider:'fixture',model:'fixture',currency:'USD',input:1,output:2,cacheRead:1,cacheWrite:1};usage.setPrice(price);
  const meter=usage.start('fixture','fixture','query');meter.update({requests:1,reportedRequests:1,inputTokens:10,outputTokens:5,totalTokens:15,cacheReadTokens:0,cacheWriteTokens:0});meter.finish('completed');
  const beforeUsage=store.db.prepare('SELECT * FROM model_usage').all(),beforePrices=store.db.prepare('SELECT * FROM model_prices').all();
  const policies=Object.fromEntries(lanes.map(lane=>[lane,{concurrency:lane==='semantic'?3:1,dailyCalls:lane==='memory'?0:100,dailyInputCharacters:lane==='aggregate'?0:1200000}]));
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('processing-policy',JSON.stringify(policies));store.db.prepare('INSERT INTO settings VALUES(?,?)').run('model-budgets',JSON.stringify({revision:3,limits:{dailyTokens:1,operationCost:1}}));
  for(const table of ['processing_usage','model_budget_usage','model_budget_attempts','model_budget_reservations']){store.db.exec(`CREATE TABLE ${table}(id TEXT); INSERT INTO ${table} VALUES('generated');`);store.db.prepare('INSERT INTO storage_ledger VALUES(?,?)').run(table,123);}
  removeRetiredBudgetState(store);removeRetiredBudgetState(store);
  const runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());
  assert.deepEqual(runtime.settings(),{extract:{concurrency:1,enabled:true},aggregate:{concurrency:1,enabled:false},semantic:{concurrency:3,enabled:true},memory:{concurrency:1,enabled:false}});
  assert.equal(store.db.prepare("SELECT 1 FROM settings WHERE key='model-budgets'").get(),undefined);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'model_budget_%' OR name='processing_usage'").get()!.n,0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM storage_ledger WHERE name LIKE 'model_budget_%' OR name='processing_usage'").get()!.n,0);
  assert.deepEqual(store.db.prepare('SELECT * FROM model_usage').all(),beforeUsage);assert.deepEqual(store.db.prepare('SELECT * FROM model_prices').all(),beforePrices);
});

test('restart wakes budget waits without replaying completed or cancelled work and still fences changed inputs',async t=>{
  const store=fixture(t),record=observation();await store.ingest(record);let calls=0;
  const processor={id:'fixture.resume',version:'1',lane:'semantic' as const,async process(){calls++;return [{kind:'generated',text:'Done',metadata:{}}];}};
  const original=new ProcessingRuntime(store);original.registry.register(processor);
  const enqueue=(index:number)=>original.enqueue([{name:'s',processor:processor.id,inputs:[record.id],config:{index}}]).s;
  const completed=enqueue(0);await original.tick();const daily=enqueue(1),oversize=enqueue(2),cancelled=enqueue(3),stale=enqueue(4);
  for(const [id,code,state] of [[daily,'daily_budget','waiting'],[oversize,'input_budget','blocked'],[stale,'daily_budget','waiting']] as const){store.db.prepare('UPDATE execution_steps SET state=?,error=?,available_at=?,attempts=2,recovery_deadline=1 WHERE id=?').run(state,code,Date.now()+86400000,id);original.engine.project(id);}
  original.cancel(cancelled);await original.close();
  const reopened=new ProcessingRuntime(store);reopened.registry.register(processor);t.after(()=>reopened.close());
  resumeRetiredBudgetWork(store,reopened.engine);
  assert.equal(reopened.engine.get(daily)?.availableAt,0);assert.equal(reopened.engine.get(daily)?.attempts,2);
  assert.equal(reopened.engine.get(oversize)?.state,'waiting');assert.equal(reopened.engine.get(completed)?.state,'succeeded');assert.equal(reopened.engine.get(cancelled)?.state,'cancelled');
  // Only one restored input is changed; the others still execute normally.
  store.db.prepare('UPDATE processing_jobs SET json=json_set(json,\'$.inputs[0].fingerprint\',\'generated-stale\') WHERE id=?').run(stale);
  await reopened.tick();assert.equal(calls,3);assert.equal(reopened.engine.get(daily)?.state,'succeeded');assert.equal(reopened.engine.get(oversize)?.state,'succeeded');assert.equal(reopened.engine.get(stale)?.state,'stale');assert.equal(reopened.engine.get(daily)?.attempts,3);
  const snapshot=store.db.prepare('SELECT id,state,attempts,available_at,error FROM execution_steps ORDER BY id').all();resumeRetiredBudgetWork(store,reopened.engine);assert.deepEqual(store.db.prepare('SELECT id,state,attempts,available_at,error FROM execution_steps ORDER BY id').all(),snapshot);
});

test('budget recovery preserves paused Memory parents and clears linked lifecycle waits',async t=>{
  const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());
  store.db.exec('CREATE TABLE IF NOT EXISTS memory_lifecycle_state(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  store.db.prepare('INSERT INTO memory_jobs(id,created_at,json) VALUES(?,?,?)').run('paused-job','2026-10-05T00:00:00Z',JSON.stringify({status:'paused'}));
  const engine=runtime.engine;engine.register({kind:'fixture.parent',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>undefined,commit:()=>{}});
  const paused=engine.enqueue('memory:paused-job','fixture.parent',{jobId:'paused-job'},{id:'paused-parent'});
  const record=observation();await store.ingest(record);runtime.registry.register({id:'fixture.child',version:'1',lane:'semantic',async process(){return [{kind:'generated',text:'Done',metadata:{}}];}});
  const child=runtime.enqueue([{name:'s',processor:'fixture.child',inputs:[record.id]}],{stepId:paused,fence:'old-grant'}).s;
  store.db.prepare("UPDATE execution_steps SET error='daily_budget',available_at=12345 WHERE id IN (?,?)").run(paused,child);
  engine.project(child);
  const free=runtime.enqueue([{name:'s',processor:'fixture.child',inputs:[record.id],config:{free:true}}]).s;
  store.db.prepare("UPDATE execution_steps SET error='daily_budget',available_at=12345 WHERE id=?").run(free);engine.project(free);
  linkOperationParent(store,'workflow:lifecycle:generated-window',engine.get(free)!.operationId);
  store.db.prepare('INSERT INTO memory_lifecycle_state VALUES(?,?)').run('extraction',JSON.stringify({active:{id:'generated-window'},error:'daily_budget',retryAt:12345,cursor:7,failures:0}));
  store.db.prepare('INSERT INTO memory_lifecycle_state VALUES(?,?)').run('cancelled',JSON.stringify({cancelled:true,error:'daily_budget',retryAt:12345,cursor:9}));
  resumeRetiredBudgetWork(store,engine);
  assert.equal(engine.get(paused)?.availableAt,12345);assert.equal(engine.get(child)?.availableAt,12345);assert.equal(engine.get(free)?.availableAt,0);
  const lifecycle=JSON.parse(String(store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='extraction'").get()!.json));assert.equal(lifecycle.retryAt,undefined);assert.equal(lifecycle.cursor,7);
  assert.equal(JSON.parse(String(store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='cancelled'").get()!.json)).retryAt,12345);
});

test('restored Memory batches refresh job progress and retain completed checkpoints',async t=>{
  const store=fixture(t),sources=new SourceStore(store),memories=new MemoryStore(store);
  sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
  const record=await sources.upsert('generated',{externalId:'note',revision:'1',observedAt:'2026-10-05T00:00:00Z',kind:'file',layer:'original',text:'G'.repeat(600)});
  let configured=true,calls=0;
  const options={store,memories,batchCharacters:256,model:()=> 'fixture',configured:()=>configured,query:async()=>{calls++;if(calls===1)configured=false;return {runId:randomUUID(),answer:'{"memories":[]}',citations:[],trace:[]};}};
  let pipeline=fixtureMemoryPipeline(options),job=pipeline.create({evidenceIds:[record.id]});
  job=await pipeline.run(job.id);assert.equal(job.completedBatches,1);assert.equal(job.totalBatches,3);
  const completed=job.batches[0].id,checkpoints=store.db.prepare('SELECT * FROM memory_checkpoints').all();
  await pipeline.close();
  for(const [index,batch] of job.batches.entries())if(index>0){store.db.prepare("UPDATE execution_steps SET state=?,error=?,available_at=? WHERE id=?").run(index===1?'waiting':'blocked',index===1?'daily_budget':'model_cost_budget',Date.now()+86400000,batch.id);}
  store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','waiting_for_model','$.errorCode','model_cost_budget','$.availableAt',?) WHERE id=?").run(Date.now()+86400000,job.id);
  configured=true;pipeline=fixtureMemoryPipeline(options);t.after(()=>pipeline.close());
  resumeRetiredBudgetWork(store,pipeline.engine);
  const restored=pipeline.get(job.id);assert.equal(restored.status,'queued');assert.equal(restored.errorCode,undefined);assert.equal(restored.availableAt,undefined);
  assert.equal(pipeline.engine.get(completed)?.state,'succeeded');assert.deepEqual(store.db.prepare('SELECT * FROM memory_checkpoints').all(),checkpoints);
  const done=await pipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(done.completedBatches,3);assert.equal(calls,3);
});
