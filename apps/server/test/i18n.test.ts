import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {requestLocale,moteText} from '../src/i18n.js';
import {ModelSettingsError} from '../src/model-settings.js';

test('concurrent requests localize presentation, retain protocol codes and leave stored evidence untouched',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'mote-language-fixture-'));
 const token='synthetic-language-fixture-owner';
 const config:Config={dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:47832,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No live model');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();await rm(dataDir,{recursive:true,force:true});});
 const headers=(locale:string)=>({authorization:'Bearer '+token,'accept-language':locale});
 const responses=await Promise.all(Array.from({length:20},(_,i)=>node.app.inject({url:'/api/configuration',headers:headers(i%2?'zh-CN':'en-US')})));
 responses.forEach((r,i)=>{assert.equal(r.statusCode,200,r.body);assert.equal(r.headers['content-language'],i%2?'zh-CN':'en');assert.match(String(r.headers.vary),/Accept-Language/i);if(i%2)assert.match(r.body,/部署配置/);else assert.doesNotMatch(r.body,/只读展示|软件更新/);});
 for(const locale of ['en','zh-CN']) {
  const r=await node.app.inject({url:'/api/status',headers:{'accept-language':locale}});
  assert.equal(r.statusCode,401);assert.equal(r.headers['content-language'],locale);
  if(locale==='en')assert.doesNotMatch(r.json().message,/\p{Script=Han}/u);else assert.match(r.json().message,/\p{Script=Han}/u);
 }
 const text='设置 $& {0} <b>Generated Chinese evidence</b>';
 node.sources.register({id:'fixture',name:'设置',kind:'custom',deviceId:'fixture',platform:'import'});
 const source=await node.sources.upsert('fixture',{externalId:'fixture',revision:'1',observedAt:'2026-01-01T00:00:00Z',text,kind:'file',layer:'original'});
 assert.equal(node.sources.getItem('fixture','fixture')?.text,text);
});
test('async language context and preloaded error maps remain isolated',async()=>{
 const messages=await Promise.all(['en','zh-CN'].map(locale=>requestLocale.run(locale as 'en'|'zh-CN',async()=>{
  await new Promise(r=>setTimeout(r,5));return [moteText('设置'),new ModelSettingsError('model_profile_missing').message];
 })));
 assert.equal(messages[0][0],'Settings');assert.doesNotMatch(messages[0][1],/\p{Script=Han}/u);
 assert.equal(messages[1][0],'设置');assert.match(messages[1][1],/所选模型配置/);
});
