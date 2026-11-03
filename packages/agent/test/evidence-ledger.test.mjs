import {catalogRequest} from './catalog-request.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberEvidence,evidenceLayers} from '../dist/evidence-ledger.js';
import {startBridge} from '../dist/bridge.js';
import {parseAnswer} from '../dist/index.js';
import {randomUUID} from 'node:crypto';
import {createDerivedNavigationPack} from '../dist/tools/packs/derived-navigation.js';
test('evidence keeps delivered ranges per revision and layer without replacing original citation authority',()=>{
 const records=new Map(),original={id:'generated',ocrText:'Original',evidenceFingerprint:'v1',contentLayer:'L0_source_text',textRange:{start:0,end:8}};
 rememberEvidence(records,original);rememberEvidence(records,{...original,ocrText:'Model guess',contentLayer:'L2_model_interpretation'});
 assert.equal(records.get('generated').ocrText,'Original');assert.equal(evidenceLayers(records).length,2);
 rememberEvidence(records,{...original,ocrText:'Tail',textRange:{start:40,end:44}});
 assert.deepEqual(records.get('generated').deliveredRanges.map(r=>[r.start,r.end]),[[0,8],[40,44]]);
 rememberEvidence(records,{...original,ocrText:'New',evidenceFingerprint:'v2',textRange:{start:0,end:3}});
 assert.equal(evidenceLayers(records).length,3);assert.equal(records.get('generated').deliveredRanges.length,1);
});
test('bridge lineage includes successfully disclosed uncited originals and derived cards only',async()=>{
 const a={id:'2d21d371-92b5-5657-90ec-ad099bf37d4e',capturedAt:'2026-09-01T00:00:00Z',appName:'Fixture',ocrText:'Read but never cited'},b={...a,id:'bfa2289f-2bbc-5827-b82b-76df5374788c'};
 const reader={search:async()=>[a],timeline:async()=>({items:[b],nextCursor:null}),evidence:async()=>[a],devices:async()=>[],activity:async()=>({}),memories:async()=>({items:[{id:'generated-memory',title:'Derived title'}],references:[{id:b.id,capturedAt:b.capturedAt,characters:20}]})};
 const bridge=await startBridge(reader,{question:'Synthetic disclosure'},8);
 const call=async(tool,args)=>{const response=await catalogRequest(bridge,tool,args);assert.equal(response.status,200);return response.json();};
 try{await call('search_context',{query:'synthetic'});await call('memories',{id:'generated-memory'});assert.deepEqual(new Set(bridge.evidenceDependencies.ids),new Set([a.id,b.id,'generated-memory']));assert.equal(bridge.evidenceDependencies.complete,true);await call('devices',{});assert.equal(bridge.evidenceDependencies.complete,false);}finally{await bridge.close();}
});
test('source and index host receipts retain dialogue lineage without disclosing private receipts or granting citations',async()=>{
 const id=randomUUID(),receipt={version:1,complete:true,ids:[id]};
 for(const tool of ['sources','context_index'])for(const dependencies of [receipt,{version:1,complete:true,ids:[]},undefined,{version:1,complete:false,ids:[id]},{version:1,complete:true,ids:['not-an-evidence-id']},{...receipt,unexpected:true}]){
  const body={items:[{name:'Generated source metadata',citationAuthority:false}],disclosureDependencies:dependencies};
  const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>({}),sources:async()=>body,catalog:async()=>body};
  const bridge=await startBridge(reader,{question:'Generated source metadata continuation'});
  try{
   const response=await catalogRequest(bridge,tool,{});assert.equal(response.status,200);const disclosed=await response.json();
   assert.equal('disclosureDependencies' in disclosed.data,false);assert.equal(bridge.records.size,0);
   assert.equal(bridge.evidenceDependencies.complete,dependencies===receipt||dependencies?.ids.length===0);
   if(dependencies===receipt)assert.deepEqual(bridge.evidenceDependencies.ids,[id]);
  }finally{await bridge.close();}
 }
});
test('source metadata pins remain private, survive dialogue continuation and do not replace description pins',async()=>{
 const description={sourceId:'generated-source',version:1,fingerprint:'a'.repeat(64)},metadata={sourceId:'generated-source',version:1,fingerprint:'b'.repeat(64),kind:'metadata'};
 const sourceContextRef='source-context:'+Buffer.from(description.sourceId).toString('base64url')+'@1#'+description.fingerprint,observed=[];
 const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>({}),sources:async()=>({items:[{name:'Generated source',sourceContextRef,statusObservedAt:'2026-10-14T00:00:00Z'}],disclosureDependencies:{version:1,complete:true,ids:[]},sourceContextDependencies:[metadata]})};
 const bridge=await startBridge(reader,{question:'Generated source metadata',onSourceContextDependencies:pins=>observed.push(pins)});
 try{
  const response=await catalogRequest(bridge,'sources',{});assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.data.sourceContextDependencies,undefined);assert.equal(value.data.disclosureDependencies,undefined);assert.equal(value.data.items[0].statusObservedAt,'2026-10-14T00:00:00Z');
  // The real source directory emits metadata before description; consumers
  // validate each kind/identity, not array order. Keep both exact pins.
  assert.deepEqual(new Set(bridge.sourceContextDependencies),new Set([description,metadata]));assert.deepEqual(new Set(observed.at(-1)),new Set([description,metadata]));assert.equal(bridge.evidenceDependencies.complete,true);assert.equal(bridge.records.size,0);
  const next=await startBridge(reader,{question:'Generated follow-up',conversation:{turns:[],omittedTurns:0,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies}});
  try{assert.deepEqual(new Set(next.sourceContextDependencies),new Set([description,metadata]));assert.equal(next.evidenceDependencies.complete,true);}finally{await next.close();}
 }finally{await bridge.close();}
 const invalid=await startBridge({...reader,sources:async()=>({items:[],disclosureDependencies:{version:1,complete:true,ids:[]},sourceContextDependencies:[{...metadata,fingerprint:'invalid'}]})},{question:'Generated invalid receipt'});
 try{assert.equal((await catalogRequest(invalid,'sources',{})).status,200);assert.equal(invalid.evidenceDependencies.complete,false);assert.deepEqual(invalid.sourceContextDependencies,[]);}finally{await invalid.close();}
});
test('measured activity receipts retain all contributors without granting citation authority or imposing a new ID quota',async()=>{
 const ids=Array.from({length:1005},()=>randomUUID()),receipt={version:1,complete:true,ids};
 for(const tool of ['activity','media_activity'])for(const dependencies of [receipt,undefined]){
  const aggregate={observations:ids.length,totalDurationMs:1005,disclosureDependencies:dependencies},reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],devices:async()=>[],activity:async()=>aggregate,mediaActivity:async()=>aggregate};
  const bridge=await startBridge(reader,{question:'Generated measured state'});
  try{
   const response=await catalogRequest(bridge,tool,{});assert.equal(response.status,200);const value=await response.json();
   assert.equal(value.data.disclosureDependencies,undefined);assert.equal(value.data.observations,1005);assert.equal(bridge.evidenceDependencies.complete,Boolean(dependencies));assert.equal(bridge.records.size,0);
   if(dependencies){assert.deepEqual(bridge.evidenceDependencies.ids,ids);assert.throws(()=>parseAnswer(JSON.stringify({answer:'Generated unread proof',citationIds:[ids[0]]}),bridge.records),/not retrieved/);}
  }finally{await bridge.close();}
 }
});
test('device directory snapshots keep hard device scope, drop body fields and remain historical across new heartbeat reports',async()=>{
 let status='paused',reportedAt='2026-10-13T00:00:00Z';
 const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>({items:['selected-device','unselected-device'].map(deviceId=>({deviceId,deviceName:'Generated device',platform:'android',status,lastSeenAt:reportedAt,lastCaptureAt:reportedAt,queueDepth:0,ocrText:'UNREAD_PERSONAL_BODY',filePath:'/private/generated'})),observedAt:'2026-10-14T00:00:00Z',disclosureDependencies:{version:1,complete:true,ids:[]}})};
 const input={question:'Generated device observation',deviceId:'selected-device'},bridge=await startBridge(reader,input);
 try{
  const response=await catalogRequest(bridge,'devices',{});assert.equal(response.status,200);const value=await response.json();
  assert.equal(value.data.length,1);assert.equal(value.data[0].deviceId,input.deviceId);assert.equal(value.data[0].healthReport.statusAsReported,'paused');assert.equal(value.data[0].healthReport.receivedAt,reportedAt);assert.equal(value.data[0].directoryObservedAt,'2026-10-14T00:00:00Z');assert.doesNotMatch(JSON.stringify(value),/UNREAD_PERSONAL_BODY|filePath|disclosureDependencies/);
  assert.deepEqual(bridge.evidenceDependencies,{version:1,complete:true,ids:[]});assert.equal(bridge.records.size,0);
  status='capturing';reportedAt='2026-10-14T00:00:01Z';
  const next=await startBridge(reader,{...input,conversation:{turns:[{question:'Generated prior',answer:'An earlier device report said paused.',createdAt:'2026-10-14T00:00:00Z',scope:{}}],omittedTurns:0,evidenceDependencies:bridge.evidenceDependencies}});
  try{const current=await catalogRequest(next,'devices',{});assert.equal(current.status,200);const data=(await current.json()).data;assert.equal(data[0].healthReport.statusAsReported,'capturing');assert.equal(data[0].healthReport.receivedAt,reportedAt);assert.equal(next.evidenceDependencies.complete,true);assert.equal(next.records.size,0);}finally{await next.close();}
 }finally{await bridge.close();}
 for(const observedAt of [undefined,'not-an-observation-time']){
  const missing=await startBridge({...reader,devices:async()=>({items:[],observedAt,disclosureDependencies:{version:1,complete:true,ids:[]}})},input);
  try{assert.equal((await catalogRequest(missing,'devices',{})).status,200);assert.equal(missing.evidenceDependencies.complete,false);}finally{await missing.close();}
 }
});
test('changes metadata preserves exact filtered snapshot lineage through continuation without granting unread citations',async()=>{
 const original={id:randomUUID(),capturedAt:'2026-10-01T00:00:00Z',deviceId:'selected-device',appName:'Generated app',ocrText:'UNREAD_ORIGINAL_BODY'},outside={...original,id:randomUUID(),deviceId:'unselected-device'},unrequested={...original,id:randomUUID(),appName:'UNREQUESTED_APP'};
 const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[original,outside,unrequested],activity:async()=>({}),devices:async()=>[]};
 for(const selected of [[],[original.id,outside.id]]){
  const input={question:'Generated snapshot coverage',deviceId:original.deviceId,incrementalEvidenceIds:selected},bridge=await startBridge(reader,input);
  try{
   const response=await catalogRequest(bridge,'changes',{view:'overview'});assert.equal(response.status,200);const value=await response.json(),ids=selected.length?[original.id]:[];
   assert.deepEqual(value.data.map(row=>row.id),ids);assert.doesNotMatch(JSON.stringify(value),/UNREAD_ORIGINAL_BODY|UNREQUESTED_APP|unselected-device/);
   assert.deepEqual(bridge.evidenceDependencies,{version:1,complete:true,ids});assert.equal(bridge.records.size,0);
   assert.throws(()=>parseAnswer(JSON.stringify({answer:'Generated unread claim',citationIds:[original.id]}),bridge.records),/not retrieved/);
   const result=parseAnswer(JSON.stringify({answer:'Generated metadata observation.',citationIds:[]}),bridge.records);
   const next=await startBridge(reader,{...input,conversation:{turns:[{question:input.question,answer:result.answer,createdAt:'2026-10-14T00:00:00Z',scope:{deviceId:input.deviceId}}],omittedTurns:0,evidenceDependencies:bridge.evidenceDependencies}});
   try{
    assert.equal(next.evidenceDependencies.complete,true);assert.equal(next.records.size,0);
    assert.equal((await catalogRequest(next,'evidence',{ids:[original.id]})).status,400,'historical dependency IDs never grant an original read');
    assert.equal((await catalogRequest(next,'changes',{view:'overview'})).status,200);assert.deepEqual(next.evidenceDependencies,{version:1,complete:true,ids});assert.equal(next.records.size,0);
   }finally{await next.close();}
  }finally{await bridge.close();}
 }
});
test('only an exact empty changes response can use the Host empty snapshot instead of a producer read',async()=>{
 const empty={source:'untrusted_personal_context',data:[],pagination:{nextCursor:null,totalCount:0}};
 for(const [arrivals,body] of [[undefined,empty],[[],{...empty,note:'Generated unproved archive statement'}],[[],{...empty,data:[{id:randomUUID()}]}]]){
  const lifetime=new AbortController(),descriptor=createDerivedNavigationPack({incrementalEvidenceIds:[]}).find(tool=>tool.name==='changes');
  let reads=0;
  const reader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>{reads++;return [];},devices:async()=>[],activity:async()=>({}),
   contextTools:()=>[{descriptors:[{...descriptor,execute:async()=>body}],lifecycle:{signal:lifetime.signal,assertCurrent(){lifetime.signal.throwIfAborted();}}}]};
  const bridge=await startBridge(reader,{question:'Generated changes proof boundary',...(arrivals===undefined?{}:{incrementalEvidenceIds:arrivals})});
  try{
   const response=await catalogRequest(bridge,'changes',{view:'overview'});assert.equal(response.status,200);
   assert.equal(bridge.evidenceDependencies.complete,false);assert.deepEqual(bridge.evidenceDependencies.ids,[]);assert.equal(bridge.records.size,0);assert.equal(reads,0);
  }finally{await bridge.close();}
 }
});
test('file evidence preserves owner-confirmed speaker metadata as untrusted data and revisions it independently of speech',async()=>{
 const attribution={name:'Generated Alice',confirmedBy:'owner',confirmationId:randomUUID(),confirmedAt:'2026-09-26T00:00:00.000Z'};
 const record={id:randomUUID(),capturedAt:'2026-09-01T00:00:00Z',appName:'Generated recording',sourceType:'file',ocrText:'[SPEAKER_0] Generated speech',fileEvidence:{captureId:randomUUID(),revision:'1',artifactId:randomUUID(),chunkId:'',speaker:'SPEAKER_0',speakerAttribution:attribution}};
 record.fileEvidence.chunkId=record.id;
 const reader={search:async()=>[record],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[record],devices:async()=>[],activity:async()=>({})};
 const bridge=await startBridge(reader,{question:'Synthetic attribution'},8);
 const search=async()=>{const response=await fetch(bridge.url+'/search_context',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({query:'Generated'})});assert.equal(response.status,200);return response.json();};
 try{
  const before=await search();assert.equal(before.source,'untrusted_personal_context');assert.deepEqual(before.data[0].fileEvidence.speakerAttribution,attribution);assert.equal(before.data[0].ocrText,record.ocrText);
  record.fileEvidence.speakerAttribution={...attribution,name:'Generated Carol',confirmationId:randomUUID()};
  const after=await search();assert.equal(after.data[0].ocrText,before.data[0].ocrText);assert.notEqual(after.data[0].evidenceFingerprint,before.data[0].evidenceFingerprint);assert.equal(after.data[0].fileEvidence.speaker,'SPEAKER_0');
 }finally{await bridge.close();}
});
test('file image geometry reaches read-only tools and affects evidence identity without inferring a speaker',async()=>{
 const imageLocation={width:1200,height:14825,polygon:[[20,2040],[600,2040],[600,2080],[20,2080]]};
 const record={id:randomUUID(),capturedAt:'2026-09-01T00:00:00Z',appName:'Generated image',sourceType:'file',ocrText:'Generated repeated words',fileEvidence:{captureId:randomUUID(),revision:'1',artifactId:randomUUID(),chunkId:'',imageLocation}};record.fileEvidence.chunkId=record.id;
 const reader={search:async()=>[record],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[record],devices:async()=>[],activity:async()=>({})};
 const bridge=await startBridge(reader,{question:'Generated layout check'},4);
 const read=async()=>{const response=await fetch(bridge.url+'/search_context',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({query:'Generated'})});assert.equal(response.status,200);return response.json();};
 try{const first=await read();assert.deepEqual(first.data[0].fileEvidence.imageLocation,imageLocation);assert.equal(first.data[0].fileEvidence.speaker,undefined);assert.equal(first.source,'untrusted_personal_context');
  record.fileEvidence.imageLocation={...imageLocation,polygon:[[620,2040],[1100,2040],[1100,2080],[620,2080]]};
  const second=await read();assert.equal(second.data[0].ocrText,first.data[0].ocrText);assert.notEqual(second.data[0].evidenceFingerprint,first.data[0].evidenceFingerprint);
 }finally{await bridge.close();}
});
