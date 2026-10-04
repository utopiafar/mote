import {fixtureCaptureId} from './capture-fixture-id.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from '../dist/bridge.js';
import { parseAnswer } from '../dist/index.js';

const small = { id:fixtureCaptureId('synthetic-budget-0'), capturedAt:'2026-01-01T00:00:00.000Z', appName:'Synthetic fixture', ocrText:'Previously delivered original evidence.' };
const oversized = Array.from({ length:100 }, (_, index) => ({
  ...small, id:fixtureCaptureId('synthetic-budget-'+index), ocrText:'字'.repeat(2000), summary:'字'.repeat(4000),
}));
const answerFor = id => JSON.stringify({ answer:'Synthetic answer.', citationIds:[id] });
function request(bridge, tool, args) {
  return fetch(`${bridge.url}/${tool}`, {
    method:'POST', headers:{ Authorization:`Bearer ${bridge.token}`, 'Content-Type':'application/json' }, body:JSON.stringify(args),
  }).then(async response => ({ status:response.status, body:await response.json() }));
}

test('a rejected oversized result cannot authorize either citations or evidence expansion', async () => {
  let evidenceCalls = 0;
  const bridge = await startBridge({
    search:async args => args.query === 'small' ? [small] : oversized,
    timeline:async()=>({items:([]),nextCursor:null}),
    evidence:async()=>{ evidenceCalls++; return [small]; },
    activity:async()=>({}), devices:async()=>[],
  }, { question:'Synthetic budget boundary' }, 8);
  try {
    const rejected = await request(bridge, 'search_context', { limit:100 });
    assert.equal(rejected.status, 400); assert.match(rejected.body.error, /evidence budget/);
    assert.equal(bridge.records.size, 0); assert.equal(bridge.trace.length, 0);
    assert.throws(() => parseAnswer(answerFor(small.id), bridge.records), /not retrieved/);
    const expansion = await request(bridge, 'evidence', { ids:[small.id] });
    assert.equal(expansion.status, 400); assert.match(expansion.body.error, /Discover records/);
    assert.equal(evidenceCalls, 0, 'rejected results never become a discovery permission');
    assert.equal((await request(bridge, 'search_context', { query:'small' })).status, 200);
    assert.equal(parseAnswer(answerFor(small.id), bridge.records).citations[0].id, small.id);
    assert.equal((await request(bridge, 'evidence', { ids:[small.id] })).status, 200);
    assert.equal(evidenceCalls, 1, 'a later valid result can authorize normal expansion');
  } finally { await bridge.close(); }
});

test('a rejected later page cannot overwrite earlier delivered citation evidence or add new IDs', async () => {
  const bridge = await startBridge({
    search:async()=>[small], timeline:async()=>({ items:oversized, nextCursor:null }),
    evidence:async()=>[small], activity:async()=>({}), devices:async()=>[],
  }, { question:'Synthetic prior evidence preservation' }, 5);
  try {
    assert.equal((await request(bridge, 'search_context', {})).status, 200);
    const previouslyDelivered = structuredClone(bridge.records.get(small.id));
    const rejected = await request(bridge, 'timeline', { limit:100 });
    assert.equal(rejected.status, 400); assert.match(rejected.body.error, /evidence budget/);
    assert.equal(bridge.records.size, 1); assert.equal(bridge.trace.length, 1);
    assert.deepEqual(bridge.records.get(small.id), previouslyDelivered);
    assert.equal(parseAnswer(answerFor(small.id), bridge.records).citations[0].excerpt, small.ocrText);
    assert.throws(() => parseAnswer(answerFor(fixtureCaptureId('synthetic-budget-99')), bridge.records), /not retrieved/);
    assert.equal((await request(bridge, 'evidence', { ids:[fixtureCaptureId('synthetic-budget-99')] })).status, 400);
  } finally { await bridge.close(); }
});

test('successful and rejected tools expose the same host budget without granting rejected evidence', async t => {
  let searches=0;
  const bridge=await startBridge({search:async args=>{searches++;return args.query==='large'?oversized:[small];},timeline:async()=>({items:([]),nextCursor:null}),evidence:async()=>[small],activity:async()=>({}),devices:async()=>[]},{question:'Generated bounded retrieval'},4);
  t.after(()=>bridge.close());
  const initial=bridge.deliveredCharacters;
  const rejected=await request(bridge,'search_context',{query:'large',limit:100});
  assert.equal(rejected.status,400);
  assert.deepEqual(rejected.body.hostBudget,{remainingCalls:3,remainingCharactersBeforeResult:48000-initial,unit:'utf16_characters'});
  assert.equal(bridge.deliveredCharacters,initial);assert.equal(bridge.records.size,0);
  const found=await request(bridge,'search_context',{query:'small'});
  assert.equal(found.status,200);assert.equal(found.body.hostBudget.remainingCalls,2);
  assert.equal(found.body.hostBudget.remainingCharactersBeforeResult,48000-initial);
  assert.equal(bridge.deliveredCharacters,initial+JSON.stringify(found.body).length,'Budget metadata is counted in delivered text');
  const before=bridge.deliveredCharacters;
  const expanded=await request(bridge,'evidence',{ids:[small.id]});
  assert.equal(expanded.status,200);assert.equal(expanded.body.hostBudget.remainingCalls,1);
  assert.equal(expanded.body.hostBudget.remainingCharactersBeforeResult,48000-before);
  const last=await request(bridge,'search_context',{query:'small'});assert.equal(last.body.hostBudget.remainingCalls,0);
  const delivered=bridge.deliveredCharacters,count=searches;
  const denied=await request(bridge,'search_context',{query:'small'});
  assert.equal(denied.status,400);assert.equal(denied.body.toolError.code,'tool_budget_exceeded');assert.equal(denied.body.hostBudget.remainingCalls,0);
  assert.equal(searches,count);assert.equal(bridge.deliveredCharacters,delivered);
  assert.equal(parseAnswer(answerFor(small.id),bridge.records).citations[0].id,small.id,'Exhaustion does not remove already admitted evidence');
});
