import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Connections} from '../src/connections.js';
import {mcpContext} from '../src/connectors/mcp-context.js';
import {registerMcp} from '../src/connectors/mcp.js';
import {McpOAuthServer} from '../src/connectors/mcp-oauth.js';
import {registerMcpOAuthRoutes} from '../src/connectors/mcp-oauth-routes.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import {SourceStore} from '../src/sources.js';
import {Store} from '../src/store.js';
import {connectorReader} from './fixtures/connector-reader.js';

const owner='synthetic-owner-for-mcp-oauth-tests';
const readToken='synthetic-static-read-oauth-token-123456789';
const writeToken='synthetic-static-write-oauth-token-123456789';
const publicUrl='https://synthetic.invalid';
const redirectUri='http://127.0.0.1:43123/callback';
const ownerHeaders=()=>({authorization:`Bearer ${owner}`});
const inactive:QueryAgent={configured:false,query:async()=>{throw Error('No model calls belong in MCP OAuth tests');},close:async()=>{}};
const challenge=(verifier:string)=>createHash('sha256').update(verifier).digest('base64url');
const verifier=()=>randomBytes(40).toString('base64url');
const form=(values:Record<string,string>)=>new URLSearchParams(values).toString();
const source=(id:string,deviceId='synthetic-device')=>({id,name:id,kind:'custom',deviceId,platform:'import',enabled:true,retention:'snapshot'});
const item=(text='Synthetic OAuth evidence')=>({externalId:`item-${randomBytes(4).toString('hex')}`,revision:randomBytes(8).toString('hex'),observedAt:new Date().toISOString(),title:'Synthetic item',text,kind:'file',layer:'original'});

async function fixture(t:test.TestContext,options:{mcp?:boolean;write?:boolean;clock?:()=>number;publicUrl?:string|null}={}){
  const directory=await mkdtemp(join(tmpdir(),'mote-mcp-oauth-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  const connections=new Connections(store,sources,{clock:options.clock});
  await connections.init();
  const ctx:ConnectorContext={
    store,sources,
    get evidenceReader(){return connectorReader(store,sources,{files:ctx.files,materials:ctx.materials,sourcePipelines:ctx.sourcePipelines,materialOrganizers:ctx.materialOrganizers});},
    config:{dataDir:join(directory,'vault'),token:owner,allowedOrigins:['https://synthetic.invalid'],...(options.publicUrl===null?{}:{publicUrl:options.publicUrl??publicUrl}),connectors:{directory:join(directory,'private'),mcpEnabled:options.mcp??true,mcpReadToken:readToken,mcpWriteEnabled:options.write??false,...(options.write?{mcpWriteToken:writeToken}:{}),mcpWriteSourceIds:options.write?['allowed']:[]}},
    ownerAuthorization:header=>header===`Bearer ${owner}`,
  };
  ctx.mcpAuthorization=(header,resource)=>connections.mcpAuthorization(header,ctx.config.connectors,resource);
  sources.register(source('allowed'));sources.register(source('other','synthetic-other'));
  const app=Fastify(),ownerAuthorization=(header:string|undefined)=>header===`Bearer ${owner}`;
  const oauth=new McpOAuthServer({connections,directory:ctx.config.connectors!.directory,...(options.clock?{clock:options.clock}:{}),policy:()=>{const local=ctx.config.connectors;return {enabled:Boolean(local?.mcpEnabled),writeEnabled:Boolean(local?.mcpEnabled&&local.mcpWriteEnabled&&local.mcpWriteSourceIds?.length),writeSourceIds:local?.mcpWriteSourceIds??[]};}});
  registerMcpOAuthRoutes(app,{oauth,configuration:()=>ctx.config.connectors,publicUrl:ctx.config.publicUrl,allowedOrigins:ctx.config.allowedOrigins,ownerAuthorization});
  const mcp=mcpContext(ctx),mount=registerMcp(app,mcp);
  t.after(async()=>{await mount.close();await app.close();await connections.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {app,connections,ctx,directory,store,sources,mcp};
}
const resource=()=>`${publicUrl}/mcp`;
function authorizeUrl(clientId:string,redirect=redirectUri,codeChallenge=challenge(verifier()),scope?:string,resourceValue=resource()){
  return '/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirect,state:'synthetic-state',code_challenge:codeChallenge,code_challenge_method:'S256',resource:resourceValue,...(scope?{scope}:{})}).toString();
}
async function registerClient(app:ReturnType<typeof Fastify>,name='Synthetic OAuth client',redirect=redirectUri){
  const result=await app.inject({method:'POST',url:'/oauth/register',payload:{redirect_uris:[redirect],client_name:name,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}});
  assert.equal(result.statusCode,201,result.body);
  const body=result.json();assert.match(body.client_id,/^[A-Za-z0-9_-]{43}$/);assert.equal(body.client_secret,undefined);assert.equal(body.token_endpoint_auth_method,'none');
  return body.client_id as string;
}
async function pendingRequest(app:ReturnType<typeof Fastify>){
  const response=await app.inject({url:'/api/connections/mcp/oauth/requests',headers:ownerHeaders()});
  assert.equal(response.statusCode,200,response.body);return response.json().items as Array<{id:string;clientName:string;write:boolean;expiresAt:string;redirectUri:string;createdAt:string}>;
}
async function approve(app:ReturnType<typeof Fastify>,id:string,headers=ownerHeaders()){
  return app.inject({method:'POST',url:`/api/connections/mcp/oauth/requests/${id}/approve`,headers,payload:{}});
}
async function codeFor(app:ReturnType<typeof Fastify>,clientId:string,challengeValue:string,scope?:string){
  const first=await app.inject({url:authorizeUrl(clientId,redirectUri,challengeValue,scope)});assert.equal(first.statusCode,200,first.body);
  const pending=await pendingRequest(app),request=pending.find(value=>value.write===Boolean(scope?.includes('mote.write')));
  assert.ok(request,'the pending authorization is visible to the owner');
  assert.equal((await approve(app,request!.id)).statusCode,200);
  const second=await app.inject({url:authorizeUrl(clientId,redirectUri,challengeValue,scope)});assert.equal(second.statusCode,303,second.body);
  const location=new URL(second.headers.location as string);assert.equal(location.origin,'http://127.0.0.1:43123');assert.equal(location.searchParams.get('state'),'synthetic-state');
  return location.searchParams.get('code')!;
}
async function exchange(app:ReturnType<typeof Fastify>,clientId:string,code:string,codeVerifier:string){
  return app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'authorization_code',code,client_id:clientId,redirect_uri:redirectUri,code_verifier:codeVerifier,resource:resource()})});
}
const mcpCall=(app:ReturnType<typeof Fastify>,token:string,body:unknown)=>app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},payload:body});

test('MCP discovery advertises protected-resource and authorization-server metadata without credentials',async t=>{
  const {app,directory}=await fixture(t);
  const unauthorized=await app.inject({method:'POST',url:'/mcp',headers:{'content-type':'application/json'},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  assert.equal(unauthorized.statusCode,401);
  assert.match(unauthorized.headers['www-authenticate'] as string,/resource_metadata="https:\/\/synthetic\.invalid\/\.well-known\/oauth-protected-resource\/mcp"/);
  const invalid=await app.inject({method:'POST',url:'/mcp',headers:{authorization:'Bearer synthetic-invalid-token','content-type':'application/json'},payload:{}});
  assert.equal(invalid.statusCode,401);assert.match(invalid.headers['www-authenticate'] as string,/error="invalid_token"/);
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
    const response=await app.inject({url:path});assert.equal(response.statusCode,200,response.body);
    const body=response.json();assert.equal(body.resource,resource());assert.deepEqual(body.authorization_servers,[publicUrl]);assert.deepEqual(body.bearer_methods_supported,['header']);assert.deepEqual(body.scopes_supported,['mote.read']);
    assert.equal(response.headers['cache-control'],'no-store');
    for(const secret of [readToken,writeToken,owner,directory])assert.ok(!response.body.includes(secret),`${path} disclosed ${secret}`);
  }
  const authorization=await app.inject({url:'/.well-known/oauth-authorization-server'});assert.equal(authorization.statusCode,200);
  const metadata=authorization.json();
  assert.equal(metadata.issuer,publicUrl);assert.equal(metadata.authorization_endpoint,publicUrl+'/oauth/authorize');
  assert.equal(metadata.token_endpoint,publicUrl+'/oauth/token');assert.equal(metadata.registration_endpoint,publicUrl+'/oauth/register');
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);assert.deepEqual(metadata.token_endpoint_auth_methods_supported,['none']);
  assert.deepEqual(metadata.scopes_supported,['mote.read']);
  for(const secret of [readToken,writeToken,owner,directory])assert.ok(!authorization.body.includes(secret));
  const disabled=await fixture(t,{mcp:false});
  const disabledMetadata=await disabled.app.inject({url:'/.well-known/oauth-protected-resource/mcp'});
  assert.equal(disabledMetadata.statusCode,200);assert.deepEqual(disabledMetadata.json().scopes_supported,['mote.read']);
  assert.equal((await disabled.app.inject({method:'POST',url:'/mcp',headers:{'content-type':'application/json'},payload:{}})).statusCode,503);
  const disabledClient=await registerClient(disabled.app);
  const disabledAuthorize=await disabled.app.inject({url:authorizeUrl(disabledClient,redirectUri,challenge(verifier()))});
  assert.equal(disabledAuthorize.statusCode,503,'discovery exists but no token can be issued while MCP is disabled');
});

test('OAuth registration, owner approval, PKCE exchange and existing read MCP tools form one flow',async t=>{
  const {app,connections,mcp}=await fixture(t);
  const clientId=await registerClient(app),codeVerifier=verifier(),codeChallenge=challenge(codeVerifier);
  const authorize=await app.inject({url:authorizeUrl(clientId,redirectUri,codeChallenge)});
  assert.equal(authorize.statusCode,200);assert.match(authorize.body,/Synthetic OAuth client/);assert.match(authorize.headers['content-security-policy'] as string,/default-src 'none'/);
  const pending=await pendingRequest(app);assert.equal(pending.length,1);assert.equal(pending[0].clientName,'Synthetic OAuth client');assert.equal(pending[0].write,false);assert.equal(typeof pending[0].expiresAt,'string');assert.ok(Date.parse(pending[0].expiresAt)>Date.now());
  for(const field of ['code','code_challenge','state','access_token','refresh_token'])assert.equal(JSON.stringify(pending).includes(field),false,field);
  assert.equal((await approve(app,pending[0].id,{authorization:`Bearer ${readToken}`})).statusCode,403,'an existing MCP read token cannot approve');
  const collectorInvite=connections.invite({serverUrl:'https://synthetic.invalid',label:'Synthetic collector',deviceId:'synthetic-collector'},'collector');
  const collector=await connections.redeem({code:collectorInvite.invitation.code,deviceId:'synthetic-collector',deviceName:'Synthetic collector',platform:'android'});
  assert.equal((await app.inject({url:'/api/connections/mcp/oauth/requests',headers:{authorization:`Bearer ${collector.token}`}})).statusCode,403,'a collector cannot list approvals');
  assert.equal((await approve(app,pending[0].id,{authorization:`Bearer ${collector.token}`})).statusCode,403,'a collector cannot approve');
  assert.equal((await approve(app,pending[0].id)).statusCode,200);
  const approved=await app.inject({url:authorizeUrl(clientId,redirectUri,codeChallenge)});assert.equal(approved.statusCode,303);
  const code=new URL(approved.headers.location as string).searchParams.get('code')!;
  const tokens=await exchange(app,clientId,code,codeVerifier);assert.equal(tokens.statusCode,200,tokens.body);
  const granted=tokens.json();assert.match(granted.access_token,/^[A-Za-z0-9_-]{43}$/);assert.equal(granted.token_type,'Bearer');assert.equal(granted.scope,'mote.read');assert.ok(granted.refresh_token);
  const list=await mcpCall(app,granted.access_token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  assert.equal(list.statusCode,200,list.body);const tools=list.json().result.tools.map((tool:{name:string})=>tool.name);
  assert.ok(tools.includes('mote_timeline'));assert.ok(tools.includes('mote_status'));assert.ok(!tools.includes('mote_put_item'));
  const status=await mcpCall(app,granted.access_token,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'mote_status',arguments:{}}});
  assert.equal(status.statusCode,200,status.body);assert.equal(status.json().result.isError,undefined);assert.ok(status.json().result.structuredContent);
  mcp.publicUrl='https://other.invalid';
  assert.equal((await mcpCall(app,granted.access_token,{jsonrpc:'2.0',id:4,method:'tools/list'})).statusCode,401,'the OAuth token is bound to its discovered MCP resource');
  mcp.publicUrl=publicUrl;
  const replay=await exchange(app,clientId,code,codeVerifier);assert.equal(replay.statusCode,400);assert.equal(replay.json().error,'invalid_grant');
  const nextChallenge=challenge(verifier()),nextCode=await codeFor(app,clientId,nextChallenge);
  const missing=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'authorization_code',code:nextCode,client_id:clientId,redirect_uri:redirectUri,resource:resource()})});
  assert.equal(missing.statusCode,400);assert.equal(missing.json().error,'invalid_request');
  const wrong=await exchange(app,clientId,nextCode,verifier());assert.equal(wrong.statusCode,400);assert.equal(wrong.json().error,'invalid_grant');
  const unknown=await app.inject({url:'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:'x'.repeat(43),redirect_uri:redirectUri,code_challenge:challenge(verifier()),code_challenge_method:'S256',resource:resource()}).toString()});
  assert.equal(unknown.statusCode,400);
  assert.ok(connections.inventory().items.some(value=>value.label==='Synthetic OAuth client'&&value.scope==='mcp-read'));
});

test('OAuth rejects unregistered redirects, plain PKCE, denied clients and disallowed browser origins',async t=>{
  const {app}=await fixture(t);
  const clientId=await registerClient(app),codeVerifier=verifier();
  const wrongRedirect=await app.inject({url:authorizeUrl(clientId,'https://attacker.invalid/callback',challenge(codeVerifier))});
  assert.equal(wrongRedirect.statusCode,400);assert.equal(wrongRedirect.headers.location,undefined);
  const plain=await app.inject({url:'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,code_challenge:codeVerifier,code_challenge_method:'plain',resource:resource()}).toString()});
  assert.equal(plain.statusCode,303);assert.equal(new URL(plain.headers.location as string).searchParams.get('error'),'invalid_request');
  const unknown=await app.inject({url:authorizeUrl('y'.repeat(43))});assert.equal(unknown.statusCode,400);
  const unapproved=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'authorization_code',code:'z'.repeat(43),client_id:clientId,redirect_uri:redirectUri,code_verifier:codeVerifier})});
  assert.equal(unapproved.statusCode,400);assert.equal(unapproved.json().error,'invalid_grant');
  const crossOrigin=await app.inject({url:'/oauth/token',method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'authorization_code',code:'a'.repeat(43),client_id:clientId,redirect_uri:redirectUri,code_verifier:codeVerifier})});
  assert.equal(crossOrigin.statusCode,403);
  const registration=await app.inject({method:'POST',url:'/oauth/register',headers:{origin:'https://attacker.invalid'},payload:{redirect_uris:[redirectUri]}});assert.equal(registration.statusCode,403);
  for(const uri of ['javascript:alert(1)','http://attacker.invalid/callback','https://synthetic.invalid/callback#fragment']){
    const rejected=await app.inject({method:'POST',url:'/oauth/register',payload:{redirect_uris:[uri]}});
    assert.equal(rejected.statusCode,400,uri);assert.equal(rejected.json().error,'invalid_redirect_uri');
  }
});

test('expired approvals, codes, access tokens and owner revocation close every OAuth path',async t=>{
  let now=Date.now();const {app,connections,ctx}=await fixture(t,{clock:()=>now});
  const clientId=await registerClient(app),codeVerifier=verifier(),codeChallenge=challenge(codeVerifier);
  const first=await app.inject({url:authorizeUrl(clientId,redirectUri,codeChallenge)});assert.equal(first.statusCode,200);
  now+=10*60*1000+1;
  const pending=await app.inject({url:'/api/connections/mcp/oauth/requests',headers:ownerHeaders()});assert.deepEqual(pending.json().items,[]);
  const authorizeAgain=await app.inject({url:authorizeUrl(clientId,redirectUri,codeChallenge)});assert.equal(authorizeAgain.statusCode,200);
  const request=(await pendingRequest(app))[0]!;assert.equal((await approve(app,request.id)).statusCode,200);
  const approved=await app.inject({url:authorizeUrl(clientId,redirectUri,codeChallenge)});assert.equal(approved.statusCode,303);
  const code=new URL(approved.headers.location as string).searchParams.get('code')!;
  now+=5*60*1000+1;
  const expiredCode=await exchange(app,clientId,code,codeVerifier);assert.equal(expiredCode.statusCode,400);assert.equal(expiredCode.json().error,'invalid_grant');

  const freshVerifier=verifier(),freshCode=await codeFor(app,clientId,challenge(freshVerifier));
  const tokens=await exchange(app,clientId,freshCode,freshVerifier);assert.equal(tokens.statusCode,200,tokens.body);
  const granted=tokens.json();
  assert.equal((await mcpCall(app,granted.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'})).statusCode,200);
  now+=60*60*1000+1;
  assert.equal((await mcpCall(app,granted.access_token,{jsonrpc:'2.0',id:2,method:'tools/list'})).statusCode,401,'the access token expires');
  const refreshed=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'refresh_token',refresh_token:granted.refresh_token,client_id:clientId,resource:resource()})});
  assert.equal(refreshed.statusCode,200,refreshed.body);const next=refreshed.json();
  assert.equal((await mcpCall(app,next.access_token,{jsonrpc:'2.0',id:3,method:'tools/list'})).statusCode,200);
  const rotated=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'refresh_token',refresh_token:granted.refresh_token,client_id:clientId})});
  assert.equal(rotated.statusCode,400,'refresh tokens rotate once');
  const credential=connections.inventory().items.find(value=>value.label==='Synthetic OAuth client')!;
  await connections.revoke(credential.id);
  assert.equal((await mcpCall(app,next.access_token,{jsonrpc:'2.0',id:4,method:'tools/list'})).statusCode,401,'revocation is immediate');
  const afterRevoke=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'refresh_token',refresh_token:next.refresh_token,client_id:clientId})});
  assert.equal(afterRevoke.statusCode,400);assert.equal(afterRevoke.json().error,'invalid_grant');
  ctx.config.connectors!.mcpEnabled=false;
  assert.equal((await mcpCall(app,next.access_token,{jsonrpc:'2.0',id:5,method:'tools/list'})).statusCode,503);
});

test('OAuth never grants write while disabled, and write credentials keep the configured source allow-list',async t=>{
  const disabled=await fixture(t,{write:false});
  const disabledClient=await registerClient(disabled.app);
  const disabledVerifier=verifier(),denied=await disabled.app.inject({url:authorizeUrl(disabledClient,redirectUri,challenge(disabledVerifier),'mote.write')});
  assert.equal(denied.statusCode,303);assert.equal(new URL(denied.headers.location as string).searchParams.get('error'),'invalid_scope');
  assert.deepEqual(await pendingRequest(disabled.app),[]);

  const first=await fixture(t,{write:true}),clientId=await registerClient(first.app),codeVerifier=verifier();
  const code=await codeFor(first.app,clientId,challenge(codeVerifier),'mote.write');
  const tokens=await exchange(first.app,clientId,code,codeVerifier);assert.equal(tokens.statusCode,200,tokens.body);
  const granted=tokens.json();assert.equal(granted.scope,'mote.write');
  const list=await mcpCall(first.app,granted.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'});assert.deepEqual(list.json().result.tools.map((tool:{name:string})=>tool.name),['mote_put_item']);
  const allowed=await mcpCall(first.app,granted.access_token,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'mote_put_item',arguments:{sourceId:'allowed',item:item()}}});
  assert.equal(allowed.json().result.isError,undefined);
  const deniedCall=await mcpCall(first.app,granted.access_token,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'mote_put_item',arguments:{sourceId:'other',item:item()}}});
  assert.equal(deniedCall.json().result.isError,true);
  first.ctx.config.connectors!.mcpWriteSourceIds=['allowed','other'];
  const widenedConfig=await mcpCall(first.app,granted.access_token,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'mote_put_item',arguments:{sourceId:'other',item:item()}}});
  assert.equal(widenedConfig.json().result.isError,true,'an OAuth credential never widens with later configuration');
  first.ctx.config.connectors!.mcpWriteEnabled=false;
  assert.equal((await mcpCall(first.app,granted.access_token,{jsonrpc:'2.0',id:5,method:'tools/list'})).statusCode,401,'disabling write closes an OAuth write credential');
});

test('static MCP Bearer tokens and generated JSON credentials still work beside OAuth',async t=>{
  const {app,connections,ctx}=await fixture(t,{write:true});
  const staticRead=await mcpCall(app,readToken,{jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal(staticRead.statusCode,200);
  const staticWrite=await mcpCall(app,writeToken,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'mote_put_item',arguments:{sourceId:'allowed',item:item()}}});
  assert.equal(staticWrite.json().result.isError,undefined);
  const minted=await connections.mintMcp({serverUrl:publicUrl,label:'Existing generated JSON',access:'read'},ctx.config.connectors);
  assert.match(minted.config.mcpServers.mote.headers.Authorization,/^Bearer [A-Za-z0-9_-]{43}$/);
  const mintedRead=await mcpCall(app,minted.config.mcpServers.mote.headers.Authorization.slice(7),{jsonrpc:'2.0',id:3,method:'tools/list'});
  assert.equal(mintedRead.statusCode,200);
});

test('the live central mounts discovery, owner approval and the control-API boundary; generated MCP JSON still works',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-mcp-oauth-central-')),store=new Store(directory),connections=new Connections(store,new SourceStore(store));
  await connections.init();
  const cfg:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:4*1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:['https://synthetic.invalid'],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,connectors:{directory:join(directory,'connectors'),mcpEnabled:true,mcpReadToken:readToken,mcpWriteEnabled:false,mcpWriteSourceIds:[]}};
  const node=await buildApp(cfg,{store,agent:inactive,connections});
  t.after(async()=>{await node.app.close();store.close();await rm(directory,{recursive:true,force:true});});
  const discovery=await node.app.inject({url:'/.well-known/oauth-protected-resource/mcp'});assert.equal(discovery.statusCode,200);
  const resourceValue=discovery.json().resource as string;assert.match(resourceValue,/^http:\/\/localhost(:\d+)?\/mcp$/);
  const clientId=await registerClient(node.app),codeVerifier=verifier(),base=resourceValue.slice(0,-4);
  const authorize='/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:redirectUri,state:'synthetic-state',code_challenge:challenge(codeVerifier),code_challenge_method:'S256',resource:resourceValue}).toString();
  const first=await node.app.inject({url:authorize});assert.equal(first.statusCode,200,first.body);
  const request=(await pendingRequest(node.app))[0]!;assert.equal((await approve(node.app,request.id)).statusCode,200);
  const second=await node.app.inject({url:authorize});assert.equal(second.statusCode,303);
  const code=new URL(second.headers.location as string).searchParams.get('code')!;
  const tokens=await node.app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:form({grant_type:'authorization_code',code,client_id:clientId,redirect_uri:redirectUri,code_verifier:codeVerifier,resource:resourceValue})});
  assert.equal(tokens.statusCode,200,tokens.body);const granted=tokens.json();
  assert.equal((await node.app.inject({url:'/api/status',headers:{authorization:`Bearer ${granted.access_token}`}})).statusCode,403,'an OAuth token is never an owner session');
  assert.equal((await node.app.inject({url:'/api/connections',headers:{authorization:`Bearer ${granted.access_token}`}})).statusCode,403);
  assert.equal((await mcpCall(node.app,granted.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'})).statusCode,200);
  const minted=await node.app.inject({method:'POST',url:'/api/connections/mcp',headers:ownerHeaders(),payload:{serverUrl:base,label:'Generated JSON client',access:'read'}});
  assert.equal(minted.statusCode,200,minted.body);const token=(minted.json().config.mcpServers.mote.headers.Authorization as string).slice(7);
  assert.equal((await mcpCall(node.app,token,{jsonrpc:'2.0',id:2,method:'tools/list'})).statusCode,200);
  const listed=await node.app.inject({url:'/api/connections',headers:ownerHeaders()});assert.equal(listed.statusCode,200);
  const oauthCredential=listed.json().items.find((value:{label:string})=>value.label==='Synthetic OAuth client');
  assert.ok(oauthCredential);
  assert.equal((await node.app.inject({method:'DELETE',url:`/api/connections/${oauthCredential.id}`,headers:ownerHeaders()})).statusCode,200);
  assert.equal((await mcpCall(node.app,granted.access_token,{jsonrpc:'2.0',id:3,method:'tools/list'})).statusCode,401,'owner revocation immediately rejects the OAuth access token');
});
