import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {zipSync,strToU8} from 'fflate';
import {buildApp,type QueryAgent} from '../../src/app.js';
import type {Config} from '../../src/config.js';
import {sha256} from '../../src/store.js';
import {GitHubPluginReleases} from '../../src/plugin-release.js';
import {CalendarActions,type CalendarActionIO} from '../../../desktop/src/calendar-actions.js';

export const owner='generated-managed-calendar-owner',text='Generated appointment on 18 September 2099.',event={title:'Generated appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:'Generated evidence only'};
export const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'generated installation settles');await delay(5);}}
export async function fixture(t:Pick<TestContext,'after'>,options:{skipDeviceConnect?:boolean;beforeListen?:(node:Awaited<ReturnType<typeof buildApp>>)=>void}={}){
 const directory=await mkdtemp(join(tmpdir(),'mote-managed-calendar-'));
 let proposal:{kind:'calendar.create'|'calendar.update'|'calendar.cancel'|'calendar.complete';event:typeof event;sameAs:string|null}={kind:'calendar.create',event,sameAs:null};
 const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{const id=input.evidenceIds![0],evidence=[{id,quote:text}],answer=input.skill==='calendar-extraction'?{actions:[{...proposal,uncertainty:'',evidence}]}:{summary:'Generated appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:proposal.kind,event:proposal.event,uncertainty:'',evidence}]};return {runId:randomUUID(),answer:JSON.stringify(answer),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]};}};
 const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'token'),profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let node=await buildApp(config,{agent,backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 options.beforeListen?.(node);
 let origin=await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,body?:unknown,token=owner,method=body?'POST':'GET')=>{const response=await fetch(origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Object.assign(Error(JSON.stringify(value)),{status:response.status});return value as any;};
 const archive=zipSync({'device.mjs':strToU8('export function createMemoryProvider(){throw Error("Unexpected worker execution")};')}),base='https://github.com/generated-fixture/calendar/releases/download/v1/';
 const capability={id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'device',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,sameDeviceCalendar:true,completionInMoteOnly:true}};
 const manifest={schemaVersion:1,id:'generated.calendar',name:'Generated calendar',version:'1',runtime:'worker',entry:'device.mjs',archive:{asset:'adapter.zip',sha256:sha256(archive)},capabilities:['calendar.manage'],actionCapabilities:[capability],configuration:[],dependencies:[],access:['Generated fixture calendar']};
 // Only the unavailable GitHub network boundary is substituted. Resolve, hash
 // verification, archive installation, owner routes and feature startup are real.
 const releases=new GitHubPluginReleases(node.pluginCenter.releases.directory,async url=>{
  if(url.endsWith('/releases/tags/v1'))return {bytes:strToU8(JSON.stringify({tag_name:'v1',draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]}))};
  if(url.endsWith('/commits/v1'))return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};if(url===base+'adapter.zip')return {bytes:archive};throw Error('Unexpected generated release URL');
 });
 node.pluginCenter.releases.resolve=releases.resolve.bind(releases);node.pluginCenter.releases.install=releases.install.bind(releases);
 const preview=await request('/api/plugins/resolve',{repository:'generated-fixture/calendar',tag:'v1'});await request('/api/plugins/install',{...command((await request('/api/plugins')).revision),previewId:preview.id});await until(()=>node.pluginCenter.view().packages[0]?.state!=='installing');
 const instance=await request('/api/plugin-instances',{...command((await request('/api/plugins')).revision),packageId:node.pluginCenter.view().packages[0].id,name:'Generated native calendar',scope:'default',configuration:{}});
 await request('/api/plugin-instances/'+instance.id+'/check',command(instance.revision));await until(()=>node.pluginCenter.instanceView(instance.id).observed!=='checking');await request('/api/plugin-instances/'+instance.id+'/enable',command(node.pluginCenter.instanceView(instance.id).revision));
 const invitation=await request('/api/connections/collector-invitations',{serverUrl:'https://generated.invalid',label:'Generated device'}),paired=await request('/api/connections/redeem',{code:invitation.invitation.code,deviceId:'generated-device',deviceName:'Generated device',platform:'macos'});
 let permission='granted',blockReceipts=false,nativeCalls=0,nativePresent=false,reconciliations=0,changedNative=false;const nativeChanges:any[]=[];let nativeHook:(()=>Promise<void>)|undefined;
 const io:CalendarActionIO={
  request:async(path,body)=>{if(blockReceipts&&path.endsWith('/receipt'))throw Error('Generated offline receipt transport');return request(path,body,paired.token);},
  native:async(kind,input:any)=>{if(kind==='calendar-permission'||kind==='calendar-list')return {permission,calendars:permission==='granted'?[{id:'generated-calendar',title:'Generated calendar',writable:true},{id:'generated-other-calendar',title:'Other generated calendar',writable:true}]:[]};
   if(kind==='calendar-change'){nativeChanges.push(input);if(changedNative)throw Error('Generated native event identity or content changed');if(!input.mutationAllowed){reconciliations++;return {externalId:input.externalId};}nativeCalls++;await nativeHook?.();return {externalId:input.externalId};}
   assert.equal(kind,'calendar-create');if(!input.createAllowed){reconciliations++;if(!nativePresent)throw Error('Generated event not found; reconciliation must not create');return {externalId:'generated-event-'+nativeCalls};}nativeCalls++;await nativeHook?.();nativePresent=true;return {externalId:'generated-event-'+nativeCalls};},
  read:async key=>{try{return await readFile(join(directory,'native-'+key),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}},
  write:async(key,value)=>{await writeFile(join(directory,'native-'+key),value,{mode:0o600,flush:true});},
 };
 const client=()=>new CalendarActions({deviceId:'generated-device',deviceName:'Generated device'},io);if(!options.skipDeviceConnect)await client().connect();
 await request('/api/sources',{id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
 // Model processing consent and calendar write consent remain separate owner decisions.
 const authorization=await request('/api/model-authorization');
 assert.equal(authorization.authorization.state,'off');
 await request('/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'on'});
 const settings=await request('/api/actions');await request('/api/actions/settings',{revision:settings.revision,authorizationRevision:settings.authorizationRevision,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]}},owner,'PUT');
 const add=async(id=randomUUID())=>{const record=await node.sources.upsert('generated-source',{externalId:id,revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated original',kind:'message',layer:'original'});await node.actions.tick();const action=node.actions.list().find(value=>value.evidence.some(e=>e.id===record.id));assert.ok(action,'real extraction host publishes a validated proposal');return action;};
 const change=async(original:any,kind:'calendar.update'|'calendar.cancel'|'calendar.complete')=>{proposal={kind,sameAs:original.id,event:{...event,start:'2099-09-19T15:00:00Z',end:'2099-09-19T16:00:00Z'}};try{return await add();}finally{proposal={kind:'calendar.create',event,sameAs:null};}};
 const grant=async(existingArchived=true,futureInputs=true,calendarId='generated-calendar')=>{const inventory=await request('/api/action-capabilities'),draft=await request('/api/action-capability-drafts',{...command(0),id:randomUUID(),capability:{id:'calendar.manage',version:1},target:{deviceId:'generated-device',calendarId,declarationRevision:inventory.declarations[0].revision},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input',platform:'import'}],existingArchived,futureInputs}},owner,'PUT');return request('/api/action-capability-grants',{...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:inventory.providers[0].identity,acknowledgeCalendarWrites:true},owner,'PUT');};
 const restart=async()=>{await node.app.close();node=await buildApp(config,{agent,backgroundWorker:false});options.beforeListen?.(node);origin=await node.app.listen({host:'127.0.0.1',port:0});};
 return {get node(){return node;},get origin(){return origin;},restart,request,paired,instance,client,add,change,grant,nativeChanges,setChangedNative:()=>{changedNative=true;},get nativeCalls(){return nativeCalls;},get reconciliations(){return reconciliations;},setNativePresent:()=>{nativePresent=true;},setPermission:(value:string)=>{permission=value;},blockReceipts:(value:boolean)=>{blockReceipts=value;},onNative:(hook:()=>Promise<void>)=>{nativeHook=hook;}};
}
