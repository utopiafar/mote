import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {snapshotHostEvidence} from '../dist/host/output.js';
import {parseAnswer} from '../dist/answer-parser.js';
import sharp from 'sharp';
import {generatedImageRead,digest} from './image-region-fixture.mjs';

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

test('an image ACK received during staging keeps its evidence receipt after discard',async()=>{
  const imageId='66666666-6666-4666-8666-666666666666';
  let entered,release;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const imageReader={...reader,readImage:async()=>({mimeType:'image/png',data:'Zml4dHVyZQ=='}),search:async()=>{entered();await gate;return [record];}};
  const bridge=await startBridge(imageReader,{question:'Generated ack during staging',directImages:[{id:imageId,name:'Generated image',mimeType:'image/png',hash:'a'.repeat(64),sizeBytes:7}]},8);
  try{
    const response=await fetch(bridge.url+'/read_image',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({id:imageId})});
    assert.equal(response.status,200);
    const image=await response.json();
    const token=image.imageDelivery;
    assert.equal(typeof token,'string');
    const pending=bridge.prepareDelivery('search_context',{query:'Generated'},signal());
    await started;
    bridge.imageDelivery(token,true);
    release();
    const staged=await pending;
    staged.discard();
    assert.equal(bridge.records.has(imageId),true,'ACKed image evidence must survive staged discard');
    assert.equal(bridge.evidenceDependencies.ids.includes(imageId),true);
  }finally{await bridge.close().catch(()=>{});}
});

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function httpTool(bridge,tool,args){
  const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});
  return {status:response.status,value:await response.json()};
}

test('cached canonical references and iterators never expose a private stage',async t=>{
  const bridge=await startBridge(reader,{question:'Generated cached Host snapshot'});t.after(()=>bridge.close());
  const records=bridge.records,get=records.get.bind(records),iterator=records.values(),trace=bridge.trace;
  const a=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
  try{
    assert.equal(get(id),undefined,'a previously cached getter must not see staged text');
    assert.equal(iterator.next().done,true,'an existing iterator must not see staged insertion');
    assert.equal(trace.length,0,'a cached trace must stay canonical');
    const snapshot=snapshotHostEvidence(bridge);
    assert.equal(snapshot.records.size,0);
  }finally{a.discard();}
});

test('a real HTTP writer queued behind a stage retains its exact receipt after discard or confirm',async t=>{
  for(const confirm of [false,true]){
    const observed=[];
    const bridge=await startBridge(reader,{question:'Generated HTTP interleaving',onEvidence:records=>observed.push(records)});
    let closing;const close=()=>closing??=bridge.close();t.after(close);
    const a=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
    const b=httpTool(bridge,'search_context',{query:'second'});
    // The bounded race lets the old unprotected HTTP producer complete before
    // discard on the broken baseline; the fixed writer stays queued until A ends.
    await Promise.race([b,new Promise(resolve=>setTimeout(resolve,40))]);
    confirm?a.confirm():a.discard();
    assert.equal((await b).status,200);
    assert.equal(bridge.records.get(other).ocrText,otherRecord.ocrText);
    assert.equal(bridge.records.has(id),confirm);
    assert.deepEqual(new Set(bridge.evidenceDependencies.ids),new Set(confirm?[id,other]:[other]));
    const beforeClose=observed.length;await close();
    assert.equal(observed.length,beforeClose+1,'close still publishes one canonical evidence snapshot');
    assert.deepEqual(new Set(observed.at(-1).map(record=>record.id)),new Set(confirm?[id,other]:[other]));
  }
});

async function pixelFixture(t){
  const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#4488cc'}}).png().toBuffer();
  const imageReader={...reader,readImage:args=>generatedImageRead(bytes,args)};
  const bridge=await startBridge(imageReader,{question:'Generated image staging proof',directImages:[{id,name:'Generated pixels',mimeType:'image/png',hash:digest(bytes),sizeBytes:bytes.length}]},20);
  t.after(()=>bridge.close());return {bridge,bytes};
}

test('discarded search text cannot become the body of an independently acknowledged image ID',async t=>{
  const {bridge}=await pixelFixture(t);
  const image=(await httpTool(bridge,'read_image',{id})).value;
  const a=await bridge.prepareDelivery('search_context',{query:'Generated'},signal());
  bridge.imageDelivery(image.imageDelivery,true);a.discard();
  assert.equal(bridge.records.get(id).ocrText,'');
  const answer=parseAnswer(JSON.stringify({answer:`Generated visual evidence [${id}]`,citationIds:[id]}),bridge.records);
  assert.doesNotMatch(answer.citations[0].excerpt,/staged evidence body/);
  assert.equal(bridge.imageReadReceipts.length,1);
});

test('discarded image view never enters the proof of an existing pixel delivery',async t=>{
  const {bridge,bytes}=await pixelFixture(t);
  const image=(await httpTool(bridge,'read_image',{id})).value;bridge.imageDelivery(image.imageDelivery,true);
  const receipts=structuredClone(bridge.imageReadReceipts);
  const a=await bridge.prepareDelivery('read_image',{id,expectedImageSha256:digest(bytes),region:{x:0,y:0,width:4,height:4}},signal());
  assert.equal(a.value.imageDisclosure.status,'already_disclosed','generated full-size crop reuses the exact delivered pixels');
  a.discard();
  assert.deepEqual(bridge.imageReadReceipts,receipts);
});

test('aborting an in-flight stage releases the writer and a late read cannot overwrite HTTP evidence',async t=>{
  const entered=deferred(),release=deferred();
  const bridge=await startBridge({...reader,search:async({query})=>{if(query==='Generated'){entered.resolve();await release.promise;return [record];}return [otherRecord];}},{question:'Generated abort window'});
  t.after(()=>bridge.close());
  const controller=new AbortController(),a=bridge.prepareDelivery('search_context',{query:'Generated'},controller.signal);void a.catch(()=>{});
  await entered.promise;controller.abort();
  assert.equal((await httpTool(bridge,'search_context',{query:'second'})).status,200);
  release.resolve();await assert.rejects(a,{name:'AbortError'});
  assert.equal(bridge.records.has(id),false);assert.equal(bridge.records.get(other).ocrText,otherRecord.ocrText);
});

test('closing during a staged read drops late callbacks and releases queued writers',async()=>{
  const entered=deferred(),release=deferred(),observed=[];
  const bridge=await startBridge({...reader,search:async()=>{entered.resolve();await release.promise;return [record];}},{question:'Generated close window',onEvidence:records=>observed.push(...records)});
  const a=bridge.prepareDelivery('search_context',{query:'Generated'},signal());void a.catch(()=>{});
  await entered.promise;
  const queued=bridge.prepareDelivery('search_context',{query:'second'},signal());void queued.catch(()=>{});
  await bridge.close();await assert.rejects(queued,{name:'AbortError'});
  release.resolve();await assert.rejects(a);
  assert.equal(bridge.records.size,0);assert.deepEqual(observed,[]);
});

test('pending stage cancellation discards its image timer and permits the next writer without an ACK',async t=>{
  const {bridge}=await pixelFixture(t),controller=new AbortController();
  const a=await bridge.prepareDelivery('read_image',{id},controller.signal);controller.abort();
  assert.throws(()=>a.confirm(),{name:'AbortError'});
  const next=await bridge.prepareDelivery('read_image',{id},signal());
  assert.equal(typeof next.value.imageDelivery,'string');next.discard();
  assert.equal(bridge.records.size,0);assert.equal(bridge.imageReadReceipts.length,0);
});

test('Memory receipt failure reaches the actual Host confirm boundary with its original error',async t=>{
  const primary=Error('Generated durable receipt failure');let received=0,persisted=0;
  const memoryReader={...reader,memories:async()=>({items:[{id:'generated-memory',statement:'Generated delivered memory',fingerprint:'f'.repeat(64),evidence:[]}],references:[],sourceSpans:[]})};
  const bridge=await startBridge(memoryReader,{question:'Generated Memory receipt',onMemoryBodies(){persisted++;throw primary;}});
  let closing;const close=()=>closing??=bridge.close();t.after(close);
  const definitions=[{name:'memories',version:'1',fingerprint:'a'.repeat(64),description:'Generated memory read',inputSchema:{type:'object'}}];
  const identity={packageId:'generated',installationId:'generated',instanceId:'generated',host:{kind:'central',id:'generated'},activationId:'generated'};
  const selection={modelId:'generated',modelRevision:1,profileId:'generated',profileRevision:1,transport:'fixture'};
  const lease=(id,value)=>({binding:{service:{id,apiVersion:'1'},provider:{scope:identity,contributionId:id},revision:1},signal:signal(),value,assertCurrent(){},release(){}});
  const runtime=lease('mote.agent.runtime',{async prepare(_profile,_model,host){host.emit({type:'tools.ready',tools:definitions.map(({name,version,fingerprint})=>({name,version,fingerprint}))},null);return {
    async run({attempt}){await host.tools.deliver(attempt,{callId:'generated-call',name:'memories',arguments:{id:'generated-memory'}},async payload=>{received++;assert.match(payload.text,/Generated delivered memory/);assert.equal(persisted,0);});return {terminal:{kind:'completed'},candidate:{text:'{"answer":"Generated","citationIds":[]}'}};},repair(){throw Error('Unexpected repair');},cancel(){},close(){},
  };}});
  const {createHostRunSession}=await import('../dist/host/run-session.js'),{createHostOutputProvider}=await import('../dist/host/output.js');
  const session=await createHostRunSession({scope:{identity,signal:signal(),assertCurrent(){},defer(){}},identity:{runId:'generated-memory-run',runtime:{id:'generated',revision:1,profileId:'generated',profileRevision:1,assemblyFingerprint:'b'.repeat(64)},model:selection},input:{question:'Generated Memory receipt'},profile:{binding:runtime.binding,runtimeId:'generated',profileId:'generated',profileRevision:1,assemblyFingerprint:'b'.repeat(64),taskKind:'query',configuration:{}},runtime,model:{...lease('generated.model',{}),selection},output:lease('mote.agent.host-output',createHostOutputProvider()),tools:{definitions,bindings:[],assertCurrent(){}},budget:{activeTimeoutMs:null},activeBudget:{run:task=>task()},commitFence:{assertCurrent(){}}},{prompt:'Generated prompt',contextUsage:{unit:'utf16_characters',system:0,tools:0,question:0,conversation:0,task:0,evidence:0,prompt:0,outputTokenReserve:100,toolResults:0},evidence:()=>bridge,readTool:async(call,s)=>{const d=await bridge.prepareDelivery(call.name,call.arguments,s);return {payload:{text:JSON.stringify(d.value)},confirm:d.confirm,discard:d.discard};},close});
  await assert.rejects(session.execute(),error=>error===primary);
  await assert.rejects(bridge.failure,error=>error===primary);
  assert.equal(received,1);assert.equal(persisted,1);assert.equal(bridge.records.size,0);assert.equal(bridge.trace.length,0);
});

test('ordinary HTTP Memory failures retain the existing failure channel and recoverable errors retain their recovery',async t=>{
  const primary=Error('Generated HTTP durable receipt failure');
  const bridge=await startBridge({...reader,memories:async()=>({items:[{id:'generated-memory',statement:'Generated memory',fingerprint:'c'.repeat(64)}]})},{question:'Generated HTTP receipt',onMemoryBodies(){throw primary;}});t.after(()=>bridge.close());
  assert.equal((await httpTool(bridge,'memories',{id:'generated-memory'})).status,200);
  await assert.rejects(bridge.failure,error=>error===primary);
  const clean=await startBridge(reader,{question:'Generated argument correction'});t.after(()=>clean.close());
  await assert.rejects(clean.prepareDelivery('evidence',{ids:'wrong'},signal()),error=>error.recovery==='correct_arguments');
  const next=await clean.prepareDelivery('search_context',{query:'Generated'},signal());next.confirm();assert.equal(clean.records.has(id),true);
});

test('a staged Host control propagates its typed yield when actual delivery is confirmed',async t=>{
  const {AgentYieldError}=await import('../dist/host-controls.js');
  const bridge=await startBridge(reader,{question:'Generated yield',hostControlChannel:{definitions:[{name:'delegation_yield',description:'Generated control',fields:{}}],execute:async()=>({data:{waiting:true},yield:true})}});t.after(()=>bridge.close());
  const delivered=await bridge.prepareDelivery('delegation_yield',{},signal());
  assert.throws(()=>delivered.confirm(),error=>error instanceof AgentYieldError);
  await assert.rejects(bridge.failure,error=>error instanceof AgentYieldError);
});

test('the actual HTTP image ACK can unblock a stage waiting for a preexisting pixel reservation',{timeout:3000},async t=>{
  const entered=deferred();let reads=0;
  const bridge=await startBridge({...reader,readImage:async()=>{if(++reads===2)entered.resolve();return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}},{question:'Generated HTTP ACK dependency',directImages:[{id,name:'Generated image',mimeType:'image/png',hash:'a'.repeat(64),sizeBytes:7}]},8);t.after(()=>bridge.close());
  const image=(await httpTool(bridge,'read_image',{id})).value;
  const pending=bridge.prepareDelivery('read_image',{id},signal());await entered.promise;
  assert.equal((await httpTool(bridge,'_image_delivery',{token:image.imageDelivery,delivered:true})).status,200);
  const staged=await pending;assert.equal(staged.value.imageDisclosure.status,'already_disclosed');staged.discard();
  assert.equal(bridge.records.get(id).ocrText,'');assert.equal(bridge.evidenceDependencies.ids.includes(id),true);
});

test('a failed HTTP image ACK releases the shared reservation while a stage waits for fresh pixels',{timeout:3000},async t=>{
  const entered=deferred();let reads=0;
  const bridge=await startBridge({...reader,readImage:async()=>{if(++reads===2)entered.resolve();return {mimeType:'image/png',data:'Zml4dHVyZQ=='};}},{question:'Generated failed ACK dependency',directImages:[{id,name:'Generated image',mimeType:'image/png',hash:'a'.repeat(64),sizeBytes:7}]},8);t.after(()=>bridge.close());
  const image=(await httpTool(bridge,'read_image',{id})).value;
  const pending=bridge.prepareDelivery('read_image',{id},signal());await entered.promise;
  assert.equal((await httpTool(bridge,'_image_delivery',{token:image.imageDelivery,delivered:false})).status,200);
  const staged=await pending;assert.equal(typeof staged.value.imageDelivery,'string');assert.notEqual(staged.value.imageDelivery,image.imageDelivery);staged.discard();
  assert.equal(bridge.records.size,0);assert.deepEqual(bridge.imageReadReceipts,[]);
});
