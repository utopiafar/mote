import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';

/** B1 preparation: exercises existing source and Material readers, not the proposed projection. */
test('source revisions and Material revisions retain distinct identities and exact historical members',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-library-b1-contract-'));
  const token='generated-library-b1-contract-owner',headers={authorization:'Bearer '+token,'x-mote-ingress-version':'2'};
  const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model calls in B1 contract preparation');},close:async()=>{}}});
  node.materialOrganizer.tick=async()=>0;
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const at='2026-10-01T10:00:00.000Z',externalId='generated-shared-name';
  for(const id of ['generated-source-a','generated-source-b'])node.sources.register({id,name:'Same generated title',kind:'custom',deviceId:'generated-phone',platform:'android',retention:'snapshot'});
  const item=(revision:string,text:string)=>({externalId,revision,observedAt:at,title:'Same generated title',kind:'message',layer:'snapshot',text,deleted:false});
  const first=await node.sources.upsert('generated-source-a',item('source-v1','Generated original v1'));
  const other=await node.sources.upsert('generated-source-b',item('source-v1','Generated original v1'));
  assert.notEqual(first.id,other.id,'equal title, time and body do not join different source identities');
  const draft=(captureId:string,text:string):MaterialDraft=>({id:materialId('generated-source-a',externalId),kind:'mote.message',schemaVersion:1,title:'Same generated title',origin:{sourceId:'generated-source-a',externalId,deviceId:'generated-phone',firstAt:at,lastAt:at},members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const material1=node.materials.publish(draft(first.id,'Generated organized v1'));
  const second=await node.sources.upsert('generated-source-a',item('source-v2','Generated original v2'));
  assert.notEqual(first.id,second.id,'a new source revision must not reuse the old original');
  const material2=node.materials.publish(draft(second.id,'Generated organized v2'),{expectedRevision:material1.revision});
  assert.equal(material1.id,material2.id);assert.notEqual(material1.revision,material2.revision);
  assert.notEqual(material2.revision,'source-v2','source and Material versions are different domains');
  const get=async(url:string)=>{const response=await node.app.inject({url,headers});assert.equal(response.statusCode,200,response.body);return response.json();};
  const history=await get('/api/sources/generated-source-a/history?externalId='+encodeURIComponent(externalId));
  assert.deepEqual(new Set(history.items.map((row:any)=>row.captureId)),new Set([first.id,second.id]));
  assert.equal(history.items.find((row:any)=>row.captureId===first.id).revision,'source-v1');
  assert.equal(history.items.find((row:any)=>row.current).captureId,second.id);
  for(const [material,original,text] of [[material1,first.id,'Generated organized v1'],[material2,second.id,'Generated organized v2']] as const){
    const read=await get(`/api/materials/${material.id}/read?revision=${material.revision}&length=4000`);
    assert.equal(read.material.ref,material.ref);assert.equal(read.text,text+"\n");
    const members=await get(`/api/materials/${material.id}/members?revision=${material.revision}&limit=20`);
    assert.deepEqual(members.items.map((row:any)=>row.ref),['capture:'+original]);
    const originalRead=await get('/api/capture-browser/'+original);
    assert.equal(originalRead.provenance.sourceId,'generated-source-a');
    assert.equal(originalRead.provenance.externalId,externalId);
    assert.equal(originalRead.ocrText,original===first.id?'Generated original v1':'Generated original v2');
  }
  assert.equal((await node.app.inject(`/api/materials/${material2.id}/read?revision=${material2.revision}`)).statusCode,401);
  const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated limited collector'}});
  assert.equal(invitation.statusCode,200,invitation.body);
  const redeem=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-limited-phone',deviceName:'Generated limited phone',platform:'android'}});
  assert.equal(redeem.statusCode,200,redeem.body);assert.equal(redeem.json().scope,'collector');
  const denied=await node.app.inject({url:`/api/materials/${material2.id}/read?revision=${material2.revision}`,headers:{authorization:'Bearer '+redeem.json().token}});
  assert.equal(denied.statusCode,403,'a real collector grant must not acquire owner Material reading');
});
