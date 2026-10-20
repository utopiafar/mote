import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {Operations} from '../src/operations.js';
import {Operations as OriginalOperations} from './performance-round1-a-original-operations.fixture.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {scopedCaptureFixture} from './fixtures/scoped-capture-host.js';

test('scoped HTTP detail batches only returned steps and preserves the complete original output',async t=>{
 const f=await scopedCaptureFixture(t),host=f.host.execution!;
 host.register({kind:'generated.dependencies',pool:'generated.dependencies',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:raw=>raw as Record<string,unknown>,execute:async()=>null});
 const a=host.forUser(await f.host.authority.authenticate(f.a.token)),b=host.forUser(await f.host.authority.authenticate(f.b.token));
 // Synchronous admission and readback keep generated task state frozen before
 // the ordinary timer gets another turn. No execution/authorization is mocked.
 const deps=Array.from({length:100},(_,i)=>a.submitSync({kind:'generated.dependencies',operationId:'file:deps',input:{dep:i}}).id).reverse();
 const output=Array.from({length:105},(_,i)=>a.submitSync({kind:'generated.dependencies',operationId:'file:page',input:{step:i},dependencies:deps.slice(0,[0,1,99,100][i%4])}));
 const foreign=b.submitSync({kind:'generated.dependencies',operationId:'file:page',input:{foreign:true}});
 assert.throws(()=>a.submitSync({kind:'generated.dependencies',operationId:'file:too-many',input:{},dependencies:[...deps,deps[0]]}),/100/,'normal admission cap is unchanged');
 const db=host.engine.store.db,reference=new OriginalOperations(host.engine.store,f.a.userId),read=new Operations(host.engine.store,f.a.userId),id=output[0].operationId;
 const prepare=db.prepare.bind(db),queries:{sql:string;args:unknown[]}[]=[];
 const spy=t.mock.method(db,'prepare',(sql:string)=>{const statement=prepare(sql);if(sql.includes('FROM execution_dependencies')){const all=statement.all.bind(statement);statement.all=((...args:any[])=>{queries.push({sql,args});return all(...args);}) as typeof statement.all;}return statement;});
 for(const limit of [1,10,50,100]){
  let cursor=0;do{
   const expected=reference.detail(id,cursor,limit);queries.length=0;
   const actual=read.detail(id,cursor,limit);assert.deepEqual(actual,expected);
   assert.equal(queries.length,Math.ceil(actual.steps.length/100));
   assert.deepEqual(queries.flatMap(query=>JSON.parse(String(query.args[0]))),actual.steps.map(step=>step.id),'only returned steps, without lookahead, are bound');
   for(const query of queries){assert.match(query.sql,/WHERE step_id=step.value ORDER BY dependency_id LIMIT 100/);assert.ok(JSON.parse(String(query.args[0])).length<=100);const plan=prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.args as string[]);assert.ok(plan.some(row=>String(row.detail).includes('COVERING INDEX sqlite_autoindex_execution_dependencies_1 (step_id=?)')));}
   cursor=actual.nextCursor??0;
  }while(cursor);
 }
 assert.deepEqual(read.detail(id,Number.MAX_SAFE_INTEGER),reference.detail(id,Number.MAX_SAFE_INTEGER));
 spy.mock.restore();
 // Freeze no state across the HTTP await: capture the original result as the
 // real scoped route calls the new detail method on that same synchronous read.
 const detail=Operations.prototype.detail;
 const expectedResponses:any[]=[];
 const callSpy=t.mock.method(Operations.prototype,'detail',function(this:Operations,operationId:string,cursor?:number,limit?:number){const original=reference.detail(operationId,cursor,limit);expectedResponses.push(original);return detail.call(this,operationId,cursor,limit);});
 for(const limit of [1,50,100]){const response=await f.request(f.a.token,`/api/operations/${encodeURIComponent(id)}?limit=${limit}`);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),JSON.parse(JSON.stringify(expectedResponses.at(-1))));}
 callSpy.mock.restore();
 for(const [account,operation] of [[f.b,id],[f.a,foreign.operationId],[f.a,'file:missing']] as const)assert.equal((await f.request(account.token,'/api/operations/'+encodeURIComponent(operation))).statusCode,404);
 assert.equal((await f.request(undefined,'/api/operations/'+encodeURIComponent(id))).statusCode,401);
 const timings:{original:number[];batched:number[]}={original:[],batched:[]};
 for(let round=0;round<5;round++)for(const [name,reader] of [['original',reference],['batched',read]] as const){const start=performance.now();for(let i=0;i<20;i++)reader.detail(id,0,100);timings[name].push((performance.now()-start)/20);}
 t.diagnostic(JSON.stringify({steps:105,maxDependencies:100,timingMsPer100StepDetail:timings}));
});

test('direct reader retains per-step 100 cap, all output fields and large-page batch boundaries',async t=>{
 const db=new DatabaseSync(':memory:'),store={db,reserveMetadata:()=>{}},engine=new ExecutionEngine(store);
 t.after(async()=>{await engine.close();db.close();});
 for(const kind of ['generated','file-step.fixture','query.run.fixture','insight.run.fixture','lifecycle-window.fixture','embedding.query.fixture'])engine.register({kind,pool:'generated',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});
 const ownership={userId:'generated-a',authorizationEpoch:1,grantId:'generated-grant'};
 const deps=Array.from({length:125},(_,i)=>engine.enqueue('file:deps','generated',{i},{id:'dependency-'+String(124-i).padStart(3,'0'),ownership}));
 const kinds=['generated','file-step.fixture','query.run.fixture','insight.run.fixture','lifecycle-window.fixture','embedding.query.fixture'];
 for(let i=0;i<205;i++)engine.enqueue('file:large',kinds[i%kinds.length],{i},{ownership,dependencies:deps.slice(0,[0,1,99,100,125][i%5]),generation:{slot:'slot-'+i,version:'current'},...(i%3===0?{optional:true,initial:{state:'blocked',attempts:2,availableAt:7,error:'summary_disabled'}}:{initial:{state:'failed',attempts:3,availableAt:9,error:i%2?'invalid private error':'processor_response_unknown'}})});
 engine.enqueue('file:large','generated',{replacement:true},{ownership,generation:{slot:'slot-1',version:'replacement'}});
 for(const owner of ['generated-a',undefined]){
  const actual=new Operations(store,owner),reference=new OriginalOperations(store,owner);
  for(const [cursor,limit] of [[0,1],[0,100],[0,205],[0,600],[130,100],[Number.MAX_SAFE_INTEGER,100]])assert.deepEqual(actual.detail('file:large',cursor,limit),reference.detail('file:large',cursor,limit));
  const page=actual.detail('file:large',0,600);assert.equal(page.steps.length,206);assert.ok(page.steps.some(step=>!step.current));
  assert.ok(page.steps.some(step=>step.optional&&step.notScheduled));assert.ok(page.steps.some(step=>step.reason==='processing_failed'));
  for(const step of page.steps)assert.deepEqual(step.dependencies,[...step.dependencies].sort());
  assert.equal(Math.max(...page.steps.map(step=>step.dependencies.length)),100);
 }
 const reader=new Operations(store,'generated-a'),before=reader.detail('file:large',0,600);db.exec('BEGIN');engine.cancel(before.steps[0].id);db.exec('ROLLBACK');assert.deepEqual(reader.detail('file:large',0,600),before);
});
