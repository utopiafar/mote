import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberEvidence,evidenceLayers} from '../dist/evidence-ledger.js';
import {startBridge} from '../dist/bridge.js';
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
