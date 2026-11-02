import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyRequest} from 'fastify';
import {captureSchema,heartbeatSchema,type CaptureInput,type Heartbeat} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {firstDeviceData} from '../src/first-device-data.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import type {RequestAuthority} from '../src/plugins/central-contracts.js';
import {createDevicesSource,createDevicesSourceFactory,devicesSourceContribution,devicesSourceDeclaration,devicesSourceReplacement} from '../src/plugins/devices-source.js';
import type {ConnectionCredential} from '../src/connections.js';

const ownerToken='generated-devices-owner-token';
const beat=(deviceId='generated-phone',platform:'android'|'macos'='android'):Heartbeat=>heartbeatSchema.parse({deviceId,deviceName:'Generated device',platform,status:'capturing',queueDepth:3,lastCaptureAt:'2026-09-14T12:00:00.000Z'});
const capture=(deviceId='generated-phone'):CaptureInput=>captureSchema.parse({id:randomUUID(),deviceId,deviceName:'Generated phone',platform:'android',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated first data original'});

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-devices-source-'));
  const store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store);
  const reader=new EvidenceReader(store,sources,files);
  const platform=createAuthorizationPlatform({ownerToken},{store,availableModelConnections:()=>[]});
  await platform.prepare();platform.bindRepositories({sources,files,materials});await platform.start();
  const pins=new WeakMap<FastifyRequest,RequestAuthority>(),credentials=new WeakMap<RequestAuthority,ConnectionCredential|undefined>();
  const intake=createDevicesSource({recordQueueSnapshot:()=>{}}, {
    devices:{heartbeat:value=>store.heartbeat(value),devices:()=>store.devices()},
    firstData:()=>firstDeviceData(store,files,reader),
    authority:platform,
    identity:{
      assertOwnDevice:(request,value)=>platform.requests.assertOwnDevice(request,value),
      assertOwnPlatform:(request,value)=>{const credential=credentials.get(request);if(credential)platform.assembly.connections!.assertPlatform(credential,value);},
    },
  });
  intake.start();
  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>{const value=error as Error&{statusCode?:number;status?:number;code?:string};reply.code(value.statusCode??value.status??500).send({error:value.code??'devices_failed'});});
  app.addHook('onRequest',async request=>{
    const credential=platform.assembly.connections!.authenticate(request.headers.authorization),pin=platform.bindRequest({authorization:request.headers.authorization,method:request.method,route:request.routeOptions.url!,params:request.params as {id?:string},origin:request.headers.origin});
    pins.set(request,pin);credentials.set(pin,credential);
  });
  app.addHook('onResponse',async request=>{const pin=pins.get(request);if(pin)platform.releaseRequest(pin);});
  intake.routes(app,{request:request=>pins.get(request)});
  t.after(async()=>{await app.close();await intake.close();await platform.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated-phone',platform:'android',enabled:true,retention:'archive'});
  const post=(url:string,token:string,payload:unknown)=>app.inject({method:'POST',url,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},payload:JSON.stringify(payload)});
  const get=(url:string,headers:Record<string,string>={authorization:`Bearer ${ownerToken}`})=>app.inject({url,headers});
  const upload=async(sourceId:string,name:string,bytes:Buffer)=>{const pending=files.begin({sourceId,item:{externalId:name,revision:'1',observedAt:new Date().toISOString(),title:name,kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});files.part(pending.uploadId,0,bytes,()=>{});return (await files.commit(pending.uploadId,()=>{})).id;};
  return {store,sources,files,platform,intake,app,post,get,upload,beat,capture};
}

test('owner and collector heartbeats write only the admitted device and stay listable',async t=>{
  const f=await fixture(t);
  assert.equal((await f.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:{'content-type':'application/json'},payload:JSON.stringify(f.beat())})).statusCode,401);
  const owner=await f.post('/api/devices/heartbeat',ownerToken,f.beat());
  assert.equal(owner.statusCode,200,owner.body);
  assert.deepEqual(owner.json(),{ok:true});
  const invitation=f.platform.assembly.connections!.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-phone'},'collector');
  const paired=await f.platform.assembly.connections!.redeem({code:invitation.invitation.code,deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'});
  const collector=await f.post('/api/devices/heartbeat',paired.token,f.beat());
  assert.equal(collector.statusCode,200,collector.body);
  const listed=await f.get('/api/devices');
  assert.equal(listed.statusCode,200,listed.body);
  assert.deepEqual(listed.json().items.map((item:{deviceId:string})=>item.deviceId),['generated-phone']);
  assert.equal(listed.json().items[0].queueDepth,3);
});

test('cross-device, platform and revoked late heartbeats are 403 without changing stored stats',async t=>{
  const f=await fixture(t),before=f.store.devices();
  const invitation=f.platform.assembly.connections!.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-phone'},'collector');
  const paired=await f.platform.assembly.connections!.redeem({code:invitation.invitation.code,deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'});
  const cross=await f.post('/api/devices/heartbeat',paired.token,f.beat('generated-other'));
  assert.equal(cross.statusCode,403,cross.body);
  const platformMismatch=await f.post('/api/devices/heartbeat',paired.token,f.beat('generated-phone','macos'));
  assert.equal(platformMismatch.statusCode,403,platformMismatch.body);
  assert.deepEqual(f.store.devices(),before,'rejected collector beats write nothing');
  await f.platform.assembly.connections!.revoke(paired.credentialId);
  const late=await f.post('/api/devices/heartbeat',paired.token,f.beat());
  assert.ok([401,403].includes(late.statusCode),late.body);
  assert.deepEqual(f.store.devices(),before);
  const owner=await f.post('/api/devices/heartbeat',ownerToken,f.beat());
  assert.equal(owner.statusCode,200,owner.body);
});

test('quiescing rejects new heartbeats while archived devices and reads remain',async t=>{
  const f=await fixture(t);
  assert.equal((await f.post('/api/devices/heartbeat',ownerToken,f.beat())).statusCode,200);
  const stored=f.store.devices();
  f.intake.quiesce('shutdown');
  const rejected=await f.post('/api/devices/heartbeat',ownerToken,f.beat());
  assert.equal(rejected.statusCode,503,rejected.body);
  assert.deepEqual(f.store.devices(),stored,'a rejected beat never overwrites archived state');
  const listed=await f.get('/api/devices');
  assert.equal(listed.statusCode,200,listed.body);
  assert.equal(listed.json().items.length,1);
  await f.intake.close();
  assert.equal((await f.get('/api/devices')).statusCode,503);
  assert.deepEqual(f.store.devices(),stored,'closing the plugin retains archived devices');
});

test('real collector heartbeat and original evidence feed the owner-only first-data view',async t=>{
  const f=await fixture(t);
  const invitation=f.platform.assembly.connections!.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-phone'},'collector');
  const paired=await f.platform.assembly.connections!.redeem({code:invitation.invitation.code,deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'});
  assert.equal((await f.post('/api/devices/heartbeat',paired.token,f.beat())).statusCode,200);
  const waiting=await f.get('/api/devices/first-data');
  assert.equal(waiting.statusCode,200,waiting.body);
  assert.equal(waiting.json().state,'unverified','pairing and heartbeat alone never count as first data');

  const fileId=await f.upload('generated-source','generated-first.txt',Buffer.from('Generated original bytes'));
  const input=f.capture();input.metadata={version:1,observedAt:input.capturedAt,attachments:[fileId]};
  const pin=f.platform.bindRequest({authorization:`Bearer ${ownerToken}`,method:'POST',route:'/api/captures'});
  try{await f.platform.withCapture(pin,input,()=>f.platform.captureIntake.capture(input,f.platform.commits.capture()));}finally{f.platform.releaseRequest(pin);}
  const ready=await f.get('/api/devices/first-data');
  assert.equal(ready.statusCode,200,ready.body);
  const view=ready.json() as {state:string;originalAvailable:boolean;candidate?:{deviceId:string;source:string;id:string}};
  assert.equal(view.state,'ready');
  assert.equal(view.originalAvailable,true);
  assert.equal(view.candidate?.deviceId,'generated-phone');
  assert.equal(view.candidate?.source,'note');
  assert.equal(view.candidate?.id,input.id);
  const collectorDenied=await f.get('/api/devices/first-data',{authorization:`Bearer ${paired.token}`});
  assert.equal(collectorDenied.statusCode,403,collectorDenied.body);
});

test('factory lifecycle and contribution shape stay restart-scoped with no published service',async t=>{
  const f=await fixture(t);
  assert.equal(devicesSourceReplacement,'restart');
  assert.deepEqual(devicesSourceContribution.provides,[]);
  assert.equal(devicesSourceDeclaration.apiVersion,'1');
  const factory=createDevicesSourceFactory({}, {devices:{heartbeat:value=>f.store.heartbeat(value),devices:()=>f.store.devices()},firstData:()=>({state:'waiting',originalAvailable:false,checkedAt:new Date().toISOString(),checkedDevices:0,checkedRecords:0,windowLimited:false} as never),authority:f.platform,identity:{assertOwnDevice:()=>{},assertOwnPlatform:()=>{}}});
  const lifecycle=factory({scope:{defer:()=>{},assertCurrent:()=>{},signal:new AbortController().signal} as never,provide:()=>{throw Error('no published service expected');}} as never);
  lifecycle.prepare();
  lifecycle.start();
  lifecycle.quiesce('shutdown');
  await lifecycle.stop('shutdown');
});
