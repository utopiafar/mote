import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {ModelBudgets} from '../src/model-budgets.js';
const price={provider:'fixture',model:'fixture',currency:'USD' as const,input:1,output:2,cacheRead:0.5,cacheWrite:1};
const request=(id:string,operationId='one')=>({id,operationId,provider:'fixture',model:'fixture',inputTokens:100,outputTokens:50,price});
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-budgets-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,budgets:new ModelBudgets(store)};}
const code=(name:string)=>(error:any)=>error?.details?.code===name;
test('a cross-midnight run keeps its admission day; a new run uses the new day without losing operation totals',t=>{
 const f=fixture(t);let now=Date.parse('2026-09-21T23:59:59Z');const b=new ModelBudgets(f.store,()=>now);
 b.configure({revision:0,limits:{dailyTokens:300,operationTokens:450}});b.reserve(request('long'));
 now+=2000;b.reserve(request('long'));assert.equal(b.view().usage.length,0,'same run charged to first admission day');b.reserve(request('new'));assert.equal(b.view().usage[0].tokens,150);
 assert.throws(()=>b.reserve(request('overflow')),code('model_token_budget'));
 b.finish('long',{requests:2,reportedRequests:1,inputTokens:10,outputTokens:10,totalTokens:20},price);
 assert.equal(f.store.db.prepare('SELECT tokens FROM model_budget_reservations WHERE id=?').get('long')?.tokens,300,'partial usage cannot release the reservation');
});
test('two hosts cannot reserve the same daily or operation balance; retries and review spend it too',t=>{
 const f=fixture(t),second=new Store(f.dir),other=new ModelBudgets(second);t.after(()=>second.close());f.budgets.configure({revision:0,limits:{dailyTokens:450,operationTokens:300}});
 f.budgets.reserve(request('extract'));other.reserve(request('review'));assert.throws(()=>f.budgets.reserve(request('retry')),code('model_token_budget'));other.reserve(request('other','two'));assert.throws(()=>other.reserve(request('overflow','three')),code('model_token_budget'));
 assert.equal(f.budgets.view().usage[0].tokens,450);
});
test('reported settlement releases excess; unknown or interrupted usage retains reservations',t=>{
 const f=fixture(t);f.budgets.configure({revision:0,limits:{dailyTokens:200}});f.budgets.reserve(request('a'));f.budgets.finish('a',{requests:1,reportedRequests:1,inputTokens:20,outputTokens:10,totalTokens:30,cacheReadTokens:0,cacheWriteTokens:0},price);
 f.budgets.reserve(request('b'));f.budgets.finish('b');assert.equal(f.budgets.view().usage[0].tokens,180);assert.equal(f.budgets.view().usage[0].unknown,1);assert.throws(()=>f.budgets.reserve(request('c')),code('model_token_budget'));
 f.budgets.finish('a',undefined);assert.equal(f.budgets.view().usage[0].tokens,180,'settlement is idempotent');
});
test('cost caps fail closed without pricing and apply provider/day/operation limits',t=>{
 const f=fixture(t);f.budgets.configure({revision:0,limits:{dailyCost:1,providerDailyCost:{fixture:0.0003}}});assert.throws(()=>f.budgets.reserve({...request('unpriced'),price:undefined}),code('budget_price_required'));
 f.budgets.reserve(request('a'));assert.throws(()=>f.budgets.reserve(request('b','two')),code('model_cost_budget'));assert.throws(()=>f.budgets.configure({revision:0,limits:{}}),{statusCode:409});assert.throws(()=>f.budgets.requireBoundedRuntime(),code('budget_unbounded_runtime'));
});
