import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberEvidence,evidenceLayers} from '../dist/evidence-ledger.js';
import {startBridge} from '../dist/bridge.js';
import {randomUUID} from 'node:crypto';
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
 const a={id:'generated-a',capturedAt:'2026-09-01T00:00:00Z',appName:'Fixture',ocrText:'Read but never cited'},b={...a,id:'generated-b'};
 const reader={search:async()=>[a],timeline:async()=>({items:[b],nextCursor:null}),evidence:async()=>[a],devices:async()=>[],activity:async()=>({}),memories:async()=>({items:[{id:'generated-memory',title:'Derived title'}],references:[{id:b.id,capturedAt:b.capturedAt,characters:20}]})};
 const bridge=await startBridge(reader,{question:'Synthetic disclosure'},8);
 const call=async(tool,args)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};
 try{await call('search_context',{query:'synthetic'});await call('memories',{id:'generated-memory'});assert.deepEqual(new Set(bridge.evidenceDependencies.ids),new Set([a.id,b.id,'generated-memory']));assert.equal(bridge.evidenceDependencies.complete,true);await call('devices',{});assert.equal(bridge.evidenceDependencies.complete,false);}finally{await bridge.close();}
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
