import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {uiRulesSchema,uiSnapshotSchema,extractUiPages,uiPageText} from '@mote/shared';
import type {Config} from '../src/config.js';

test('UI pages ingest, retry, browse, index and export without an image or OCR job',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-ui-e2e-')),token='generated-ui-page-owner-token-000000';
 const config:Config={dataDir:dir,token,tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const {app,store}=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No live models');},close:async()=>{}}});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const f=JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/structured-conformance.json',import.meta.url),'utf8')).find((fixture:{name:string})=>fixture.name==='builtin-wechat-article-android-8.0.78-visible');
 const page=extractUiPages(uiSnapshotSchema.parse(f.snapshot),uiRulesSchema.parse(f.rules),f.platform)[0]!;
 const at=page.observations.lastAt;
 const record={id:randomUUID(),deviceId:'fixture-page',deviceName:'Generated',platform:f.platform,capturedAt:at,durationMs:0,source:'ui_page',appId:f.snapshot.appId,appName:'Generated App',ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page}};
 const headers={authorization:`Bearer ${token}`};
 for(const status of [201,200]){const response=await app.inject({method:'POST',url:'/api/captures',headers,payload:record});assert.equal(response.statusCode,status,response.body);}
 const storedPage={...page,observations:{...page.observations,firstAt:new Date(page.observations.firstAt).toISOString(),lastAt:new Date(page.observations.lastAt).toISOString()}};
 const detail=await app.inject({url:`/api/capture-browser/${record.id}`,headers});assert.equal(detail.statusCode,200);assert.deepEqual(detail.json().metadata.uiPage,storedPage);assert.equal(detail.json().blobHash,null);
 const list=await app.inject({url:'/api/capture-browser?source=ui_page',headers});assert.equal(list.statusCode,200);assert.equal(list.json().totalCount,1);assert.equal(list.json().items[0].hasImage,false);assert.equal(list.json().items[0].ocr.status,'not_applicable');
 assert.equal((await app.inject({url:`/api/capture-browser/${record.id}/image`,headers})).statusCode,404);
 assert.equal(store.search('"Generated"',{}).some(r=>r.id===record.id),true);
 const archive=store.exportArchive(10_000_000);assert.equal(archive.captures.find(r=>r.id===record.id)?.metadata?.uiPage?.adapterId,page.adapterId);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM perception_jobs WHERE capture_id=?').get(record.id)?.n,0);
 const changed=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...record,ocrText:'forged'}});assert.equal(changed.statusCode,400);
 const activity=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...record,id:randomUUID(),privacy:{...record.privacy,collection:'activity'}}});assert.equal(activity.statusCode,400);
 const legacyPage={version:1,scope:'visible_window',adapterId:'generated.legacy',adapterVersion:'1',appVersion:f.snapshot.appVersion,activity:f.snapshot.activity,status:'partial',truncated:false,
   nodes:[{id:'legacy',resourceId:'generated:id/text',role:'android.widget.TextView',text:'Generated legacy selected node',bounds:{x:0,y:0,width:100,height:20}}]};
 const legacy=await app.inject({method:'POST',url:'/api/captures',headers,payload:{...record,id:randomUUID(),ocrText:'Generated legacy selected node',metadata:{...record.metadata,uiPage:legacyPage}}});
 assert.equal(legacy.statusCode,400,'old page versions are rejected instead of converted');
 const invite=await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://fixture.invalid',label:'Generated'}});
 const redeem=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'other-page',deviceName:'Other',platform:'android'}});
 const foreign=await app.inject({url:`/api/capture-browser/${record.id}`,headers:{authorization:`Bearer ${redeem.json().token}`}});assert.equal(foreign.statusCode,200);
});
