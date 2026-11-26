import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {defaultDistribution} from '../src/distribution/default.js';
import {connectionsRoutesPlugin,connectionsRouteInputContribution,connectionsRoutesContribution} from '../src/features/connections.js';

const token='generated-connections-domain-owner-0123456789';
const agent={configured:false,query:async()=>{throw Error('No model belongs to the Connections domain fixture');},close:async()=>{}};
function config(directory:string):ConfigurationPlatformOptions{return {path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1000000},server:{host:'127.0.0.1',port:0,profile:'test',allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};}
async function fixture(t:import('node:test').TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-connections-domain-'));let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{try{await node?.app.close();}finally{await rm(directory,{recursive:true,force:true});}});
 const build=async(distribution=defaultDistribution)=>{
  await node?.app.close();node=undefined;node=await buildApp(config(directory),{distribution,agent,backgroundWorker:false});
  const origin=await node.app.listen({host:'127.0.0.1',port:0});
  const request=async(method:string,path:string,authorization:string|undefined=token,payload?:unknown)=>{
   const response=await fetch(origin+path,{method,headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),'x-mote-ingress-version':'2',...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),body=await response.text();
   return {status:response.status,body,json:()=>body?JSON.parse(body):undefined};
  };
  return {node,origin,request};
 };
 return {directory,build};
}

for(const omitted of ['feature','plugin','both'] as const)test(`omitting Connections ${omitted} opens no input/factory/routes and retains the developer selection rule`,{timeout:120000},async t=>{
 const f=await fixture(t);let calls=0;
 const sentinel={...connectionsRoutesPlugin,activation:{...connectionsRoutesPlugin.activation!,create(){calls++;throw Error('Unselected Connections factory ran');}}};
 const distribution={...defaultDistribution,features:omitted==='plugin'?defaultDistribution.features:defaultDistribution.features.filter(id=>id!=='mote.connections'),plugins:defaultDistribution.plugins.flatMap(plugin=>plugin.contribution.id!==connectionsRoutesContribution.id?[plugin]:omitted==='feature'?[sentinel]:[])};
 const {node,request}=await f.build(distribution);
 for(const path of ['/api/connections','/api/connections/self'])assert.equal((await request('GET',path)).status,404,path);
 assert.equal((await request('POST','/api/connections/redeem',token,{})).status,404);
 assert.equal(calls,0);assert.equal(node.bootstrap.snapshot().contributions.some(row=>[connectionsRoutesContribution.id,connectionsRouteInputContribution.id].includes(row.identity.contributionId)),false);
 assert.equal(node.featureRoutes.registry.inventory().capabilities.some(row=>row.featureId==='mote.connections'),false);
 assert.equal((await request('GET','/api/developer')).status,omitted==='plugin'?200:404,'developer access remains selected by mote.connections alone');
 assert.equal((await request('GET','/api/health')).status,200);
});

test('selected Connections uses the original authorization owner and actual HTTP pairing/collector checks in its fixed slot',{timeout:120000},async t=>{
 const f=await fixture(t),{node,origin,request}=await f.build();
 assert.equal(node.connections,node.authorizationPlatform.trusted().connections);
 for(const id of [connectionsRouteInputContribution.id,connectionsRoutesContribution.id])assert.equal(node.bootstrap.snapshot().contributions.filter(row=>row.identity.contributionId===id).length,1,id);
 const order=node.featureRoutes.registry.inventory().features.map(row=>row.id),at=order.indexOf('mote.connections');assert.ok(at>=0);assert.equal(order[at+1],'mote.developer-access');
 assert.equal((await request('POST','/api/connections/invitations','',{serverUrl:origin,label:'Generated owner'})).status,401);
 const ownerInvitation=await request('POST','/api/connections/invitations',token,{serverUrl:origin,label:'Generated owner'});assert.equal(ownerInvitation.status,200,ownerInvitation.body);assert.equal(ownerInvitation.body.includes(token),false);
 const owner=await request('POST','/api/connections/redeem','',{code:ownerInvitation.json().invitation.code,deviceId:'generated-owner-device',deviceName:'Generated owner',platform:'android'});assert.equal(owner.status,200,owner.body);assert.equal(owner.json().scope,'owner');
 const invitation=await request('POST','/api/connections/collector-invitations',owner.json().token,{serverUrl:origin,label:'Generated collector'});assert.equal(invitation.status,200,invitation.body);
 const collector=await request('POST','/api/connections/redeem','',{code:invitation.json().invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'});assert.equal(collector.status,200,collector.body);assert.equal(collector.json().scope,'collector');
 const credential=collector.json(),self=await request('GET','/api/connections/self',credential.token);assert.equal(self.status,200);assert.equal(self.json().credential.id,credential.credentialId);assert.equal(self.json().capabilities.archiveRead,false);
 assert.equal((await request('GET','/api/connections',credential.token)).status,403);assert.equal((await request('POST','/api/connections/invitations',credential.token,{serverUrl:origin,label:'Denied'})).status,403);
 const note={id:randomUUID(),deviceId:'generated-collector',deviceName:'Generated collector',platform:'android',capturedAt:new Date().toISOString(),text:'Generated collector note through unchanged owner checks'};
 assert.equal((await request('POST','/api/notes',credential.token,note)).status,201);
 assert.equal((await request('POST','/api/notes',credential.token,{...note,id:randomUUID(),deviceId:'generated-other-device'})).status,403);
 assert.equal((await request('GET','/api/notes/'+note.id,owner.json().token)).json().ocrText,note.text);
 assert.equal((await request('DELETE','/api/connections/'+credential.credentialId,owner.json().token)).status,200);assert.equal((await request('GET','/api/connections/self',credential.token)).status,401);
 assert.equal((await request('GET','/api/developer',owner.json().token)).status,200);
});

test('Connections domain withdrawal affects only its routes; reselect/restart retains connection state and sibling Notes/developer access',{timeout:120000},async t=>{
 const f=await fixture(t),selected={...defaultDistribution,features:defaultDistribution.features};
 const first=await f.build(selected),invitation=await first.request('POST','/api/connections/collector-invitations',token,{serverUrl:first.origin,label:'Generated retained collector'});
 const paired=await first.request('POST','/api/connections/redeem','',{code:invitation.json().invitation.code,deviceId:'generated-retained',deviceName:'Generated retained',platform:'android'});assert.equal(paired.status,200,paired.body);
 const saved=paired.json(),domains=await first.node.bootstrap.activateDomains();assert.equal(domains.routes.filter(route=>route.id==='mote.connections').length,1);
 await domains.quiesce();assert.equal((await first.request('GET','/api/connections/self',saved.token)).status,503);
 await domains.close();assert.equal((await first.request('GET','/api/connections',token)).status,503);
 assert.equal((await first.request('GET','/api/developer')).status,200);assert.equal(first.node.connections.authenticate('Bearer '+saved.token)?.id,saved.credentialId,'route withdrawal did not close the authorization-owned Connections');
 const note={id:randomUUID(),deviceId:'generated-retained',deviceName:'Generated retained',platform:'android',capturedAt:new Date().toISOString(),text:'Generated retained sibling note'};
 assert.equal((await first.request('POST','/api/notes',saved.token,note)).status,201);
 const omitted=await f.build({...selected,features:selected.features.filter(id=>id!=='mote.connections')});assert.equal((await omitted.request('GET','/api/connections/self')).status,404);assert.equal((await omitted.request('GET','/api/developer')).status,404);
 const omittedNotes=await omitted.request('GET','/api/notes');assert.equal(omittedNotes.status,200,omittedNotes.body);assert.deepEqual(omittedNotes.json().items.map((row:{id:string;ocrText:string})=>({id:row.id,text:row.ocrText})),[{id:note.id,text:note.text}]);
 const restored=await f.build(selected);assert.equal((await restored.request('GET','/api/connections/self',saved.token)).json().credential.id,saved.credentialId);assert.equal((await restored.request('GET','/api/developer')).status,200);
 const restoredNotes=await restored.request('GET','/api/notes');assert.equal(restoredNotes.status,200,restoredNotes.body);assert.deepEqual(restoredNotes.json().items.map((row:{id:string;ocrText:string})=>({id:row.id,text:row.ocrText})),[{id:note.id,text:note.text}]);
 assert.equal(restored.node.bootstrap.snapshot().contributions.filter(row=>row.identity.contributionId===connectionsRoutesContribution.id).length,1);
});

test('selected Connections requires its actual input binding and failed startup can reopen the same generated profile',{timeout:120000},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.build({...defaultDistribution,plugins:defaultDistribution.plugins.filter(plugin=>plugin.contribution.id!==connectionsRouteInputContribution.id)}),/Connections routes require their input provider/);
 const restored=await f.build();assert.equal((await restored.request('GET','/api/connections/self')).status,200);
});
