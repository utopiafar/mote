import {testPluginControl} from './fixtures/plugin-storage.js';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OAuth2Client} from 'google-auth-library';
import {centralCalendarPluginCapabilitySchema,type ActionConnectorChoice,type ActionGrant,type ActionPluginProvider,type PluginBuildView} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {Connections} from '../src/connections.js';
import {Actions} from '../src/actions.js';
import {ManagedCalendar} from '../src/managed-calendar.js';
import {ActionCapabilities} from '../src/plugins/action-capabilities.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {officialPluginCatalog} from '../src/official-plugin-catalog.js';
import {GoogleCalendarConnector,type GoogleDependencies} from '../src/connectors/google.js';
import {googleCalendarContext} from '../src/connectors/google-context.js';
import {LarkConnector,LARK_SCOPES,LARK_CALENDAR_WRITE_SCOPES} from '../src/connectors/lark.js';
import {larkContext} from '../src/connectors/lark-context.js';
import type {LarkCommand,LarkRunner} from '../src/connectors/lark-cli.js';
import type {ConnectorContext} from '../src/connectors/types.js';
import {connectorReader} from './fixtures/connector-reader.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {hostRun} from './fixtures/host-run.js';

const ownerToken='generated-cloud-calendar-owner';
const event={title:'Generated cloud appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:'Generated description'};
const text='Generated cloud calendar appointment is scheduled on 18 September 2099.';
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
const until=async(check:()=>boolean,message:string)=>{const end=Date.now()+8000;while(!check()){assert.ok(Date.now()<end,message);await new Promise(resolve=>setTimeout(resolve,10));}};

async function local(t:TestContext,prefix:string){
 const directory=await mkdtemp(join(tmpdir(),prefix)),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 return {directory,store,sources};
}
function context(directory:string,store:Store,sources:SourceStore):ConnectorContext{
 return {evidenceReader:connectorReader(store,sources),store,sources,config:{dataDir:directory,token:ownerToken,allowedOrigins:[],connectors:{directory:join(directory,'connectors'),googleClientId:'synthetic-client',googleClientSecret:'synthetic-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}}};
}

const calendarA={id:'generated-calendar-a@example.invalid',summary:'Generated calendar A',timeZone:'UTC',primary:true};
const calendarB={id:'generated-calendar-b',summary:'Generated calendar B',timeZone:'UTC'};
const readScope='https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly';
const writeScope='https://www.googleapis.com/auth/calendar.events';

async function googleFixture(t:TestContext){
 const base=await local(t,'mote-cloud-google-'),ctx=context(base.directory,base.store,base.sources);
 const oauth=new OAuth2Client({clientId:'synthetic-client',clientSecret:'synthetic-secret',redirectUri:ctx.config.connectors!.googleRedirectUri});
 oauth.getToken=(async(options:{code?:string})=>{
  const write=options.code==='generated-write-code';
  return {tokens:{refresh_token:write?'synthetic-write-refresh-private':'synthetic-read-refresh-private',access_token:write?'synthetic-write-access-private':'synthetic-read-access-private',scope:write?writeScope:readScope}};
 }) as any;
 oauth.getAccessToken=(async()=>({token:oauth.credentials.access_token})) as any;
 const calls:{method:string;path:string;body?:Record<string,unknown>;authorization:string}[]=[];
 let failWrites=false;
 const deps:GoogleDependencies={oauthFactory:()=>oauth,fetch:(async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';
  if(method==='GET'&&url.pathname.endsWith('/calendarList'))return Response.json({items:[calendarA,calendarB]});
  calls.push({method,path:url.pathname,body:init?.body?JSON.parse(String(init.body)):undefined,authorization:new Headers(init?.headers).get('authorization')??''});
  if(failWrites&&method!=='GET')return new Response('',{status:403});
  if(method==='POST')return Response.json({id:'generated-google-event'});
  if(method==='PATCH')return Response.json({id:decodeURIComponent(url.pathname.split('/').at(-1)!)});
  if(method==='DELETE')return new Response(null,{status:204});
  return new Response('',{status:404});
 }) as typeof fetch};
 const connector=new GoogleCalendarConnector(googleCalendarContext(ctx),deps);await connector.init();t.after(()=>connector.close());
 const read=await connector.start();await connector.callback(new URL(read.authorizationUrl).searchParams.get('state')!,'generated-read-code');
 await connector.select({calendarIds:[calendarA.id,calendarB.id]});
 return {connector,calls,setFailWrites(value:boolean){failWrites=value;}};
}

async function larkFixture(t:TestContext){
 const base=await local(t,'mote-cloud-lark-'),ctx:ConnectorContext={...context(base.directory,base.store,base.sources),config:{dataDir:base.directory,token:ownerToken,allowedOrigins:[],connectors:{directory:join(base.directory,'connectors')}}};
 const state={write:false,fail:false,calls:[] as LarkCommand[]};
 const runner:LarkRunner=async command=>{
  state.calls.push(command);
  switch(command.kind){
   case 'version':return 'lark-cli version 1.0.98';
   case 'status':return JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:'generated-lark-user',userName:'Generated Lark user',scope:[...LARK_SCOPES,'calendar:calendar:readonly',...(state.write?['calendar:calendar']:[])].join(' ')}}});
   case 'login':
    if(command.scopes.includes('calendar:calendar'))state.write=true;
    return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?fixture=generated',device_code:'generated-private-device-code',expires_in:600});
   case 'complete':return '{}';
   case 'calendars':return JSON.stringify({data:{calendar_list:[{calendar_id:'generated-lark-calendar-a',summary:'Generated Lark calendar A',role:'owner',type:'primary'},{calendar_id:'generated-lark-calendar-b',summary:'Generated Lark calendar B',role:'writer'}],has_more:false}});
   case 'calendar-event-create':if(state.fail)throw Error('Generated Lark write failure');return JSON.stringify({data:{event:{event_id:'generated-lark-event'}}});
   case 'calendar-event-update':if(state.fail)throw Error('Generated Lark write failure');return '{}';
   case 'calendar-event-delete':if(state.fail)throw Error('Generated Lark write failure');return '{}';
   default:return '{}';
  }
 };
 const connector=new LarkConnector(larkContext(ctx),runner);await connector.init();t.after(()=>connector.close());
 return {connector,state};
}
async function done(connector:LarkConnector){for(let n=0;n<500;n++){const status=connector.status();if(!status.job||!['running','waiting'].includes(status.job.state))return status;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Lark job did not finish');}

test('Google read-only connection never writes; a separate write consent enables one explicitly selected calendar at a time',async t=>{
 const f=await googleFixture(t),target=(calendarId:string)=>({executionLocation:'central-connector' as const,packageId:'mote.builtin.google-calendar',instanceId:'google-calendar',instanceRevision:1,capabilityId:'calendar.manage',capabilityVersion:1,calendarId});
 assert.deepEqual(f.connector.calendarActionProviders(),[],'read authorization is not write authorization');
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target(calendarA.id),actionId:randomUUID()}}),/google_calendar_write_not_authorized/);
 assert.equal(f.calls.length,0,'a read-only token never reaches a write request');
 const started=await f.connector.startWrite(),url=new URL(started.authorizationUrl);
 assert.equal(url.searchParams.get('scope'),writeScope);assert.equal(url.searchParams.get('include_granted_scopes'),'true');
 await f.connector.callback(url.searchParams.get('state')!,'generated-write-code');
 assert.equal(f.connector.status().writeConnected,true);assert.ok(!JSON.stringify(f.connector.status()).includes('synthetic-write'));
 const providers=f.connector.calendarActionProviders();assert.deepEqual(providers.map(provider=>provider.calendarId).sort(),[calendarA.id,calendarB.id].sort());
 assert.ok(!JSON.stringify(providers).includes('synthetic-write'),'the inventory projection never contains a write token');

 const created=await f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target(calendarA.id),actionId:randomUUID()}});
 assert.deepEqual(created,{status:'succeeded',externalId:'generated-google-event'});
 const create=f.calls.at(-1)!;assert.equal(create.method,'POST');assert.equal(create.authorization,'Bearer synthetic-write-access-private');assert.ok(create.path.includes(encodeURIComponent(calendarA.id)));assert.equal(create.body?.summary,event.title);
 const updated=await f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.update',event:{...event,title:'Generated updated appointment'},target:target(calendarA.id),externalId:'generated-google-event',actionId:randomUUID()}});
 assert.deepEqual(updated,{status:'succeeded',externalId:'generated-google-event'});assert.equal(f.calls.at(-1)!.method,'PATCH');assert.ok(f.calls.at(-1)!.path.includes(encodeURIComponent(calendarA.id)));
 const cancelled=await f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.cancel',event,target:target(calendarB.id),externalId:'generated-google-event',actionId:randomUUID()}});
 assert.deepEqual(cancelled,{status:'succeeded',externalId:'generated-google-event'});assert.equal(f.calls.at(-1)!.method,'DELETE');assert.ok(f.calls.at(-1)!.path.includes(encodeURIComponent(calendarB.id)),'each action writes only its declared calendar');
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-unselected'),actionId:randomUUID()}}),/google_calendar_target_not_selected/);
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.complete',event,target:target(calendarA.id),actionId:randomUUID()}}),/google_calendar_completion_unsupported/);

 f.setFailWrites(true);
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target(calendarA.id),actionId:randomUUID()}}),/google_calendar_write_permission_required/);
 assert.equal(f.connector.status().writeConnected,false,'a rejected write credential is not reported as connected');
 assert.deepEqual(f.connector.calendarActionProviders(),[],'revoked write access stops new write targets');
});

test('Lark write consent reuses the existing account and writes only the selected calendar',async t=>{
 const f=await larkFixture(t);await f.connector.refresh();f.connector.login();assert.equal((await done(f.connector)).connected,true);
 const selection={documents:[],calendarIds:['generated-lark-calendar-a','generated-lark-calendar-b'],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false};
 await f.connector.select(selection);
 assert.deepEqual(f.connector.calendarActionProviders(),[],'calendar read consent is not write authorization');
 const target=(calendarId:string)=>({executionLocation:'central-connector' as const,packageId:'mote.builtin.lark-calendar',instanceId:'lark-calendar',instanceRevision:1,capabilityId:'calendar.manage',capabilityVersion:1,calendarId});
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-lark-calendar-a'),actionId:randomUUID()}}),/lark_calendar_write_not_authorized/);
 f.connector.startWriteAuthorization();const writeJob=await done(f.connector);assert.equal(writeJob.job?.state,'completed');
 const loginCalls=f.state.calls.filter(command=>command.kind==='login');
 assert.ok(loginCalls.some(command=>command.kind==='login'&&command.scopes.includes('calendar:calendar')),'write consent asks for the separate write scope');
 assert.equal(writeJob.calendarWriteAuthorized,true);const providers=f.connector.calendarActionProviders();assert.deepEqual(providers.map(provider=>provider.calendarId).sort(),[...selection.calendarIds].sort());
 assert.ok(!JSON.stringify(writeJob).includes('private-device-code'));

 const created=await f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-lark-calendar-a'),actionId:randomUUID()}});
 assert.deepEqual(created,{status:'succeeded',externalId:'generated-lark-event'});
 const create=f.state.calls.at(-1)!;assert.equal(create.kind,'calendar-event-create');if(create.kind!=='calendar-event-create')throw Error('expected create');assert.equal(create.calendarId,'generated-lark-calendar-a');assert.equal(create.data.summary,event.title);
 const updated=await f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.update',event:{...event,title:'Generated updated Lark appointment'},target:target('generated-lark-calendar-b'),externalId:'generated-lark-event',actionId:randomUUID()}});
 assert.deepEqual(updated,{status:'succeeded',externalId:'generated-lark-event'});const update=f.state.calls.at(-1)!;assert.equal(update.kind,'calendar-event-update');if(update.kind!=='calendar-event-update')throw Error('expected update');assert.equal(update.calendarId,'generated-lark-calendar-b');
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-unselected'),actionId:randomUUID()}}),/lark_calendar_target_not_selected/);
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.complete',event,target:target('generated-lark-calendar-a'),actionId:randomUUID()}}),/lark_calendar_completion_unsupported/);
 f.state.fail=true;
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-lark-calendar-a'),actionId:randomUUID()}}),/Generated Lark write failure/);
 f.connector.disconnectWriteAuthorization();assert.equal((await done(f.connector)).calendarWriteAuthorized,false);
 assert.deepEqual(f.connector.calendarActionProviders(),[],'stopping write authorization removes every write target');
 await assert.rejects(()=>f.connector.executeAction({capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create',event,target:target('generated-lark-calendar-a'),actionId:randomUUID()}}),/lark_calendar_write_not_authorized/);
});

const centralCapability=centralCalendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'central-connector',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,completionInMoteOnly:true}});
const provider=(packageId:string,calendarId:string):ActionPluginProvider=>({identity:{packageId,releaseDigest:'a'.repeat(64),instanceId:'generated-instance',instanceRevision:1,capabilityDigest:'b'.repeat(64)},name:'Generated cloud connector',capability:centralCapability,calendarId});

test('a single calendar-scoped Central grant auto-dispatches only that calendar; ambiguous or revoked scopes stay pending until the owner confirms',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-cloud-host-')),store=new Store(join(directory,'vault')),sources=new SourceStore(store);
 const files=new FileStore(store,sources),connections=new Connections(store,sources);await connections.init();
 const providers=[provider('mote.builtin.google-calendar','generated-calendar-a'),provider('mote.builtin.google-calendar','generated-calendar-b'),provider('mote.builtin.lark-calendar','generated-lark-calendar-a')];
 const calls:{target:any;request:any}[]=[];
 const capabilities=new ActionCapabilities(store,sources,connections,()=>providers);
 const actions=new Actions(store,files,async input=>({runId:randomUUID(),answer:JSON.stringify({actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence:[{id:input.evidenceIds![0],quote:text}]}]}),citations:[{id:input.evidenceIds![0],capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]}),()=>true,{connectorTargets:()=>capabilities.centralConnectors(),messageSendAuthorized:()=>false});
 t.after(async()=>{await actions.close();await files.close();await connections.close();store.close();await rm(directory,{recursive:true,force:true});});
 const managed=new ManagedCalendar(store,actions,capabilities,connections,async({target,request})=>{calls.push({target,request});return {status:'succeeded',externalId:'generated-cloud-'+calls.length};});
 actions.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});
 sources.register({id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
 const propose=async()=>{const record=await sources.upsert('generated-source',{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated original',kind:'message',layer:'original'});for(let n=0;n<20;n++){await actions.tick();const action=actions.list().find(item=>item.evidence.some(evidence=>evidence.id===record.id));if(action)return action;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('proposal not published');};
 const save=async(target:any)=>{const draft=capabilities.saveDraft({...command(0),id:randomUUID(),capability:{id:'calendar.manage',version:1},target,inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input',platform:'import'}],existingArchived:true,futureInputs:true}});return capabilities.authorize({...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:providers.find(provider=>provider.calendarId===target.calendarId)!.identity,acknowledgeCalendarWrites:true});};
 const choice=(calendarId:string)=>capabilities.centralConnectors().find(item=>item.target.calendarId===calendarId)!;

 const first=await propose();await managed.tick();assert.equal(actions.get(first.id).status,'proposed','enabling or declaring a connector never writes');
 const grantA=await save(choice('generated-calendar-a').target);assert.equal(capabilities.available(grantA),true);
 await managed.tick();await until(()=>actions.get(first.id).status==='succeeded','calendar-scoped grant auto-dispatches');assert.equal((actions.get(first.id).target as any).calendarId,'generated-calendar-a');assert.equal(calls.length,1);assert.equal(calls[0].target.calendarId,'generated-calendar-a');

 const grantB=await save(choice('generated-calendar-b').target);const second=await propose();await managed.tick();assert.equal(actions.get(second.id).status,'proposed','overlapping grants never choose a destination silently');
 const confirmed=actions.confirm(second.id,{version:second.version,event:second.event,target:choice('generated-calendar-b').target});assert.equal(confirmed.status,'approved');
 await managed.tick();await until(()=>actions.get(second.id).status==='succeeded','owner confirmation dispatches the explicit target');assert.equal(calls.at(-1).target.calendarId,'generated-calendar-b');

 capabilities.revokeGrant(grantA.id,command(grantA.revision));capabilities.revokeGrant(grantB.id,command(grantB.revision));
 const third=await propose();await managed.tick();assert.equal(actions.get(third.id).status,'proposed','revoking the grants stops new automatic writes');
 assert.equal(calls.length,2);
});

test('the host dispatch seam revalidates a built-in calendar target and the catalog never gains installable calendar writers',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-cloud-center-')),store=new Store(join(directory,'vault')),executor=new ExecutionEngine(store);
 const releases=new GitHubPluginReleases(join(directory,'packages'),async()=>{throw Error('No release fetch in this fixture');});
 const center=new PluginCenter(store,executor,releases,testPluginControl(store));t.after(async()=>{await center.close();await executor.close();store.close();await rm(directory,{recursive:true,force:true});});
 const builtin=provider('mote.builtin.google-calendar','generated-calendar-a'),calls:{connectorId:string;target:any;request:any}[]=[];
 center.builtinActions={providers:()=>[{connectorId:'google-calendar',provider:builtin}],execute:async({connectorId,target,request})=>{calls.push({connectorId,target,request});return {status:'succeeded',externalId:'generated-host-event'};}};
 assert.deepEqual(center.actionProviders(),[builtin],'a built-in provider appears only through its live declaration');
 const target={executionLocation:'central-connector' as const,packageId:builtin.identity.packageId,instanceId:builtin.identity.instanceId,instanceRevision:1,capabilityId:'calendar.manage',capabilityVersion:1,calendarId:'generated-calendar-a'};
 const request={capability:{id:'calendar.manage',version:1},operationId:randomUUID(),input:{kind:'calendar.create' as const,event,target,actionId:randomUUID()}};
 assert.deepEqual(await center.executeConnectorAction({target,request}),{status:'succeeded',externalId:'generated-host-event'});
 assert.equal(calls.length,1);assert.equal(calls[0].connectorId,'google-calendar');assert.equal(calls[0].target.calendarId,'generated-calendar-a');
 await assert.rejects(()=>center.executeConnectorAction({target:{...target,calendarId:'generated-other-calendar'},request}),/provider is unavailable/);
 assert.equal(calls.length,1,'a changed destination is never silently substituted');
 const catalogIds=officialPluginCatalog().map(entry=>(entry as {packageId?:string}).packageId);
 assert.ok(!catalogIds.includes('mote.builtin.google-calendar'));assert.ok(!catalogIds.includes('mote.builtin.lark-calendar'));
});

/** Exercise the production manifests and host assembly; only the cloud OAuth,
 * HTTP and CLI boundaries are generated. No connector class is exposed here. */
function calendarGate(){
 let release!:()=>void,returned!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;}),finished=new Promise<void>(resolve=>{returned=resolve;});
 const state={entered:false,returned:false,signal:undefined as AbortSignal|undefined};
 return {state,release,finished,async pause(signal?:AbortSignal){state.entered=true;state.signal=signal;await wait;state.returned=true;returned();}};
}
async function productionCalendarFixture(t:TestContext,kind:'google'|'lark'){
 const directory=await mkdtemp(join(tmpdir(),'mote-cloud-production-'+kind+'-'));
 const config:Config={dataDir:directory,token:ownerToken,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxExportBytes:1024*1024,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,googleClientId:'synthetic-client',googleClientSecret:'synthetic-secret',googleRedirectUri:'http://127.0.0.1/oauth/google/callback'}};
 const state={write:false,account:'generated-lark-user',outcome:'ok' as 'ok'|'missing',requests:0,calls:[] as {calendarId:string;event:Record<string,unknown>;authorization?:string}[]};
 const gates:ReturnType<typeof calendarGate>[]=[],blocked:{preflight?:ReturnType<typeof calendarGate>;write?:ReturnType<typeof calendarGate>}={};
 const pause=async(phase:'preflight'|'write',signal?:AbortSignal)=>{const gate=blocked[phase];if(gate){delete blocked[phase];await gate.pause(signal);}};
 const google:GoogleDependencies={oauthFactory:()=>{
  const oauth=new OAuth2Client({clientId:'synthetic-client',clientSecret:'synthetic-secret',redirectUri:config.connectors!.googleRedirectUri});
  oauth.getToken=(async(options:{code?:string})=>{const write=options.code==='generated-write-code',identity=write?'write':options.code==='generated-other-read-code'?'other-read':'read';return {tokens:{refresh_token:'synthetic-'+identity+'-refresh-private',access_token:'synthetic-'+identity+'-access-private',scope:write?writeScope:readScope}};}) as any;
  oauth.getAccessToken=(async()=>{await pause('preflight');return {token:oauth.credentials.access_token};}) as any;return oauth;
 },fetch:(async(input,init)=>{
  state.requests++;const url=new URL(String(input));assert.equal(url.origin,'https://www.googleapis.com');
  if((init?.method??'GET')==='GET'&&url.pathname.endsWith('/calendarList'))return Response.json({items:[calendarA,calendarB]});
  assert.equal(init?.method,'POST','the production fixture allows only explicit event creates');
  const match=url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);assert.ok(match,url.pathname);
  state.calls.push({calendarId:decodeURIComponent(match[1]),event:JSON.parse(String(init?.body)),authorization:new Headers(init?.headers).get('authorization')??''});
  await pause('write',init?.signal??undefined);
  return Response.json(state.outcome==='missing'?{}:{id:'generated-google-event-'+state.calls.length});
 }) as typeof fetch};
 const lark:LarkRunner=async(command,options)=>{
  state.requests++;
  switch(command.kind){
   case 'version':return 'lark-cli version 1.0.98';
   case 'status':{const value=JSON.stringify({appId:'cli_generated',identities:{user:{available:true,openId:state.account,userName:'Generated Lark user',scope:[...LARK_SCOPES,'calendar:calendar:readonly',...(state.write?['calendar:calendar']:[])].join(' ')}}});await pause('preflight',options?.signal);return value;}
   case 'login':if(command.scopes.includes('calendar:calendar'))state.write=true;return JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?fixture=generated',device_code:'generated-private-device-code',expires_in:600});
   case 'complete':return '{}';
   case 'calendars':return JSON.stringify({data:{calendar_list:[{calendar_id:'generated-lark-calendar-a',summary:'Generated Lark calendar A',role:'owner',type:'primary'},{calendar_id:'generated-lark-calendar-b',summary:'Generated Lark calendar B',role:'writer'}],has_more:false}});
   case 'calendar-event-create':
    state.calls.push({calendarId:command.calendarId,event:command.data});
    await pause('write',options?.signal);
    return JSON.stringify(state.outcome==='missing'?{}:{data:{event:{event_id:'generated-lark-event-'+state.calls.length}}});
   default:throw Error('Unexpected generated Lark command: '+command.kind);
  }
 };
 const start=()=>buildApp(config,{backgroundWorker:false,connectorTesting:{google,lark},agent:{configured:true,async close(){},async query(input){
  hostRun(input);const id=input.evidenceIds![0],evidence=[{id,quote:text}];
  const answer=input.skill==='calendar-extraction'?{actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence}]}:{summary:'Generated cloud appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'',evidence}]};
  return {runId:randomUUID(),answer:JSON.stringify(answer),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]};
 }}});
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 t.after(async()=>{for(const gate of gates)gate.release();await node?.app.close();await rm(directory,{recursive:true,force:true});});
 node=await start();
 const current=()=>node!,headers={authorization:'Bearer '+ownerToken};
 const request=async(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:any)=>{const response=await current().app.inject({method,url,headers,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,200,response.body);return response.json();};
 const inventory=async()=>await request('GET','/api/action-capabilities') as {providers:ActionPluginProvider[];centralConnectors:ActionConnectorChoice[];grants:(ActionGrant&{available:boolean})[];executionEnabled:boolean};
 const calendarIds=kind==='google'?[calendarA.id,calendarB.id]:['generated-lark-calendar-a','generated-lark-calendar-b'];
 const packageId='mote.builtin.'+(kind==='google'?'google-calendar':'lark-calendar');
 const settleLark=async()=>{const end=Date.now()+8000;for(;;){const status=await request('GET','/api/connectors/lark');if(!status.job||!['running','waiting'].includes(status.job.state)){assert.equal(status.job?.state,'completed',JSON.stringify(status));return status;}assert.ok(Date.now()<end,'the generated Lark job settles');await new Promise(resolve=>setTimeout(resolve,10));}};
 const googleAuthorize=async(write:boolean,code=write?'generated-write-code':'generated-read-code')=>{const authorization=await request('POST','/api/connectors/google'+(write?'/write':'')+'/start');const url=new URL(authorization.authorizationUrl);if(write)assert.equal(url.searchParams.get('scope'),writeScope);const callback=await current().app.inject('/oauth/google/callback?'+new URLSearchParams({state:url.searchParams.get('state')!,code}));assert.equal(callback.statusCode,200,callback.body);};
 const select=async(ids:string[])=>{if(kind==='google')await request('PUT','/api/connectors/google/calendars',{calendarIds:ids});else await request('PUT','/api/connectors/lark/selection',{documents:[],calendarIds:ids,pastDays:30,futureDays:90,timeZone:'UTC',autoSync:false});};
 const connectRead=async()=>{if(kind==='google')await googleAuthorize(false);else{await request('POST','/api/connectors/lark/check');await request('POST','/api/connectors/lark/login',{calendar:true});await settleLark();}await select(calendarIds);};
 const connectWrite=async()=>{if(kind==='google')await googleAuthorize(true);else{await request('POST','/api/connectors/lark/write/start');await settleLark();}};
 const disconnectWrite=async()=>{if(kind==='google')await request('DELETE','/api/connectors/google/write');else{await request('POST','/api/connectors/lark/write/disconnect');await settleLark();}};
 const source={sourceId:'generated-cloud-input',kind:'custom',deviceId:'generated-input',platform:'import'};
 const excluded={...source,sourceId:'generated-cloud-excluded-input'};
 for(const identity of [source,excluded])current().sources.register({id:identity.sourceId,kind:'custom',name:'Generated cloud input',deviceId:identity.deviceId,platform:'import'});
 await authorizeFixtureModels(current());
 const settings=await request('GET','/api/actions');await request('PUT','/api/actions/settings',{revision:settings.revision,authorizationRevision:settings.authorizationRevision,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]}});
 const invitation=await request('POST','/api/connections/collector-invitations',{serverUrl:'https://generated.invalid',label:'Generated cloud review device'});
 const pairing=await current().app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'generated-cloud-review-device',deviceName:'Generated cloud review device',platform:'macos'}});assert.equal(pairing.statusCode,200,pairing.body);
 const tick=async()=>{const response=await current().app.inject({url:'/api/managed-calendar-deliveries',headers:{authorization:'Bearer '+pairing.json().token}});assert.equal(response.statusCode,200,response.body);};
 const propose=async(sourceId=source.sourceId)=>{const record=await current().sources.upsert(sourceId,{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated cloud original',kind:'message',layer:'original'});for(let n=0;n<20;n++){await current().actions.tick();const action=current().actions.list().find(item=>item.evidence.some(evidence=>evidence.id===record.id));if(action)return action;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Production proposal not published');};
 const grant=async(choice:ActionConnectorChoice)=>{const provider=(await inventory()).providers.find(value=>value.identity.packageId===choice.target.packageId&&value.calendarId===choice.target.calendarId)!;const draft=await request('PUT','/api/action-capability-drafts',{...command(0),id:randomUUID(),capability:choice.capability,target:choice.target,inputs:{sources:[source],existingArchived:true,futureInputs:true}});return await request('PUT','/api/action-capability-grants',{...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:provider.identity,acknowledgeCalendarWrites:true}) as ActionGrant;};
 const setEnabled=async(enabled:boolean)=>{const path='/api/plugin-builds/'+encodeURIComponent('bundled:'+(kind==='google'?'google-calendar':'lark'));const build=await request('GET',path) as PluginBuildView;return request('PATCH',path,{...command(build.revision),selection:enabled?{packageId:build.packageId,version:build.version,configurationRevision:0}:null});};
 return {current,state,calendarIds,packageId,excluded,inventory,request,connectRead,connectWrite,disconnectWrite,select,propose,grant,tick,setEnabled,
  holdNext(phase:'preflight'|'write'){assert.equal(blocked[phase],undefined);const gate=calendarGate();gates.push(gate);blocked[phase]=gate;return gate;},
  async restart(){await current().app.close();node=await start();},
  async changeAccount(){if(kind==='google')await googleAuthorize(false,'generated-other-read-code');else{state.account='generated-other-lark-user';await request('POST','/api/connectors/lark/check');}},
 };
}

for(const kind of ['google','lark'] as const)test('production '+kind+' calendar manifest publishes scoped targets and settles host writes across authorization and lifecycle changes',async t=>{
 const f=await productionCalendarFixture(t,kind);
 await f.connectRead();
 assert.deepEqual((await f.inventory()).centralConnectors,[],'read authorization never declares cloud write targets');
 const pending=await f.propose();await f.tick();assert.equal(f.current().actions.get(pending.id).status,'proposed');assert.equal(f.state.calls.length,0);
 await f.connectWrite();
 const inventory=await f.inventory(),choices=inventory.centralConnectors;
 assert.deepEqual(choices.map(choice=>choice.target.calendarId).sort(),[...f.calendarIds].sort(),'the real production manifest declares exactly the selected calendars');
 assert.ok(choices.every(choice=>choice.target.packageId===f.packageId&&choice.capability.id==='calendar.manage'));
 assert.equal(inventory.executionEnabled,false,'provider write consent does not grant Action execution');
 assert.ok(!JSON.stringify(inventory).includes('synthetic-write'),'the live directory contains no cloud credentials');
 await f.tick();assert.equal(f.current().actions.get(pending.id).status,'proposed');assert.equal(f.state.calls.length,0);
 const choice=choices.find(value=>value.target.calendarId===f.calendarIds[0])!,grant=await f.grant(choice);
 await f.tick();await until(()=>f.current().actions.get(pending.id).status==='succeeded','the production host consumes the cloud receipt');
 const completed=f.current().actions.get(pending.id);
 assert.equal(completed.managed?.state,'succeeded');assert.deepEqual(completed.target,choice.target);assert.equal(completed.externalId,'generated-'+kind+'-event-1');
 assert.equal(f.state.calls.length,1,'an exact preauthorized scope executes without per-event confirmation');
 assert.equal(f.state.calls[0].calendarId,f.calendarIds[0]);assert.equal(f.state.calls[0].event.summary,event.title);
 assert.match(String(f.state.calls[0].event.description),new RegExp(completed.operationId!),'the host operation identity reaches the cloud writer');
 if(kind==='google')assert.equal(f.state.calls[0].authorization,'Bearer synthetic-write-access-private','the production writer uses the separate write token');
 const excluded=await f.propose(f.excluded.sourceId);await f.tick();assert.equal(f.current().actions.get(excluded.id).status,'proposed','a grant never includes an unselected input source');assert.equal(f.state.calls.length,1);

 assert.equal((await f.setEnabled(false)).observed,'stopped');assert.deepEqual((await f.inventory()).centralConnectors,[]);
 const paused=await f.propose();await f.tick();assert.equal(f.current().actions.get(paused.id).status,'proposed');
 const requests=f.state.requests;await f.restart();assert.equal(f.state.requests,requests,'persisted disabled connectors acquire no cloud resources on restart');
 assert.deepEqual((await f.inventory()).centralConnectors,[]);assert.equal((await f.inventory()).grants.find(value=>value.id===grant.id)?.available,false);
 const request={capability:choice.capability,operationId:randomUUID(),input:{kind:'calendar.create' as const,event,target:choice.target,actionId:randomUUID()}};
 await assert.rejects(()=>f.current().pluginCenter.executeConnectorAction({target:choice.target,request}),/provider is unavailable/);
 assert.equal(f.state.calls.length,1);
 assert.equal((await f.setEnabled(true)).observed,'active');
 assert.deepEqual((await f.inventory()).centralConnectors.map(value=>value.target.calendarId).sort(),[...f.calendarIds].sort(),'re-enabling restores only the saved selection');
 await f.tick();await until(()=>f.current().actions.get(paused.id).status==='succeeded','the retained exact grant resumes after re-enable');assert.equal(f.state.calls.length,2);

 await f.disconnectWrite();assert.deepEqual((await f.inventory()).centralConnectors,[]);
 const revoked=await f.propose();await f.tick();assert.equal(f.current().actions.get(revoked.id).status,'proposed');assert.equal(f.state.calls.length,2,'write withdrawal fences pending automatic dispatch');
 await assert.rejects(()=>f.current().pluginCenter.executeConnectorAction({target:choice.target,request}),/provider is unavailable/);
 await f.connectWrite();f.state.outcome='missing';await f.tick();await until(()=>f.current().actions.get(revoked.id).status==='uncertain','a missing cloud event identity remains uncertain');
 assert.equal(f.current().actions.get(revoked.id).managed?.state,'uncertain');assert.equal(f.current().actions.get(revoked.id).externalId,undefined);
 await f.tick();assert.equal(f.state.calls.length,3,'an uncertain operation is not blindly retried');
 f.state.outcome='ok';await f.select([f.calendarIds[1]]);
 assert.deepEqual((await f.inventory()).centralConnectors.map(value=>value.target.calendarId),[f.calendarIds[1]]);
 assert.equal((await f.inventory()).grants.find(value=>value.id===grant.id)?.available,false,'removing a selected destination withdraws its exact Action grant');
 await assert.rejects(()=>f.current().pluginCenter.executeConnectorAction({target:choice.target,request}),/provider is unavailable/);
 const unselected=await f.propose();await f.tick();assert.equal(f.current().actions.get(unselected.id).status,'proposed');assert.equal(f.state.calls.length,3);
 await f.changeAccount();assert.deepEqual((await f.inventory()).centralConnectors,[],'a changed read account inherits neither calendar selection nor write targets');
 await f.tick();assert.equal(f.state.calls.length,3);
 const center=f.current().pluginCenter,host=center.connectorHost!;await f.current().app.close();
 assert.deepEqual(host.actionProviders(),[],'closing removes live manifest declarations');
 await assert.rejects(()=>host.executeAction(kind==='google'?'google-calendar':'lark',request),/closed/);
 await assert.rejects(()=>center.executeConnectorAction({target:choice.target,request}),/closed/);
 assert.equal(f.state.calls.length,3);
});

for(const kind of ['google','lark'] as const)for(const withdrawal of ['stop','selection','write authorization'] as const)test('production '+kind+' preflight is fenced by '+withdrawal+' even when the cloud ignores cancellation',async t=>{
 const f=await productionCalendarFixture(t,kind);await f.connectRead();await f.connectWrite();
 const choice=(await f.inventory()).centralConnectors.find(value=>value.target.calendarId===f.calendarIds[0])!;await f.grant(choice);
 const pending=await f.propose(),gate=f.holdNext('preflight');await f.tick();await until(()=>gate.state.entered,'the write reaches the controlled cloud preflight');
 assert.equal(f.state.calls.length,0,'the cloud create has not been issued');
 if(withdrawal==='stop'){assert.equal((await f.setEnabled(false)).observed,'stopped');assert.deepEqual((await f.inventory()).centralConnectors,[]);}
 else if(withdrawal==='selection'){await f.select([f.calendarIds[1]]);await f.select(f.calendarIds);}
 else{await f.disconnectWrite();await f.connectWrite();}
 assert.equal(gate.state.returned,false,'scope withdrawal completes while the old cloud preflight is still blocked');
 assert.equal(f.state.calls.length,0);
 gate.release();await gate.finished;await until(()=>['succeeded','uncertain'].includes(f.current().actions.get(pending.id).status),'the old accepted operation settles');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.state.calls.length,0,'late preflight results cannot dispatch an old authorization generation');
 assert.equal(f.current().actions.get(pending.id).status,'uncertain');assert.equal(f.current().actions.get(pending.id).externalId,undefined);
 await f.tick();assert.equal(f.state.calls.length,0,'an interrupted operation is not blindly retried');
 if(withdrawal==='stop')await f.setEnabled(true);
 const next=await f.propose();await f.tick();await until(()=>f.current().actions.get(next.id).status==='succeeded','a new operation can use the current explicit scope');
 assert.equal(f.state.calls.length,1);assert.equal(f.state.calls[0].calendarId,f.calendarIds[0]);
});

for(const kind of ['google','lark'] as const)test('production '+kind+' stop tracks an issued write and keeps a missing late receipt uncertain',async t=>{
 const f=await productionCalendarFixture(t,kind);await f.connectRead();await f.connectWrite();
 const choice=(await f.inventory()).centralConnectors.find(value=>value.target.calendarId===f.calendarIds[0])!;await f.grant(choice);
 const pending=await f.propose(),gate=f.holdNext('write');await f.tick();await until(()=>gate.state.entered,'the cloud write is issued');assert.equal(f.state.calls.length,1);
 let stopped=false;const stopping=f.setEnabled(false).then(value=>{stopped=true;return value;});
 await until(()=>gate.state.signal?.aborted===true,'stop signals the in-flight cloud write');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stopped,false,'an issued write is tracked until its runner settles');
 f.state.outcome='missing';gate.release();assert.equal((await stopping).observed,'stopped');
 await until(()=>f.current().actions.get(pending.id).status==='uncertain','a missing issued-write receipt remains uncertain');
 assert.equal(f.current().actions.get(pending.id).managed?.state,'uncertain');assert.equal(f.current().actions.get(pending.id).externalId,undefined);
 await f.tick();assert.equal(f.state.calls.length,1,'stop never claims the cloud write was undone or retries it');
});
