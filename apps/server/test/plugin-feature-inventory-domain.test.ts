import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {defaultDistribution} from '../src/distribution/default.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {sha256} from '../src/store.js';
import {featureInventoryPlugin} from '../src/plugins/feature-inventory-domain.js';
import {plugins as inventoryPlugins,prepareFeatureInventory} from '../src/plugins/feature-inventory-domain.js';
import Fastify from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {createDomainActivations} from '../src/domain-activation.js';
import {ServerResources} from '../src/server-resources.js';
import {FeatureScope} from '../src/features/index.js';
import {featureInventory} from '../src/feature-inventory.js';

const token='generated-inventory-domain-owner';
const agent={configured:false,query:async()=>{throw Error('No model authorized for generated inventory');},close:async()=>{}};
async function fixture(t:TestContext,distribution=defaultDistribution){
 const root=await mkdtemp(join(tmpdir(),'mote-inventory-domain-'));
 const config:ConfigurationPlatformOptions={path:(root)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated-inventory'},initialDocument:{version:1,revision:0,storage:{dataDir:root,maxExportBytes:1000000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
 const node=await buildApp(config,{agent,backgroundWorker:false,distribution});t.after(async()=>{await node.app.close();await rm(root,{recursive:true,force:true});});
 const origin=await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,authorization:string|undefined=token,method='GET',body?:unknown)=>{const response=await fetch(origin+path,{method,headers:{...(authorization?{authorization:'Bearer '+authorization}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();return {status:response.status,json:()=>JSON.parse(text),body:text};};
 return {node,origin,request};
}
test('selected inventory owns its HTTP route and reads live Agent and HTTP contributions',async t=>{
 const {node,origin,request}=await fixture(t);
 assert.equal((await request('/api/features','')).status,401);assert.equal((await request('/api/features','generated-invalid')).status,401);
 const invitation=await request('/api/connections/collector-invitations',token,'POST',{serverUrl:origin,label:'Generated inventory collector'});assert.equal(invitation.status,200,invitation.body);
 const collector=await request('/api/connections/redeem','','POST',{code:invitation.json().invitation.code,deviceId:'generated-inventory-device',deviceName:'Generated inventory collector',platform:'android'});assert.equal(collector.status,200,collector.body);assert.equal((await request('/api/features',collector.json().token)).status,403);
 const read=async()=>{const response=await request('/api/features');assert.equal(response.status,200,response.body);return response.json();};
 const before=await read();assert.equal(before.schemaVersion,1);assert.equal(before.revision,parseInt(sha256(JSON.stringify({features:before.features,capabilities:before.capabilities})).slice(0,12),16));assert.ok(before.capabilities.some((c:any)=>c.id==='http:GET:/api/features'&&c.featureId==='mote.features'&&c.state==='active'));
 assert.equal(node.bootstrap.snapshot().contributions.filter(c=>c.identity.contributionId==='feature-inventory').length,1);
 const registry=node.featureServices.agentFeatures.registry,removeFeature=registry.install({id:'generated.inventory-reader',version:'1',components:[{id:'agent:generated-inventory-read',version:'1',surface:'agent'}]}),removeTool=registry.register('generated.inventory-reader',{id:'agent:generated-inventory-read',version:'1',surface:'agent'},()=>[]);
 const added=await read();assert.notEqual(added.revision,before.revision);assert.ok(added.capabilities.some((c:any)=>c.id==='agent:generated-inventory-read'&&c.state==='active'));
 removeTool();removeFeature();const removed=await read();assert.ok(!removed.capabilities.some((c:any)=>c.id==='agent:generated-inventory-read'));assert.equal(removed.revision,before.revision);
 await node.featureRoutes.dispose('mote.notes');const withdrawn=await read();assert.ok(!withdrawn.capabilities.some((c:any)=>c.id==='http:POST:/api/notes'));assert.notEqual(withdrawn.revision,before.revision);assert.equal((await request('/api/status')).status,200);assert.equal((await request('/api/health','')).status,200);
});
for(const omitted of ['feature','plugin','both'] as const)test('unselected inventory '+omitted+' opens no factory or reader',async t=>{
 let calls=0;const guarded={...featureInventoryPlugin,activation:{...featureInventoryPlugin.activation!,create(){calls++;throw Error('Unselected inventory factory opened');}}};
 const distribution={...defaultDistribution,features:omitted==='plugin'?defaultDistribution.features:defaultDistribution.features.filter(id=>id!=='mote.features'),plugins:defaultDistribution.plugins.flatMap(plugin=>plugin.contribution.id!==featureInventoryPlugin.contribution.id?[plugin]:omitted==='feature'?[guarded]:[])};
 const {node,request}=await fixture(t,distribution);assert.equal((await request('/api/features')).status,404);assert.equal(calls,0);assert.ok(!node.bootstrap.snapshot().contributions.some(c=>['feature-inventory','feature-inventory-reader'].includes(c.identity.contributionId)));assert.equal((await request('/api/status')).status,200);
});
test('reselection and restart recreate only the selected inventory over the retained profile',async t=>{
 const {node}=await fixture(t);await node.app.close();
 const facts=node.bootstrap.configurationBootstrap,config={path:facts.configFile,privateCredential:{token:facts.owner.token,tokenPath:facts.owner.tokenPath}};
 for(const selected of [false,true,true]){
  const current=await buildApp(config,{agent,backgroundWorker:false,distribution:{...defaultDistribution,features:selected?defaultDistribution.features:defaultDistribution.features.filter(id=>id!=='mote.features')}});
  try{const origin=await current.app.listen({host:'127.0.0.1',port:0}),response=await fetch(origin+'/api/features',{headers:{authorization:'Bearer '+token}});assert.equal(response.status,selected?200:404);assert.equal(current.bootstrap.snapshot().contributions.filter(c=>c.identity.contributionId==='feature-inventory').length,selected?1:0);}
  finally{await current.app.close();}
 }
});
test('inventory withdrawal fences the HTTP reader and never opens persistence',async t=>{
 let stateAccess=0,reads=0;
 const host=new PluginHost({kind:'central',id:'generated-inventory-only'},undefined,undefined,{stateFor(){stateAccess++;throw Error('Inventory cannot open state');}}),registry=createDomainActivations(host,inventoryPlugins,['mote.features']),resources=new ServerResources(),scope=new FeatureScope(),app=Fastify();
 await prepareFeatureInventory({host,selectsFeature:id=>id==='mote.features',selectsPlugin:id=>inventoryPlugins.some(p=>p.contribution.id===id),registerDomainService:registry.register},resources,()=>{reads++;return featureInventory(host.snapshot(),inventoryPlugins.map(p=>({...p.contribution,featureVersion:p.contribution.version})));});
 const domains=await registry.activate();t.after(async()=>{await domains.close();await resources.close();await scope.close();await app.close();await host.close();});
 assert.equal(domains.routes.length,1);domains.routes[0]!.mount(app,scope);const origin=await app.listen({host:'127.0.0.1',port:0});
 assert.equal((await fetch(origin+'/api/features')).status,200);assert.equal(reads,1);assert.equal(stateAccess,0);
 await domains.quiesce();assert.equal((await fetch(origin+'/api/features')).status,503);await domains.close();assert.equal((await fetch(origin+'/api/features')).status,503);assert.equal(reads,1);assert.equal(stateAccess,0);assert.ok(!host.snapshot().contributions.some(c=>c.identity.contributionId==='feature-inventory'));
});
