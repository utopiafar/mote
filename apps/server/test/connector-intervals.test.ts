import {larkContext} from '../src/connectors/lark-context.js';
import {gmailContext} from '../src/connectors/gmail-context.js';
import {googleCalendarContext} from '../src/connectors/google-context.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {OAuth2Client} from 'google-auth-library';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {registerConnectors} from '../src/connectors/index.js';
import {connectorRegistryHost} from './fixtures/connector-host.js';
import {GoogleCalendarConnector,type GoogleDependencies} from '../src/connectors/google.js';
import {GmailConnector,gmailScope} from '../src/connectors/gmail.js';
import {LarkConnector,LARK_SCOPES} from '../src/connectors/lark.js';
import {RecordingConnector,type RecordingProvider} from '../src/connectors/recordings.js';
import type {LarkRunner} from '../src/connectors/lark-cli.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import {connectorReader} from './fixtures/connector-reader.js';

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-connector-interval-')),store=new Store(join(directory,'vault'));
  const privateDirectory=join(directory,'credentials');await mkdir(privateDirectory,{mode:0o700});
  const sources=new SourceStore(store),ctx:ConnectorContext={store,sources,evidenceReader:connectorReader(store,sources),config:{dataDir:directory,token:'generated-interval-owner-token',allowedOrigins:[],connectors:{directory:privateDirectory,syncIntervalMs:120000,googleClientId:'generated-client',googleClientSecret:'generated-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}}};
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const save=(name:string,value:unknown)=>writeFile(join(privateDirectory,name),JSON.stringify(value),{mode:0o600});
  return {ctx,save};
}
function generatedRecording(id='generated'):RecordingProvider{
  return {id,version:'generated@1',account:async()=>({id:'generated-owner'}),discover:async()=>({ids:[]}),
    metadata:async()=>{throw Error('Unexpected fixture metadata read');},transcript:async()=>{throw Error('Unexpected fixture transcript read');},media:async()=>{throw Error('Unexpected fixture media read');}};
}
const generatedLark:LarkRunner=async command=>{
  if(command.kind==='version')return 'lark-cli version 1.0.85';
  if(command.kind==='status')return JSON.stringify({appId:'cli_generated_interval',identities:{user:{available:true,openId:'generated-interval-owner',scope:LARK_SCOPES.join(' ')}}});
  if(command.kind==='login')return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?generated=interval',device_code:'generated-interval-device-code',expires_in:600});
  if(command.kind==='complete')return '{}';
  if(command.kind==='documents-search')return JSON.stringify({results:[],has_more:false});
  throw Error('Unexpected generated interval CLI operation: '+command.kind);
};
async function larkSettled(lark:LarkConnector){
  for(let index=0;index<1000;index++){
    const status=lark.status();if(!['running','waiting'].includes(status.job?.state??'')){assert.equal(status.job?.state,'completed',JSON.stringify(status));return;}
    await new Promise(resolve=>setTimeout(resolve,1));
  }throw Error('Generated interval authorization did not settle');
}
async function authorizeLark(lark:LarkConnector){
  await lark.refresh();lark.login();await larkSettled(lark);
  await lark.select({documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'UTC',autoSync:true,documentDiscovery:{created:true,edited:true,opened:true,firstSyncDays:30}});
  lark.startPreview();await larkSettled(lark);lark.startSync();await larkSettled(lark);assert.equal(lark.status().documentSync?.confirmed,true);
}
const googleResult={imported:0,duplicates:0,calendars:1},gmailResult={imported:0,duplicates:0,hasMore:false};
const larkJob={id:'generated-sync',kind:'sync' as const,state:'completed' as const};

for(const kind of ['google-calendar','gmail','lark','recordings'] as const)test(`${kind} replaces future polls, keeps an unchanged cadence and cannot restart after close`,async t=>{
  const {ctx,save}=await fixture(t);t.mock.timers.enable({apis:['setInterval']});
  let polls=0,authorize=async()=>{};
  let connector:{init():Promise<void>;configureSyncInterval(intervalMs:number):void;close():Promise<void>};
  if(kind==='google-calendar'){
    await save('google-calendar.json',{version:1,tokens:{},calendars:[{id:'generated-calendar',summary:'Generated calendar'}],checkpoints:{}});
    const google=new GoogleCalendarConnector(googleCalendarContext(ctx));t.mock.method(google,'sync',async()=>{polls++;return googleResult;});connector=google;
  }else if(kind==='gmail'){
    await save('gmail.json',{version:1,tokens:{},account:'generated@example.invalid'});
    const gmail=new GmailConnector(gmailContext(ctx));t.mock.method(gmail,'sync',async()=>{polls++;return gmailResult;});connector=gmail;
  }else if(kind==='lark'){
    const lark=new LarkConnector(larkContext(ctx),generatedLark);authorize=async()=>{await authorizeLark(lark);t.mock.method(lark,'startSync',()=>{polls++;return larkJob;});};connector=lark;
  }else{
    const recordings=new RecordingConnector(ctx,generatedRecording());t.mock.method(recordings,'tick',async()=>{polls++;});connector=recordings;
  }
  t.after(()=>connector.close());
  connector.configureSyncInterval(60000);t.mock.timers.tick(60000);assert.equal(polls,0,'configuration before init does not start collection');
  await connector.init();await authorize();t.mock.timers.tick(60000);assert.equal(polls,0);
  connector.configureSyncInterval(180000);
  t.mock.timers.tick(120000);assert.equal(polls,0,'the old timer must not fire after replacement');
  t.mock.timers.tick(60000);assert.equal(polls,1);
  t.mock.timers.tick(60000);connector.configureSyncInterval(180000);
  t.mock.timers.tick(120000);assert.equal(polls,2,'an identical effective interval must not postpone the next poll');
  connector.configureSyncInterval(60000);t.mock.timers.tick(60000);assert.equal(polls,3);
  await connector.close();connector.configureSyncInterval(120000);t.mock.timers.tick(360000);assert.equal(polls,3);
});

test('registry applies intervals to built-ins and opt-in deployment plugins through the normal registration lifecycle',async t=>{
  const {ctx,save}=await fixture(t);t.mock.timers.enable({apis:['setInterval']});
  await save('google-calendar.json',{version:1,tokens:{},calendars:[{id:'generated-calendar',summary:'Generated calendar'}],checkpoints:{}});
  await save('gmail.json',{version:1,tokens:{},account:'generated@example.invalid'});
  const approvedLark=new LarkConnector(larkContext(ctx),generatedLark);await approvedLark.init();await authorizeLark(approvedLark);await approvedLark.close();
  const counts={google:0,gmail:0,lark:0,feishu:0,dingtalk:0},intervals:number[]=[];
  t.mock.method(GoogleCalendarConnector.prototype,'sync',async()=>{counts.google++;return googleResult;});
  t.mock.method(GmailConnector.prototype,'sync',async()=>{counts.gmail++;return gmailResult;});
  t.mock.method(LarkConnector.prototype,'startSync',()=>{counts.lark++;return larkJob;});
  t.mock.method(RecordingConnector.prototype,'tick',async function(this:RecordingConnector){counts[this.provider.id as 'feishu'|'dingtalk']++;});
  const app=Fastify(),registry=await registerConnectors(app,ctx,{recordings:[generatedRecording('feishu'),generatedRecording('dingtalk')]},[
    {apiVersion:1,id:'generated-interval-plugin',sourceKinds:[],create:context=>({configureSyncInterval:interval=>{assert.equal(context.config.connectors?.syncIntervalMs,interval);intervals.push(interval);}})},
  ]);
  t.after(async()=>{await registry.close();await app.close();});
  t.mock.timers.tick(60000);registry.configureSyncInterval(180000);t.mock.timers.tick(120000);
  assert.deepEqual(counts,{google:0,gmail:0,lark:0,feishu:0,dingtalk:0});
  t.mock.timers.tick(60000);assert.deepEqual(counts,{google:1,gmail:1,lark:1,feishu:1,dingtalk:1});
  registry.configureSyncInterval(60000);t.mock.timers.tick(60000);assert.deepEqual(counts,{google:2,gmail:2,lark:2,feishu:2,dingtalk:2});
  assert.deepEqual(intervals,[180000,60000]);
  await registry.close();registry.configureSyncInterval(120000);t.mock.timers.tick(360000);
  assert.deepEqual(counts,{google:2,gmail:2,lark:2,feishu:2,dingtalk:2});assert.deepEqual(intervals,[180000,60000]);
});

test('registry interval configured before start is available during plugin initialization',async t=>{
  const {ctx}=await fixture(t),app=Fastify();let initial:number|undefined;
  const host=connectorRegistryHost(app,ctx,[{apiVersion:1,id:'generated-interval-plugin',sourceKinds:[],create:context=>({init:async()=>{initial=context.config.connectors?.syncIntervalMs;}})}]);
  host.registry.configureSyncInterval(180000);await host.registry.start();
  t.after(async()=>{await host.close();await app.close();});
  assert.equal(initial,180000);assert.throws(()=>host.registry.configureSyncInterval(Number.NaN));assert.equal(ctx.config.connectors?.syncIntervalMs,180000);
});

for(const kind of ['google-calendar','gmail'] as const)test(`${kind} interval reload lets an in-flight fixture sync finish and uses the new cadence afterwards`,async t=>{
  const {ctx}=await fixture(t);t.mock.timers.enable({apis:['setInterval']});
  const oauth=new OAuth2Client({clientId:'generated-client',redirectUri:ctx.config.connectors!.googleRedirectUri});
  oauth.getToken=(async()=>({tokens:{refresh_token:'generated-refresh-token',access_token:'generated-access-token',scope:kind==='gmail'?gmailScope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly'}})) as typeof oauth.getToken;
  oauth.getAccessToken=(async()=>({token:'generated-access-token'})) as typeof oauth.getAccessToken;
  let release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined,polls=0;
  const waiting=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const dependencies:GoogleDependencies={oauthFactory:()=>oauth,fetch:(async(input,options)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/calendarList'))return Response.json({items:[{id:'generated-calendar',summary:'Generated calendar',timeZone:'UTC'}]});
    if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'generated@example.invalid',historyId:'1'});
    polls++;if(polls===1){signal=options?.signal??undefined;entered();await hold;}
    return kind==='gmail'?Response.json({messages:[],history:[],historyId:String(polls)}):Response.json({items:[],nextSyncToken:`generated-${polls}`});
  }) as typeof fetch};
  const connector=kind==='gmail'?new GmailConnector(gmailContext(ctx),dependencies):new GoogleCalendarConnector(googleCalendarContext(ctx),dependencies);
  t.after(async()=>{release();await connector.close();});
  await connector.init();
  const state=new URL((await connector.start()).authorizationUrl).searchParams.get('state')!;await connector.callback(state,'generated-code');
  if(connector instanceof GoogleCalendarConnector)await connector.select({calendarIds:['generated-calendar']});
  const running=connector.sync();await waiting;
  connector.configureSyncInterval(60000);t.mock.timers.tick(60000);await Promise.resolve();
  assert.equal(signal?.aborted,false);assert.equal(polls,1,'a poll during the held sync reuses its in-flight work');
  release();await running;assert.equal(connector.status().state,'idle');
  t.mock.timers.tick(60000);await connector.sync();assert.equal(polls,2);
});

test('recording interval reload preserves a running durable discovery step',async t=>{
  const {ctx}=await fixture(t);t.mock.timers.enable({apis:['setInterval']});
  ctx.sources.capabilities.register('generated.recordings',{lifecycle:'continuous',discovery:'provider-list',listening:'polling',readOriginal:'explicit-provider-read',synchronization:'revisions',externalWrite:false});
  let entered!:()=>void,release!:()=>void,signal:AbortSignal|undefined,discoveries=0;
  const waiting=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
  const provider=generatedRecording();provider.discover=async(_account,_range,operationSignal)=>{discoveries++;signal=operationSignal;entered();await hold;return {ids:[]};};
  const connector=new RecordingConnector(ctx,provider);t.after(async()=>{release();await connector.close();});
  await connector.init();await connector.connect();await connector.select({enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-09-02T00:00:00Z',autoSync:true,backupAudio:true});await waiting;
  connector.configureSyncInterval(60000);t.mock.timers.tick(60000);await Promise.resolve();
  assert.equal(signal?.aborted,false);assert.equal(discoveries,1);
  release();await connector.drain();assert.equal(connector.status().counts.pending,0);assert.equal(connector.status().counts.failed,0);await connector.close();
});
