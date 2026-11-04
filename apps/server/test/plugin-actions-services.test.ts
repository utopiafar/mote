import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import {PluginHost} from '@mote/plugin-host';
import {calendarPluginCapabilitySchema,type ActionPluginProvider} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {Connections} from '../src/connections.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {actionsServicesContribution,actionsServicesDeclaration,createActionsServices,createActionsServicesFactory} from '../src/plugins/actions-services.js';

const text='Generated appointment is scheduled on 18 September 2099.',ownerToken='generated-actions-owner';
const event={title:'Generated appointment',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'Generated room',description:''};
const capability=calendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'device',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,sameDeviceCalendar:true,completionInMoteOnly:true}});
const provider=():ActionPluginProvider=>({identity:{packageId:'generated.calendar',releaseDigest:sha256('generated-release'),instanceId:'generated-instance',instanceRevision:1,capabilityDigest:sha256(JSON.stringify(capability))},name:'Generated calendar',capability});
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
const answer=(id:string)=>({answer:JSON.stringify({actions:[{kind:'calendar.create',event,uncertainty:'',sameAs:null,evidence:[{id,quote:text}]}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}],trace:[],runId:randomUUID()});

async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-actions-services-')),vault=join(directory,'vault');
  const open=async()=>{
    const store=new Store(vault),sources=new SourceStore(store),files=new FileStore(store,sources),connections=new Connections(store,sources),executor=new ExecutionEngine(store);
    await connections.init();return {store,sources,files,connections,executor};
  };
  let state=await open(),host=new PluginHost({kind:'central',id:'generated-actions-host'});
  const close=async()=>{await host.close();await state.files.close();await state.executor.close();await state.connections.close();state.store.close();};
  t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  return {directory,get state(){return {host,...state};},
    async restart(){await close();host=new PluginHost({kind:'central',id:'generated-actions-host'});state=await open();}};
}
type State=Awaited<ReturnType<typeof fixture>>['state'];

function platform(state:State,providers:ActionPluginProvider[]=[provider()]){
  const connectionIdentity=(request:{headers:{authorization?:string}})=>state.connections.authenticate(String(request.headers.authorization??''));
  return createActionsServices({store:state.store,files:state.files,sources:state.sources,connections:state.connections,executor:state.executor,
    actionProviders:()=>providers,
    query:async input=>answer(String(input.evidenceIds![0])),configured:()=>true,
    authorization:{connectionIdentity,credential:request=>{const c=connectionIdentity(request);return c&&!state.connections.isOwner(c)?c:undefined;}}});
}
const install=(host:PluginHost,services:ReturnType<typeof platform>)=>host.install({identity:{host:host.identity,packageId:'generated.actions-services',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},contributions:[actionsServicesDeclaration],factory:createActionsServicesFactory(services)});
const routed=(t:TestContext,services:ReturnType<typeof platform>)=>{const app=Fastify();services.routes(app);t.after(()=>app.close());return app;};

async function pair(state:State){
  const invitation=state.connections.invite({serverUrl:'https://generated.invalid',label:'Generated device'},'collector');
  const paired=await state.connections.redeem({code:invitation.invitation.code,deviceId:'generated-device',deviceName:'Generated device',platform:'macos'});
  return {paired,device:{authorization:'Bearer '+paired.token},owner:{authorization:'Bearer '+ownerToken}};
}
async function grant(app:FastifyInstance,headers:{device:{authorization:string};owner:{authorization:string}},identity:ActionPluginProvider['identity'],inputs={existingArchived:true,futureInputs:true}){
  assert.equal((await app.inject({method:'POST',url:'/api/device-action-capabilities',headers:headers.device,payload:{...command(0),deviceId:'generated-device',capability:{id:'calendar.manage',version:1},permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar'}]}})).statusCode,200);
  const inventory=(await app.inject({url:'/api/action-capabilities',headers:headers.owner})).json();
  const draft=(await app.inject({method:'PUT',url:'/api/action-capability-drafts',headers:headers.owner,payload:{...command(0),id:randomUUID(),capability:{id:'calendar.manage',version:1},target:{deviceId:'generated-device',calendarId:'generated-calendar',declarationRevision:inventory.declarations[0].revision},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input',platform:'import'}],...inputs}}})).json();
  const granted=await app.inject({method:'PUT',url:'/api/action-capability-grants',headers:headers.owner,payload:{...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:identity,acknowledgeCalendarWrites:true}});
  assert.equal(granted.statusCode,200,granted.body);return granted.json();
}
async function propose(state:State,services:ReturnType<typeof platform>){
  state.sources.register({id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
  const record=await state.sources.upsert('generated-source',{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',text,title:'Generated original',kind:'message',layer:'original'});
  await services.actionsForAssembly.tick();
  const action=services.actionsForAssembly.list().find(item=>item.evidence.some(e=>e.id===record.id));
  assert.ok(action,'real extraction publishes a validated proposal');return action;
}

test('an approved proposal is serialized to the native consumer once with matching device, calendar and provider digests; a repeated ACK cannot execute twice',async t=>{
  const f=await fixture(t),s=f.state,services=platform(s),handle=await install(s.host,services),app=routed(t,services);
  services.actionsForAssembly.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});
  const headers=await pair(s),identity=provider().identity;
  // Without an owner grant nothing is delivered and no external write is attempted.
  const action=await propose(s,services);assert.equal(action.status,'proposed');
  assert.deepEqual((await app.inject({url:'/api/managed-calendar-deliveries',headers:headers.device})).json().items,[]);

  const granted=await grant(app,headers,identity);
  const queue=(await app.inject({url:'/api/managed-calendar-deliveries',headers:headers.device})).json();
  assert.equal(queue.items.length,1);assert.equal(queue.items[0].id,action.id);
  const bound=services.actionsForAssembly.get(action.id);
  assert.equal(bound.status,'approved');assert.equal(bound.managed?.state,'waiting_device');
  assert.equal(bound.target?.deviceId,'generated-device');assert.equal(bound.target?.calendarId,'generated-calendar');
  assert.equal(bound.managed?.grantId,granted.id);assert.equal(bound.managed?.grantRevision,granted.revision);
  assert.equal(bound.managed?.connectionId,s.connections.authenticate('Bearer '+headers.paired.token)!.id);
  assert.deepEqual(granted.plugin,identity,'the grant binds the exact provider release and capability digests');

  const claim=(await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/claim`,headers:headers.device,payload:{}})).json();
  assert.equal(claim.mutationAllowed,true);assert.equal(claim.target.deviceId,granted.target.deviceId);assert.equal(claim.target.calendarId,granted.target.calendarId);
  const ack=await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/receipt`,headers:headers.device,payload:{operationId:claim.operationId,status:'succeeded',externalId:'generated-event-1'}});
  assert.equal(ack.statusCode,200,ack.body);assert.equal(ack.json().status,'succeeded');
  // An idempotent replay of the same ACK is a receipt, never a second execution.
  const replay=(await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/receipt`,headers:headers.device,payload:{operationId:claim.operationId,status:'succeeded',externalId:'generated-event-1'}})).json();
  assert.equal(replay.status,'succeeded');assert.equal(replay.operationId,claim.operationId);
  assert.equal((await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/claim`,headers:headers.device,payload:{}})).json().mutationAllowed,false);
  await handle.close('disabled');
});

test('a revoked grant rejects the queued proposal while the lost in-flight ACK reconciles once without a new execution',async t=>{
  const f=await fixture(t),s=f.state,services=platform(s),handle=await install(s.host,services),app=routed(t,services);
  services.actionsForAssembly.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});
  s.sources.register({id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input',platform:'import'});
  const headers=await pair(s),granted=await grant(app,headers,provider().identity);
  const action=await propose(s,services);
  const queue=(await app.inject({url:'/api/managed-calendar-deliveries',headers:headers.device})).json();
  assert.deepEqual(queue.items.map((item:{id:string})=>item.id),[action.id]);
  const claim=(await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/claim`,headers:headers.device,payload:{}})).json();
  assert.equal(claim.mutationAllowed,true,'the device claimed the approved write once');
  // The ACK is lost in flight and the owner withdraws the grant afterwards.
  const revoked=await app.inject({method:'POST',url:`/api/action-capability-grants/${granted.id}/revoke`,headers:headers.owner,payload:command(granted.revision)});
  assert.equal(revoked.statusCode,200,revoked.body);
  const next=await propose(s,services);assert.equal(next.status,'proposed','the old grant cannot silently approve the next proposal');
  const retained=(await app.inject({url:'/api/managed-calendar-deliveries',headers:headers.device})).json();
  assert.deepEqual(retained.items.map((item:{id:string})=>item.id),[action.id],'only the retained in-flight receipt remains deliverable');
  assert.equal((await app.inject({method:'POST',url:`/api/managed-calendar/${next.id}/claim`,headers:headers.device,payload:{}})).statusCode,403,'the revoked grant rejects the queued proposal');
  assert.equal(services.actionsForAssembly.get(next.id).status,'proposed');
  // The retained receipt still reconciles exactly once; replaying it is inert.
  const ack=await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/receipt`,headers:headers.device,payload:{operationId:claim.operationId,status:'succeeded',externalId:'generated-event-1'}});
  assert.equal(ack.statusCode,200,ack.body);assert.equal(services.actionsForAssembly.get(action.id).status,'succeeded');
  assert.equal((await app.inject({method:'POST',url:`/api/managed-calendar/${action.id}/receipt`,headers:headers.device,payload:{operationId:claim.operationId,status:'succeeded',externalId:'generated-event-1'}})).statusCode,200);
  assert.equal((await app.inject({url:'/api/managed-calendar-deliveries',headers:headers.device})).json().items.length,0);
  await handle.close('disabled');
});

test('actions services lifecycle fences writes, recovers routes on re-enable and preserves the durable profile across restart',async t=>{
  const f=await fixture(t),s=f.state,services=platform(s),handle=await install(s.host,services),app=routed(t,services);
  const owner={authorization:'Bearer '+ownerToken},todo={id:randomUUID(),title:'Generated lifecycle task'},device=await pair(s);
  assert.equal((await app.inject({method:'POST',url:'/api/todos',headers:owner,payload:todo})).statusCode,201);
  const declared=await app.inject({method:'POST',url:'/api/device-action-capabilities',headers:device.device,payload:{...command(0),deviceId:'generated-device',capability:{id:'calendar.manage',version:1},permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar'}]}});
  assert.equal(declared.statusCode,200,declared.body);
  const projection=async()=> (await app.inject({url:'/api/device-action-capabilities',headers:device.device})).json().projection;
  assert.equal((await projection()).available,true);assert.equal((await projection()).authorized,false);

  await handle.quiesce('upgrade');
  assert.equal((await app.inject({method:'POST',url:'/api/todos',headers:owner,payload:{id:randomUUID(),title:'Rejected while quiescing'}})).statusCode,503,'quiesce rejects new writes');
  assert.equal((await app.inject({url:'/api/todos',headers:owner})).statusCode,200,'accepted reads stay available while draining');
  assert.equal((await app.inject({method:'POST',url:'/api/device-action-capabilities',headers:device.device,payload:{...command(1),deviceId:'generated-device',capability:{id:'calendar.manage',version:1},permission:'required',calendars:[]}})).statusCode,503,'quiesce rejects new device declarations');
  assert.equal((await projection()).available,true,'accepted projection reads stay available while draining');
  await handle.close('disabled');
  assert.equal((await app.inject({url:'/api/todos',headers:owner})).statusCode,503);
  assert.equal((await app.inject({url:'/api/device-action-capabilities',headers:device.device})).statusCode,503);
  assert.throws(()=>services.actionsForAssembly,{statusCode:503});

  // Re-enable installs a new activation against the same profile without a
  // process restart; the engine handler released by close() registers cleanly.
  const revived=platform(s),revivedHandle=await install(s.host,revived),next=routed(t,revived);
  const page=(await next.inject({url:'/api/todos',headers:owner})).json();
  assert.equal(page.items[0].id,todo.id);assert.equal(page.items[0].title,todo.title);
  const recovered=(await next.inject({url:'/api/device-action-capabilities',headers:device.device})).json();
  assert.equal(recovered.declaration.revision,1);assert.equal(recovered.projection.available,true);assert.equal(recovered.projection.authorized,false);
  assert.equal((await next.inject({method:'POST',url:'/api/todos',headers:owner,payload:{id:randomUUID(),title:'Generated re-enabled task'}})).statusCode,201);
  revived.actionsForAssembly.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});
  const action=await propose(s,revived);assert.equal(action.status,'proposed');
  await revivedHandle.close('disabled');

  // A full restart over the same profile preserves the durable domain state.
  await f.restart();const nextState=f.state,restored=platform(nextState),restoredHandle=await install(nextState.host,restored),restoredApp=routed(t,restored);
  const restoredPage=(await restoredApp.inject({url:'/api/todos',headers:owner})).json();
  assert.equal(restoredPage.items.length,2);assert.equal(restoredPage.items.find((item:{id:string})=>item.id===todo.id)?.title,todo.title);
  assert.equal(restored.actionsForAssembly.get(action.id).status,'proposed');
  await restoredHandle.close('disabled');
});

test('a prepare that fails inside a caller transaction leaves the borrowed vault and engine usable',async t=>{
  const f=await fixture(t),s=f.state;
  s.store.db.exec('BEGIN IMMEDIATE');
  const blocked=platform(s);
  await assert.rejects(blocked.prepare(),{statusCode:503});
  assert.equal(s.store.db.isTransaction,true,'the failed prepare must not claim the caller transaction');
  s.store.db.exec('ROLLBACK');
  await assert.rejects(blocked.prepare(),{statusCode:503},'the same closure stays fenced');
  await blocked.close();
  const restored=platform(s);
  await assert.doesNotReject(restored.prepare());restored.start();
  assert.equal(s.executor.closed,false,'the borrowed engine survives a failed activation');
  restored.actionsForAssembly.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});
  const action=await propose(s,restored);assert.equal(action.status,'proposed');
  await restored.close();
});

test('the contribution declares no service ports beyond the route and assembly bridges',()=>{
  assert.deepEqual(actionsServicesContribution.provides,[]);
  assert.equal(actionsServicesDeclaration.id,'actions-services');
});
