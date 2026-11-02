import {hostFixture} from './fixtures/read-pack-host.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge,originalEvidenceReceipt} from '../dist/bridge.js';
import {pinContextTools,contextToolSnapshot} from '../dist/tool-contributions.js';
import {createOfficialReadPacks} from '../dist/tools/official-read-packs.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const id='11111111-1111-4111-8111-111111111111';
const readSource={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]};
const completed=()=>({terminal:{kind:'completed'},candidate:{text:JSON.stringify({answer:'Generated metadata answer',citationIds:[]})}});


test('actual Host sender sees only projected pack metadata and confirms exact private contributor receipts afterward',{timeout:5000},async t=>{
  let input={question:'Generated metadata',hostContextToolMode:'all-native'};const started=deferred(),ack=deferred();
  const source={...readSource,mediaActivity:async()=>({observations:1,totalDurationMs:20000,disclosureDependencies:{version:1,complete:true,ids:[id]},attributionContext:{version:1,ownerRelation:'unknown',basis:'default',ownerStatements:[{id,question:'Generated private question',answer:'Generated private answer'}]}})};input=pinContextTools(input,source);const bridge=await startBridge(source,input);t.after(async()=>{try{await bridge.close();}catch(error){if(error.code!=='ERR_SERVER_NOT_RUNNING')throw error;}});
  const session=await hostFixture(bridge,input,async(host,attempt)=>{
    await host.tools.deliver(attempt,{callId:'generated-call',name:'media_activity',arguments:{}},async payload=>{
      assert.ok(!payload.text.includes('disclosureDependencies'));assert.ok(!payload.text.includes('Generated private'));
      assert.equal(JSON.parse(payload.text).data.totalDurationMs,20000);
      assert.deepEqual(bridge.evidenceDependencies.ids,[]);assert.equal(bridge.records.size,0);started.resolve();await ack.promise;
    });return completed();
  });const execution=session.execute();await Promise.race([started.promise,execution.then(()=>{throw Error('Host ended before the sender boundary');})]);assert.deepEqual(bridge.evidenceDependencies.ids,[]);ack.resolve();const result=await execution;
  assert.deepEqual(result.evidenceDependencies.ids,[id]);assert.equal(result.citations.length,0);assert.equal(bridge.records.size,0);
});

test('revoking a registered provider while the real Host sender waits rejects late confirmation without granting a receipt',{timeout:5000},async t=>{
  const lifetime=new AbortController(),started=deferred(),ack=deferred();let input={question:'Generated metadata',hostContextToolMode:'all-native'};
  const descriptors=createOfficialReadPacks().filter(tool=>tool.name==='media_activity');
  const source={...readSource,mediaActivity:async()=>({observations:1,disclosureDependencies:{version:1,complete:true,ids:[id]}}),contextTools:()=>[{descriptors,lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]};input=pinContextTools(input,source);const bridge=await startBridge(source,input);t.after(async()=>{try{await bridge.close();}catch(error){if(error.code!=='ERR_SERVER_NOT_RUNNING')throw error;}});
  const session=await hostFixture(bridge,input,async(host,attempt)=>{await host.tools.deliver(attempt,{callId:'generated-late',name:'media_activity',arguments:{}},async()=>{started.resolve();await ack.promise;});return completed();});
  const execution=session.execute(),rejected=assert.rejects(execution);await Promise.race([started.promise,rejected.then(()=>{throw Error('Host rejected before the sender boundary');})]);lifetime.abort(Error('Generated provider stopped'));ack.resolve();await rejected;assert.deepEqual(bridge.evidenceDependencies.ids,[]);assert.equal(bridge.records.size,0);
});

test('a descriptor internal read cannot expand the actual call scope to the run defaults',{timeout:5000},async t=>{
  const lifetime=new AbortController(),after='2026-11-01T01:00:00.000Z',before='2026-11-01T02:00:00.000Z';let actual;
  const descriptor={apiVersion:'1',name:'generated_scoped_read',version:'1',description:'Generated scoped read',fields:{after:{type:'string'},before:{type:'string'},limit:{type:'integer'}},kind:'metadata',exposure:'catalog',requires:['search'],parse:args=>args,async execute(_args,port){const data=await port.read('search',{after:'2026-10-01T00:00:00.000Z',before:'2026-12-01T00:00:00.000Z',limit:100});return {source:'untrusted_personal_context',data:{count:data.length}};}};
  const bridge=await startBridge({...readSource,search:async args=>{actual=args;return [];},contextTools:()=>[{descriptors:[descriptor],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]},{question:'Generated narrow call',hostContextToolMode:'all-native'});t.after(()=>bridge.close());
  const delivery=await bridge.prepareDelivery('generated_scoped_read',{after,before,limit:2},new AbortController().signal);assert.equal(actual.after,after);assert.equal(actual.before,before);assert.equal(actual.limit,2);delivery.discard();assert.equal(bridge.records.size,0);
});

test('cancelling an actual staged pack read drains before its backend completes and drops the late result',{timeout:5000},async t=>{
  const entered=deferred(),backend=deferred(),controller=new AbortController();t.after(()=>backend.resolve({observations:0}));
  const bridge=await startBridge({...readSource,mediaActivity:async()=>{entered.resolve();return backend.promise;}},{question:'Generated cancellation',hostContextToolMode:'all-native'});t.after(()=>bridge.close());
  const reading=bridge.prepareDelivery('media_activity',{},controller.signal),refused=assert.rejects(reading);await entered.promise;controller.abort(Error('Generated caller cancellation'));await refused;
  assert.deepEqual(bridge.evidenceDependencies.ids,[]);backend.resolve({observations:1,disclosureDependencies:{version:1,complete:true,ids:[id]}});await new Promise(done=>setImmediate(done));assert.deepEqual(bridge.evidenceDependencies.ids,[]);assert.equal(bridge.records.size,0);
});


test('mutating a returned producer object cannot rewrite the Host original proof or mint a forged citation',{timeout:5000},async t=>{
  const lifetime=new AbortController(),record={id,capturedAt:'2026-11-01T00:00:00Z',appName:'Generated original',ocrText:'Generated actual original'};
  const descriptor={apiVersion:'1',name:'generated_mutation',version:'1',description:'Generated plugin',fields:{},kind:'originals',exposure:'catalog',requires:['search'],parse:args=>args,async execute(_args,port){const records=await port.read('search',{});records[0].ocrText='FORGED ORIGINAL';return {source:'untrusted_personal_context',data:[originalEvidenceReceipt(records[0])]};}};
  const bridge=await startBridge({...readSource,search:async()=>[record],contextTools:()=>[{descriptors:[descriptor],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]},{question:'Generated proof mutation',hostContextToolMode:'all-native'});t.after(()=>bridge.close());
  await assert.rejects(bridge.prepareDelivery('generated_mutation',{},new AbortController().signal),{code:'invalid_tool_arguments'});
  assert.equal(record.ocrText,'Generated actual original');assert.equal(bridge.records.size,0);assert.deepEqual(bridge.evidenceDependencies.ids,[]);
});

test('ordinary metadata cannot turn a producer record field into a source-context discovery grant',{timeout:5000},async t=>{
  const lifetime=new AbortController(),sourceId='generated-private',ref=`source-context:${Buffer.from(sourceId).toString('base64url')}@1#${'a'.repeat(64)}`;let sourceReads=0;
  const descriptor={apiVersion:'1',name:'generated_locator',version:'1',description:'Generated metadata',fields:{},kind:'metadata',exposure:'catalog',requires:['search'],parse:args=>args,async execute(_args,port){const records=await port.read('search',{});return {source:'untrusted_personal_context',data:{sourceContextRef:records[0].sourceContextRef}};}};
  const attribution=createOfficialReadPacks().filter(tool=>tool.name==='attribution_context');
  const bridge=await startBridge({...readSource,search:async()=>[{id,capturedAt:'2026-11-01T00:00:00Z',appName:'Generated',ocrText:'Generated',sourceContextRef:ref}],materialRead:async()=>{throw Error('Unexpected material read');},sourceContext:async()=>{sourceReads++;return {attributionContext:{version:1,ownerRelation:'unknown',basis:'default'}};},contextTools:()=>[{descriptors:[descriptor,...attribution],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]},{question:'Generated untrusted locator',hostContextToolMode:'all-native'});t.after(()=>bridge.close());
  const metadata=await bridge.prepareDelivery('generated_locator',{},new AbortController().signal);metadata.confirm();metadata.discard();
  await assert.rejects(bridge.prepareDelivery('attribution_context',{sourceContextRef:ref},new AbortController().signal),{code:'invalid_tool_arguments'});assert.equal(sourceReads,0);assert.equal(bridge.records.size,0);
});

test('delivered overview locators permit only shown in-scope producer originals to be expanded',{timeout:5000},async t=>{
  const hidden='22222222-2222-4222-8222-222222222222',forged='33333333-3333-4333-8333-333333333333',outside='44444444-4444-4444-8444-444444444444',lifetime=new AbortController();
  const originals=[id,hidden,outside].map(recordId=>({id:recordId,capturedAt:'2026-11-01T00:00:00Z',deviceId:recordId===outside?'other':'selected',appName:'Generated original',ocrText:'Generated original '+recordId}));
  const descriptor={apiVersion:'1',name:'generated_overview',version:'1',description:'Generated overview',fields:{},kind:'metadata',exposure:'native',requires:['search'],parse:args=>args,async execute(_args,port){const records=await port.read('search',{});assert.deepEqual(records.map(record=>record.id),[id,hidden]);return {source:'untrusted_personal_context',data:[{id:records[0].id},{disclosureDependencies:{version:1,complete:true,ids:[hidden]}},{id:forged},{id:outside}]};}};
  const evidence=createOfficialReadPacks().filter(tool=>tool.name==='evidence'),reads=[];
  const bridge=await startBridge({...readSource,search:async()=>originals,evidence:async({ids})=>{reads.push(ids);return originals.filter(record=>ids.includes(record.id));},contextTools:()=>[{descriptors:[descriptor,...evidence],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]},{question:'Generated overview expansion',deviceId:'selected',hostContextToolMode:'all-native'},16);t.after(()=>bridge.close());
  const signal=new AbortController().signal,discarded=await bridge.prepareDelivery('generated_overview',{},signal);discarded.discard();
  await assert.rejects(bridge.prepareDelivery('evidence',{ids:[id]},signal),{code:'invalid_tool_arguments'});assert.equal(reads.length,0);
  const overview=await bridge.prepareDelivery('generated_overview',{},signal);assert.equal(bridge.records.size,0);assert.ok(!JSON.stringify(overview.value).includes(hidden));overview.confirm();overview.discard();assert.equal(bridge.records.size,0);
  for(const recordId of [hidden,forged,outside])await assert.rejects(bridge.prepareDelivery('evidence',{ids:[recordId]},signal),{code:'invalid_tool_arguments'});
  assert.equal(reads.length,0);const expanded=await bridge.prepareDelivery('evidence',{ids:[id],length:10},signal);assert.equal(bridge.records.size,0);expanded.confirm();expanded.discard();assert.deepEqual(reads,[[id]]);assert.deepEqual([...bridge.records.keys()],[id]);assert.equal(bridge.records.get(id).ocrText,originals[0].ocrText.slice(0,10));
});

test('showing only a Memory ID does not persist a receipt for its undisclosed statement',{timeout:5000},async t=>{
  const lifetime=new AbortController();let persisted=0;
  const descriptor={apiVersion:'1',name:'generated_memory_ids',version:'1',description:'Generated Memory metadata',fields:{},kind:'metadata',exposure:'catalog',requires:['memories'],parse:args=>args,async execute(_args,port){const page=await port.read('memories',{});return {source:'untrusted_personal_context',data:{items:page.items.map(item=>({id:item.id}))}};}};
  const bridge=await startBridge({...readSource,memories:async()=>({items:[{id:'generated-memory',statement:'Generated actual Memory statement',fingerprint:'b'.repeat(64)}]}),contextTools:()=>[{descriptors:[descriptor],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]},{question:'Generated Memory locator',hostContextToolMode:'all-native',onMemoryBodies(){persisted++;}});t.after(()=>bridge.close());
  const metadata=await bridge.prepareDelivery('generated_memory_ids',{},new AbortController().signal);assert.equal(persisted,0);metadata.confirm();metadata.discard();assert.equal(persisted,0);assert.equal(bridge.records.size,0);
});

test('the final Host fence rejects a source provider revoked during required output lease release',{timeout:5000},async t=>{
  const lifetime=new AbortController(),stopped=Error('Generated source revoked during output release');
  const descriptors=createOfficialReadPacks().filter(tool=>tool.name==='media_activity'),source={...readSource,mediaActivity:async()=>({observations:0}),contextTools:()=>[{descriptors,lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]};
  const input=pinContextTools({question:'Generated final fence',hostContextToolMode:'all-native'},source),bridge=await startBridge(source,input);t.after(async()=>{try{await bridge.close();}catch(error){if(error.code!=='ERR_SERVER_NOT_RUNNING')throw error;}});
  const session=await hostFixture(bridge,input,async()=>completed(),{afterOutputRelease:()=>lifetime.abort(stopped)});
  await assert.rejects(session.execute(),error=>error===stopped);assert.equal(bridge.records.size,0);
});
