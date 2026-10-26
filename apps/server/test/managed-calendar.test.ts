import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {zipSync,strToU8} from 'fflate';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {CalendarActions,type CalendarActionIO} from '../../desktop/src/calendar-actions.js';

const owner='generated-managed-calendar-owner',text='Generated appointment on 18 September 2099.',event={title:'Generated appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:'Generated evidence only'};
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'generated installation settles');await delay(5);}}
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-managed-calendar-'));
 const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{const id=input.evidenceIds![0],evidence=[{id,quote:text}],answer=input.skill==='calendar-extraction'?{actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence}]}:{summary:'Generated appointment',evidence,events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'',evidence}]};return {runId:randomUUID(),answer:JSON.stringify(answer),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[]};}};
 const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'token'),profile:'test',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let node=await buildApp(config,{agent,backgroundWorker:false});let origin=await node.app.listen({host:'127.0.0.1',port:0});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(path:string,body?:unknown,token=owner,method=body?'POST':'GET')=>{const response=await fetch(origin+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw Object.assign(Error(JSON.stringify(value)),{status:response.status});return value as any;};
 const archive=zipSync({'device.mjs':strToU8('export function createMemoryProvider(){throw Error("Unexpected worker execution")};')}),base='https://github.com/generated-fixture/calendar/releases/download/v1/';
 const capability={id:'calendar.create',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',executionLocation:'device',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredEvent:true,noParticipants:true,noUpdates:true,noDeletes:true}};
 const manifest={schemaVersion:1,id:'generated.calendar',name:'Generated calendar',version:'1',runtime:'worker',entry:'device.mjs',archive:{asset:'adapter.zip',sha256:sha256(archive)},capabilities:['calendar.create'],actionCapabilities:[capability],configuration:[],dependencies:[],access:['Generated fixture calendar']};
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
 let permission='granted',blockReceipts=false,nativeCalls=0,nativePresent=false,reconciliations=0;let nativeHook:(()=>Promise<void>)|undefined;
 const io:CalendarActionIO={
  request:async(path,body)=>{if(blockReceipts&&path.endsWith('/receipt'))throw Error('Generated offline receipt transport');return request(path,body,paired.token);},
  native:async(kind,input:any)=>{if(kind==='calendar-permission'||kind==='calendar-list')return {permission,calendars:permission==='granted'?[{id:'generated-calendar',title:'Generated calendar',writable:true}]:[]};assert.equal(kind,'calendar-create');if(!input.createAllowed){reconciliations++;if(!nativePresent)throw Error('Generated event not found; reconciliation must not create');return {externalId:'generated-event-'+nativeCalls};}nativeCalls++;await nativeHook?.();nativePresent=true;return {externalId:'generated-event-'+nativeCalls};},
  read:async key=>{try{return await readFile(join(directory,'native-'+key),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}},
  write:async(key,value)=>{await writeFile(join(directory,'native-'+key),value,{mode:0o600,flush:true});},
 };
 const client=()=>new CalendarActions({deviceId:'generated-device',deviceName:'Generated device'},io);await client().connect();
 await request('/api/sources',{id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
 // Model processing consent and calendar write consent remain separate owner decisions.
 const authorization=await request('/api/model-authorization');
 assert.equal(authorization.authorization.state,'unapproved');
 await request('/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'authorize',connections:authorization.connections,scope:{sourceIds:['generated-source'],dataKinds:['text']}});
 const settings=await request('/api/actions');await request('/api/actions/settings',{revision:settings.revision,authorizationRevision:settings.authorizationRevision,settings:{enabled:true,timeZone:'UTC',reviewDeviceIds:[]}},owner,'PUT');
 const add=async(id=randomUUID())=>{const record=await node.sources.upsert('generated-source',{externalId:id,revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated original',kind:'message',layer:'original'});await node.actions.tick();const action=node.actions.list().find(value=>value.evidence.some(e=>e.id===record.id));assert.ok(action,'real extraction host publishes a validated proposal');return action;};
 const grant=async(existingArchived=true,futureInputs=true)=>{const inventory=await request('/api/action-capabilities'),draft=await request('/api/action-capability-drafts',{...command(0),id:randomUUID(),capability:{id:'calendar.create',version:1},target:{deviceId:'generated-device',calendarId:'generated-calendar',declarationRevision:inventory.declarations[0].revision},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input',platform:'import'}],existingArchived,futureInputs}},owner,'PUT');return request('/api/action-capability-grants',{...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:inventory.providers[0].identity,acknowledgeCalendarWrites:true},owner,'PUT');};
 const restart=async()=>{await node.app.close();node=await buildApp(config,{agent,backgroundWorker:false});origin=await node.app.listen({host:'127.0.0.1',port:0});};
 return {get node(){return node;},restart,request,paired,instance,client,add,grant,get nativeCalls(){return nativeCalls;},get reconciliations(){return reconciliations;},setNativePresent:()=>{nativePresent=true;},setPermission:(value:string)=>{permission=value;},blockReceipts:(value:boolean)=>{blockReceipts=value;},onNative:(hook:()=>Promise<void>)=>{nativeHook=hook;}};
}

test('actual HTTP grant dispatches to the paired native consumer and Central retains the same successful action exactly once',async t=>{
 const f=await fixture(t),action=await f.add();assert.equal((await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token)).items.length,0);assert.equal(f.nativeCalls,0);
 await f.grant();const queued=await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);assert.equal(queued.items.length,1);assert.equal(queued.manualReviewAllowed,false);assert.equal(f.node.actions.get(action.id).managed?.state,'waiting_device');assert.equal(f.node.actions.get(action.id).status,'approved');
 await assert.rejects(()=>f.request('/api/actions/'+action.id+'/claim',{deviceId:'generated-device'},owner),{status:403},'legacy owner channel cannot bypass the grant');
 await f.client().deliver();const result=f.node.actions.get(action.id);assert.equal(result.id,action.id);assert.equal(result.status,'succeeded');assert.equal(result.externalId,'generated-event-1');assert.equal(result.managed?.state,'succeeded');
 await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal((await f.request('/api/actions')).items[0].externalId,'generated-event-1');
});

test('offline native receipt survives consumer reconstruction, scope withdrawal and OS permission loss without another write',async t=>{
 const f=await fixture(t),grant=await f.grant(),action=await f.add();f.blockReceipts(true);await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(action.id).status,'executing');
 await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));f.setPermission('required');f.blockReceipts(false);
 await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(action.id).status,'succeeded');assert.equal((await f.request('/api/action-capabilities')).grants[0].state,'revoked');
});

test('cancel before claim prevents writing; cancel during native work records the late successful receipt honestly',async t=>{
 const f=await fixture(t);await f.grant();const first=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 await f.request('/api/managed-calendar/'+first.id+'/cancel',{version:f.node.actions.get(first.id).version});await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(first.id).managed?.state,'cancelled');
 const next=await f.add();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);f.onNative(async()=>{entered();await hold;});const running=f.client().deliver();await Promise.race([started,running.then(()=>{throw Error('Native write was not entered');})]);
 try{await f.request('/api/managed-calendar/'+next.id+'/cancel',{version:f.node.actions.get(next.id).version});assert.equal(f.node.actions.get(next.id).managed?.state,'cancel_requested');}finally{release();}await running;
 const result=f.node.actions.get(next.id);assert.equal(result.status,'succeeded');assert.ok(result.managed?.cancelRequestedAt);assert.equal(f.nativeCalls,1);
});

test('future-input scope uses first Central receipt, while plugin withdrawal fences an already queued action',async t=>{
 const f=await fixture(t),old=await f.add();await f.grant(false,true);const fresh=await f.add();const queue=await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 assert.deepEqual(queue.items.map((item:any)=>item.id),[fresh.id]);assert.equal(f.node.actions.get(old.id).status,'proposed');
 await f.request('/api/plugin-instances/'+f.instance.id+'/disable',command(f.node.pluginCenter.instanceView(f.instance.id).revision));
 await assert.rejects(()=>f.request('/api/managed-calendar/'+fresh.id+'/claim',{deviceId:'generated-device'},f.paired.token),{status:403});await f.client().deliver();assert.equal(f.nativeCalls,0);
});


test('Central restart preserves a queued operation and an in-flight receipt without granting a second write',async t=>{
 const f=await fixture(t);await f.grant();const a=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);const queued=f.node.actions.get(a.id);
 await f.restart();assert.equal(f.node.actions.get(a.id).operationId,queued.operationId);assert.equal(f.node.actions.get(a.id).managed?.state,'waiting_device');
 f.blockReceipts(true);await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);
 await f.restart();f.blockReceipts(false);await f.client().deliver();assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(a.id).status,'succeeded');
 const nearby=await f.request('/api/actions/by-evidence/'+a.evidence[0].id);assert.equal(nearby.items[0].id,a.id);assert.equal(nearby.items[0].status,'succeeded');assert.equal(nearby.items[0].evidence,undefined);assert.equal((await f.request('/api/actions/'+a.id)).id,a.id);
});

test('foreign devices cannot claim or receive action content, collectors cannot grant, and revoked connections cannot return receipts',async t=>{
 const f=await fixture(t);const grant=await f.grant(),a=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 const invitation=await f.request('/api/connections/collector-invitations',{serverUrl:'https://generated.invalid',label:'Generated other device'}),other=await f.request('/api/connections/redeem',{code:invitation.invitation.code,deviceId:'generated-other',deviceName:'Other generated',platform:'macos'});
 assert.deepEqual((await f.request('/api/managed-calendar-deliveries',undefined,other.token)).items,[]);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},other.token),{status:403});
 await assert.rejects(()=>f.request('/api/action-capability-grants',{},f.paired.token,'PUT'),{status:403});
 await assert.rejects(()=>f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision),f.paired.token),{status:403});
 const claims=await Promise.all([1,2].map(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},f.paired.token)));assert.deepEqual(claims.map(c=>c.mutationAllowed).sort(),[false,true]);
 await f.node.connections.revoke(f.paired.credentialId);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/receipt',{operationId:claims[0].operationId,status:'succeeded',externalId:'generated'},f.paired.token),{status:401});assert.equal(f.node.actions.get(a.id).status,'executing');
});

test('overlapping grants retain manual review and multi-source evidence cannot escape the authorized scope',async t=>{
 const f=await fixture(t),first=await f.grant(),second=await f.grant(),a=await f.add();await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(a.id).status,'proposed');
 await f.request('/api/action-capability-grants/'+second.id+'/revoke',command(second.revision));
 await f.request('/api/sources',{id:'generated-outside',kind:'custom',name:'Outside fixture',deviceId:'generated-input',platform:'import'});
 // Authorize model reading of both generated sources, while calendar write grants stay on generated-source only.
 const authorization=await f.request('/api/model-authorization');
 await f.request('/api/model-authorization/commands',{revision:authorization.authorization.revision,operationId:randomUUID(),action:'authorize',connections:authorization.connections,scope:{sourceIds:['generated-source','generated-outside'],dataKinds:['text']}});
 const outside=await f.node.sources.upsert('generated-outside',{externalId:'outside',revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated outside',kind:'message',layer:'original'});
 // A validated multi-source proposal is the input to the deterministic permission gate.
 // Keep the original real extraction and append a current fixture evidence snapshot.
 await f.node.actions.tick();const outsideAction=f.node.actions.list().find(x=>x.evidence.some(e=>e.id===outside.id))!;assert.ok(outsideAction);
 const record=f.node.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(a.id)!;const proposal=JSON.parse(String(record.json));proposal.evidence.push(outsideAction.evidence[0]);f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(proposal),a.id);
 assert.equal(f.node.actions.get(a.id).status,'proposed','multi-source evidence must be current before testing scope');await f.client().deliver();assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(a.id).status,'proposed');assert.equal(first.state,'active');
});


test('attempting crash with a lost native result only reconciles after restart and grant withdrawal',async t=>{
 const f=await fixture(t),grant=await f.grant(),a=await f.add();f.onNative(async()=>{f.setNativePresent();throw Error('Generated crash after native commit');});
 await assert.rejects(()=>f.client().deliver());assert.equal(f.nativeCalls,1);assert.equal(f.node.actions.get(a.id).status,'uncertain');
 await f.request('/api/action-capability-grants/'+grant.id+'/revoke',command(grant.revision));await f.restart();await f.client().deliver();
 assert.equal(f.nativeCalls,1);assert.equal(f.reconciliations,1);assert.equal(f.node.actions.get(a.id).status,'succeeded');
});

test('queued expired events and changed original evidence cannot obtain a new native mutation',async t=>{
 const f=await fixture(t);await f.grant();const expired=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);
 const a=f.node.actions.get(expired.id);a.event={...a.event,start:'2000-01-01T12:00:00Z',end:'2000-01-01T13:00:00Z'};f.node.store.db.prepare('UPDATE action_proposals SET json=? WHERE id=?').run(JSON.stringify(a),a.id);
 await assert.rejects(()=>f.request('/api/managed-calendar/'+a.id+'/claim',{},f.paired.token),{status:409});
 const changed=await f.add();await f.request('/api/managed-calendar-deliveries',undefined,f.paired.token);const record=f.node.actions.read([changed.evidence[0].id])[0];
 await f.node.sources.upsert('generated-source',{externalId:record.provenance!.externalId,revision:'2',observedAt:'2026-01-02T00:00:00Z',text:'Generated replacement without an event',title:'Changed original',kind:'message',layer:'original'});
 await assert.rejects(()=>f.request('/api/managed-calendar/'+changed.id+'/claim',{},f.paired.token));assert.equal(f.nativeCalls,0);assert.equal(f.node.actions.get(changed.id).status,'stale');
});
