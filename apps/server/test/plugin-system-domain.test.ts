import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {defaultDistribution} from '../src/distribution/default.js';
import type {Config} from '../src/config.js';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {MOTE_PROTOCOL_RANGE} from '@mote/shared';
import {createDomainActivations} from '../src/domain-activation.js';
import {FeatureScope} from '../src/features/index.js';
import {systemHealthPlugin,systemHealthContribution} from '../src/plugins/system-domain.js';

const agent={configured:false,query:async()=>{throw Error('No model in generated System fixture');},close:async()=>{}};
const token='generated-system-domain-owner-token';
function config(dataDir:string):Config{return {dataDir,token,tokenPath:'generated-system-domain',host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};}

test('a missing selected System plugin cannot borrow a legacy Host health route',{timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-system-domain-'));let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{await node?.app.close();await rm(root,{recursive:true,force:true});});
 node=await buildApp(config(root),{agent,backgroundWorker:false,distribution:{...defaultDistribution,plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!=='system-health')}});
 const origin=await node.app.listen({host:'127.0.0.1',port:0}),response=await fetch(origin+'/api/health',{headers:{authorization:'Bearer '+token}});
 assert.equal(response.status,404,'only the registered System activation can contribute health');
 assert.equal(node.bootstrap.snapshot().contributions.some(item=>item.identity.contributionId==='system-health'),false);
});


async function fixture(t:import('node:test').TestContext,distribution=defaultDistribution){
 const root=await mkdtemp(join(tmpdir(),'mote-system-domain-'));let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{await node?.app.close();await rm(root,{recursive:true,force:true});});
 node=await buildApp(config(root),{agent,backgroundWorker:false,distribution});const origin=await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(method:string,path:string,authorization?:string,payload?:unknown)=>{const response=await fetch(origin+path,{method,headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const body=await response.text();return {status:response.status,headers:response.headers,json:()=>JSON.parse(body),body};};
 return {root,node,origin,request};
}

test('default System declaration owns the unchanged anonymous, owner and collector health payload',{timeout:120000},async t=>{
 const {node,origin,request}=await fixture(t),version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
 assert.equal(node.bootstrap.snapshot().contributions.filter(item=>item.identity.contributionId===systemHealthContribution.id).length,1);
 const invitation=await request('POST','/api/connections/collector-invitations',token,{serverUrl:origin,label:'Generated System collector'});assert.equal(invitation.status,200,invitation.body);
 const redeemed=await request('POST','/api/connections/redeem',undefined,{code:invitation.json().invitation.code,deviceId:'generated-system-device',deviceName:'Generated System collector',platform:'android'});assert.equal(redeemed.status,200,redeemed.body);
 assert.equal(redeemed.json().scope,'collector');
 for(const authorization of [undefined,token,redeemed.json().token,'generated-invalid-bearer']){
  const health=await request('GET','/api/health',authorization);assert.equal(health.status,200,health.body);assert.deepEqual(health.json(),{ok:true,version,protocol:MOTE_PROTOCOL_RANGE});assert.equal(health.headers.get('cache-control'),'no-store');
 }
 assert.equal((await request('HEAD','/api/health')).status,200);
 assert.equal((await request('GET','/api/status')).status,401);assert.equal((await request('GET','/api/status',redeemed.json().token)).status,403);
 const inventory=await request('GET','/api/features',token);assert.equal(inventory.status,200,inventory.body);assert.ok(inventory.json().capabilities.some((item:any)=>item.featureId==='mote.system'&&item.id==='http:GET:/api/health'&&item.state==='active'));
 assert.equal(node.featureServices.serverVersion,version);
});

for(const omitted of ['feature','plugin','both'] as const)test(`omitting the System ${omitted} never opens its activation or mounts health`,{timeout:120000},async t=>{
 let calls=0;const original=systemHealthPlugin;
 const guarded={...original,activation:{...original.activation!,create(){calls++;throw Error('An unselected System factory ran');}}};
 const distribution={...defaultDistribution,features:omitted==='plugin'?defaultDistribution.features:defaultDistribution.features.filter(id=>id!=='mote.system'),plugins:defaultDistribution.plugins.flatMap(plugin=>plugin.contribution.id!==original.contribution.id?[plugin]:omitted==='feature'?[guarded]:[])};
 const {node,request}=await fixture(t,distribution);
 assert.equal((await request('GET','/api/health',token)).status,404);assert.equal(calls,0);assert.equal(node.bootstrap.snapshot().contributions.some(item=>item.identity.contributionId===original.contribution.id),false);
 const inventory=await request('GET','/api/features',token);assert.equal(inventory.status,200);assert.ok(!inventory.json().capabilities.some((item:any)=>item.featureId==='mote.system'&&item.id.startsWith('http:')));
});

test('the resource-free System activation uses only the common Host lifecycle and becomes unavailable on withdrawal',async t=>{
 let stateAccess=0;const host=new PluginHost({kind:'central',id:'generated-system-only'},undefined,undefined,{stateFor(){stateAccess++;throw Error('System health cannot open persistence');}}),app=Fastify(),scope=new FeatureScope();
 const registry=createDomainActivations(host,[systemHealthPlugin],['mote.system']),domains=await registry.activate();
 t.after(async()=>{await domains.close();await scope.close();await app.close();await host.close();});
 assert.equal(domains.routes.length,1);domains.routes[0]!.mount(app,scope);
 const health=await app.inject('/api/health');assert.equal(health.statusCode,200,health.body);assert.equal(health.json().ok,true);assert.equal((await app.inject('/api/status')).statusCode,404);assert.equal((await app.inject('/api/diagnostics')).statusCode,404);assert.equal(stateAccess,0);
 await domains.quiesce();assert.equal((await app.inject('/api/health')).statusCode,503);
 await domains.close();assert.equal((await app.inject('/api/health')).statusCode,503);assert.equal(host.snapshot().contributions.length,0);assert.equal(stateAccess,0);
});
