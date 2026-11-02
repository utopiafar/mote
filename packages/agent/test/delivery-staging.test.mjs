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

test('discarded staged reads do not leak private evidence layers through close',async t=>{
  const observed=[];
  const bridge=await startBridge(reader,{question:'Generated discarded layer',onEvidence:records=>observed.push(...records)});
  let closed=false;t.after(async()=>{if(!closed)await bridge.close();});
  const staged=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
  staged.discard();
  await bridge.close();closed=true;
  assert.deepEqual(observed,[],'the private layer ledger must be restored with the public records map');
});

test('discarded capability discovery cannot authorize a later execute',async()=>{
  const bridge=await startBridge({...reader,mediaActivity:async()=>({observations:1})},{question:'Generated staged capability',deviceId:'selected'},12);
  try{
    const discovery=await bridge.prepareDelivery('capability_discover',{name:'media_activity'},signal());
    discovery.discard();
    await assert.rejects(
      bridge.prepareDelivery('capability_execute',{name:'media_activity',version:'1',argumentsJson:'{}'},signal()),
      /Discover this exact registered capability/,
    );
  }finally{await bridge.close();}
});

test('discarding a staged image releases its reservation for a fresh staged read',async()=>{
  const imageId='55555555-5555-4555-8555-555555555555';
  const imageReader={...reader,readImage:async()=>({mimeType:'image/png',data:'Zml4dHVyZQ=='})};
  const bridge=await startBridge(imageReader,{
    question:'Generated staged image',
    directImages:[{id:imageId,name:'Generated image',mimeType:'image/png',hash:'a'.repeat(64),sizeBytes:7}],
  },8);
  try{
    const first=await bridge.prepareDelivery('read_image',{id:imageId},signal());
    first.discard();
    const second=await bridge.prepareDelivery('read_image',{id:imageId},signal());
    assert.equal(second.value.image.data,'Zml4dHVyZQ==');
    second.discard();
  }finally{await bridge.close();}
});

test('in-flight preparation does not expose staged records through the public bridge or close callback',async()=>{
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const blocking={...reader,search:async()=>{entered();await gate;return [record];}};
  const observed=[];
  const bridge=await startBridge(blocking,{question:'Generated in-flight staging',onEvidence:records=>observed.push(...records)});
  try{
    const pending=bridge.prepareDelivery('search_context',{query:'Generated'},signal());
    await started;
    assert.equal(bridge.records.size,0,'public records must stay pre-state while the read awaits');
    assert.deepEqual(bridge.deliveredRanges,[]);
    assert.equal(bridge.trace.length,0);
    release();
    const staged=await pending;
    assert.equal(bridge.records.size,0,'staged records remain hidden before confirm');
    staged.discard();
    await bridge.close();
    assert.deepEqual(observed,[],'close must not publish undelivered evidence');
  }finally{await bridge.close().catch(()=>{});}
});
