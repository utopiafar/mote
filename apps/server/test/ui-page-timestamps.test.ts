import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureSchema,uiPageText,type UiPageV2} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const token='generated-page-time-owner-token-000000';
const headers={authorization:`Bearer ${token}`};
const agent={configured:false,query:async()=>{throw Error('No live model in generated fixtures');},close:async()=>{}};
async function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'mote-page-time-'));
  const config:Config={dataDir:dir,token,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,dataKey:'32'.repeat(32),
    maxStorageBytes:30_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const result=await buildApp(config,{agent,backgroundWorker:false});
  t.after(async()=>{await result.app.close();rmSync(dir,{recursive:true,force:true});});
  return result;
}
function record(firstAt:string,lastAt:string){
  const page:UiPageV2={version:2,scope:'visible_window',adapterId:'generated.fields',adapterVersion:'1',appVersion:'1.0',
    activity:'fixture.ArticleActivity',status:'ok',truncated:false,observations:{firstAt,lastAt,count:2},
    objects:[{kind:'article',title:'Generated article',author:'Generated author',body:[{text:'Generated original body\n2026-10-10T08:00:02+08:00 remains literal.'}]}]};
  return {id:randomUUID(),deviceId:'fixture-phone',deviceName:'Generated phone',platform:'android',source:'ui_page',
    appId:'fixture.app',appName:'Generated App',capturedAt:lastAt,durationMs:0,ocrText:uiPageText(page),
    privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},
    metadata:{version:1,observedAt:lastAt,collector:{method:'accessibility'},uiPage:page}};
}

for(const [name,firstAt,lastAt] of [
  ['UTC without milliseconds','2026-10-10T00:00:00Z','2026-10-10T00:00:01Z'],
  ['nanosecond precision','2026-10-10T00:00:00.123456789Z','2026-10-10T00:00:01.987654321Z'],
  ['timezone offset','2026-10-10T08:00:00+08:00','2026-10-10T08:00:02+08:00'],
] as const)test(`field-page ${name} stays valid through real ingress, retry, export and import`,async t=>{
  const source=await fixture(t),restored=await fixture(t),input=record(firstAt,lastAt);
  const send=(app:typeof source.app,payload:unknown)=>app.inject({method:'POST',url:'/api/captures',headers,payload});
  captureSchema.parse(input);
  const accepted=await send(source.app,input);assert.equal(accepted.statusCode,201,accepted.body);
  const retry=await send(source.app,input);assert.equal(retry.statusCode,200,retry.body);
  const stored=source.store.evidence([input.id])[0]!;
  assert.equal(stored.capturedAt,new Date(lastAt).toISOString());
  assert.equal(stored.metadata?.observedAt,stored.capturedAt);
  assert.equal(stored.metadata?.uiPage?.version,2);
  if(stored.metadata?.uiPage?.version!==2)throw Error('Expected generated field page');
  assert.deepEqual(stored.metadata.uiPage.observations,{firstAt:new Date(firstAt).toISOString(),lastAt:new Date(lastAt).toISOString(),count:2});
  assert.deepEqual(stored.metadata.uiPage.objects,input.metadata.uiPage.objects);
  assert.equal(stored.ocrText,input.ocrText);
  const exported=await source.app.inject({url:'/api/export',headers});assert.equal(exported.statusCode,200,exported.body);
  const archive=exported.json();assert.equal(archive.captures.length,1);
  for(const {receivedAt:_receivedAt,blobHash:_blobHash,...capture} of archive.captures){
    captureSchema.parse(capture);
    const canonicalRetry=await send(source.app,capture);assert.equal(canonicalRetry.statusCode,200,canonicalRetry.body);
  }
  const merge=await source.app.inject({method:'POST',url:'/api/import',headers,payload:archive});
  assert.equal(merge.statusCode,200,merge.body);assert.equal(merge.json().duplicates,1);
  const restore=await restored.app.inject({method:'POST',url:'/api/import',headers,payload:archive});
  assert.equal(restore.statusCode,200,restore.body);assert.equal(restore.json().imported,1);
  const restoredRetry=await send(restored.app,input);assert.equal(restoredRetry.statusCode,200,restoredRetry.body);
  const restoredExport=await restored.app.inject({url:'/api/export',headers});assert.equal(restoredExport.statusCode,200,restoredExport.body);
  for(const {receivedAt:_receivedAt,blobHash:_blobHash,...capture} of restoredExport.json().captures)captureSchema.parse(capture);
  const detail=await restored.app.inject({url:`/api/capture-browser/${input.id}`,headers});
  assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().ocrText,input.ocrText);
});
