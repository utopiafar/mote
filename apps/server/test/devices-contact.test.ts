import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DeviceRecord} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const agent:QueryAgent={configured:false,query:async()=>{throw Error('No model calls in generated device tests');},close:async()=>{}};
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-device-contact-'));
  const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-device-contact-owner-token',tokenPath:'generated-only'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
  const node=await buildApp(config,{agent,backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.privateCredential!.token}`};
  const post=async(payload:unknown)=>{
    const response=await node.app.inject({method:'POST',url:'/api/devices/heartbeat',headers,payload});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{ok:true});
  };
  const list=async()=>{
    const response=await node.app.inject({url:'/api/devices',headers});
    assert.equal(response.statusCode,200,response.body);
    return response.json() as {items:DeviceRecord[];disconnectedDeviceIds:string[]};
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

test('source bar can read a newly paired identity before heartbeat, then read reported status and keep archived notes after removal',async t=>{
  const {node,headers,list}=await fixture(t);
  const device=beat('generated-paired-phone','interval',40),url='/api/connections';
  const invitation=await node.app.inject({
    method:'POST',url:url+'/collector-invitations',headers,
    payload:{serverUrl:'https://generated.invalid',label:'Generated source bar device'},
  });
  assert.equal(invitation.statusCode,200,invitation.body);
  const redeemed=await node.app.inject({
    method:'POST',url:url+'/redeem',payload:{
      code:invitation.json().invitation.code,deviceId:device.deviceId,deviceName:device.deviceName,platform:device.platform,
    },
  });
  assert.equal(redeemed.statusCode,200,redeemed.body);
  const {token,credentialId}=redeemed.json() as {token:string;credentialId:string};
  const inventory=async()=>{
    const response=await node.app.inject({url,headers});
    assert.equal(response.statusCode,200,response.body);
    return response.json().items as {id:string;deviceId:string;deviceName:string;platform:string;scope:string;revokedAt?:string}[];
  };
  const [connection]=await inventory();
  assert.equal(connection.id,credentialId);
  assert.equal(connection.deviceId,device.deviceId);
  assert.equal(connection.deviceName,device.deviceName);
  assert.equal(connection.platform,device.platform);
  assert.equal(connection.scope,'collector');
  assert.equal(connection.revokedAt,undefined);
  assert.deepEqual(await list(),{items:[],disconnectedDeviceIds:[]},'redeeming does not manufacture a heartbeat');

  const collector={authorization:'Bearer '+token};
  const report=async(status:'paused'|'capturing')=>{
    const response=await node.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:collector,payload:{...device,status}});
    assert.equal(response.statusCode,200,response.body);
    const {items,disconnectedDeviceIds}=await list();
    assert.equal(items.length,1);
    assert.equal(items[0].deviceId,connection.deviceId);
    assert.equal(items[0].status,status);
    assert.deepEqual(items[0].sync,device.sync);
    assert.deepEqual(disconnectedDeviceIds,[]);
  };
  await report('paused');
  await report('capturing');

  const noteId=randomUUID();
  for(const [id,deviceId] of [[noteId,device.deviceId],[randomUUID(),'generated-other-phone']]){
    const note=await node.app.inject({
      method:'POST',url:'/api/notes',headers:{...headers,'x-mote-ingress-version':'2'},
      payload:{id,deviceId,deviceName:'Generated phone',platform:device.platform,capturedAt:new Date().toISOString(),text:'Generated source bar note'},
    });
    assert.equal(note.statusCode,201,note.body);
  }
  const revoked=await node.app.inject({method:'DELETE',url:url+'/'+credentialId,headers});
  assert.equal(revoked.statusCode,200,revoked.body);
  assert.ok((await inventory())[0].revokedAt);
  assert.ok((await list()).items.some(item=>item.deviceId===device.deviceId));
  const archived=await node.app.inject({url:'/api/library/browse?deviceId='+encodeURIComponent(device.deviceId),headers});
  assert.equal(archived.statusCode,200,archived.body);
  assert.deepEqual(archived.json().items.map((item:{ref:string})=>item.ref),['capture:'+noteId]);
});
