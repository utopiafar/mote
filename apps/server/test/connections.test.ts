import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {parseConnectionInvitation} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Connections,ConnectionError,type ConnectionFile} from '../src/connections.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';

const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in connection tests');},close:async()=>{}};
const owner='synthetic-owner-for-connection-tests';
const headers=(token=owner)=>({authorization:`Bearer ${token}`});
function config(directory:string):Config{return {dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:4*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:['https://synthetic.invalid'],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true};}
async function fixture(t:TestContext,options:{clock?:()=>number;mcp?:boolean}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-connections-')),cfg=config(directory),store=new Store(directory),sources=new SourceStore(store);
  if(options.mcp)cfg.connectors={directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:'synthetic-static-read-mcp-token-123456789',mcpWriteEnabled:true,mcpWriteToken:'synthetic-static-write-mcp-token-123456789',mcpWriteSourceIds:['allowed']};
  const connections=new Connections(store,sources,{clock:options.clock});
  const value=await buildApp(cfg,{store,agent:inactive,connections});
  t.after(async()=>{await value.app.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {...value,directory,cfg};
}
const invite=(app:Awaited<ReturnType<typeof buildApp>>['app'],deviceId?:string)=>app.inject({method:'POST',url:'/api/connections/invitations',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic phone',...(deviceId?{deviceId}:{})}});
const redeem=(app:Awaited<ReturnType<typeof buildApp>>['app'],code:string,deviceId='synthetic-phone')=>app.inject({method:'POST',url:'/api/connections/redeem',payload:{code,deviceId,deviceName:'Synthetic phone',platform:'android'}});
async function paired(app:Awaited<ReturnType<typeof buildApp>>['app'],deviceId='synthetic-phone'){const created=await invite(app);assert.equal(created.statusCode,200);const result=await redeem(app,created.json().invitation.code,deviceId);assert.equal(result.statusCode,200);return result.json() as {token:string;credentialId:string;serverUrl:string;scope:string};}
const note=(deviceId='synthetic-phone')=>({id:randomUUID(),deviceId,deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),text:'Synthetic authored note; no actual personal text.'});
const source=(id:string,deviceId='synthetic-phone')=>({id,deviceId,name:'Synthetic source',kind:'local-files',platform:'import',retention:'snapshot',enabled:true});
const item=()=>({externalId:'one',revision:randomUUID(),observedAt:new Date().toISOString(),title:'Synthetic file',text:'Synthetic file evidence',kind:'file',layer:'snapshot'});

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
  const granted=replies.find(r=>r.statusCode===200)!.json();assert.notEqual(granted.token,owner);assert.equal(granted.scope,'collector');
  const file=join(directory,'connectors/client-connections.json'),raw=await readFile(file,'utf8');
  for(const secret of [code,granted.token,owner])assert.ok(!raw.includes(secret));
  assert.equal((await lstat(file)).mode&0o777,0o600);assert.equal((await lstat(join(directory,'connectors'))).mode&0o777,0o700);
  const loaded=new Connections(store,sources);await loaded.init();assert.equal(loaded.authenticate(`Bearer ${granted.token}`)?.id,granted.credentialId);await loaded.close();
  const inventory=(await app.inject({url:'/api/connections',headers:headers()})).json();assert.equal(inventory.items.length,1);assert.ok(!JSON.stringify(inventory).includes(granted.token));assert.ok(!JSON.stringify(inventory).includes('"hash"'));
  const self=await app.inject({url:'/api/connections/self',headers:headers(granted.token)});assert.equal(self.statusCode,200);assert.equal(self.json().credential.deviceId,'synthetic-phone');assert.equal(self.json().capabilities.archiveRead,false);
  assert.deepEqual(Object.keys(self.json().credential).sort(),['deviceId','deviceName','id','label','platform','scope','serverUrl']);
  await app.inject({method:'DELETE',url:`/api/connections/${granted.credentialId}`,headers:headers()});
  assert.equal(connections.authenticate(`Bearer ${granted.token}`),undefined);
  const restarted=new Connections(store,sources);await restarted.init();assert.equal(restarted.authenticate(`Bearer ${granted.token}`),undefined);await restarted.close();
  const diagnosticsBody=JSON.stringify(diagnostics.events(0,500));for(const secret of [code,granted.token,owner])assert.ok(!diagnosticsBody.includes(secret));
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

test('collector auth rejects device/capture/source impersonation and central archive or management access',async t=>{
  const {app,store,sources}=await fixture(t),client=await paired(app),auth=headers(client.token);
  const original=note('owner-device');await app.inject({method:'POST',url:'/api/notes',headers:headers(),payload:original});
  const own=note();assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:own})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:own})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:note('owner-device')})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/notes',headers:auth,payload:{...own,id:original.id}})).statusCode,403);
  const screen={id:randomUUID(),deviceId:'synthetic-phone',deviceName:'Synthetic phone',platform:'android',capturedAt:new Date().toISOString(),durationMs:1000,appId:'synthetic',appName:'Synthetic',source:'screen',ocrText:'Generated synthetic screen text'};
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth,payload:screen})).statusCode,201);
  assert.equal((await app.inject({method:'POST',url:'/api/captures',headers:auth,payload:{...screen,id:randomUUID(),source:'file',durationMs:0,provenance:{sourceId:'foreign',externalId:'one',revision:'one',layer:'original'}}})).statusCode,403);
  const beat={deviceId:'synthetic-phone',deviceName:'Synthetic phone',platform:'android',status:'capturing',queueDepth:0};
  assert.equal((await app.inject({method:'POST',url:'/api/devices/heartbeat',headers:auth,payload:beat})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/devices/heartbeat',headers:auth,payload:{...beat,deviceId:'owner-device'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/devices/heartbeat',headers:auth,payload:{...beat,platform:'macos'}})).statusCode,403);
  assert.equal(store.devices().find(d=>d.deviceId==='synthetic-phone')?.platform,'android');
  sources.register(source('foreign','owner-device'));await sources.upsert('foreign',item());
  assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:auth,payload:source('owned')})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:auth,payload:source('foreign')})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/sources',headers:auth,payload:source('spoofed','owner-device')})).statusCode,403);
  const ownItem=item();assert.equal((await app.inject({method:'PUT',url:'/api/sources/owned/items',headers:auth,payload:ownItem})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:'/api/sources/foreign/items',headers:auth,payload:item()})).statusCode,403);
  assert.equal((await app.inject({method:'PATCH',url:'/api/sources/foreign',headers:auth,payload:{enabled:false}})).statusCode,403);
  assert.deepEqual((await app.inject({url:'/api/sources',headers:auth})).json().items.map((s:any)=>s.id),['owned']);
  assert.equal((await app.inject({url:'/api/source-items',headers:auth})).json().items.length,1);
  for(const url of ['/api/source-items?deviceId=owner-device','/api/source-items?sourceId=foreign','/api/sources/foreign/items','/api/sources/foreign/item?externalId=one','/api/sources/foreign/history?externalId=one'])assert.equal((await app.inject({url,headers:auth})).statusCode,403,url);
  for(const url of ['/api/status','/api/configuration','/api/captures','/api/notes','/api/devices','/api/activity','/api/export','/api/updates','/api/memories','/api/connections','/api/diagnostics','/api/support-bundle','/api/software-update',`/api/captures/${own.id}`,`/api/notes/${own.id}`])assert.equal((await app.inject({url,headers:auth})).statusCode,403,url);
  for(const url of ['/api/query','/api/import','/api/index/retry','/api/connections/mcp','/api/connections/invitations','/api/connectors/google/start'])assert.equal((await app.inject({method:'POST',url,headers:auth,payload:{}})).statusCode,403,url);
  assert.equal((await app.inject({method:'DELETE',url:`/api/captures/${own.id}`,headers:auth})).statusCode,403);
  assert.equal(store.evidence([original.id])[0].deviceId,'owner-device');
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

test('redemption has a bounded per-address rate limit without exhausting the owner bucket',async t=>{
  const {app}=await fixture(t),code='a'.repeat(43);
  for(let i=0;i<12;i++)assert.equal((await redeem(app,code)).statusCode,410);
  assert.equal((await redeem(app,code)).statusCode,429);
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
  const {app,cfg,sources}=await fixture(t,{mcp:true});sources.register(source('allowed','mcp-owner'));sources.register(source('later','mcp-owner'));
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
  cfg.connectors!.mcpWriteSourceIds!.push('later');
  assert.equal((await writer.callTool({name:'mote_put_item',arguments:{sourceId:'later',item:item()}})).isError,true,'A broader later config must not widen the issued credential');
  assert.equal((await app.inject({url:'/api/configuration',headers:write.config.mcpServers.mote.headers})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/mcp',headers:headers(),payload:{}})).statusCode,401);
  await app.inject({method:'DELETE',url:`/api/connections/${read.credential.id}`,headers:headers()});
  await assert.rejects(reader.listTools());
  cfg.connectors!.mcpWriteEnabled=false;await assert.rejects(writer.listTools());
});

test('disabled MCP minting fails with actionable fixed codes and accurate safe diagnostics',async t=>{
  const {app,connections,cfg,diagnostics}=await fixture(t);
  const mint=()=>app.inject({method:'POST',url:'/api/connections/mcp',headers:headers(),payload:{serverUrl:'https://synthetic.invalid',label:'Synthetic',access:'write'}});
  const disabled=await mint();assert.equal(disabled.statusCode,409);assert.equal(disabled.json().error,'mcp_disabled');
  cfg.connectors={directory:join(cfg.dataDir,'connectors'),mcpEnabled:true};const write=await mint();assert.equal(write.statusCode,409);assert.equal(write.json().error,'mcp_write_disabled');assert.equal(connections.inventory().items.length,0);
  const events=diagnostics.events(0,100).items.filter(e=>e.event==='request.failed');assert.equal(events.length,2);assert.ok(events.every(e=>e.statusCode===409&&e.category==='conflict'&&e.route==='connections'));
});
