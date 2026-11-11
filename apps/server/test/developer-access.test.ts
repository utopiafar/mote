import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Connections} from '../src/connections.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {materialId,type MaterialDraft} from '../src/materials.js';
import {officialPluginCatalog} from '../src/official-plugin-catalog.js';

const owner='synthetic-owner-for-developer-access-tests';
const headers=(token=owner)=>({authorization:`Bearer ${token}`});
const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in developer access tests');},close:async()=>{}};
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;

function config(directory:string,mcp=false):Config{
  return {dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',
    tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:4*1024*1024,retentionDays:0,insightIntervalHours:0,
    allowedOrigins:['https://synthetic.invalid'],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true,
    ...(mcp?{connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'synthetic-static-read-mcp-token-123456789',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}}:{})};
}
async function fixture(t:TestContext,options:{mcp?:boolean}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-developer-access-')),cfg=config(directory,options.mcp),store=new Store(directory,{maxStorageBytes:30*1024*1024}),sources=new SourceStore(store);
  const connections=new Connections(store,sources);
    const value=await buildApp(cfg,{store,agent:inactive,connections});
    t.after(async()=>{await value.app.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {...value,directory,cfg,connections};
}
function registerSource(sources:SourceStore,id:string,kind='local-files'){
  sources.register({id,name:`Synthetic ${id}`,kind,deviceId:'synthetic-device',platform:'import',retention:'snapshot',enabled:true});
}
function draft(sourceId:string,externalId:string,text:string,kind='mote.note'):MaterialDraft{
  return {id:materialId(sourceId,externalId),kind,schemaVersion:1,title:'Synthetic archived material',
    origin:{sourceId,externalId,deviceId:'synthetic-device',firstAt:'2026-11-01T00:00:00.000Z',lastAt:'2026-11-01T00:00:00.000Z'},
    members:[{id:'original',kind:'source-item',ref:`source-item:${sourceId}:${externalId}`,revision:'v1'}],
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}
async function mockWebhook(t:TestContext,respond?:(requestCount:number,res:import('node:http').ServerResponse)=>void){
  const requests:{headers:import('node:http').IncomingHttpHeaders;body:string}[]=[];
  const server:Server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    requests.push({headers:req.headers,body:Buffer.concat(chunks).toString('utf8')});
    if(respond)respond(requests.length,res);else{res.statusCode=204;res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  t.after(async()=>{server.closeAllConnections?.();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {url:`http://127.0.0.1:${port}/hook`,requests,server};
}
async function createDeveloper(app:Awaited<ReturnType<typeof buildApp>>['app'],sourceIds=['allowed'],rateLimitPerMinute?:number){
  const response=await app.inject({method:'POST',url:'/api/developer/credentials',headers:headers(),payload:{label:'Synthetic developer',sourceIds,...(rateLimitPerMinute?{rateLimitPerMinute}:{})}});
  assert.equal(response.statusCode,200,response.body);
  return response.json() as {token:string;credential:{id:string;label:string;eventSourceIds:string[];eventKinds:string[];rateLimitPerMinute:number;tokenHint:string}};
}
async function createWebhook(app:Awaited<ReturnType<typeof buildApp>>['app'],url:string,sourceIds=['allowed'],extra:Record<string,unknown>={}){
  const response=await app.inject({method:'POST',url:'/api/developer/webhooks',headers:headers(),payload:{label:'Synthetic webhook',url,sourceIds,eventKinds:['material.archived'],...extra}});
  assert.equal(response.statusCode,200,response.body);
  return response.json() as {endpoint:{id:string;label:string;enabled:boolean;sourceIds:string[];eventKinds:string[];maxAttempts:number};secret:string};
}
const inventory=async(app:Awaited<ReturnType<typeof buildApp>>['app'])=> (await app.inject({url:'/api/developer',headers:headers()})).json() as {
  credentials:Array<{id:string;label:string;scope:string;tokenHint:string;revokedAt?:string}>;
  endpoints:Array<{id:string;label:string;url:string;sourceIds:string[];enabled:boolean;maxAttempts:number}>;
  deliveries:Array<{id:string;endpointId:string;status:'pending'|'success'|'failed';attempts:number;lastError?:string;httpStatus?:number}>;
};

test('owner creates independent developer credentials and webhooks whose complete secrets appear only once',async t=>{
    const {app,materials,sources,developerAccess}=await fixture(t);registerSource(sources,'allowed');
    const hook=await mockWebhook(t);
    const developer=await createDeveloper(app);
    assert.match(developer.token,tokenPattern);assert.equal(developer.credential.eventSourceIds[0],'allowed');assert.deepEqual(developer.credential.eventKinds,['material.archived']);
  assert.equal(developer.credential.rateLimitPerMinute,60);
  const webhook=await createWebhook(app,hook.url);
    assert.match(webhook.secret,tokenPattern);assert.equal(webhook.endpoint.enabled,true);assert.deepEqual(webhook.endpoint.sourceIds,['allowed']);

  const visible=JSON.stringify(await inventory(app));
    assert.equal(visible.includes(developer.token),false,'the full developer token is never listed');
  assert.equal(visible.includes(webhook.secret),false,'the full webhook secret is never listed');
  assert.equal(visible.includes('"hash"'),false);
  assert.equal(visible.includes('"secret"'),false);

  const published=materials.publish(draft('allowed','one','Synthetic archived body that must not leave the host'));
  await developerAccess.flush(true);
  assert.equal(hook.requests.length,1,'one declared archived material creates one delivery');
  const request=hook.requests[0]!,deliveryId=String(request.headers['x-mote-delivery-id']);
  const timestamp=String(request.headers['x-mote-timestamp']);
  const signature=createHmac('sha256',webhook.secret).update(`${timestamp}.${deliveryId}.${request.body}`).digest('hex');
  assert.match(deliveryId,/^[0-9a-f-]{36}$/);assert.equal(request.headers['x-mote-signature'],`sha256=${signature}`);
  assert.equal(request.headers['x-mote-event'],'material.archived');
  const event=JSON.parse(request.body);
  assert.equal(event.type,'material.archived');assert.equal(event.version,1);assert.equal(event.sourceId,'allowed');
  assert.equal(event.material.id,published.id);assert.equal(event.material.revision,published.revision);assert.equal(event.material.kind,'mote.note');
  const journal=await app.inject({url:'/api/developer/v1/events?after=0&limit=50',headers:headers(developer.token)});
  assert.equal(journal.statusCode,200,journal.body);assert.equal(journal.json().events[0].id,event.id,'webhook and Developer API read the same event');
  assert.equal(request.body.length<4096,true,'the event envelope is bounded');
  assert.equal(request.body.includes('Synthetic archived body'),false,'material text is never sent');
  for(const key of ['title','text','externalId','members','blocks','locator','payload','capture'])assert.equal(request.body.includes(`"${key}"`),false,key);
  const status=await inventory(app);assert.equal(status.deliveries.length,1);assert.equal(status.deliveries[0]!.status,'success');assert.equal(status.deliveries[0]!.attempts,1);
});

test('an actual source archive publication reaches the same webhook pipeline',async t=>{
  const {app,sources,materialOrganizer,developerAccess}=await fixture(t);registerSource(sources,'allowed');
  const hook=await mockWebhook(t);
  await createDeveloper(app,['allowed']);
  await createWebhook(app,hook.url,['allowed'],{label:'Archive hook'});
  await sources.upsert('allowed',{externalId:'archived-file',revision:'v1',observedAt:'2026-11-01T00:00:00.000Z',
    title:'Synthetic archived file',text:'Synthetic archived source body',kind:'file',layer:'snapshot'});
  await materialOrganizer.tick(20);
  await developerAccess.flush(true);
  assert.equal(hook.requests.length,1,'the existing source archive path produces the event');
  const event=JSON.parse(hook.requests[0]!.body);assert.equal(event.type,'material.archived');assert.equal(event.sourceId,'allowed');
  assert.equal(hook.requests[0]!.body.includes('Synthetic archived source body'),false);
});

test('owner updates a webhook and rotates its secret without exposing the old or new value in inventory',async t=>{
  const {app}=await fixture(t);
  const hook=await mockWebhook(t);
  const created=await createWebhook(app,hook.url);
  const updated=await app.inject({method:'PATCH',url:`/api/developer/webhooks/${created.endpoint.id}`,headers:headers(),payload:{label:'Updated hook',sourceIds:['allowed','other'],maxAttempts:2,enabled:false}});
  assert.equal(updated.statusCode,200,updated.body);
  assert.equal(updated.json().endpoint.label,'Updated hook');assert.equal(updated.json().endpoint.enabled,false);assert.equal(updated.json().endpoint.maxAttempts,2);
  assert.deepEqual(updated.json().endpoint.sourceIds,['allowed','other']);assert.equal('secret' in updated.json(),false);
  const rotated=await app.inject({method:'PATCH',url:`/api/developer/webhooks/${created.endpoint.id}`,headers:headers(),payload:{rotateSecret:true}});
  assert.equal(rotated.statusCode,200,rotated.body);assert.match(rotated.json().secret,tokenPattern);assert.notEqual(rotated.json().secret,created.secret);
  const visible=JSON.stringify(await inventory(app));
  assert.equal(visible.includes(created.secret),false);assert.equal(visible.includes(rotated.json().secret),false);
  const empty=await app.inject({method:'PATCH',url:`/api/developer/webhooks/${created.endpoint.id}`,headers:headers(),payload:{url:''}});
  assert.equal(empty.statusCode,400);assert.equal(empty.json().error,'developer_target_invalid');
});

test('empty targets, empty scopes and wildcards are rejected instead of delivering the library',async t=>{
  const {app}=await fixture(t);
  const cases:[Record<string,unknown>,string][]=[
    [{label:'Empty URL',url:'',sourceIds:['allowed']},'developer_target_invalid'],
    [{label:'Empty scope',url:'http://127.0.0.1:9/hook',sourceIds:[]},'validation'],
    [{label:'Wildcard',url:'http://127.0.0.1:9/hook',sourceIds:['allowed','*']},'developer_scope_wildcard'],
    [{label:'File scheme',url:'file:///tmp/mote-hook',sourceIds:['allowed']},'developer_target_scheme'],
    [{label:'Embedded credentials',url:'http://user:pass@127.0.0.1:9/hook',sourceIds:['allowed']},'developer_target_denied'],
    [{label:'Metadata address',url:'http://169.254.169.254/latest/meta-data',sourceIds:['allowed']},'developer_target_denied'],
    [{label:'Mapped metadata address',url:'http://[::ffff:169.254.169.254]/latest/meta-data',sourceIds:['allowed']},'developer_target_denied'],
  ];
  for(const [payload,error] of cases){
    const response=await app.inject({method:'POST',url:'/api/developer/webhooks',headers:headers(),payload});
    assert.equal(response.statusCode,400,JSON.stringify(payload));
    assert.equal(response.json().error,error,JSON.stringify(payload));
  }
  for(const sourceIds of [[],['*'],['allowed','*']]){
    const response=await app.inject({method:'POST',url:'/api/developer/credentials',headers:headers(),payload:{label:'Synthetic developer',sourceIds}});
    assert.equal(response.statusCode,400,JSON.stringify(sourceIds));
  }
});

test('disabled, out-of-scope, screen and coding sources never produce deliveries',async t=>{
  const {app,materials,sources,developerAccess}=await fixture(t);
  for(const [id,kind] of [['allowed','local-files'],['other','local-files'],['screen','local-files'],['coding','coding-agent']] as const)registerSource(sources,id,kind);
  const hook=await mockWebhook(t);
  await createWebhook(app,hook.url,['allowed'],{label:'Disabled hook',enabled:false});
  await createWebhook(app,hook.url,['allowed'],{label:'Enabled hook'});
  materials.publish(draft('allowed','one','Synthetic allowed body'));
  materials.publish(draft('other','two','Synthetic out-of-scope body'));
  materials.publish(draft('screen','three','Synthetic screenshot body','mote.screen-segment'));
  materials.publish(draft('coding','four','Synthetic coding body','mote.note'));
  await developerAccess.flush(true);
  assert.equal(hook.requests.length,1,'only the enabled, in-scope non-sensitive event is delivered');
  const event=JSON.parse(hook.requests[0]!.body);assert.equal(event.sourceId,'allowed');
  const status=await inventory(app);assert.equal(status.deliveries.length,1,'the disabled endpoint has no delivery row');
});

test('Developer API reads the same journal inside its frozen scope, with independent rate limits',async t=>{
  const {app,materials,sources,developerAccess}=await fixture(t);registerSource(sources,'allowed');registerSource(sources,'other');
  const developer=await createDeveloper(app,['allowed'],2);
  materials.publish(draft('allowed','one','Synthetic allowed body'));
  materials.publish(draft('other','two','Synthetic out-of-scope body'));
  await developerAccess.flush(true);
  const first=await app.inject({url:'/api/developer/v1/events?after=0&limit=50',headers:headers(developer.token)});
  assert.equal(first.statusCode,200,first.body);const page=first.json();
  assert.equal(page.events.length,1);assert.equal(page.events[0].sourceId,'allowed');assert.equal(page.events[0].type,'material.archived');
  assert.equal(JSON.stringify(page).includes('Synthetic allowed body'),false);
  assert.equal(JSON.stringify(page).includes('"title"'),false);
  const second=await app.inject({url:`/api/developer/v1/events?after=${page.nextCursor}&limit=50`,headers:headers(developer.token)});
  assert.equal(second.statusCode,200,second.body);assert.equal(second.json().events.length,0);
  const limited=await app.inject({url:'/api/developer/v1/events?after=0&limit=50',headers:headers(developer.token)});
  assert.equal(limited.statusCode,429);assert.equal(limited.json().error,'developer_rate_limited');
  assert.equal((await app.inject({method:'POST',url:'/api/developer/webhooks',headers:headers(developer.token),payload:{label:'Nope',url:'http://127.0.0.1:9/hook',sourceIds:['allowed']}})).statusCode,403,'a developer credential cannot widen or create webhooks');
  assert.equal((await app.inject({url:'/api/developer',headers:headers(developer.token)})).statusCode,403,'a developer credential cannot read owner management');
});

test('collector and minted MCP credentials cannot configure or read developer control',async t=>{
  const {app,connections}=await fixture(t,{mcp:true});
  const invitation=await app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic collector',deviceId:'synthetic-collector'}});
  assert.equal(invitation.statusCode,200,invitation.body);
  const collector=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'synthetic-collector',deviceName:'Synthetic collector',platform:'android'}});
  assert.equal(collector.statusCode,200,collector.body);const collectorToken=collector.json().token as string;
  const mcp=await app.inject({method:'POST',url:'/api/connections/mcp',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic MCP',access:'read'}});
  assert.equal(mcp.statusCode,200,mcp.body);const mcpToken=mcp.json().config.mcpServers.mote.headers.Authorization.slice(7) as string;

  for(const token of [collectorToken,mcpToken]){
    assert.equal((await app.inject({url:'/api/developer',headers:headers(token)})).statusCode,403,'non-owner cannot read control');
    assert.equal((await app.inject({method:'POST',url:'/api/developer/webhooks',headers:headers(token),payload:{label:'Nope',url:'http://127.0.0.1:9/hook',sourceIds:['allowed']}})).statusCode,403,'non-owner cannot create');
    assert.equal((await app.inject({method:'POST',url:'/api/developer/credentials',headers:headers(token),payload:{label:'Nope',sourceIds:['allowed']}})).statusCode,403,'non-owner cannot mint a developer credential');
  }
  const ownerView=await app.inject({url:'/api/developer',headers:headers()});assert.equal(ownerView.statusCode,200,ownerView.body);
  assert.ok(connections.authenticate(`Bearer ${collectorToken}`));assert.ok(connections.authenticate(`Bearer ${mcpToken}`));
});

test('credential revocation and endpoint disable stop new access and deliveries immediately',async t=>{
  const {app,materials,sources,developerAccess}=await fixture(t);registerSource(sources,'allowed');
  const hook=await mockWebhook(t);
  const developer=await createDeveloper(app);const webhook=await createWebhook(app,hook.url);
  assert.equal((await app.inject({url:'/api/developer/v1/events',headers:headers(developer.token)})).statusCode,200);
  const revoked=await app.inject({method:'DELETE',url:`/api/developer/credentials/${developer.credential.id}`,headers:headers()});
  assert.equal(revoked.statusCode,200,revoked.body);
  assert.equal((await app.inject({url:'/api/developer/v1/events',headers:headers(developer.token)})).statusCode,401,'a revoked developer credential is immediately invalid');

  materials.publish(draft('allowed','one','Synthetic first body'));await developerAccess.flush(true);assert.equal(hook.requests.length,1);
  assert.equal((await app.inject({method:'DELETE',url:`/api/developer/webhooks/${webhook.endpoint.id}`,headers:headers()})).statusCode,200);
  materials.publish(draft('allowed','two','Synthetic second body'));await developerAccess.flush(true);
  assert.equal(hook.requests.length,1,'a disabled endpoint creates no new delivery');
  const status=await inventory(app);assert.equal(status.endpoints[0]!.enabled,false);assert.equal(status.deliveries.length,1);
});

test('a failed attempt retries within its declared budget and can recover',async t=>{
  const {app,materials,sources,developerAccess}=await fixture(t);registerSource(sources,'allowed');
  const hook=await mockWebhook(t,(count,res)=>{res.statusCode=count===1?500:204;res.end();});
  const webhook=await createWebhook(app,hook.url,['allowed'],{label:'Recovering hook',maxAttempts:2});
  materials.publish(draft('allowed','one','Synthetic retry recovery body'));await developerAccess.flush(true);
  assert.equal(hook.requests.length,2,'the first failure consumes one retry and the second attempt succeeds');
  const status=await inventory(app);const delivery=status.deliveries.find(value=>value.endpointId===webhook.endpoint.id)!;
  assert.equal(delivery.status,'success');assert.equal(delivery.attempts,2);assert.equal(delivery.httpStatus,204);
});

test('failed deliveries spend a finite retry budget and redirects are never followed',async t=>{
  const {app,materials,sources,developerAccess}=await fixture(t);registerSource(sources,'retry');registerSource(sources,'redirect');
  const failing=await mockWebhook(t,(_count,res)=>{res.statusCode=500;res.end('synthetic failure');});
  const redirect=await mockWebhook(t,(_count,res)=>{res.statusCode=302;res.setHeader('location','http://169.254.169.254/latest/meta-data');res.end();});
  const retry=await createWebhook(app,failing.url,['retry'],{label:'Retry hook',maxAttempts:1});
  const redirected=await createWebhook(app,redirect.url,['redirect'],{label:'Redirect hook',maxAttempts:1});
  materials.publish(draft('retry','one','Synthetic retry body'));await developerAccess.flush(true);
  materials.publish(draft('redirect','two','Synthetic redirect body'));await developerAccess.flush(true);
  assert.equal(failing.requests.length,1,'maxAttempts=1 makes exactly one attempt');
  assert.equal(redirect.requests.length,1,'the redirect target is never requested');
  const status=await inventory(app);
  const failed=status.deliveries.find(value=>value.endpointId===retry.endpoint.id)!;
  const stopped=status.deliveries.find(value=>value.endpointId===redirected.endpoint.id)!;
  assert.equal(failed.status,'failed');assert.equal(failed.attempts,1);assert.equal(failed.httpStatus,500);
  assert.equal(stopped.status,'failed');assert.equal(stopped.httpStatus,302);assert.equal(stopped.lastError,'http_302');
  await developerAccess.flush(true);assert.equal(failing.requests.length,1,'a spent retry budget does not retry forever');
  assert.equal(redirect.requests.length,1);
});

test('webhook is a host surface, not an installable official package',()=>{
  const catalog=officialPluginCatalog();
  assert.equal(catalog.some(entry=>/webhook|developer/i.test(`${entry.repository} ${entry.packageId} ${entry.name}`)),false);
  assert.deepEqual(catalog.filter(entry=>entry.group==='outbound-processing').map(entry=>entry.packageId),['mote.official.markdown-export']);
});
