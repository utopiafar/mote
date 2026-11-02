import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';

const id='33333333-3333-4333-8333-333333333333';
const other='44444444-4444-4444-8444-444444444444';
const record={id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated source',ocrText:'Generated staged evidence body'};
const otherRecord={...record,id:other,ocrText:'Generated second staged body'};
const reader={
  search:async({query}={})=>query==='second'?[otherRecord]:[record],
  timeline:async()=>({items:[],nextCursor:null}),
  evidence:async({ids=[]}={})=>[record,otherRecord].filter(item=>ids.includes(item.id)),
  activity:async()=>({}),
  devices:async()=>[],
};
const signal=()=>new AbortController().signal;

test('prepared bridge delivery publishes the same ledger only after confirm and drops late or discarded receipts',async t=>{
  const observedEvidence=[],observedProgress=[];
  const bridge=await startBridge(reader,{
    question:'Generated staged delivery',
    onEvidence:records=>observedEvidence.push(...records),
    onProgress:event=>observedProgress.push(event),
  });
  t.after(()=>bridge.close());

  const staged=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
  assert.equal(bridge.records.size,0,'staged body must not enter the eligible ledger');
  assert.deepEqual(bridge.deliveredRanges,[],'staged ranges must not be eligible');
  assert.deepEqual(bridge.evidenceDependencies.ids,[],'staged dependencies must not be eligible');
  assert.equal(bridge.trace.length,0,'staged trace must not be persisted');
  assert.equal(observedEvidence.length,0);
  assert.equal(observedProgress.length,0);
  assert.match(JSON.stringify(staged.value),/Generated staged evidence body/);

  staged.confirm();
  assert.equal(bridge.records.get(id).ocrText,record.ocrText);
  assert.deepEqual(bridge.records.get(id).deliveredRanges.map(range=>[range.start,range.end]),[[0,record.ocrText.length]]);
  assert.deepEqual(bridge.evidenceDependencies.ids,[id]);
  assert.equal(bridge.trace.some(entry=>entry.tool==='search_context'),true);
  assert.ok(observedEvidence.length>0);
  assert.ok(observedProgress.length>0);

  const ranges=bridge.deliveredRanges.length,current=bridge.records.size;
  staged.confirm();
  assert.equal(bridge.deliveredRanges.length,ranges,'duplicate confirm must not widen the receipt');
  assert.equal(bridge.records.size,current,'duplicate confirm must not add records');

  const second=await bridge.prepareDelivery('search_context',{query:'second'},signal());
  second.discard();
  second.discard();
  assert.equal(bridge.records.has(other),false,'discarded read must not publish');
  assert.deepEqual(bridge.deliveredRanges.some(range=>range.id===other),false);
  second.confirm();
  assert.equal(bridge.records.has(other),false,'late confirm after discard must be a no-op');
});

test('prepared bridge delivery rechecks authority and cancellation before publishing',async t=>{
  let revoked=false;
  const bridge=await startBridge(reader,{
    question:'Generated staged authority',
    assertContextAuthority:()=>{if(revoked)throw Error('Generated authority revoked');},
  });
  t.after(()=>bridge.close());
  const staged=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
  revoked=true;
  assert.throws(()=>staged.confirm(),/authority revoked/);
  assert.equal(bridge.records.size,0,'revoked confirmation must not publish');
  assert.deepEqual(bridge.deliveredRanges,[]);
  staged.discard();
  revoked=false;

  const controller=new AbortController();
  const cancelled=await bridge.prepareDelivery('search_context',{query:'second'},controller.signal);
  controller.abort();
  assert.throws(()=>cancelled.confirm(),/aborted|cancelled/i);
  assert.equal(bridge.records.has(other),false,'cancelled confirmation must not publish');
  cancelled.discard();
});

test('closing the bridge drops an unconfirmed staged read and context_evidence stages its range',async t=>{
  const contextBridge=await startBridge(reader,{
    question:'Generated staged context evidence',
    evidenceIds:[id],
    evidenceRanges:[{id,offset:0,length:5}],
    evidenceReadRanges:[{id,offset:0,length:10}],
  });
  t.after(()=>contextBridge.close());
  const baseline=contextBridge.deliveredRanges.length;
  const staged=await contextBridge.prepareDelivery('context_evidence',{id,offset:5,length:5},signal());
  assert.equal(contextBridge.deliveredRanges.length,baseline,'context_evidence staged range leaked before confirm');
  staged.confirm();
  assert.equal(contextBridge.deliveredRanges.some(range=>range.id===id&&range.offset===0&&range.length===10),true);
  assert.equal(contextBridge.records.get(id).deliveredRanges.length>=1,true);

  const closingBridge=await startBridge(reader,{question:'Generated closing staged read'});
  const pending=await closingBridge.prepareDelivery('search_context',{query:'Generated'},signal());
  await closingBridge.close();
  pending.confirm();
  assert.equal(closingBridge.records.size,0,'close must drop an unconfirmed staged read');
  assert.deepEqual(closingBridge.deliveredRanges,[]);
});
