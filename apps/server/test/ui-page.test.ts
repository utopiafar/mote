import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {uiRulesSchema,uiSnapshotSchema,extractUiPage,uiPageText} from '@mote/shared';
import type {Config} from '../src/config.js';

test('UI pages ingest, retry, browse, index and export without an image or OCR job',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-ui-e2e-')),token='generated-ui-page-owner-token-000000';
 const config:Config={dataDir:dir,token,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const {app,store}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No live models');},close:async()=>{}}});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const f=JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/conformance.json',import.meta.url),'utf8'))[0];
 const page=extractUiPage(uiSnapshotSchema.parse(f.snapshot),uiRulesSchema.parse(f.rules),'android')!;
 const record={id:randomUUID(),deviceId:'fixture-page',deviceName:'Generated',platform:'android',capturedAt:'2026-09-20T00:00:00Z',durationMs:0,source:'ui_page',appId:f.snapshot.appId,appName:'Generated App',ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:'2026-09-20T00:00:00Z',collector:{method:'accessibility'},uiPage:page}};
 const headers={authorization:`Bearer ${token}`};
 for(const status of [201,200]){const response=await app.inject({method:'POST',url:'/api/captures',headers,payload:record});assert.equal(response.statusCode,status,response.body);}
 const detail=await app.inject({url:`/api/capture-browser/${record.id}`,headers});assert.equal(detail.statusCode,200);assert.deepEqual(detail.json().metadata.uiPage,page);assert.equal(detail.json().blobHash,null);
 const list=await app.inject({url:'/api/capture-browser?source=ui_page',headers});assert.equal(list.statusCode,200);assert.equal(list.json().totalCount,1);assert.equal(list.json().items[0].hasImage,false);assert.equal(list.json().items[0].ocr.status,'not_applicable');
 assert.equal((await app.inject({url:`/api/capture-browser/${record.id}/image`,headers})).statusCode,404);
 assert.equal(store.search('"Generated"',{}).some(r=>r.id===record.id),true);
 const archive=store.exportArchive(10_000_000);assert.equal(archive.captures.find(r=>r.id===record.id)?.metadata?.uiPage?.adapterId,page.adapterId);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM perception_jobs WHERE capture_id=?').get(record.id)?.n,0);
 const changed=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...record,ocrText:'forged'}});assert.equal(changed.statusCode,400);
 const activity=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...record,id:randomUUID(),privacy:{...record.privacy,collection:'activity'}}});assert.equal(activity.statusCode,400);
 const invite=await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://fixture.invalid',label:'Generated'}});
 const redeem=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'other-page',deviceName:'Other',platform:'android'}});
 const foreign=await app.inject({url:`/api/capture-browser/${record.id}`,headers:{authorization:`Bearer ${redeem.json().token}`}});assert.equal(foreign.statusCode,404);
});
