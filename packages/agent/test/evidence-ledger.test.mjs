import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberEvidence,evidenceLayers} from '../dist/evidence-ledger.js';
test('evidence keeps delivered ranges per revision and layer without replacing original citation authority',()=>{
 const records=new Map(),original={id:'generated',ocrText:'Original',evidenceFingerprint:'v1',contentLayer:'L0_source_text',textRange:{start:0,end:8}};
 rememberEvidence(records,original);rememberEvidence(records,{...original,ocrText:'Model guess',contentLayer:'L2_model_interpretation'});
 assert.equal(records.get('generated').ocrText,'Original');assert.equal(evidenceLayers(records).length,2);
 rememberEvidence(records,{...original,ocrText:'Tail',textRange:{start:40,end:44}});
 assert.deepEqual(records.get('generated').deliveredRanges.map(r=>[r.start,r.end]),[[0,8],[40,44]]);
 rememberEvidence(records,{...original,ocrText:'New',evidenceFingerprint:'v2',textRange:{start:0,end:3}});
 assert.equal(evidenceLayers(records).length,3);assert.equal(records.get('generated').deliveredRanges.length,1);
});
