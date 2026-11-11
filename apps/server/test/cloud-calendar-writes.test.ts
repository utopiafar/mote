import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OAuth2Client} from 'google-auth-library';
import {centralCalendarPluginCapabilitySchema,type ActionPluginProvider} from '@mote/shared';
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
 const center=new PluginCenter(store,executor,releases);t.after(async()=>{await center.close();await executor.close();store.close();await rm(directory,{recursive:true,force:true});});
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
