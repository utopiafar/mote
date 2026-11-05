import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';

const agent:QueryAgent={configured:false,query:async()=>{throw Error('No model calls in generated device tests');},close:async()=>{}};
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-device-contact-'));
  const config:Config={dataDir:directory,token:'generated-device-contact-owner-token',tokenPath:'generated-only',host:'127.0.0.1',port:0,profile:'test',maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  const node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  const post=async(payload:unknown)=>{
    const response=await node.app.inject({method:'POST',url:'/api/devices/heartbeat',headers,payload});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{ok:true});
  };
  const list=async()=>{
    const response=await node.app.inject({url:'/api/devices',headers});
    assert.equal(response.statusCode,200,response.body);
    return response.json() as {items:Array<{deviceId:string;status:string;sync?:unknown;lastSeenAt:string}>;disconnectedDeviceIds:string[]};
  };
  return {node,headers,post,list};
}

type Mode='realtime'|'interval'|'batch'|'manual';
const beat=(deviceId:string,mode?:Mode,intervalMinutes=1)=>({
  deviceId,deviceName:'Generated '+deviceId,platform:'android',status:'capturing',queueDepth:0,
  ...(mode?{sync:{mode,state:mode==='manual'?'idle':'waiting',intervalMinutes,batchSize:20,pendingRecords:0}}:{}),
});
const minute=60_000;

test('central calculates contact loss from generated heartbeat sequences without changing reported capture status',async t=>{
  const f=await fixture(t),start=Date.parse('2026-11-06T00:00:00.000Z');
  t.mock.timers.enable({apis:['Date'],now:start});
  await f.post(beat('realtime','realtime',1440));
  await f.post(beat('interval','interval',40));
  await f.post(beat('batch','batch',90));
  await f.post(beat('manual','manual'));
  await f.post(beat('unreported'));
  const lost=async()=>[...(await f.list()).disconnectedDeviceIds].sort();

  assert.deepEqual(await lost(),[]);
  t.mock.timers.setTime(start+30*minute);
  assert.deepEqual(await lost(),[],'a 15-minute Android heartbeat has two full scheduling intervals');
  t.mock.timers.setTime(start+30*minute+1);
  assert.deepEqual(await lost(),['realtime'],'realtime does not use an unrelated saved upload interval');
  t.mock.timers.setTime(start+80*minute);
  assert.deepEqual(await lost(),['realtime'],'an interval is not overdue exactly at its deadline');
  t.mock.timers.setTime(start+80*minute+1);
  assert.deepEqual(await lost(),['interval','realtime']);
  t.mock.timers.setTime(start+180*minute+1);
  assert.deepEqual(await lost(),['batch','interval','realtime']);
  t.mock.timers.setTime(start+365*24*60*minute);
  assert.deepEqual(await lost(),['batch','interval','realtime'],'manual and unreported policies never acquire a fabricated deadline');
  const before=(await f.list()).items;
  assert.ok(before.every(device=>device.status==='capturing'),'timeout never overwrites the last reported capture state');
  assert.ok(f.node.store.devices().every(device=>!Object.hasOwn(device,'disconnected')),'derived contact state is never persisted');

  await f.post(beat('realtime','realtime'));
  assert.deepEqual(await lost(),['batch','interval'],'a fresh heartbeat restores contact');
  await f.post(beat('interval','manual'));
  assert.deepEqual(await lost(),['batch'],'the latest reported mode takes precedence over the previous automatic deadline');
  const capture=await f.node.app.inject({method:'POST',url:'/api/captures',headers:{...f.headers,'x-mote-ingress-version':'2'},payload:{
    id:randomUUID(),deviceId:'batch',deviceName:'Generated batch',platform:'android',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated contact evidence',
  }});
  assert.equal(capture.statusCode,201,capture.body);
  assert.deepEqual(await lost(),[],'a real capture receipt also proves recent contact');
  assert.equal((await f.list()).items.find(device=>device.deviceId==='batch')?.status,'capturing');
  t.mock.timers.setTime(start+365*24*60*minute+181*minute);
  assert.deepEqual(await lost(),['batch','realtime'],'the latest contact and each reported interval set new deadlines');
});
