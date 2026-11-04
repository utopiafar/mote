import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,StoreError,sha256} from '../src/store.js';
import {calendarPluginCapabilitySchema} from '@mote/shared';

const owner='generated-action-capability-owner',headers=(token=owner)=>({authorization:'Bearer '+token});
const agent:QueryAgent={configured:false,query:async()=>{throw Error('Capability contracts do not call a model');},close:async()=>{}};
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-action-capabilities-')),store=new Store(directory),config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,profile:'test',maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'http://127.0.0.1:1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let node=await buildApp(config,{store,agent,backgroundWorker:false});
 const restart=async()=>{await node.app.close();node=await buildApp(config,{store,agent,backgroundWorker:false});return node;};
 t.after(async()=>{await node.app.close();store.close();await rm(directory,{recursive:true,force:true});});
 node.sources.register({id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-source-device',platform:'import'});
 const pair=async(deviceId='generated-phone')=>{const invite=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:headers(),payload:{serverUrl:'https://generated.invalid',label:'Generated device'}});assert.equal(invite.statusCode,200);const result=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId,deviceName:'Generated phone',platform:'android'}});assert.equal(result.statusCode,200);return result.json() as {token:string;credentialId:string};};
 return {...node,store,restart,pair};
}
const declaration=()=>({operationId:randomUUID(),expectedRevision:0,deviceId:'generated-phone',capability:{id:'calendar.manage',version:1},permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar'}]});
const draft=()=>({operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:{id:'calendar.manage',version:1},target:{deviceId:'generated-phone',calendarId:'generated-calendar',declarationRevision:1},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-source-device',platform:'import'}],existingArchived:true,futureInputs:true}});

test('real transport separates paired self declarations from owner draft authority and never exposes an active grant',async t=>{
 const f=await fixture(t),paired=await f.pair();await f.app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+(f.app.server.address() as {port:number}).port;
 const send=async(path:string,method='GET',payload?:unknown,token?:string)=>fetch(origin+path,{method,headers:{...(token?headers(token):{}),'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});
 assert.equal((await send('/api/action-capabilities')).status,401);
 assert.equal((await send('/api/device-action-capabilities','POST',declaration(),owner)).status,403,'owner sessions cannot pretend to be a paired device');
 assert.equal((await send('/api/device-action-capabilities','POST',{...declaration(),deviceId:'another-phone'},paired.token)).status,403);
 assert.equal((await send('/api/device-action-capabilities','POST',declaration(),paired.token)).status,200);
 for(const path of ['/api/action-capabilities','/api/action-capability-drafts'])assert.equal((await send(path,path.endsWith('drafts')?'PUT':'GET',path.endsWith('drafts')?draft():undefined,paired.token)).status,403);
 const result=await send('/api/action-capability-drafts','PUT',draft(),owner);assert.equal(result.status,200);const saved=await result.json() as any;assert.equal(saved.state,'draft');assert.equal(saved.executionEnabled,false);
 const inventory=await(await send('/api/action-capabilities','GET',undefined,owner)).json() as any;assert.equal(inventory.executionEnabled,false);assert.equal(inventory.drafts.length,1);assert.equal(inventory.capabilities[0].invitesParticipants,false);
 assert.equal((await send('/api/action-capability-drafts/'+saved.id+'/activate','POST',{},owner)).status,404);
 const actions=(await f.app.inject({url:'/api/actions',headers:headers()})).json();assert.deepEqual(actions.items,[]);assert.deepEqual(actions.settings.reviewDeviceIds,[],'drafts do not grant review access or execute actions');
});

test('exact commands replay after restart; changed operation bodies and stale revisions cannot overwrite drafts',async t=>{
 const f=await fixture(t),paired=await f.pair(),decl=declaration(),input=draft();let app=f.app;
 const post=()=>app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(paired.token),payload:decl});assert.equal((await post()).statusCode,200);const before=f.store.logicalBytes();
 const save=(payload=input)=>app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload});const first=await save();assert.equal(first.statusCode,200);assert.ok(f.store.logicalBytes()>before,'control records and operation receipts count toward storage');
 app=(await f.restart()).app;assert.deepEqual((await post()).json(),(await post()).json());assert.deepEqual((await save()).json(),first.json());
 assert.equal((await save({...input,inputs:{...input.inputs,futureInputs:false}})).statusCode,409);
 assert.equal((await save({...input,operationId:randomUUID()})).statusCode,409);
 const updated=await save({...input,operationId:randomUUID(),expectedRevision:1,inputs:{...input.inputs,futureInputs:false}});assert.equal(updated.statusCode,200);assert.equal(updated.json().revision,2);
 assert.deepEqual((await save()).json(),first.json(),'replay preserves the original receipt without rolling current state back');
 assert.equal((await app.inject({url:'/api/action-capabilities',headers:headers()})).json().drafts[0].revision,2);
 const revoke={operationId:randomUUID(),expectedRevision:2},request=()=>app.inject({method:'POST',url:'/api/action-capability-drafts/'+input.id+'/revoke',headers:headers(),payload:revoke});const revoked=await request();assert.equal(revoked.statusCode,200);assert.equal(revoked.json().state,'revoked');assert.deepEqual((await request()).json(),revoked.json());
 assert.equal((await save({...input,operationId:randomUUID(),expectedRevision:3})).statusCode,409,'a revoked draft cannot be silently reactivated');
});

test('invalid capabilities, missing scope choices and changed source or device declarations cannot broaden a draft',async t=>{
 const f=await fixture(t),paired=await f.pair(),decl=declaration();const declare=(payload:unknown)=>f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(paired.token),payload});
 assert.equal((await declare({...decl,capability:{id:'calendar.cancel',version:1}})).statusCode,400);assert.equal((await declare({...decl,permission:'required'})).statusCode,400);assert.equal((await declare(decl)).statusCode,200);
 const save=(payload:unknown)=>f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload}),input=draft();
 for(const extra of [{enabled:true},{state:'active'},{executionEnabled:true}])assert.equal((await save({...input,...extra})).statusCode,400);
 assert.equal((await save({...input,inputs:{...input.inputs,existingArchived:false,futureInputs:false}})).statusCode,400);
 assert.equal((await save({...input,inputs:{...input.inputs,sources:[{...input.inputs.sources[0],deviceId:'another-device'}]}})).statusCode,409);
 assert.equal((await declare({...decl,operationId:randomUUID(),expectedRevision:1,permission:'required',calendars:[]})).statusCode,200);assert.equal((await save(input)).statusCode,409);
 assert.equal((await f.app.inject({url:'/api/action-capabilities',headers:headers()})).json().drafts.length,0);
});

test('revoked device connections cannot declare or anchor a new owner draft and storage failure rolls back both record and command',async t=>{
 const f=await fixture(t),paired=await f.pair();assert.equal((await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(paired.token),payload:declaration()})).statusCode,200);
 const reserve=f.store.reserveMetadata.bind(f.store);f.store.reserveMetadata=()=>{throw new StoreError('Generated quota failure',507);};
 const input=draft(),save=()=>f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload:input});assert.equal((await save()).statusCode,507);f.store.reserveMetadata=reserve;assert.equal((await save()).statusCode,200,'failed transaction does not consume operation identity');
 await f.connections.revoke(paired.credentialId);
 assert.equal((await f.app.inject({method:'GET',url:'/api/device-action-capabilities',headers:headers(paired.token)})).statusCode,401);
 const inventory=(await f.app.inject({url:'/api/action-capabilities',headers:headers()})).json();assert.equal(inventory.declarations[0].connectionActive,false);
 assert.equal((await f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload:draft()})).statusCode,409);
});


test('paired owner devices retain their own declaration identity without losing owner draft controls',async t=>{
 const f=await fixture(t);
 const invite=await f.app.inject({method:'POST',url:'/api/connections/invitations',headers:headers(),payload:{serverUrl:'https://generated.invalid',label:'Generated Mac'}});
 assert.equal(invite.statusCode,200);
 const paired=await f.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'generated-phone',deviceName:'Generated Mac',platform:'macos'}});
 assert.equal(paired.statusCode,200);const auth=headers(paired.json().token);
 const empty=await f.app.inject({url:'/api/device-action-capabilities',headers:auth});assert.equal(empty.statusCode,200);assert.equal(empty.json().declaration,null);
 const declared=await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:auth,payload:declaration()});assert.equal(declared.statusCode,200);assert.equal(declared.json().connectionId,paired.json().credentialId);
 assert.equal((await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:auth,payload:{...declaration(),deviceId:'foreign-device'}})).statusCode,403);
 const saved=await f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:auth,payload:draft()});assert.equal(saved.statusCode,200);assert.equal(saved.json().executionEnabled,false);
 assert.equal((await f.app.inject({url:'/api/action-capabilities',headers:auth})).json().drafts.length,1);
});

test('replacement pairing cannot inherit an old connection declaration or silently retarget its drafts',async t=>{
 const f=await fixture(t),original=await f.pair(),decl=declaration(),input=draft();
 assert.equal((await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(original.token),payload:decl})).statusCode,200);
 assert.equal((await f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload:input})).statusCode,200);
 const invite=await f.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:headers(),payload:{serverUrl:'https://generated.invalid',label:'Replacement generated device',deviceId:'generated-phone'}});assert.equal(invite.statusCode,200);
 const paired=await f.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'generated-phone',deviceName:'Replacement generated device',platform:'android'}});assert.equal(paired.statusCode,200);
 const token=paired.json().token;
 assert.equal((await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(original.token),payload:decl})).statusCode,401,'a replay cannot bypass revoked authentication');
 let current=(await f.app.inject({url:'/api/device-action-capabilities',headers:headers(token)})).json().declaration;
 assert.equal(current.connectionActive,false);assert.equal(current.connectionId,original.credentialId);
 const save=(payload:unknown)=>f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload});
 assert.equal((await save(draft())).statusCode,409);
 assert.equal((await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(token),payload:{...decl,operationId:randomUUID(),expectedRevision:1}})).statusCode,200);
 current=(await f.app.inject({url:'/api/device-action-capabilities',headers:headers(token)})).json().declaration;assert.equal(current.connectionId,paired.json().credentialId);assert.equal(current.revision,2);
 assert.equal((await save(draft())).statusCode,409,'old declaration revision cannot authorize the replacement');
 const updated={...input,operationId:randomUUID(),expectedRevision:1,target:{...input.target,declarationRevision:2}};assert.equal((await save(updated)).statusCode,200);
 assert.deepEqual((await f.app.inject({url:'/api/actions',headers:headers()})).json().items,[],'redeclaration and editing a draft do not dispatch work');
});


test('Mac and Kotlin publisher payloads keep installed, available, authorized and waiting-device separate; old connection heartbeats cannot revive or rebind',async t=>{
 const {publishCalendarCapability}=await import('../../desktop/src/calendar-capabilities.js');
 const f=await fixture(t),mac=await f.pair('generated-phone'),tablet=await f.pair('generated-tablet');
 const origin=await f.app.listen({host:'127.0.0.1',port:0});
 const requestFor=(token:string)=>async(path:string,body?:unknown)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200,path);return response.json();};
 const inventory=async()=> (await f.app.inject({url:'/api/action-capabilities',headers:headers()})).json();
 const projection=async()=> (await inventory()).deviceCapabilities.find((value:any)=>value.id==='calendar.manage'&&value.version===1);
 const macPayload={permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar',writable:true}]};
 const published=await publishCalendarCapability('generated-phone',macPayload,requestFor(mac.token));
 assert.equal(published!.declaration.revision,1);assert.equal(published!.projection.installed,false);assert.equal(published!.projection.available,true);assert.equal(published!.projection.authorized,false);assert.equal(published!.projection.waitingDevice,false);
 // Exact CalendarCapabilityPublisher payload from Kotlin: operationId, expectedRevision, deviceId, capability, permission, calendars.
 const kotlinBody={operationId:randomUUID(),expectedRevision:0,deviceId:'generated-tablet',capability:{id:'calendar.manage',version:1},permission:'granted',calendars:[{id:'generated-kotlin-calendar',title:'Generated Kotlin calendar'}]};
 const declared=await requestFor(tablet.token)('/api/device-action-capabilities',kotlinBody);assert.equal(declared.revision,1);assert.equal(declared.permission,'granted');
 let current=await projection();
 assert.equal(current.installed,false,'installation is the enabled provider, not a device declaration');
 assert.equal(current.available,true,'both real publishers report a live granted device');
 assert.equal(current.authorized,false,'a declaration is never an owner grant');
 assert.equal(current.waitingDevice,false,'installed is false, so waiting-device cannot be inferred from a missing provider');
 assert.equal(current.grant,'granted');

 const providerCapability=calendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'device',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,sameDeviceCalendar:true,completionInMoteOnly:true}});
 const provider=()=>({identity:{packageId:'generated.calendar',releaseDigest:'a'.repeat(64),instanceId:'generated-instance',instanceRevision:1,capabilityDigest:sha256(JSON.stringify(providerCapability))},name:'Generated calendar',capability:providerCapability});
 f.pluginCenter.actionProviders=()=>[provider()];
 current=await projection();assert.equal(current.installed,true);assert.equal(current.available,true);assert.equal(current.authorized,false);assert.equal(current.waitingDevice,false);

 const target=(await inventory()).declarations.find((value:any)=>value.deviceId==='generated-phone');
 const saved=await f.app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers(),payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),capability:{id:'calendar.manage',version:1},target:{deviceId:'generated-phone',calendarId:'generated-calendar',declarationRevision:target.revision},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-source-device',platform:'import'}],existingArchived:true,futureInputs:true}}});
 assert.equal(saved.statusCode,200,saved.body);
 const granted=await f.app.inject({method:'PUT',url:'/api/action-capability-grants',headers:headers(),payload:{operationId:randomUUID(),expectedRevision:0,id:randomUUID(),draftId:saved.json().id,draftRevision:saved.json().revision,plugin:provider().identity,acknowledgeCalendarWrites:true}});
 assert.equal(granted.statusCode,200,granted.body);
 current=await projection();assert.equal(current.authorized,true);assert.equal(current.available,true);assert.equal(current.waitingDevice,false);

 // The previous connection generation disappears from every live check, but
 // the owner's authorization stays present instead of collapsing into state.
 const beat={deviceId:'generated-phone',deviceName:'Generated phone',platform:'android',status:'capturing',queueDepth:0};
 assert.equal((await f.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:headers(mac.token),payload:beat})).statusCode,200,'the current generation writes its observation once');
 await f.connections.revoke(mac.credentialId);await f.connections.revoke(tablet.credentialId);
 const stored=f.store.devices();
 const late=await f.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:headers(mac.token),payload:beat});
 assert.ok([401,403].includes(late.statusCode),late.body);
 const cross=await f.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:headers(mac.token),payload:{...beat,deviceId:'generated-other-device'}});
 assert.ok([401,403].includes(cross.statusCode),cross.body);
 assert.deepEqual(f.store.devices(),stored,'late old-generation heartbeats do not revive device state or rebind another device');
 current=await projection();
 assert.equal(current.installed,true);assert.equal(current.available,false);assert.equal(current.authorized,true);assert.equal(current.waitingDevice,true);assert.equal(current.grant,'unavailable');

 const invite=await f.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:headers(),payload:{serverUrl:'https://generated.invalid',label:'Generated replacement',deviceId:'generated-phone'}});
 assert.equal(invite.statusCode,200,invite.body);
 const replacement=await f.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invite.json().invitation.code,deviceId:'generated-phone',deviceName:'Generated replacement',platform:'android'}});
 assert.equal(replacement.statusCode,200,replacement.body);
 const redeclared=await f.app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers(replacement.json().token),payload:{...kotlinBody,operationId:randomUUID(),deviceId:'generated-phone',expectedRevision:1,calendars:[{id:'generated-calendar',title:'Generated calendar'}]}});
 assert.equal(redeclared.statusCode,200,redeclared.body);
 current=await projection();
 assert.equal(current.installed,true);assert.equal(current.available,true);assert.equal(current.authorized,false,'the old revision cannot authorize the replacement pairing');assert.equal(current.waitingDevice,false);
 assert.equal((await f.app.inject({method:'POST',url:'/api/devices/heartbeat',headers:headers(mac.token),payload:beat})).statusCode,401,'the old generation stays fenced after replacement');
});

test('the desktop declaration consumer uses real paired HTTP, preserves stable revisions and publishes permission loss',async t=>{
 const {publishCalendarCapability}=await import('../../desktop/src/calendar-capabilities.js');
 const f=await fixture(t),paired=await f.pair();const origin=await f.app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,body?:unknown)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...headers(paired.token),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(response.status,200);return response.json();};
 const raw={permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar',writable:true},{id:'readonly',title:'Read only',writable:false}]};
 const first=await publishCalendarCapability('generated-phone',raw,request);assert.equal(first!.declaration.revision,1);assert.deepEqual(first!.declaration.calendars,[{id:'generated-calendar',title:'Generated calendar'}]);assert.equal(first!.projection.grant,'granted');assert.equal(first!.projection.available,true);assert.equal(first!.projection.authorized,false);
 assert.equal((await publishCalendarCapability('generated-phone',raw,request))!.declaration.revision,1,'polling unchanged calendars must not invalidate a grant revision');
 const denied=await publishCalendarCapability('generated-phone',{permission:'required',calendars:[]},request);assert.equal(denied!.declaration.revision,2);assert.deepEqual(denied!.declaration.calendars,[]);assert.equal(denied!.declaration.permission,'required');assert.equal(denied!.projection.grant,'required');assert.equal(denied!.projection.available,false);
 const restored=await publishCalendarCapability('generated-phone',raw,request);assert.equal(restored!.declaration.revision,3,'restored permission is a new declaration, not an inherited grant');
 const inventory=(await f.app.inject({url:'/api/action-capabilities',headers:headers()})).json();assert.deepEqual(inventory.drafts,[]);assert.equal(inventory.executionEnabled,false);
});
