import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge } from '../dist/bridge.js';
import { parseAnswer } from '../dist/index.js';

const small = { id:'synthetic-budget-0', capturedAt:'2026-01-01T00:00:00.000Z', appName:'Synthetic fixture', ocrText:'Previously delivered original evidence.' };
const oversized = Array.from({ length:100 }, (_, index) => ({
  ...small, id:`synthetic-budget-${index}`, ocrText:'字'.repeat(2000), summary:'字'.repeat(4000),
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
    timeline:async()=>[],
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
    assert.throws(() => parseAnswer(answerFor('synthetic-budget-99'), bridge.records), /not retrieved/);
    assert.equal((await request(bridge, 'evidence', { ids:['synthetic-budget-99'] })).status, 400);
  } finally { await bridge.close(); }
});
