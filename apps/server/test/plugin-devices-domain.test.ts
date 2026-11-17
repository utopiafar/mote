import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {HostScope} from '@mote/plugin-host';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {defaultDistribution} from '../src/distribution/default.js';
import {devicesSourcePlugin} from '../src/plugins/devices-domain.js';
import {sha256} from '../src/store.js';

const token='generated-devices-domain-owner',agent={configured:false,query:async()=>{throw Error('No model in generated Devices domain');},close:async()=>{}};
const beat=(depth=3)=>({deviceId:'generated-domain-phone',deviceName:'Generated Devices phone',platform:'android',status:'capturing',queueDepth:depth});
const note=()=>({id:randomUUID(),deviceId:'generated-domain-phone',deviceName:'Generated Devices phone',platform:'android',capturedAt:new Date().toISOString(),text:'Generated sibling note remains authorized'});
async function fixture(t:TestContext,omitted?:'feature'|'plugin'|'both'){
 const root=await mkdtemp(join(tmpdir(),'mote-devices-domain-'));
 const config:Config={dataDir:root,token,tokenPath:'generated-devices-domain',host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 let scope:HostScope|undefined,creates=0,starts=0,disposes=0,timers=0;const releases:(()=>void)[]=[];
 const tracked={...devicesSourcePlugin,activation:{...devicesSourcePlugin.activation!,async create(context:Parameters<NonNullable<typeof devicesSourcePlugin.activation>['create']>[0],bindings:Parameters<NonNullable<typeof devicesSourcePlugin.activation>['create']>[1]){
  creates++;if(omitted)throw Error('Unselected Devices factory ran');scope=context.scope;
  const active=await devicesSourcePlugin.activation!.create({...context,scope:{...context.scope,every(...args){timers++;return context.scope.every(...args);}}},bindings);
  return {...active,start(){starts++;return active.start();},dispose(){disposes++;return active.dispose();}};
 }}};
 const distribution={...defaultDistribution,features:omitted==='feature'||omitted==='both'?defaultDistribution.features.filter(id=>id!=='mote.devices'):defaultDistribution.features,plugins:defaultDistribution.plugins.flatMap(plugin=>plugin.contribution.id!=='devices-source'?[plugin]:omitted==='plugin'||omitted==='both'?[]:[tracked])};
 let node=await buildApp(config,{agent,backgroundWorker:false,distribution});
 const holds=new Map<string,{entered:ReturnType<typeof Promise.withResolvers<void>>;release:ReturnType<typeof Promise.withResolvers<void>>}>();
 const hook=()=>node.app.addHook('preHandler',async req=>{const key=req.headers['x-generated-hold'];if(typeof key!=='string')return;const held=holds.get(key);if(!held)return;held.entered.resolve();await held.release.promise;});hook();
 let origin=await node.app.listen({host:'127.0.0.1',port:0});
 t.after(async()=>{for(const release of releases)release();await node.app.close();await rm(root,{recursive:true,force:true});});
 const request=async(method:string,path:string,payload?:unknown,authorization:string|undefined=token,extra:Record<string,string>={})=>{const response=await fetch(origin+path,{method,headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),'x-mote-ingress-version':'2',...(payload===undefined?{}:{'content-type':Buffer.isBuffer(payload)?'application/octet-stream':'application/json'}),...extra},...(payload===undefined?{}:{body:Buffer.isBuffer(payload)?new Uint8Array(payload):JSON.stringify(payload)})});const bytes=Buffer.from(await response.arrayBuffer());return {status:response.status,body:bytes.toString(),bytes,json:()=>JSON.parse(bytes.toString())};};
 const pair=async()=>{const invitation=await request('POST','/api/connections/collector-invitations',{serverUrl:origin,label:'Generated Devices collector'});assert.equal(invitation.status,200,invitation.body);const redeemed=await request('POST','/api/connections/redeem',{code:invitation.json().invitation.code,deviceId:'generated-domain-phone',deviceName:'Generated Devices phone',platform:'android'},'');assert.equal(redeemed.status,200,redeemed.body);return redeemed.json() as {token:string;credentialId:string};};
 return {config,get node(){return node;},get scope(){assert.ok(scope);return scope;},counts:()=>({creates,starts,disposes,timers}),request,pair,
  hold(key:string){const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();holds.set(key,{entered,release});releases.push(()=>release.resolve());return {entered:entered.promise,release:()=>release.resolve()};},
  async restart(){await node.app.close();node=await buildApp(config,{agent,backgroundWorker:false,distribution});hook();origin=await node.app.listen({host:'127.0.0.1',port:0});},
 };
}

test('Devices declaration owns heartbeat and first-data over existing collector pins and survives restart/revocation', {timeout:120000},async t=>{
 const f=await fixture(t),paired=await f.pair();assert.deepEqual(f.counts(),{creates:1,starts:1,disposes:0,timers:0});
 assert.equal((await f.request('POST','/api/devices/heartbeat',beat(),'')).status,401);
 assert.equal((await f.request('POST','/api/devices/heartbeat',beat(),paired.token)).status,200);
 const before=f.node.store.devices();assert.equal((await f.request('POST','/api/devices/heartbeat',{...beat(),deviceId:'generated-foreign'},paired.token)).status,403);assert.equal((await f.request('POST','/api/devices/heartbeat',{...beat(),platform:'macos'},paired.token)).status,403);assert.deepEqual(f.node.store.devices(),before);
 assert.equal((await f.request('GET','/api/devices/first-data',undefined,paired.token)).status,403);
 const original=note();assert.equal((await f.request('POST','/api/notes',original,paired.token)).status,201);assert.equal((await f.request('GET','/api/devices/first-data')).json().candidate.id,original.id);
 const activation=f.scope.identity.activationId;await f.restart();assert.notEqual(f.scope.identity.activationId,activation);assert.equal((await f.request('GET','/api/devices')).json().items[0].deviceId,beat().deviceId);assert.equal((await f.request('GET','/api/devices/first-data')).json().candidate.id,original.id);
 const held=f.hold('revoked');const pending=f.request('POST','/api/devices/heartbeat',beat(99),paired.token,{'x-generated-hold':'revoked'});await held.entered;
 const preserved=f.node.store.devices();const revoked=await f.request('DELETE','/api/connections/'+paired.credentialId);assert.equal(revoked.status,200,revoked.body);held.release();assert.equal((await pending).status,401);assert.deepEqual(f.node.store.devices(),preserved);assert.equal((await f.request('POST','/api/devices/heartbeat',beat(5),paired.token)).status,401);assert.equal((await f.request('POST','/api/devices/heartbeat',beat(5))).status,200);assert.equal(f.node.liveRequestPins(),0);
});

for(const omitted of ['feature','plugin','both'] as const)test('omitting Devices '+omitted+' creates no owner/source/timer and retains sibling routes', {timeout:120000},async t=>{
 const f=await fixture(t,omitted);assert.deepEqual(f.counts(),{creates:0,starts:0,disposes:0,timers:0});assert.equal((await f.request('GET','/api/devices')).status,404);assert.equal((await f.request('GET','/api/devices/first-data')).status,404);assert.equal((await f.request('POST','/api/devices/heartbeat',beat())).status,404);
 assert.ok(!f.node.bootstrap.snapshot().contributions.some(c=>['devices-source','devices-source-factory'].includes(c.identity.contributionId)));
 assert.equal((await f.request('POST','/api/notes',note())).status,201);assert.equal((await f.request('GET','/api/health',undefined,'')).status,200);
 assert.ok(f.node.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='devices'").get(),'Vault shared device state is not removed with this domain');
});

test('closing the real Devices owner fences admitted heartbeat and attachment view while Notes/Capture/Files stay live', {timeout:120000},async t=>{
 const f=await fixture(t),paired=await f.pair();assert.equal((await f.request('POST','/api/devices/heartbeat',beat(),paired.token)).status,200);
 const source={id:'generated-domain-files',name:'Generated attachment source',kind:'local-files',deviceId:beat().deviceId,platform:'android',retention:'archive'};assert.equal((await f.request('POST','/api/sources',source,paired.token)).status,200);
 const bytes=Buffer.from('Generated retained attachment bytes'),observedAt=new Date().toISOString();
 const begun=await f.request('POST','/api/file-sync/v1/uploads',{sourceId:source.id,previousRevision:null,relativePath:'generated.txt',sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:'generated.txt',revision:'1',observedAt,title:'Generated attachment',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false}},paired.token);assert.equal(begun.status,200,begun.body);
 const uploadId=begun.json().uploadId;assert.equal((await f.request('PUT','/api/file-sync/v1/uploads/'+uploadId+'/parts/0',bytes,paired.token)).status,200);const committed=await f.request('POST','/api/file-sync/v1/uploads/'+uploadId+'/commit',{},paired.token);assert.equal(committed.status,200,committed.body);const fileId=committed.json().id;
 const input={id:randomUUID(),deviceId:beat().deviceId,deviceName:beat().deviceName,platform:'android',source:'note',capturedAt:observedAt,durationMs:0,ocrText:'Generated attachment-backed device original',metadata:{version:1,observedAt,attachments:[fileId]}};assert.equal((await f.request('POST','/api/captures',input,paired.token)).status,201);
 const first=await f.request('GET','/api/devices/first-data');assert.equal(first.status,200,first.body);assert.equal(first.json().state,'ready');
 const hb=f.hold('heartbeat'),read=f.hold('first-data');const pendingHeartbeat=f.request('POST','/api/devices/heartbeat',beat(99),paired.token,{'x-generated-hold':'heartbeat'}),pendingRead=f.request('GET','/api/devices/first-data',undefined,token,{'x-generated-hold':'first-data'});await Promise.all([hb.entered,read.entered]);
 const before=f.node.store.devices();await f.scope.cordis.fiber.dispose();assert.equal(f.scope.signal.aborted,true);hb.release();read.release();const [lateBeat,lateRead]=await Promise.all([pendingHeartbeat,pendingRead]);assert.equal(lateBeat.status,503,lateBeat.body);assert.equal(lateRead.status,503,lateRead.body);assert.deepEqual(f.node.store.devices(),before);assert.equal(f.node.liveRequestPins(),0);
 assert.equal((await f.request('GET','/api/devices')).status,503);assert.ok(!f.node.bootstrap.snapshot().contributions.some(c=>c.identity.contributionId==='devices-source'));assert.equal(f.counts().disposes,1);
 assert.equal((await f.request('POST','/api/notes',note(),paired.token)).status,201);const next={...input,id:randomUUID()};assert.equal((await f.request('POST','/api/captures',next,paired.token)).status,201);const original=await f.request('GET','/api/files/'+fileId+'/content');assert.equal(original.status,200,original.body);assert.deepEqual(original.bytes,bytes);
});

test('withdrawing the Devices HTTP scope closes its actual owner and reselection opens a new activation', {timeout:120000},async t=>{
 const f=await fixture(t);assert.equal((await f.request('POST','/api/devices/heartbeat',beat())).status,200);const activation=f.scope.identity.activationId,prior=f.node.store.devices();
 await f.node.featureRoutes.dispose('mote.devices');assert.equal(f.scope.signal.aborted,true);assert.equal(f.counts().disposes,1);assert.equal((await f.request('GET','/api/devices')).status,503);assert.deepEqual(f.node.store.devices(),prior);
 await f.restart();assert.notEqual(f.scope.identity.activationId,activation);assert.equal((await f.request('GET','/api/devices')).status,200);assert.equal((await f.request('POST','/api/devices/heartbeat',beat(7))).status,200);assert.equal(f.node.store.devices()[0]!.queueDepth,7);
});
