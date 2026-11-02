import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildApp} from '../src/app.js';
import {closeSourcePlatforms} from '../src/platform-close-order.js';
import type {Config} from '../src/config.js';

const note=(deviceId='generated-notes-device')=>({id:randomUUID(),deviceId,deviceName:'Generated notes device',platform:'android',capturedAt:'2026-11-03T00:00:00.000Z',text:'Generated ROOTS-2 note body'});

test('real buildApp Notes journey uses one C10A ingress and C04 pin, then closes',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-roots-notes-'));
  const config:Config={dataDir,token:'generated-roots-notes-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in roots notes fixture');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  assert.equal(node.featureServices.ingress,node.captureIntake.ingress);
  assert.equal(node.featureServices.files,node.filesPlatform.assemblyForRoutes().files);
  const headers={authorization:`Bearer ${config.token}`},input=note();
  const created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:input});
  assert.equal(created.statusCode,201,created.body);assert.equal(created.json().receipt.state,'received');
  const listed=await node.app.inject({url:'/api/notes',headers});assert.equal(listed.statusCode,200,listed.body);
  assert.ok(listed.json().items.some((item:any)=>item.id===input.id&&item.attributionContext));
  assert.deepEqual((await node.app.inject({method:'DELETE',url:'/api/notes/'+input.id,headers})).json(),{deleted:1});
  const connections=node.authorizationPlatform.assembly.connections!;
  const invitation=connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector',deviceId:'generated-notes-device'},'collector');
  const paired=await connections.redeem({code:invitation.invitation.code,deviceId:'generated-notes-device',deviceName:'Generated notes device',platform:'android'});
  const collector={authorization:'Bearer '+paired.token,'x-mote-ingress-version':'2'};
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note()})).statusCode,201);
  assert.equal((await node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note('generated-other-device')})).statusCode,403);
  await connections.revoke(paired.credentialId);
  const revoked=await node.app.inject({method:'POST',url:'/api/notes',headers:collector,payload:note()});assert.ok([401,403].includes(revoked.statusCode),revoked.body);
  await node.app.close();assert.throws(()=>node.store.stats());
});

test('authorization startup failure clears the started FilesSource sweep timer',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-roots-notes-fail-')),connectors=join(dataDir,'connectors');mkdirSync(connectors,{recursive:true});writeFileSync(join(connectors,'client-connections.json'),'generated malformed json');
  const config:Config={dataDir,token:'generated-roots-notes-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const set=globalThis.setInterval,clear=globalThis.clearInterval,active=new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval=((fn:TimerHandler,ms?:number,...args:unknown[])=>{const timer=set(fn,ms,...args);active.add(timer);return timer;}) as typeof setInterval;
  globalThis.clearInterval=((timer?:ReturnType<typeof setInterval>)=>{if(timer)active.delete(timer);clear(timer);}) as typeof clearInterval;
  t.after(()=>{globalThis.setInterval=set;globalThis.clearInterval=clear;rmSync(dataDir,{recursive:true,force:true});});
  try{await assert.rejects(buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model');},close:async()=>{}}}));}
  finally{globalThis.setInterval=set;globalThis.clearInterval=clear;}
  assert.equal(active.size,0,'startup failure must clear the C11 sweep timer');
});

test('an authenticated request aborted over a real socket releases its C04 pin',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-roots-notes-abort-'));
  const config:Config={dataDir,token:'generated-roots-notes-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in roots abort fixture');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  await node.app.listen({host:'127.0.0.1',port:0});
  const {port}=node.app.server.address() as AddressInfo;
  let observed=false;
  const client=http.request({host:'127.0.0.1',port,path:'/api/notes',method:'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json','content-length':'512'}});
  client.on('error',()=>{});
  client.write('{"id":"partial');
  for(let i=0;i<200&&!observed;i++){observed=node.liveRequestPins()>0;if(!observed)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok(observed,'the interrupted request must have bound a C04 pin before aborting');
  client.destroy();
  for(let i=0;i<200&&node.liveRequestPins()>0;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(node.liveRequestPins(),0,'an aborted request must release its C04 pin');
});


test('source shutdown quiesces C09 before C05 interruption and keeps accepted Memory authorized',async()=>{
  const events:string[]=[];
  let memoryAllowed=true,duringStop:boolean|undefined,decisionTakenDuringSourceDrain:boolean|undefined,sourceDrainStarted=false;
  let releaseMemory!:()=>void;const memoryWork=new Promise<void>(resolve=>{releaseMemory=resolve;});
  const chain={
    authorization:{quiesce:()=>{events.push('authorization.quiesce');}},
    capture:{quiesce:()=>{events.push('capture.quiesce');},close:async()=>{events.push('capture.close');}},
    files:{close:async()=>{events.push('files.close');}},
    source:{
      quiesce:()=>{events.push('source.quiesce');releaseMemory();},
      close:async()=>{
        // Retiring authority happens here, and only after C05 has stopped.
        sourceDrainStarted=true;memoryAllowed=false;events.push('source.close');
      },
    },
    execution:{stop:async()=>{
      events.push('execution.stop');
      // A Memory batch accepted before shutdown completes while C05 drains.
      await memoryWork;duringStop=memoryAllowed;
      decisionTakenDuringSourceDrain=sourceDrainStarted;
    }},
  };
  await closeSourcePlatforms(chain);
  assert.deepEqual(events,['authorization.quiesce','capture.quiesce','capture.close','files.close','source.quiesce','execution.stop','source.close']);
  assert.equal(duringStop,true,'accepted Memory work must keep source authority through the C05 interruption');
  assert.equal(decisionTakenDuringSourceDrain,false,'the runtime must not be retiring authority while C05 drains accepted work');
  assert.equal(memoryAllowed,false,'the runtime retires its authority only after C05 stops');
});
