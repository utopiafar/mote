import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {parseConnectionInvitation,MOTE_PROTOCOL_RANGE,noteCapture} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Connections,ConnectionError,type ConnectionFile} from '../src/connections.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';

const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in connection tests');},close:async()=>{}};
const owner='synthetic-owner-for-connection-tests';
const headers=(token=owner)=>({authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'});
function config(directory:string):Config{return {dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:4*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:['https://synthetic.invalid'],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};}
async function fixture(t:TestContext,options:{clock?:()=>number;mcp?:boolean;mcpWriteEnabled?:boolean;maxStorageBytes?:number}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-connections-')),cfg=config(directory),storageOptions={maxStorageBytes:options.maxStorageBytes},store=new Store(directory,storageOptions),sources=new SourceStore(store);
  if(options.mcp)cfg.connectors={directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'synthetic-static-read-mcp-token-123456789',mcpWriteEnabled:options.mcpWriteEnabled??true,mcpWriteToken:'synthetic-static-write-mcp-token-123456789',mcpWriteSourceIds:['allowed']};
  const connections=new Connections(store,sources,{clock:options.clock});
  let value=await buildApp(cfg,{store,agent:inactive,connections});
  const restart=async()=>{await value.app.close();value=await buildApp(cfg,{store,agent:inactive,connections:new Connections(store,sources,{clock:options.clock})});return value;};
  t.after(async()=>{await value.app.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {...value,directory,cfg,storageOptions,restart};
}
const invite=(app:Awaited<ReturnType<typeof buildApp>>['app'],deviceId?:string)=>app.inject({method:'POST',url:'/api/connections/invitations',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic phone',...(deviceId?{deviceId}:{})}});
const redeem=(app:Awaited<ReturnType<typeof buildApp>>['app'],code:string,deviceId='synthetic-phone')=>app.inject({method:'POST',url:'/api/connections/redeem',payload:{code,deviceId,deviceName:'Synthetic phone',platform:'android'}});
async function paired(app:Awaited<ReturnType<typeof buildApp>>['app'],deviceId='synthetic-phone'){const created=await invite(app);assert.equal(created.statusCode,200);const result=await redeem(app,created.json().invitation.code,deviceId);assert.equal(result.statusCode,200);return result.json() as {token:string;credentialId:string;serverUrl:string;scope:string};}
const note=(deviceId='synthetic-phone')=>({id:randomUUID(),deviceId,deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),text:'Synthetic authored note; no actual personal text.'});
const source=(id:string,deviceId='synthetic-phone')=>({id,deviceId,name:'Synthetic source',kind:'local-files',platform:'import',retention:'snapshot',enabled:true});
const item=()=>({externalId:'one',revision:randomUUID(),observedAt:new Date().toISOString(),title:'Synthetic file',text:'Synthetic file evidence',kind:'file',layer:'snapshot'});

test('wire metadata is independent of product versions and always includes its protocol contract',async t=>{
  const {app}=await fixture(t);
  const health=(await app.inject('/api/health')).json();
  assert.equal(health.ok,true);assert.deepEqual(health.protocol,MOTE_PROTOCOL_RANGE);
  assert.equal('capabilities' in health,false,'Public metadata does not reveal credential authorization');
  const legacy=(await app.inject({url:'/api/connections/self',headers:headers()})).json();
  assert.deepEqual(Object.keys(legacy.node).sort(),['profile','protocol','version']);
  for(const version of ['1','2']){
    const self=(await app.inject({url:'/api/connections/self',headers:{...headers(),'x-mote-protocol-version':version}})).json();
    assert.deepEqual(self.node.protocol,MOTE_PROTOCOL_RANGE);assert.equal(self.node.version,health.version);
    assert.deepEqual(self.capabilities,{ingest:true,ingressVersion:2,ownSources:true,archiveRead:true});
  }
  const granted=await paired(app);
  const collector=(await app.inject({url:'/api/connections/self',headers:{...headers(granted.token),'x-mote-protocol-version':'1'}})).json();
  assert.deepEqual(collector.node.protocol,MOTE_PROTOCOL_RANGE);
  assert.deepEqual(collector.capabilities,{ingest:true,ingressVersion:2,ownSources:true,archiveRead:true});
  assert.equal((await app.inject({url:'/api/connections/self',headers:{'x-mote-protocol-version':'1'}})).statusCode,401);
});

test('owner-only invitation uses explicit canonical HTTPS/loopback origins and contains no owner credential',async t=>{
  const {app}=await fixture(t);
  assert.equal((await app.inject({method:'POST',url:'/api/connections/invitations',payload:{serverUrl:'https://synthetic.invalid',label:'test'}})).statusCode,401);
  for(const serverUrl of ['http://192.168.1.1:47832','https://name:secret@synthetic.invalid','https://synthetic.invalid/path','https://synthetic.invalid/?secret=value','https://synthetic.invalid/#fragment']){
    const response=await app.inject({method:'POST',url:'/api/connections/invitations',headers:headers(),payload:{serverUrl,label:'test'}});assert.equal(response.statusCode,400);assert.equal(response.json().error,'connection_url_invalid');
  }
  const response=await app.inject({method:'POST',url:'/api/connections/invitations',headers:{...headers(),host:'attacker.invalid','x-forwarded-host':'attacker.invalid','x-forwarded-proto':'http'},payload:{serverUrl:'http://127.0.0.1:47838/',label:'Synthetic node'}});
  assert.equal(response.statusCode,200);const {invitation,uri}=response.json();
  assert.equal(invitation.serverUrl,'http://127.0.0.1:47838');assert.match(invitation.code,/^[A-Za-z0-9_-]{43}$/);assert.deepEqual(parseConnectionInvitation(uri),invitation);
  assert.ok(Date.parse(invitation.expiresAt)-Date.now()<=600000);assert.ok(!response.body.includes(owner));assert.equal(response.headers['cache-control'],'no-store');
  const self=await app.inject({url:'/api/connections/self',headers:headers()});assert.equal(self.json().credential.scope,'owner');assert.equal(self.json().capabilities.archiveRead,true);
});

test('single-use redemption is serialized, persists only hashes and reloads across restarts',async t=>{
  const {app,connections,directory,store,sources,diagnostics}=await fixture(t);
  const code=(await invite(app)).json().invitation.code;
  const replies=await Promise.all([redeem(app,code),redeem(app,code),redeem(app,code)]);
  assert.deepEqual(replies.map(r=>r.statusCode).sort(),[200,410,410]);
  const granted=replies.find(r=>r.statusCode===200)!.json();assert.notEqual(granted.token,owner);assert.equal(granted.scope,'owner');
  const file=join(directory,'connectors/client-connections.json'),raw=await readFile(file,'utf8');
  for(const secret of [code,granted.token,owner])assert.ok(!raw.includes(secret));
  assert.equal((await lstat(file)).mode&0o777,0o600);assert.equal((await lstat(join(directory,'connectors'))).mode&0o777,0o700);
  const loaded=new Connections(store,sources);await loaded.init();assert.equal(loaded.authenticate(`Bearer ${granted.token}`)?.id,granted.credentialId);await loaded.close();
  const inventory=(await app.inject({url:'/api/connections',headers:headers()})).json();assert.equal(inventory.items.length,1);assert.ok(!JSON.stringify(inventory).includes(granted.token));assert.ok(!JSON.stringify(inventory).includes('"hash"'));
  const self=await app.inject({url:'/api/connections/self',headers:headers(granted.token)});assert.equal(self.statusCode,200);assert.equal(self.json().credential.deviceId,'synthetic-phone');assert.equal(self.json().capabilities.archiveRead,true);
  assert.deepEqual(Object.keys(self.json().credential).sort(),['deviceId','deviceName','id','label','platform','scope','serverUrl']);
  await app.inject({method:'DELETE',url:`/api/connections/${granted.credentialId}`,headers:headers()});
  assert.equal(connections.authenticate(`Bearer ${granted.token}`),undefined);
  const restarted=new Connections(store,sources);await restarted.init();assert.equal(restarted.authenticate(`Bearer ${granted.token}`),undefined);await restarted.close();
  const diagnosticsBody=JSON.stringify(diagnostics.events(0,500));for(const secret of [code,granted.token,owner])assert.ok(!diagnosticsBody.includes(secret));
});

test('iOS is a first-class connection platform',async t=>{
  const {app}=await fixture(t);
  const created=await invite(app);
  const granted=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:created.json().invitation.code,deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios'}});
  assert.equal(granted.statusCode,200);
  const self=await app.inject({url:'/api/connections/self',headers:headers(granted.json().token)});
  assert.equal(self.json().credential.platform,'ios');assert.equal(self.json().credential.deviceId,'generated-iphone');
});

test('connection invitations declare central client platforms so iOS can check before connecting',async t=>{
  const {app}=await fixture(t);
  const created=await invite(app);assert.equal(created.statusCode,200);
  const {invitation,uri}=created.json();
  assert.deepEqual(invitation.platforms,['android','macos','ios','windows','linux']);
  assert.deepEqual(parseConnectionInvitation(uri).platforms,invitation.platforms,'The QR carries the same declaration as the invitation file');
  const withoutIos=parseConnectionInvitation(JSON.stringify({...invitation,platforms:invitation.platforms.filter((platform:string)=>platform!=='ios')}));
  assert.equal(withoutIos.platforms?.includes('ios'),false,'A central without iOS is not treated as iOS-capable');
  const undeclared=parseConnectionInvitation(JSON.stringify({format:'mote.connection',version:1,serverUrl:'https://synthetic.invalid',code:'a'.repeat(43),expiresAt:new Date(Date.now()+600000).toISOString()}));
  assert.equal(undeclared.platforms,undefined,'A central that does not declare platforms never implies iOS support');
  const granted=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.code,deviceId:'generated-iphone',deviceName:'Generated iPhone',platform:'ios'}});
  assert.equal(granted.statusCode,200,'The declaring central accepts an iOS credential');
});

test('expired, cancelled and restart-lost invitations cannot mint credentials',async t=>{
  let now=Date.now();const {app,connections,store,sources}=await fixture(t,{clock:()=>now});
  const expired=(await invite(app)).json().invitation.code;now+=600001;
  assert.equal((await redeem(app,expired)).statusCode,410);
  const cancelled=(await invite(app)).json().invitation.code;
  for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/api/connections/invitations/revoke',headers:headers(),payload:{code:cancelled}})).statusCode,200);
  assert.equal((await redeem(app,cancelled)).statusCode,410);
  const lost=(await invite(app)).json().invitation.code,restarted=new Connections(store,sources);await restarted.init();
  await assert.rejects(restarted.redeem({code:lost,deviceId:'new',deviceName:'New',platform:'other'}),(e:any)=>e.code==='invitation_invalid_or_expired');await restarted.close();
  assert.equal(connections.inventory().items.length,0);
});

test('existing device identity requires explicit owner binding and replaces only that device credential',async t=>{
  const {app,store,connections}=await fixture(t);
  store.heartbeat({deviceId:'legacy-device',deviceName:'Existing manual-token device',platform:'android',status:'offline',queueDepth:0});
  const unbound=(await invite(app)).json().invitation.code;
  const refused=await redeem(app,unbound,'legacy-device');assert.equal(refused.statusCode,409);assert.equal(refused.json().error,'device_already_registered');
  const bound=(await invite(app,'legacy-device')).json().invitation.code;
  assert.equal((await redeem(app,bound,'wrong-device')).statusCode,403);
  const first=(await redeem(app,bound,'legacy-device')).json();assert.ok(first.token);
  const other=await paired(app,'other-device');
  const replacement=(await invite(app,'legacy-device')).json().invitation.code;
  const second=(await redeem(app,replacement,'legacy-device')).json();assert.ok(second.token);assert.notEqual(first.token,second.token);
  assert.equal(connections.authenticate(`Bearer ${first.token}`),undefined);assert.ok(connections.authenticate(`Bearer ${second.token}`));assert.ok(connections.authenticate(`Bearer ${other.token}`));
  assert.equal((await app.inject({url:'/api/status',headers:headers()})).statusCode,200);
});

test('paired clients have the same archive, source and management permissions as the node token',async t=>{
  const {app,store,sources}=await fixture(t),client=await paired(app),auth=headers(client.token);
  const original=note('owner-device');await app.inject({method:'POST',url:'/api/notes',headers:headers(),payload:original});
  const own=note();assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:own})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:note('owner-device')})).statusCode,201);
  sources.register(source('foreign','owner-device'));await sources.upsert('foreign',item());
  assert.equal((await app.inject({method:'PUT',url:'/api/sources/foreign/items',headers:auth,payload:item()})).statusCode,200);
  for(const url of ['/api/status','/api/configuration','/api/captures','/api/notes','/api/devices','/api/activity','/api/export','/api/updates','/api/memories','/api/connections','/api/diagnostics','/api/support-bundle','/api/software-update',`/api/captures/${own.id}`,`/api/notes/${own.id}`,'/api/sources','/api/source-items?deviceId=owner-device','/api/sources/foreign/items','/api/sources/foreign/item?externalId=one','/api/sources/foreign/history?externalId=one']){
    const ownerReply=await app.inject({url,headers:headers()}),clientReply=await app.inject({url,headers:auth});assert.equal(clientReply.statusCode,ownerReply.statusCode,url);
  }
  for(const url of ['/api/query','/api/import','/api/index/retry','/api/connections/mcp','/api/connections/invitations','/api/connectors/google/start','/api/connectors/gmail/start','/api/connectors/gmail/sync']){
    const ownerReply=await app.inject({method:'POST',url,headers:headers(),payload:{}}),clientReply=await app.inject({method:'POST',url,headers:auth,payload:{}});assert.equal(clientReply.statusCode,ownerReply.statusCode,url);
  }
  assert.equal((await app.inject({method:'DELETE',url:`/api/captures/${original.id}`,headers:auth})).statusCode,200);assert.equal(store.evidence([original.id]).length,0);
});

test('revocation during capture preparation prevents commit and leaves no new evidence',async t=>{
  const {app,store}=await fixture(t),client=await paired(app);
  let entered!:()=>void,resume!:()=>void;const inside=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r),prepare=store.prepare.bind(store);
  store.prepare=async raw=>{const value=await prepare(raw);entered();await gate;return value;};
  const input=note(),pending=app.inject({method:'POST',url:'/api/notes',headers:headers(client.token),payload:input});
  await inside;assert.equal((await app.inject({method:'DELETE',url:`/api/connections/${client.credentialId}`,headers:headers()})).statusCode,200);resume();
  assert.equal((await pending).statusCode,401);assert.equal(store.evidence([input.id]).length,0);
});

test('revocation during source ingestion also rolls back the capture and source revision',async t=>{
  const {app,store,sources}=await fixture(t),client=await paired(app);sources.register(source('owned'));
  let entered!:()=>void,resume!:()=>void;const inside=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r),prepare=store.prepare.bind(store);
  store.prepare=async raw=>{const value=await prepare(raw);entered();await gate;return value;};
  const pending=app.inject({method:'PUT',url:'/api/sources/owned/items',headers:headers(client.token),payload:item()});
  await inside;await app.inject({method:'DELETE',url:`/api/connections/${client.credentialId}`,headers:headers()});resume();
  assert.equal((await pending).statusCode,401);assert.equal(sources.history('owned','one').length,0);assert.equal(store.list().items.length,0);
});

test('failed durable writes neither consume invitations nor revoke the previous device credential',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-connection-write-failure-')),store=new Store(directory),sources=new SourceStore(store);
  let saved:unknown,fail=false;const file:ConnectionFile={read:async()=>saved,write:async value=>{if(fail)throw Error('synthetic private disk failure');saved=structuredClone(value);}};
  const connections=new Connections(store,sources,{file});await connections.init();t.after(async()=>{await connections.close();store.close();await rm(directory,{recursive:true,force:true});});
  const invite=()=>connections.invite({serverUrl:'https://synthetic.invalid',label:'Synthetic',deviceId:'same'}).invitation.code;
  const redeem=(code:string)=>connections.redeem({code,deviceId:'same',deviceName:'Synthetic',platform:'android'});
  const first=await redeem(invite()),code=invite();fail=true;
  await assert.rejects(redeem(code),(e:any)=>e instanceof ConnectionError&&e.code==='connection_storage_failed');assert.ok(connections.authenticate(`Bearer ${first.token}`));assert.equal(connections.inventory().items.length,1);
  await assert.rejects(connections.revoke(first.credentialId),(e:any)=>e.code==='connection_storage_failed');assert.ok(connections.authenticate(`Bearer ${first.token}`));
  fail=false;const second=await redeem(code);assert.ok(connections.authenticate(`Bearer ${second.token}`));assert.equal(connections.authenticate(`Bearer ${first.token}`),undefined);
});

test('redemption bursts retain expired invitation errors and owner access',async t=>{
  const {app}=await fixture(t),code='a'.repeat(43);
  for(let i=0;i<30;i++)assert.equal((await redeem(app,code)).statusCode,410);
  assert.equal((await app.inject({url:'/api/connections',headers:headers()})).statusCode,200);
});

test('large MCP scopes cannot create an unreadable credential file and a full registry remains revocable',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-connection-capacity-')),store=new Store(directory),sources=new SourceStore(store);
  let saved:unknown;const file:ConnectionFile={read:async()=>saved,write:async value=>{saved=structuredClone(value);}};
  const connections=new Connections(store,sources,{file});await connections.init();t.after(async()=>{await connections.close();store.close();await rm(directory,{recursive:true,force:true});});
  const cfg={directory,mcpEnabled:true,mcpWriteEnabled:true,mcpWriteSourceIds:Array.from({length:500},(_,i)=>`${i}-`+'a'.repeat(120))};
  let first:string|undefined,limited=false;
  for(let i=0;i<50;i++){try{const issued=await connections.mintMcp({serverUrl:'https://synthetic.invalid',label:'Large synthetic scope',access:'write'},cfg);first??=issued.credential.id;}catch(e){assert.equal((e as ConnectionError).code,'connection_limit');limited=true;break;}}
  assert.equal(limited,true);assert.ok(Buffer.byteLength(JSON.stringify(saved))<=2*1024*1024);assert.ok(first);
  await connections.revoke(first!);assert.ok(connections.inventory().items.find(c=>c.id===first)?.revokedAt);
  const loaded=new Connections(store,sources,{file});await loaded.init();assert.equal(loaded.inventory().items.length,connections.inventory().items.length);await loaded.close();
});

test('minted MCP credentials use the real SDK with independent read/write, fixed sources and revocation',async t=>{
  const initial=await fixture(t,{mcp:true}),{sources,restart}=initial;let app=initial.app,configService=initial.configService;sources.register(source('allowed','mcp-owner'));sources.register(source('later','mcp-owner'));
  await app.listen({host:'127.0.0.1',port:0});const endpoint=new URL('/mcp',app.listeningOrigin),clients:Client[]=[];
  t.after(async()=>{await Promise.allSettled(clients.map(c=>c.close()));});
  const mint=async(access:'read'|'write')=>{const r=await app.inject({method:'POST',url:'/api/connections/mcp',headers:headers(),payload:{serverUrl:app.listeningOrigin,label:'Synthetic MCP',access}});assert.equal(r.statusCode,200);return r.json();};
  const read=await mint('read'),write=await mint('write');
  const connect=async(issued:any)=>{const client=new Client({name:'synthetic-connection-test',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:issued.config.mcpServers.mote.headers}}));return client;};
  const reader=await connect(read),writer=await connect(write);
  assert.equal(reader.getServerVersion()?.version,(await app.inject('/api/health')).json().version);
  assert.ok((await reader.listTools()).tools.some(t=>t.name==='mote_timeline'));assert.ok(!(await reader.listTools()).tools.some(t=>t.name==='mote_put_item'));
  assert.deepEqual((await writer.listTools()).tools.map(t=>t.name),['mote_put_item']);
  assert.equal((await writer.callTool({name:'mote_put_item',arguments:{sourceId:'allowed',item:item()}})).isError,undefined);
  await configService.update('connectors',{mcpWriteSourceIds:['allowed','later']},configService.revision);
  assert.deepEqual(configService.current<{mcpWriteSourceIds:string[]}>('connectors').mcpWriteSourceIds,['allowed'],'saved authorization configuration takes effect after restart');
  const port=new URL(app.listeningOrigin).port;({app,configService}=await restart());await app.listen({host:'127.0.0.1',port:Number(port)});
  assert.deepEqual(configService.current<{mcpWriteSourceIds:string[]}>('connectors').mcpWriteSourceIds,['allowed','later']);
  assert.equal((await writer.callTool({name:'mote_put_item',arguments:{sourceId:'later',item:item()}})).isError,true,'A broader later config must not widen the issued credential');
  assert.equal((await app.inject({url:'/api/configuration',headers:write.config.mcpServers.mote.headers})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/mcp',headers:headers(),payload:{}})).statusCode,401);
  await app.inject({method:'DELETE',url:`/api/connections/${read.credential.id}`,headers:headers()});
  await assert.rejects(reader.listTools());
  await configService.update('connectors',{mcpWriteEnabled:false},configService.revision);
  assert.equal(configService.current<{mcpWriteEnabled:boolean}>('connectors').mcpWriteEnabled,true);
  ({app,configService}=await restart());await app.listen({host:'127.0.0.1',port:Number(port)});
  assert.equal(configService.current<{mcpWriteEnabled:boolean}>('connectors').mcpWriteEnabled,false);await assert.rejects(writer.listTools());
});

test('disabled MCP minting fails with actionable fixed codes and accurate safe diagnostics',async t=>{
  const {app,diagnostics}=await fixture(t);
  const mint=()=>app.inject({method:'POST',url:'/api/connections/mcp',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic',access:'write'}});
  const disabled=await mint();assert.equal(disabled.statusCode,409);assert.equal(disabled.json().error,'mcp_disabled');
  const enabled=await fixture(t,{mcp:true,mcpWriteEnabled:false});
  const write=await enabled.app.inject({method:'POST',url:'/api/connections/mcp',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic',access:'write'}});assert.equal(write.statusCode,409);assert.equal(write.json().error,'mcp_write_disabled');assert.equal(enabled.connections.inventory().items.length,0);
  const events=[...diagnostics.events(0,100).items,...enabled.diagnostics.events(0,100).items].filter(e=>e.event==='request.failed');assert.equal(events.length,2);assert.ok(events.every(e=>e.statusCode===409&&e.category==='conflict'&&e.route==='connections'));
});

test('paired clients preserve content-free activity and bounded heartbeat metadata',async t=>{
  const {app,store,diagnostics}=await fixture(t),key=await paired(app),metadata={version:1,observedAt:new Date(Date.now()-1000).toISOString(),device:{osVersion:'Synthetic OS'},state:{batteryPercent:52,charging:false},capture:{intervalMs:15000}};
  const capture={id:randomUUID(),deviceId:'synthetic-phone',deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),durationMs:15000,source:'activity',appId:'synthetic.activity',appName:'Synthetic app',ocrText:'',windowTitle:'',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'},metadata};
  const send=(body:unknown)=>app.inject({method:'POST',url:'/api/captures',headers:headers(key.token),payload:body});
  assert.equal((await send(capture)).statusCode,201);assert.equal((await send(capture)).json().duplicate,true);
  assert.deepEqual(store.evidence([capture.id])[0].metadata,metadata);
  assert.equal((await send({...capture,id:randomUUID(),deviceId:'another-device'})).statusCode,201);
  assert.equal((await send({...capture,id:randomUUID(),platform:'macos'})).statusCode,201);
  assert.equal((await send({...capture,id:randomUUID(),ocrText:'Synthetic forbidden hidden activity content'})).statusCode,400);
  assert.equal((await send({...capture,id:randomUUID(),windowTitle:'Synthetic forbidden window title'})).statusCode,400);
  const beat=await app.inject({method:'POST',url:'/api/devices/heartbeat',headers:headers(key.token),payload:{deviceId:'synthetic-phone',deviceName:'Synthetic phone',platform:'android',status:'capturing',queueDepth:0,metadata}});
  assert.equal(beat.statusCode,200);assert.deepEqual(store.devices().find(d=>d.deviceId==='synthetic-phone')!.metadata,metadata);
  assert.equal(store.activity().activityEvents,3);assert.equal(store.activity().contentCaptures,0);assert.equal(store.stats().imageCaptures,0);
  const log=JSON.stringify(diagnostics.events(0,500));for(const privateField of ['synthetic.activity','Synthetic forbidden hidden activity content','Synthetic forbidden window title','Synthetic OS',key.token])assert.ok(!log.includes(privateField));
});

test('capture batches isolate per-item failure, retry idempotently and validate scope before writes',async t=>{
  const {app}=await fixture(t);const client=await paired(app);
  const capture=(deviceId='synthetic-phone')=>({id:randomUUID(),deviceId,deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),durationMs:0,source:'activity',appId:'fixture.reader',appName:'Generated reader',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
  const a=capture(),b=capture();
  const post=(captures:unknown[],token=client.token)=>app.inject({method:'POST',url:'/api/captures/batch',headers:headers(token),payload:{captures}});
  for(const appName of [undefined,'',' \t\n']) {
    const invalid={...capture(),appName};
    assert.equal((await post([invalid])).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:headers(client.token),payload:invalid})).statusCode,400);
  }
  assert.equal((await post([capture('someone-else')])).statusCode,200);
  assert.equal((await app.inject({url:`/api/captures/${a.id}`,headers:headers()})).statusCode,404);
  const initial=await post([a,b]);assert.equal(initial.statusCode,200);
  assert.deepEqual(initial.json().results.map((r:{status:number})=>r.status),[201,201]);
  assert.deepEqual((await post([a,b])).json().results.map((r:{status:number})=>r.status),[200,200]);
  const c=capture();const partial=await post([{...a,durationMs:1000},c]);
  assert.deepEqual(partial.json().results.map((r:{status:number})=>r.status),[409,201]);
  await app.inject({method:'DELETE',url:`/api/captures/${b.id}`,headers:headers()});
  assert.equal((await post([b])).json().results[0].status,410);
  assert.equal((await post([a,a])).statusCode,400);
  assert.equal((await post([])).statusCode,400);
  assert.equal((await post(Array.from({length:26},()=>capture()))).statusCode,400);
  const unseen=capture();assert.equal((await post([unseen,{...capture(),privacy:{excluded:true}}])).statusCode,400);
  assert.equal((await app.inject({url:`/api/captures/${unseen.id}`,headers:headers()})).statusCode,404);
  assert.equal((await post([capture()],'invalid')).statusCode,401);
});

test('batch quota failures preserve accepted receipts and permit idempotent replay',async t=>{
  const {app,store,storageOptions}=await fixture(t);
  // Boot with normal room for installed metadata, then leave a measured intake
  // budget. The batch must exercise real quota rejection after some receipts.
  storageOptions.maxStorageBytes=store.logicalBytes()+4096;
  const captures=Array.from({length:25},()=>({id:randomUUID(),deviceId:'quota-fixture',deviceName:'Synthetic quota fixture',platform:'android',capturedAt:new Date().toISOString(),durationMs:0,source:'activity',appId:'fixture.reader',appName:'Generated reader',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}}));
  const send=()=>app.inject({method:'POST',url:'/api/captures/batch',headers:headers(),payload:{captures}});
  const first=await send();assert.equal(first.statusCode,200);
  const statuses=first.json().results.map((r:{status:number})=>r.status);
  assert.ok(statuses.includes(201));assert.ok(statuses.includes(507));
  assert.deepEqual((await send()).json().results.map((r:{status:number})=>r.status),statuses.map((s:number)=>s===201?200:s));
});

test('gzip JSONL capture bundles are unpacked, scoped and acknowledged per record',async t=>{
  const {app}=await fixture(t),client=await paired(app);
  const capture=()=>({id:randomUUID(),deviceId:'synthetic-phone',deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),durationMs:0,source:'activity',appId:'fixture.reader',appName:'Generated reader',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
  const first=capture(),second=capture();
  const payload=Buffer.from([first,second].map(value=>JSON.stringify(value)).join('\n')+'\n');
  const send=(body:Buffer)=>app.inject({method:'POST',url:'/api/captures/bundle',headers:{...headers(client.token),'content-type':'application/x-ndjson+gzip'},payload:body});
  const response=await send(gzipSync(payload));
  assert.equal(response.statusCode,200);assert.deepEqual(response.json().results.map((item:{status:number})=>item.status),[201,201]);
  assert.deepEqual((await send(gzipSync(payload))).json().results.map((item:{status:number})=>item.status),[200,200]);
  assert.equal((await send(gzipSync(Buffer.from(JSON.stringify({...capture(),deviceId:'someone-else'})+'\n')))).statusCode,200);
  assert.equal((await send(gzipSync(Buffer.from(JSON.stringify({...first,id:randomUUID(),deviceId:'someone-else'})+'\n')))).statusCode,200);
});


test('attribution controls require owner authority and paired owner clients can correct a material',async t=>{
  const {app,materials,materialOrganizer,sources}=await fixture(t,{mcp:true}),client=await paired(app);
  sources.register(source('attribution'));
  const patch={ownerRelation:'third_party'};
  assert.equal((await app.inject({method:'PATCH',url:'/api/sources/attribution',payload:patch})).statusCode,401);
  assert.equal((await app.inject({method:'PATCH',url:'/api/sources/attribution',headers:headers('synthetic-static-write-mcp-token-123456789'),payload:patch})).statusCode,401);
  const declared=await app.inject({method:'PATCH',url:'/api/sources/attribution',headers:headers(client.token),payload:patch});assert.equal(declared.statusCode,200);assert.equal(declared.json().ownerRelationVersion,1);
  await sources.upsert('attribution',item());await materialOrganizer.tick(50);
  const material=materials.list({sourceId:'attribution'}).items[0]!;assert.equal(material.attributionContext?.ownerRelation,'third_party');
  const payload={expectedRevision:material.revision,ownerRelation:'owner'};
  assert.equal((await app.inject({method:'PATCH',url:`/api/materials/${material.id}/context`,payload})).statusCode,401);
  const corrected=await app.inject({method:'PATCH',url:`/api/materials/${material.id}/context`,headers:headers(client.token),payload});assert.equal(corrected.statusCode,200);assert.equal(corrected.json().attributionContext.basis,'owner_material');
  assert.equal((await app.inject({method:'PATCH',url:`/api/materials/${material.id}/context`,headers:headers(),payload})).statusCode,409);
});

test('500 revoked credentials do not block HTTP re-pairing and current credential remains valid after a full restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-connections-history-')),cfg=config(directory);
 let node=await buildApp(cfg,{backgroundWorker:false,agent:inactive});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const first=await paired(node.app,'generated-history-device');
 const path=join(directory,'connectors/client-connections.json'),saved=JSON.parse(await readFile(path,'utf8')),original=saved.credentials[0];
 await node.app.close();
 const revoked=Array.from({length:500},(_,i)=>({...original,id:randomUUID(),hash:createHash('sha256').update('generated-revoked-token-'+i).digest('hex'),revokedAt:new Date().toISOString()}));
 await writeFile(path,JSON.stringify({...saved,credentials:[...revoked,original]}),{mode:0o600});
 node=await buildApp(cfg,{backgroundWorker:false,agent:inactive});
 const code=(await invite(node.app,'generated-history-device')).json().invitation.code,replacement=await redeem(node.app,code,'generated-history-device');
 assert.equal(replacement.statusCode,200,replacement.body);const current=replacement.json();
 assert.equal(node.connections.inventory().items.length,502);
 assert.equal((await node.app.inject({url:'/api/connections/self',headers:headers(first.token)})).statusCode,401);
 assert.equal((await node.app.inject({url:'/api/connections/self',headers:headers(current.token)})).statusCode,200);
 await node.app.close();node=await buildApp(cfg,{backgroundWorker:false,agent:inactive});
 assert.equal((await node.app.inject({url:'/api/connections/self',headers:headers(first.token)})).statusCode,401);
 assert.equal((await node.app.inject({url:'/api/connections/self',headers:headers(current.token)})).statusCode,200);
 assert.equal((await node.app.inject({url:'/api/connections/self',headers:headers('generated-revoked-token-0')})).statusCode,401);
 assert.equal(node.connections.inventory().items.length,502);
});

async function collector(app:Awaited<ReturnType<typeof buildApp>>['app'],deviceId='synthetic-phone',bound=false){
  const invitation=await app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Standalone collector',...(bound?{deviceId}:{})}});
  assert.equal(invitation.statusCode,200,invitation.body);assert.equal(invitation.json().scope,'collector');
  const result=await redeem(app,invitation.json().invitation.code,deviceId);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().scope,'collector');return result.json() as {token:string;credentialId:string};
}

test('collector uses actual HTTP for resumable intake without receiving archive or owner capabilities',async t=>{
  const {app,sources}=await fixture(t),client=await collector(app),auth=headers(client.token);
  const address=await app.listen({host:'127.0.0.1',port:0});
  async function request(path:string,method='GET',body?:unknown,status=200){
    const response=await fetch(address+path,{method,headers:{...auth,...(body?{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'}:{})},...(body?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{})});
    const text=await response.text();assert.equal(response.status,status,method+' '+path+' '+text);return text?JSON.parse(text):undefined;
  }
  const self=await request('/api/connections/self');assert.equal(self.credential.scope,'collector');assert.deepEqual(self.capabilities,{ingest:true,ingressVersion:2,ownSources:true,archiveRead:false});
  await request('/api/devices/heartbeat','POST',{deviceId:'synthetic-phone',deviceName:'Generated',platform:'android',status:'paused',queueDepth:0});
  const saved=note();await request('/api/notes','POST',saved,201);
  await request('/api/captures','POST',noteCapture(note()),201);
  const batch=await request('/api/captures/batch','POST',{captures:[noteCapture(note()),noteCapture(note())]});assert.equal(batch.results.length,2);assert.ok(batch.results.every((r:any)=>r.status===201));

  assert.deepEqual((await request('/api/capture-browser/reconcile','POST',{deviceId:saved.deviceId,ids:[saved.id,randomUUID()]})).items.map((i:any)=>i.state),['present','unavailable']);
  await request('/api/sources','POST',{...source('collected'),platform:'android',retention:'archive'});
  await request('/api/sources/collected/items','PUT',item());
  const bytes=Buffer.from('Generated file bytes, never personal content.'),manifest={sourceId:'collected',previousRevision:null,item:{externalId:'generated-file',revision:'v1',observedAt:new Date().toISOString(),title:'fixture.bin',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'fixture.bin',sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await request('/api/file-sync/v1/capabilities');
  const upload=await request('/api/file-sync/v1/uploads','POST',manifest);
  await request(`/api/file-sync/v1/uploads/${upload.uploadId}/parts/0`,'PUT',bytes);
  assert.equal((await request(`/api/file-sync/v1/uploads/${upload.uploadId}`)).parts.length,1);
  const ack=await request(`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,'POST',{});
  assert.deepEqual(await request('/api/file-sync/v1/head?sourceId=collected&externalId=generated-file'),{revision:'v1',forgotten:false});
  await request('/api/file-sync/v1/recovery?sourceId=collected');
  assert.equal(sources.getItem('collected','generated-file')?.revision,'v1');
  for(const path of ['/api/captures','/api/notes','/api/status','/api/configuration','/api/export','/api/connections','/api/capture-browser','/api/capture-browser/updates?deviceId=synthetic-phone','/api/source-items','/api/sources/collected/items','/api/sources/collected/item?externalId=one','/api/sources/collected/history?externalId=one','/api/sources/collected/catalog','/api/sources/collected/context','/api/files',`/api/files/${ack.id}/content`,'/api/not-a-collector-route']){
    await request(path,'GET',undefined,403);await request(path,'HEAD',undefined,403);
  }
  for(const path of ['/api/login/ticket','/api/login/session','/api/login/requests/generated/approve','/api/connections/invitations','/api/connections/collector-invitations','/api/connections/mcp','/api/query','/api/import'])await request(path,'POST',{},403);
  await request(`/api/connections/${client.credentialId}`,'DELETE',undefined,403);
  await request(`/api/captures/${saved.id}`,'DELETE',undefined,403);
});

test('collector binds source, platform and capture identity and omits owner declarations from every source response',async t=>{
  const {app,sources,store}=await fixture(t),client=await collector(app),auth=headers(client.token);
  sources.register({...source('own'),platform:'android',ownerRelation:'owner'});sources.updateContext('own',{expectedVersion:0,description:'Generated owner-only context'});
  sources.register(source('foreign','foreign-device'));sources.register({...source('wrong-platform'),platform:'linux'});
  const calls=[{url:'/api/sources'},{method:'POST' as const,url:'/api/sources',payload:{...source('own'),platform:'android'}},{method:'PATCH' as const,url:'/api/sources/own',payload:{name:'Renamed'}}];
  for(const call of calls){const response=await app.inject({...call,headers:auth});assert.equal(response.statusCode,200,response.body);for(const s of response.json().items??[response.json()]){assert.equal(s.deviceId,'synthetic-phone');for(const key of ['ownerRelation','ownerRelationVersion','sourceContext'])assert.equal(key in s,false,key);}}
  assert.ok((await app.inject({url:'/api/sources',headers:headers()})).json().items.find((s:any)=>s.id==='own').sourceContext);
  for(const body of [{...source('new'),platform:'linux'},{...source('new','foreign-device'),platform:'android'},{...source('own'),platform:'android',ownerRelation:'owner'},{...source('wrong-platform'),platform:'android'}])assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:auth,payload:body})).statusCode,403);
  for(const id of ['foreign','wrong-platform'])for(const method of ['PATCH','PUT'] as const){const response=await app.inject({method,url:`/api/sources/${id}${method==='PUT'?'/items':''}`,headers:auth,payload:method==='PUT'?item():{name:'Denied'}});assert.equal(response.statusCode,403,response.body);}
  for(const body of [note('foreign-device'),{...note(),platform:'linux'}])assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:body})).statusCode,403);
  const foreign=note('foreign-device');await app.inject({method:'POST',url:'/api/notes',headers:headers(),payload:foreign});
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:{...note(),id:foreign.id}})).statusCode,403);assert.equal(store.evidence([foreign.id])[0].deviceId,'foreign-device');
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:{authorization:`Bearer ${client.token}`},payload:note()})).statusCode,426);
  assert.equal((await app.inject({method:'PATCH',url:'/api/sources/own',headers:auth,payload:{ownerRelation:'third_party'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/file-sync/v1/head?sourceId=foreign&externalId=one',headers:auth})).statusCode,403);
  const own=noteCapture(note()),foreignCapture=noteCapture(note('foreign-device'));
  assert.equal((await app.inject({method:'POST',url:'/api/captures/batch',headers:auth,payload:{captures:[own,foreignCapture]}})).statusCode,403);
  assert.equal(store.evidence([own.id]).length,0,'scope validation precedes every batch write');
  const c=noteCapture(note());const bundle=await app.inject({method:'POST',url:'/api/captures/bundle',headers:{...auth,'content-type':'application/gzip'},payload:gzipSync(JSON.stringify(c)+'\n')});
  assert.equal(bundle.statusCode,200,bundle.body);assert.equal(bundle.json().results[0].status,201);

});

test('owner and collector credentials rotate independently for one device and collector revocation survives restart',async t=>{
  const {app,connections,restart}=await fixture(t),ownerClient=await paired(app),first=await collector(app,'synthetic-phone',true),second=await collector(app,'synthetic-phone',true);
  assert.ok(connections.authenticate(`Bearer ${ownerClient.token}`));assert.equal(connections.authenticate(`Bearer ${first.token}`),undefined);assert.ok(connections.authenticate(`Bearer ${second.token}`));
  const ownerInvite=await invite(app,'synthetic-phone');const replacement=(await redeem(app,ownerInvite.json().invitation.code)).json();
  assert.equal(connections.authenticate(`Bearer ${ownerClient.token}`),undefined);assert.ok(connections.authenticate(`Bearer ${replacement.token}`));assert.ok(connections.authenticate(`Bearer ${second.token}`));
  const next=await restart();assert.equal((await next.app.inject({url:'/api/connections/self',headers:headers(second.token)})).json().credential.scope,'collector');
  await next.app.inject({method:'DELETE',url:`/api/connections/${second.credentialId}`,headers:headers()});
  const final=await restart();assert.equal((await final.app.inject({url:'/api/connections/self',headers:headers(second.token)})).statusCode,401);
});

test('collector revoked during source preparation cannot publish evidence or a revision',async t=>{
  const {app,store,sources}=await fixture(t),client=await collector(app);sources.register({...source('owned'),platform:'android'});
  let entered!:()=>void,resume!:()=>void;const inside=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>resume=r),prepare=store.prepare.bind(store);
  store.prepare=async raw=>{const value=await prepare(raw);entered();await gate;return value;};
  const pending=app.inject({method:'PUT',url:'/api/sources/owned/items',headers:headers(client.token),payload:item()});
  await inside;await app.inject({method:'DELETE',url:`/api/connections/${client.credentialId}`,headers:headers()});resume();
  assert.equal((await pending).statusCode,401);assert.equal(sources.history('owned','one').length,0);assert.equal(store.list().items.length,0);
});
