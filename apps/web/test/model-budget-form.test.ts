import test from 'node:test';
import assert from 'node:assert/strict';
import {budgetDraft,budgetPayload,type ModelBudgetView} from '../src/model-budget-form.js';
const view:ModelBudgetView={revision:7,limits:{dailyTokens:null,dailyCost:null,operationTokens:null,operationCost:null,providerDailyTokens:{},providerDailyCost:{},currency:'USD'},day:'2026-09-22',timeZone:'UTC',usage:[]};
test('unlimited defaults remain null and only the edited revision and limits are sent',()=>{
 const draft=budgetDraft(view),payload=budgetPayload(draft);assert.deepEqual(payload,{revision:7,limits:view.limits});assert.equal(draft.dailyTokens,'');assert.equal('usage' in payload,false);
});
test('provider token and cost limits round trip without confusing zero with unlimited',()=>{
 const draft=budgetDraft({...view,limits:{...view.limits,dailyTokens:100000,providerDailyTokens:{generated:4500},providerDailyCost:{generated:0.5,second:1}}});assert.deepEqual(budgetPayload(draft).limits.providerDailyTokens,{generated:4500});assert.deepEqual(budgetPayload(draft).limits.providerDailyCost,{generated:0.5,second:1});
 draft.providers[0].tokens='';assert.deepEqual(budgetPayload(draft).limits.providerDailyTokens,{});for(const bad of ['0','-1','Infinity','1.5','1000000000001'])assert.throws(()=>budgetPayload({...draft,dailyTokens:bad}),/invalid_budget/);
 assert.throws(()=>budgetPayload({...draft,providers:[{id:'generated',tokens:'1',cost:''},{id:' generated ',tokens:'2',cost:''}]}),/invalid_provider/);
});
test('provider identifiers are data even when they name a JavaScript prototype property',()=>{const draft=budgetDraft(view);draft.providers=[{id:'__proto__',tokens:'42',cost:''}];assert.equal(JSON.stringify(budgetPayload(draft).limits.providerDailyTokens),'{"__proto__":42}');assert.equal(({} as any).tokens,undefined);});
