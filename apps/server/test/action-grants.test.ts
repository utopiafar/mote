import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {zipSync,strToU8} from 'fflate';
import {calendarPluginCapabilitySchema,centralCalendarPluginCapabilitySchema,messageSendPluginCapabilitySchema} from '@mote/shared';
import {Store,StoreError,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {Connections} from '../src/connections.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,pluginManifestSchema,type PluginManifest} from '../src/plugin-release.js';
import {ActionCapabilities} from '../src/plugins/action-capabilities.js';

const capability=calendarPluginCapabilitySchema.parse({id:'calendar.manage',version:1,inputSchema:'calendar.event.v1',outputSchema:'calendar.receipt.v1',operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],executionLocation:'device',risk:'calendar-write',constraints:{writableCalendar:true,completeEvent:true,currentEvidence:true,unexpiredCreatesAndUpdates:true,noParticipants:true,existingMoteEventsOnly:true,sameDeviceCalendar:true,completionInMoteOnly:true}});
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
async function waitFor(check:()=>boolean){const until=Date.now()+5000;while(!check()){assert.ok(Date.now()<until,'generated plugin operation must settle');await delay(5);}}
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-action-grants-')),store=new Store(directory),sources=new SourceStore(store),connections=new Connections(store,sources);await connections.init();
 const executor=new ExecutionEngine(store),archive=zipSync({'device.mjs':strToU8('export function createMemoryProvider(){throw Error("Device declaration must not invoke a worker");}')});
 const manifest:PluginManifest={schemaVersion:1,id:'generated.calendar',name:'Generated calendar declaration',version:'1',runtime:'worker',entry:'device.mjs',archive:{asset:'adapter.zip',sha256:sha256(archive)},capabilities:['calendar.manage'],actionCapabilities:[capability],configuration:[],dependencies:[],access:['Owner-selected device calendar']};
 const base='https://github.com/generated-fixture/calendar/releases/download/v1/';
 const releases=new GitHubPluginReleases(join(directory,'packages'),async url=>{
  if(url==='https://api.github.com/repos/generated-fixture/calendar/releases/tags/v1')return {bytes:strToU8(JSON.stringify({tag_name:'v1',draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]}))};
  if(url==='https://api.github.com/repos/generated-fixture/calendar/commits/v1')return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
  if(url===base+'adapter.zip')return {bytes:archive};
  throw Error('Unexpected release URL');
 });
 const plugins=new PluginCenter(store,executor,releases),capabilities=new ActionCapabilities(store,sources,connections,()=>plugins.actionProviders());
 t.after(async()=>{await executor.close();await plugins.close();await connections.close();store.close();await rm(directory,{recursive:true,force:true});});
 const preview=await plugins.resolve({repository:'generated-fixture/calendar',tag:'v1'});plugins.install({...command(plugins.revision()),previewId:preview.id});await waitFor(()=>plugins.view().packages[0]?.state!=='installing');assert.equal(plugins.view().packages[0].state,'installed');
 const instance=plugins.configure(undefined,{...command(plugins.revision()),packageId:plugins.view().packages[0].id,name:'Generated device actions',scope:'default',configuration:{}});
 assert.deepEqual(plugins.actionProviders(),[],'installation/configuration is not an executable provider');
 plugins.action(instance.id,'check',command(instance.revision));await waitFor(()=>plugins.instanceView(instance.id).observed!=='checking');assert.equal(plugins.instanceView(instance.id).observed,'ready');assert.deepEqual(plugins.actionProviders(),[],'checking does not enable a provider');
 plugins.action(instance.id,'enable',command(plugins.instanceView(instance.id).revision));assert.equal(plugins.actionProviders().length,1);assert.deepEqual(capabilities.grants(),[],'enabling does not grant execution');
 sources.register({id:'generated-source',kind:'custom',name:'Generated source',deviceId:'generated-input-device',platform:'import'});
 const invitation=connections.invite({serverUrl:'https://generated.invalid',label:'Generated'},'collector');const paired=await connections.redeem({code:invitation.invitation.code,deviceId:'generated-device',deviceName:'Generated',platform:'android'});const credential=connections.authenticate('Bearer '+paired.token)!;
 capabilities.declare({...command(0),deviceId:'generated-device',capability:{id:'calendar.manage',version:1},permission:'granted',calendars:[{id:'generated-calendar',title:'Generated calendar'}]},credential);
 const draft=capabilities.saveDraft({...command(0),id:randomUUID(),capability:{id:'calendar.manage',version:1},target:{deviceId:'generated-device',calendarId:'generated-calendar',declarationRevision:1},inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input-device',platform:'import'}],existingArchived:true,futureInputs:true}});
 const grant=()=>({...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:plugins.actionProviders()[0].identity,acknowledgeCalendarWrites:true});
 return {store,sources,connections,executor,plugins,capabilities,credential,draft,grant,instance};
}

test('installed checked plugin scopes require explicit owner grant, bind exact revisions and preserve revocation across service restart',async t=>{
 const f=await fixture(t),input=f.grant(),granted=f.capabilities.authorize(input);assert.equal(granted.executionEnabled,true);assert.equal(f.capabilities.available(granted),true);assert.equal(granted.connectionId,f.credential.id);
 assert.deepEqual(f.capabilities.authorize(input),granted,'same command returns the same receipt');
 assert.throws(()=>f.capabilities.authorize({...input,plugin:{...input.plugin,instanceRevision:input.plugin.instanceRevision+1}}),/conflicts/);
 const revoke={...command(1)},revoked=f.capabilities.revokeGrant(granted.id,revoke);assert.equal(revoked.executionEnabled,false);assert.equal(f.capabilities.available(revoked),false);
 const restored=new ActionCapabilities(f.store,f.sources,f.connections,()=>f.plugins.actionProviders());assert.equal(restored.grant(granted.id)?.state,'revoked');assert.deepEqual(restored.revokeGrant(granted.id,revoke),revoked);
 assert.throws(()=>restored.authorize({...input,...command(2)}),/changed/,'revoked grant cannot silently reactivate');
 assert.equal(restored.inventory().executionEnabled,false,'no execution consumer has been enabled by this control-plane test');
});

test('an enabled Central connector declares message.send as a selectable target, but only an explicit owner grant with its own acknowledgement authorizes it',async t=>{
 const f=await fixture(t),message=messageSendPluginCapabilitySchema.parse({id:'message.send',version:1,inputSchema:'message.send.v1',outputSchema:'message.receipt.v1',operations:['message.send'],executionLocation:'central-connector',risk:'message-send',constraints:{confirmsEveryMessage:true,currentEvidence:true}});
 const identity={packageId:'mote.official.fixture-connector',releaseDigest:'c'.repeat(64),instanceId:'generated-connector',instanceRevision:1,capabilityDigest:sha256(JSON.stringify(message))},provider=()=>({identity,name:'Generated connector',capability:message});
 const central=new ActionCapabilities(f.store,f.sources,f.connections,()=>[provider()]);
 const target={executionLocation:'central-connector' as const,packageId:identity.packageId,instanceId:identity.instanceId,instanceRevision:1,capabilityId:'message.send',capabilityVersion:1};
 assert.deepEqual(central.centralConnectors(),[{name:'Generated connector',capability:{id:'message.send',version:1},target}]);
 assert.equal(central.inventory().executionEnabled,false,'a declaration is not an owner grant');
 const draft=central.saveDraft({...command(0),id:randomUUID(),capability:{id:'message.send',version:1},target,inputs:{sources:[{sourceId:'generated-source',kind:'custom',deviceId:'generated-input-device',platform:'import'}],existingArchived:true,futureInputs:true}});
 assert.equal(draft.executionEnabled,false);
 const input={...command(0),id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,plugin:identity,acknowledgeMessageSends:true};
 assert.throws(()=>central.authorize({...input,acknowledgeMessageSends:undefined,acknowledgeCalendarWrites:true}),/Acknowledge/);
 const granted=central.authorize(input);assert.equal(granted.executionEnabled,true);assert.equal(central.available(granted),true);
 assert.equal(central.inventory().executionEnabled,true);
});

test('plugin disable/re-enable and device permission changes never inherit the original active grant',async t=>{
 const f=await fixture(t),grant=f.capabilities.authorize(f.grant());
 f.plugins.action(f.instance.id,'disable',command(f.plugins.instanceView(f.instance.id).revision));assert.equal(f.capabilities.available(grant),false);
 f.plugins.action(f.instance.id,'enable',command(f.plugins.instanceView(f.instance.id).revision));assert.equal(f.capabilities.available(grant),false,'same named plugin with a new instance revision needs a new grant');
 assert.throws(()=>f.capabilities.authorize({...f.grant(),plugin:grant.plugin}),/changed/);
 const next=f.capabilities.authorize(f.grant());assert.equal(f.capabilities.available(next),true);
 f.capabilities.declare({...command(1),deviceId:'generated-device',capability:{id:'calendar.manage',version:1},permission:'required',calendars:[]},f.credential);assert.equal(f.capabilities.available(next),false);
 assert.throws(()=>f.capabilities.authorize(f.grant()),/changed/);
});

test('a plugin manifest cannot add participants, unknown execution locations or an undeclared calendar capability',()=>{
 for(const change of [{constraints:{...capability.constraints,noParticipants:false}},{executionLocation:'central'},{inputSchema:'arbitrary-script'}])assert.equal(calendarPluginCapabilitySchema.safeParse({...capability,...change}).success,false);
 assert.equal(calendarPluginCapabilitySchema.safeParse({...capability,executionLocation:'central-connector'}).success,false,'the device calendar contract stays device-only');
 const central={...capability,executionLocation:'central-connector',constraints:{...capability.constraints}};delete (central.constraints as any).sameDeviceCalendar;
 assert.equal(centralCalendarPluginCapabilitySchema.safeParse(central).success,true);
 assert.equal(messageSendPluginCapabilitySchema.safeParse({id:'message.send',version:1,inputSchema:'message.send.v1',outputSchema:'message.receipt.v1',operations:['message.send'],executionLocation:'central-connector',risk:'message-send',constraints:{confirmsEveryMessage:true,currentEvidence:true}}).success,true);
 assert.equal(calendarPluginCapabilitySchema.safeParse({...capability,executionLocation:'central'}).success,false,'only the explicit official location is accepted');
 const base={schemaVersion:1,id:'generated.calendar',name:'Generated',version:'2',runtime:'worker',entry:'device.mjs',archive:{asset:'adapter.zip',sha256:'a'.repeat(64)},capabilities:['calendar.manage'],configuration:[],dependencies:[],access:[]};
 assert.equal(pluginManifestSchema.safeParse(base).success,false);assert.equal(pluginManifestSchema.safeParse({...base,actionCapabilities:[capability]}).success,true);
 assert.equal(pluginManifestSchema.safeParse({...base,actionCapabilities:[capability,messageSendPluginCapabilitySchema.parse({id:'message.send',version:1,inputSchema:'message.send.v1',outputSchema:'message.receipt.v1',operations:['message.send'],executionLocation:'central-connector',risk:'message-send',constraints:{confirmsEveryMessage:true,currentEvidence:true}})]}).success,true,'a package may declare more than one write kind');
});


test('grant quota failure atomically preserves the retry identity and cannot publish a partial grant',async t=>{
 const f=await fixture(t),input=f.grant(),reserve=f.store.reserveMetadata.bind(f.store);let calls=0;
 f.store.reserveMetadata=(bytes:number)=>{if(++calls===2)throw new StoreError('Generated receipt quota failure',507);reserve(bytes);};
 assert.throws(()=>f.capabilities.authorize(input),/quota/);assert.equal(f.capabilities.grants().length,0);
 f.store.reserveMetadata=reserve;assert.equal(f.capabilities.authorize(input).id,input.id);assert.equal(f.capabilities.grants().length,1);
});

test('a create-only declaration, draft or grant never acquires the expanded manage authority',async t=>{
 const f=await fixture(t),grant=f.capabilities.authorize(f.grant()),old={id:'calendar.create',version:1};
 assert.equal(calendarPluginCapabilitySchema.safeParse({...capability,id:'calendar.create'}).success,false);
 assert.equal(f.capabilities.available({...grant,capability:old} as any),false);
 f.store.db.prepare("UPDATE action_capability_drafts SET json=json_set(json,'$.capability',json(?)) WHERE id=?").run(JSON.stringify(old),f.draft.id);
 assert.throws(()=>f.capabilities.authorize(f.grant()),/changed/);
 f.store.db.prepare("UPDATE action_device_capabilities SET json=json_set(json,'$.capability',json(?)) WHERE device_id=?").run(JSON.stringify(old),grant.target.deviceId);
 assert.equal(f.capabilities.available(grant),false);
 const draft={...f.draft,...command(0),id:randomUUID()};delete (draft as any).revision;delete (draft as any).state;delete (draft as any).executionEnabled;delete (draft as any).createdAt;delete (draft as any).updatedAt;
 assert.throws(()=>f.capabilities.saveDraft(draft),/unavailable or changed/);
});
