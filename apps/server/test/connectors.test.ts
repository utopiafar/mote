import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Fastify from 'fastify';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {OAuth2Client} from 'google-auth-library';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {registerConnectors} from '../src/connectors/index.js';
import {RemoteMcp} from '../src/connectors/mcp.js';
import {GoogleCalendarConnector,calendarBoundary,googleItem,type GoogleDependencies} from '../src/connectors/google.js';
import {publicAddress,remoteUrl,restrictedFetch} from '../src/connectors/network.js';
import type {ConnectorContext} from '../src/connectors/types.js';

const owner='synthetic-owner-credential-123456789';
const readToken='synthetic-read-credential-123456789';
const writeToken='synthetic-write-credential-123456789';
const jsonResult=(result:any)=>JSON.parse(result.content[0].text);
async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'mote-connectors-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
  const ctx:ConnectorContext={store,sources,config:{dataDir:join(directory,'vault'),token:owner,allowedOrigins:['https://synthetic.invalid'],connectors:{directory:join(directory,'private'),mcpEnabled:true,mcpReadToken:readToken,mcpWriteEnabled:true,mcpWriteToken:writeToken,mcpWriteSourceIds:['allowed'],googleClientId:'synthetic-client',googleClientSecret:'synthetic-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}}};
  sources.register({id:'allowed',name:'Synthetic source',kind:'custom',deviceId:'synthetic-device',platform:'import'});
  sources.register({id:'other',name:'Other synthetic source',kind:'custom',deviceId:'synthetic-other',platform:'import'});
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});return {ctx,directory,store,sources};
}
const item=(text='Synthetic evidence')=>({externalId:'synthetic-item',revision:randomUUID(),observedAt:new Date().toISOString(),title:'Synthetic item',text,kind:'file',layer:'original'});

test('MCP real SDK isolates read/write credentials, scopes writes and exposes bounded complete archive reads',async t=>{
  const {ctx,store,sources}=await fixture(t),app=Fastify();
  const connectors=await registerConnectors(app,ctx);
  await app.listen({host:'127.0.0.1',port:0});
  const endpoint=new URL('/mcp',app.listeningOrigin);
  const clients:Client[]=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await connectors.close();await app.close();});
  assert.equal((await app.inject({url:'/api/connectors/status'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/connectors/status',headers:{authorization:`Bearer ${owner}`}})).statusCode,200);
  for(const token of [undefined,owner])assert.equal((await app.inject({method:'POST',url:'/mcp',headers:token?{authorization:`Bearer ${token}`}:{},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${readToken}`,origin:'https://attacker.invalid'},payload:{}})).statusCode,403);
  const connect=async(token:string)=>{const client=new Client({name:'synthetic-client',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client;};
  const reader=await connect(readToken),writer=await connect(writeToken);
  const names=(await reader.listTools()).tools.map(tool=>tool.name);
  assert.ok(names.includes('mote_timeline'));assert.ok(names.includes('mote_memories'));assert.ok(names.includes('mote_history'));assert.ok(!names.includes('mote_put_item'));
  assert.deepEqual((await writer.listTools()).tools.map(tool=>tool.name),['mote_put_item']);
  const refused=await writer.callTool({name:'mote_put_item',arguments:{sourceId:'other',item:item()}});assert.equal(refused.isError,true);assert.equal(sources.listItems({sourceId:'other'}).items.length,0);
  const event={...item('x'.repeat(14000)),metadata:{version:1,file:{sizeBytes:14000,createdAt:'2026-09-01T00:00:00Z'}}};
  const written=jsonResult(await writer.callTool({name:'mote_put_item',arguments:{sourceId:'allowed',item:event}}));assert.equal(written.duplicate,false);
  assert.equal(jsonResult(await writer.callTool({name:'mote_put_item',arguments:{sourceId:'allowed',item:event}})).duplicate,true);
  const original=await reader.callTool({name:'mote_evidence',arguments:{ids:[written.id],offset:12000,length:2000}});
  assert.equal(jsonResult(original)[0].text.length,2000);assert.equal(jsonResult(original)[0].textRange.nextOffset,null);
  assert.deepEqual(jsonResult(original)[0].provenance.metadata,event.metadata);
  const revised={...event,revision:randomUUID(),text:'a😀b',observedAt:new Date(Date.now()+1000).toISOString()};
  const revision=jsonResult(await writer.callTool({name:'mote_put_item',arguments:{sourceId:'allowed',item:revised}}));
  const unicode=jsonResult(await reader.callTool({name:'mote_evidence',arguments:{ids:[revision.id],offset:2,length:1}}))[0];
  assert.equal(unicode.text,'😀');assert.equal(unicode.textRange.offset,1);assert.equal(unicode.textRange.nextOffset,3);
  const history=jsonResult(await reader.callTool({name:'mote_history',arguments:{sourceId:'allowed',externalId:event.externalId}}));
  assert.equal(history.length,2);assert.equal(history.filter((v:any)=>v.current).length,1);
  assert.equal(jsonResult(await reader.callTool({name:'mote_items',arguments:{deviceId:'synthetic-other'}})).items.length,0);
  await writer.callTool({name:'mote_put_item',arguments:{sourceId:'allowed',item:{...revised,revision:randomUUID(),observedAt:new Date(Date.now()+2000).toISOString(),deleted:true,text:''}}});
  assert.equal(jsonResult(await reader.callTool({name:'mote_items',arguments:{}})).items.length,0);
  assert.equal(jsonResult(await reader.callTool({name:'mote_items',arguments:{includeDeleted:true}})).items[0].deleted,true);
  const updates=jsonResult(await reader.callTool({name:'mote_updates',arguments:{cursor:0}}));assert.ok(updates.items.every((e:any)=>!('record'in e)&&!('text'in e)));
  const noteId=randomUUID();await store.ingest({id:noteId,deviceId:'synthetic-notes',deviceName:'Synthetic notes',platform:'import',capturedAt:new Date().toISOString(),durationMs:0,appId:'notes',appName:'Notes',source:'note',ocrText:'Authored synthetic diary'});
  const timeline=jsonResult(await reader.callTool({name:'mote_timeline',arguments:{}}));assert.ok(timeline.items.some((e:any)=>e.id===noteId));assert.ok(timeline.items.every((e:any)=>e.text.length<=2000));
  const found=jsonResult(await reader.callTool({name:'mote_search',arguments:{query:'Authored'}}));assert.equal(found[0].id,noteId);
  const activityId=randomUUID(),metadata={version:1,observedAt:new Date(Date.now()-1000).toISOString(),state:{batteryPercent:35}};
  await store.ingest({id:activityId,deviceId:'synthetic-activity',deviceName:'Synthetic activity',platform:'android',capturedAt:new Date().toISOString(),durationMs:15000,appId:'synthetic.activity',appName:'Synthetic activity',source:'activity',ocrText:'',privacy:{collection:'activity'},metadata});
  const scoped=jsonResult(await reader.callTool({name:'mote_timeline',arguments:{appId:'synthetic.activity',source:'activity',collection:'activity'}}));
  assert.equal(scoped.totalCount,1);assert.equal(scoped.items[0].id,activityId);assert.equal(scoped.items[0].text,'');assert.equal(scoped.items[0].durationMs,15000);assert.deepEqual(scoped.items[0].metadata,metadata);
  assert.equal(jsonResult(await reader.callTool({name:'mote_search',arguments:{query:'Synthetic',collection:'activity',appId:'synthetic.activity'}})).length,1);
  const activity=jsonResult(await reader.callTool({name:'mote_activity',arguments:{collection:'activity',appId:'synthetic.activity'}}));assert.equal(activity.totalDurationMs,15000);assert.equal(activity.activityEvents,1);assert.equal(activity.contentCaptures,0);
  assert.equal((await reader.readResource({uri:'mote://sources'})).contents[0].mimeType,'application/json');
});

test('remote MCP uses official HTTP SDK, selected resources, explicit readonly tools and restoration revisions',async t=>{
  const {ctx,sources}=await fixture(t);ctx.config.connectors!.allowLocalMcp=true;
  sources.register({id:'remote',name:'Synthetic remote',kind:'mcp',deviceId:'remote-fixture',platform:'import'});
  let text='Version A',mutations=0,resourceReads=0,toolReads=0;const remoteApp=Fastify();
  remoteApp.all('/mcp',async(req,reply)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-remote-token');
    if(req.method!=='POST')return reply.code(405).send();
    const server=new McpServer({name:'synthetic-external',version:'1'});
    server.registerResource('document','fixture://document',{mimeType:'text/plain'},async()=>{resourceReads++;return {contents:[{uri:'fixture://document',mimeType:'text/plain',text}]};});
    server.registerTool('read-note',{annotations:{readOnlyHint:true}},async()=>{toolReads++;return {content:[{type:'text',text:'Synthetic selected tool result'}]};});
    server.registerTool('unsafe-write',{annotations:{readOnlyHint:false}},async()=>{mutations++;return {content:[]};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);reply.hijack();try{await transport.handleRequest(req.raw,reply.raw,req.body);}finally{await server.close();}
  });
  await remoteApp.listen({host:'127.0.0.1',port:0});const remote=new RemoteMcp(ctx);t.after(async()=>{await remote.close();await remoteApp.close();});
  const target={url:remoteApp.listeningOrigin+'/mcp',token:'synthetic-remote-token'};
  const discovery=await remote.discover(target);assert.equal(discovery.resources.length,1);assert.equal(discovery.tools.find(t=>t.name==='unsafe-write')?.readOnly,false);
  const input={...target,sourceId:'remote',resourceUris:['fixture://document']};
  assert.equal((await remote.import(input)).imported,1);assert.equal((await remote.import(input)).duplicates,1);
  const first=sources.listItems({sourceId:'remote'}).items[0];text='Version B';await remote.import(input);text='Version A';await remote.import(input);
  const current=sources.listItems({sourceId:'remote'}).items[0];assert.equal(current.text,'Version A');assert.notEqual(current.revision,first.revision);assert.equal(sources.history('remote',current.externalId).length,3);
  await assert.rejects(remote.import({...target,sourceId:'remote',tool:{name:'unsafe-write',arguments:{},confirmedReadOnly:true}}),/mcp_tool_not_readonly/);assert.equal(mutations,0);
  assert.equal((await remote.import({...target,sourceId:'remote',tool:{name:'read-note',arguments:{},confirmedReadOnly:true}})).imported,1);
  await assert.rejects(remote.import({...target,sourceId:'remote',tool:{name:'read-note',arguments:{}}}));
  sources.register({id:'reference',name:'Metadata only',kind:'mcp',deviceId:'reference',platform:'import',retention:'reference'});
  const reads=resourceReads,toolCalls=toolReads;
  assert.equal((await remote.import({...input,sourceId:'reference'})).imported,1);
  assert.equal(resourceReads,reads,'Reference import must not read the resource body');assert.equal(sources.listItems({sourceId:'reference'}).items[0].text,'');
  await assert.rejects(remote.import({...target,sourceId:'reference',tool:{name:'read-note',arguments:{},confirmedReadOnly:true}}),/reference_tool_denied/);assert.equal(toolReads,toolCalls);
  const external=JSON.stringify(sources.listItems({sourceId:'remote'}));assert.ok(!external.includes(target.token));
  await remote.close();await assert.rejects(remote.discover(target),/connector_closed/);
});

test('remote fetch denies private/default targets, credentials, metadata IPs and redirects',async t=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1','fe80::1','64:ff9b::7f00:1','2002:7f00:1::'])assert.equal(publicAddress(ip),false);
  assert.equal(publicAddress('8.8.8.8'),true);
  assert.throws(()=>remoteUrl('http://127.0.0.1:1234/mcp'));
  assert.throws(()=>remoteUrl('https://x:y@host.invalid/mcp'));
  assert.throws(()=>remoteUrl('https://host.invalid/mcp?token=synthetic'));
  assert.throws(()=>remoteUrl('http://127.attacker.invalid/mcp',true));
  await assert.rejects(restrictedFetch(new URL('https://127.0.0.1/mcp'))('https://127.0.0.1/mcp'),/address_rejected/);
  const app=Fastify();app.get('/mcp',(_,reply)=>reply.redirect('http://169.254.169.254/'));await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());
  const endpoint=new URL('/mcp',app.listeningOrigin);await assert.rejects(restrictedFetch(endpoint,true)(endpoint),/redirect_rejected/);
});

function googleFixture(ctx:ConnectorContext,handle:(url:URL)=>Response|Promise<Response>){
  let exchanges=0,accesses=0,receivedVerifier='';
  const oauth=new OAuth2Client({clientId:'synthetic-client',clientSecret:'synthetic-secret',redirectUri:ctx.config.connectors!.googleRedirectUri});
  oauth.getToken=(async(options:any)=>{exchanges++;receivedVerifier=options.codeVerifier;return {tokens:{refresh_token:'synthetic-refresh-private',access_token:'synthetic-access-private',scope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly'}};}) as any;
  oauth.getAccessToken=(async()=>{accesses++;oauth.credentials={...oauth.credentials,access_token:'synthetic-access-private'};return {token:'synthetic-access-private'};}) as any;
  const deps:GoogleDependencies={oauthFactory:()=>oauth,fetch:(async(input,init)=>{assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-access-private');return handle(new URL(String(input)));}) as typeof fetch};
  const connector=new GoogleCalendarConnector(ctx,deps);
  const authorize=async()=>{const started=await connector.start(),url=new URL(started.authorizationUrl);assert.equal(url.searchParams.get('access_type'),'offline');assert.equal(url.searchParams.get('code_challenge_method'),'S256');await connector.callback(url.searchParams.get('state')!,'synthetic-code');assert.equal(createHash('sha256').update(receivedVerifier).digest('base64url'),url.searchParams.get('code_challenge'));return url.searchParams.get('state')!;};
  return {connector,authorize,counts:()=>({exchanges,accesses})};
}
const calendar={id:'synthetic-calendar',summary:'Synthetic calendar',timeZone:'America/New_York',primary:true};
const googleEvent=(id:string,summary:string)=>({id,etag:summary,summary,start:{dateTime:new Date(Date.now()+86400000).toISOString()},end:{dateTime:new Date(Date.now()+90000000).toISOString()},status:'confirmed'});

test('Google OAuth state/PKCE, private refresh persistence, calendar selection and disconnect isolation',async t=>{
  const {ctx,directory,sources}=await fixture(t);
  const {connector,authorize,counts}=googleFixture(ctx,()=>Response.json({items:[calendar]}));await connector.init();t.after(()=>connector.close());
  await assert.rejects(connector.callback('missing-state','synthetic-code'),/state_invalid/);assert.equal(counts().exchanges,0);
  const state=await authorize();await assert.rejects(connector.callback(state,'synthetic-code'),/state_invalid/);assert.equal(counts().exchanges,1);
  const path=join(directory,'private/google-calendar.json');assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(join(directory,'private'))).mode&0o777,0o700);
  assert.equal(connector.status().connected,true);assert.ok(!JSON.stringify(connector.status()).includes('synthetic-refresh'));
  await connector.select({calendarIds:[calendar.id]});assert.equal(sources.listSources().filter(s=>s.kind==='google-calendar').length,1);
  assert.equal((await connector.calendars()).calendars[0].selected,true);assert.ok(counts().accesses>=2);
  await assert.rejects(connector.select({calendarIds:['not-permitted']}),/not_found/);
  await authorize();assert.equal(sources.listSources().find(s=>s.kind==='google-calendar')?.enabled,false,'Replacing the account pauses its prior sources');
  await connector.select({calendarIds:[calendar.id]});
  await connector.disconnect();assert.equal(connector.status().connected,false);assert.equal(sources.listSources().find(s=>s.kind==='google-calendar')?.enabled,false);await assert.rejects(readFile(path),{code:'ENOENT'});
});

test('Google full pagination, incremental token invariants, 410 rebuild, cancellation times and failed-page checkpoint',async t=>{
  const {ctx,sources,directory}=await fixture(t);let mode='full';const queries:URL[]=[];
  const {connector,authorize}=googleFixture(ctx,url=>{
    if(url.pathname.endsWith('/calendarList'))return Response.json({items:[calendar]});queries.push(url);
    if(mode==='full')return url.searchParams.has('pageToken')?Response.json({items:[googleEvent('second','Second')],nextSyncToken:'sync-one'}):Response.json({items:[googleEvent('first','First')],nextPageToken:'page-two'});
    if(mode==='incremental')return Response.json({items:[{id:'first',status:'cancelled'}],nextSyncToken:'sync-two'});
    if(mode==='expired')return url.searchParams.has('syncToken')?new Response('',{status:410}):Response.json({items:[googleEvent('third','Third')],nextSyncToken:'sync-three'});
    if(mode==='failure')return new Response('',{status:503});
    throw Error('Unexpected fixture mode');
  });await connector.init();t.after(()=>connector.close());await authorize();await connector.select({calendarIds:[calendar.id]});
  assert.deepEqual(await connector.sync(),{imported:2,duplicates:0,calendars:1});const source=sources.listSources().find(s=>s.kind==='google-calendar')!;
  assert.equal(queries.length,2);assert.equal(queries[0].searchParams.get('timeMin'),queries[1].searchParams.get('timeMin'));
  const plan=sources.getItem(source.id,'first')!.calendar;mode='incremental';await connector.sync();
  assert.equal(queries.at(-1)!.searchParams.get('syncToken'),'sync-one');for(const key of ['timeMin','timeMax','orderBy','q','updatedMin'])assert.equal(queries.at(-1)!.searchParams.has(key),false);
  const cancelled=sources.getItem(source.id,'first')!;assert.equal(cancelled.deleted,true);assert.deepEqual(cancelled.calendar,{...plan,status:'cancelled'});
  assert.ok(sources.listItems({sourceId:source.id,after:plan!.start,before:plan!.end,includeDeleted:true}).items.some(item=>item.externalId==='first'));
  mode='expired';await connector.sync();assert.equal(sources.getItem(source.id,'second')!.deleted,true);assert.equal(sources.getItem(source.id,'third')!.deleted,false);
  const saved=JSON.parse(await readFile(join(directory,'private/google-calendar.json'),'utf8'));assert.equal(saved.checkpoints[calendar.id].syncToken,'sync-three');
  mode='failure';await assert.rejects(connector.sync(),/rate_limited/);
  assert.equal(JSON.parse(await readFile(join(directory,'private/google-calendar.json'),'utf8')).checkpoints[calendar.id].syncToken,'sync-three');assert.equal(connector.status().state,'error');
});

test('Google all-day boundaries retain calendar time zone across DST and timestamp offsets stay explicit',()=>{
  assert.equal(calendarBoundary('2026-03-08','America/New_York'),'2026-03-08T05:00:00.000Z');
  assert.equal(calendarBoundary('2026-03-09','America/New_York'),'2026-03-09T04:00:00.000Z');
  const value=googleItem({id:'day',summary:'Synthetic day',start:{date:'2026-03-08'},end:{date:'2026-03-09'}},calendar);
  assert.equal(Date.parse(value.calendar!.end)-Date.parse(value.calendar!.start),23*3600000);assert.equal(value.calendar!.allDay,true);
  const precise=googleItem({id:'offset',start:{dateTime:'2026-09-14T01:00:00+14:00'},end:{dateTime:'2026-09-14T02:00:00+14:00'}},calendar);assert.equal(precise.calendar!.start,'2026-09-14T01:00:00+14:00');
});

test('Google failed final page preserves checkpoint and reference retention excludes original body',async t=>{
  const {ctx,sources,directory}=await fixture(t);let fail=true;
  const event={...googleEvent('reference-only','Synthetic visible title'),description:'synthetic-body-never-persisted'};
  const {connector,authorize}=googleFixture(ctx,url=>{
    if(url.pathname.endsWith('/calendarList'))return Response.json({items:[calendar]});
    if(url.searchParams.has('pageToken'))return fail?new Response('',{status:503}):Response.json({items:[],nextSyncToken:'committed-after-final-page'});
    return Response.json({items:[event],nextPageToken:'final'});
  });await connector.init();t.after(()=>connector.close());await authorize();await connector.select({calendarIds:[calendar.id]});
  const source=sources.listSources().find(s=>s.kind==='google-calendar')!;sources.update(source.id,{retention:'reference'});
  await assert.rejects(connector.sync(),/rate_limited/);assert.equal(sources.listItems({sourceId:source.id}).items.length,0);
  assert.equal(JSON.parse(await readFile(join(directory,'private/google-calendar.json'),'utf8')).checkpoints[calendar.id],undefined);
  fail=false;await connector.sync();const record=sources.getItem(source.id,event.id)!;assert.equal(record.layer,'reference');assert.equal(record.text,'');
  assert.ok(!JSON.stringify(ctx.store.evidence([record.captureId])[0]).includes('synthetic-body-never-persisted'));
});

test('Google disconnect waits for token-refresh work and cannot resurrect credentials',async t=>{
  const {ctx,directory}=await fixture(t);let block=false,release:()=>void=()=>{},entered:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const {connector,authorize}=googleFixture(ctx,async()=>{if(block){entered();await gate;}return Response.json({items:[calendar]});});
  await connector.init();t.after(()=>connector.close());await authorize();block=true;
  const reading=connector.calendars();await started;const disconnect=connector.disconnect();release();await reading;await disconnect;
  assert.equal(connector.status().connected,false);await assert.rejects(readFile(join(directory,'private/google-calendar.json')),{code:'ENOENT'});
});

test('Google real provider timestamps remain distinct from observation and metadata-only changes create revisions',async t=>{
  const {sources,store}=await fixture(t),event={...googleEvent('metadata-event','Synthetic calendar record'),created:'2025-01-01T01:00:00Z',updated:'2026-09-01T02:00:00Z'},first=googleItem(event,calendar);
  await sources.upsert('allowed',first);const original=sources.getItem('allowed',event.id)!;
  assert.deepEqual(original.metadata,{version:1,provider:{createdAt:event.created,updatedAt:event.updated}});
  assert.equal(original.modifiedAt,event.updated);assert.notEqual(original.observedAt,event.updated);assert.notEqual(original.calendar!.start,original.observedAt);
  const next=googleItem({...event,created:'2025-01-02T01:00:00Z'},calendar,original);assert.notEqual(next.revision,first.revision);await sources.upsert('allowed',next);
  assert.equal(sources.history('allowed',event.id).length,2);assert.deepEqual(store.evidence([original.captureId])[0].provenance!.metadata,original.metadata);
  const prior=sources.getItem('allowed',event.id)!,cancel=googleItem({id:event.id,status:'cancelled'},calendar,prior);await sources.upsert('allowed',cancel);
  assert.deepEqual(cancel.metadata,prior.metadata);assert.equal(cancel.modifiedAt,prior.modifiedAt);assert.equal(cancel.calendar!.status,'cancelled');assert.equal(cancel.text,'');
  const unknown=googleItem(googleEvent('unknown-timestamps','Synthetic unknown'),calendar);assert.equal(unknown.metadata,undefined);assert.equal(unknown.modifiedAt,undefined);
  const reference=googleItem(event,calendar,undefined,true);assert.equal(reference.text,'');assert.deepEqual(reference.metadata,first.metadata);
});
