import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId,type MaterialDraft} from '../src/materials.js';

/** Real owner HTTP projection plus immutable source and Material reader contracts. */
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
  const request={after:'2026-10-01T00:00:00Z',before:'2026-10-02T00:00:00Z',stream:'originals',limit:1,candidates:[]};
  const project=async(payload:unknown,expected=200)=>{const r=await node.app.inject({method:'POST',url:'/api/library/source-view',headers,payload});assert.equal(r.statusCode,expected,r.body);return r.json();};
  const page1=await project(request),page2=await project({...request,cursor:page1.nextCursor});
  assert.deepEqual(new Set([...page1.items,...page2.items].map((r:any)=>r.captureId)),new Set([second.id,other.id]));
  assert.equal(page2.nextCursor,null);
  await project({...request,cursor:page1.nextCursor,sourceId:'generated-source-a'},409);
  await project({...request,cursor:'invalid'},409);
  const matches=await project({...request,candidates:[
    {sourceId:'generated-source-a',externalId,revision:'source-v1',deviceId:'generated-phone',captureId:first.id},
    {sourceId:'generated-source-a',externalId,revision:'source-v2',deviceId:'generated-phone',captureId:first.id},
    {sourceId:'generated-source-a',externalId,revision:'source-v2',deviceId:'other-phone'},
  ]});
  assert.equal(matches.matches[0].original.captureId,first.id);
  assert.equal(matches.matches[1].state,'unavailable');assert.equal(matches.matches[2].state,'unavailable');
  assert.equal(matches.matches[1].original,undefined);
  const materialPage=await project({...request,stream:'materials'});
  assert.equal(materialPage.items[0].ref,material2.ref);assert.equal(materialPage.items[0].type,'material');
  const empty=await project({...request,sourceId:'missing'});assert.deepEqual(empty.items,[]);
  // Collection time is independent of authored/modified time and keeps the old source API semantics.
  const dated=await node.sources.upsert('generated-source-a',{...item('dated-v1','Generated old authored text'),externalId:'dated',modifiedAt:'2020-01-01T00:00:00Z'});
  const datedPage=await project({...request,limit:20});assert.ok(datedPage.items.some((row:any)=>row.captureId===dated.id));
  const fallbackDraft={...draft(second.id,'Generated fallback time'),id:materialId('generated-source-a','fallback'),origin:{sourceId:'generated-source-a',externalId:'fallback',deviceId:'generated-phone'}};
  const fallback=node.materials.publish(fallbackDraft);
  const fallbackPage=await project({...request,stream:'materials',after:new Date(Date.now()-60000).toISOString(),before:new Date(Date.now()+60000).toISOString(),limit:20});
  assert.equal(fallbackPage.items.find((row:any)=>row.id===fallback.id)?.sortAt,fallback.updatedAt);
  await project({...request,candidates:Array.from({length:21},()=>({sourceId:'generated-source-a',externalId,revision:'source-v1',deviceId:'generated-phone'}))},400);
  assert.equal((await node.app.inject({method:'POST',url:'/api/library/source-view',payload:request})).statusCode,401);

  assert.equal((await node.app.inject(`/api/materials/${material2.id}/read?revision=${material2.revision}`)).statusCode,401);
  const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated limited collector'}});
  assert.equal(invitation.statusCode,200,invitation.body);
  const redeem=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-limited-phone',deviceName:'Generated limited phone',platform:'android'}});
  assert.equal(redeem.statusCode,200,redeem.body);assert.equal(redeem.json().scope,'collector');
  const denied=await node.app.inject({url:`/api/materials/${material2.id}/read?revision=${material2.revision}`,headers:{authorization:'Bearer '+redeem.json().token}});
  const deniedProjection=await node.app.inject({method:'POST',url:'/api/library/source-view',payload:request,headers:{authorization:'Bearer '+redeem.json().token}});
  assert.equal(deniedProjection.statusCode,403);
  assert.equal(denied.statusCode,403,'a real collector grant must not acquire owner Material reading');
});
