import {ActionInputScope} from '../action-input-scope.js';
import {actionGrantCommandSchema,type ActionConnectorChoice,type ActionGrant,type ActionPluginProvider,type ActionPluginIdentity,type CentralConnectorActionTarget} from '@mote/shared';
import {actionCapabilityCommandSchema,actionCapabilityDraftSchema,actionDeviceDeclarationSchema,actionPluginCapabilityIdentitySchema,actionPluginCapabilitySchema,calendarManageCapability,calendarCapabilityIdentitySchema,projectDeviceCapability,type ActionCapabilityDraft,type ActionDeviceCapability,type DeviceCapabilityProjection} from '@mote/shared';
import {StoreError,sha256} from '../store.js';
import type {SourceStore} from '../sources.js';
import type {Connections,ConnectionCredential} from '../connections.js';

/** Owner control plane; installing a plugin or saving a draft never authorizes execution. */
export class ActionCapabilities {
 readonly inputs:ActionInputScope;
 constructor(private store:ConstructorParameters<typeof ActionInputScope>[0],private sources:SourceStore,private connections:Connections,private providers:()=>ActionPluginProvider[]=()=>[]){this.inputs=new ActionInputScope(store,sources);store.db.exec(`
  CREATE TABLE IF NOT EXISTS action_device_capabilities(device_id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_grants(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_drafts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);`);store.registerStorage('actions-services',{
  action_device_capabilities:'length(CAST(json AS BLOB))+length(CAST(device_id AS BLOB))+128',
  action_capability_grants:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+256',
  action_capability_drafts:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128',
  action_capability_commands:'length(CAST(receipt AS BLOB))+length(CAST(id AS BLOB))+length(CAST(fingerprint AS BLOB))+128',
});}
 private active(connectionId:string){return this.connections.inventory().items.some(item=>item.id===connectionId&&!item.revokedAt&&(!item.expiresAt||Date.parse(item.expiresAt)>Date.now()));}
 private read<T>(table:'action_device_capabilities'|'action_capability_drafts'|'action_capability_grants',key:string):T|undefined{const row=this.store.db.prepare(`SELECT json FROM ${table} WHERE ${table==='action_device_capabilities'?'device_id':'id'}=?`).get(key);return row?JSON.parse(String(row.json)):undefined;}
 private command<T>(kind:string,input:{operationId:string;expectedRevision:number},work:()=>T):T{
  const db=this.store.db,fingerprint=sha256(JSON.stringify([kind,input]));db.exec('BEGIN IMMEDIATE');
  try{const prior=db.prepare('SELECT fingerprint,receipt FROM action_capability_commands WHERE id=?').get(input.operationId);
   if(prior){if(prior.fingerprint!==fingerprint)throw new StoreError('Capability operation identity conflicts with its original request',409);db.exec('COMMIT');return JSON.parse(String(prior.receipt));}
   if(input.expectedRevision===Number.MAX_SAFE_INTEGER)throw new StoreError('Capability revision is exhausted',503);
   const result=work(),receipt=JSON.stringify(result);this.store.reserveMetadata(Buffer.byteLength(receipt)+fingerprint.length+input.operationId.length+128);
   db.prepare('INSERT INTO action_capability_commands VALUES(?,?,?)').run(input.operationId,fingerprint,receipt);db.exec('COMMIT');return result;
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 }
 declare(raw:unknown,credential:ConnectionCredential){const input=actionDeviceDeclarationSchema.parse(raw);this.connections.assertOwnDevice(credential,input);
  if(!['collector','owner'].includes(credential.scope)||!credential.deviceId)throw new StoreError('A paired device must declare its own capabilities',403);
  return this.command('declare:'+credential.id,input,()=>{this.connections.assertActive(credential);const prior=this.read<ActionDeviceCapability>('action_device_capabilities',input.deviceId);
   if((prior?.revision??0)!==input.expectedRevision)throw new StoreError('Device capability declaration changed; refresh before retrying',409);
   const {operationId:_,expectedRevision:__,...fields}=input,value={...fields,revision:input.expectedRevision+1,connectionId:credential.id,declaredAt:new Date().toISOString(),connectionActive:true};
   const json=JSON.stringify(value);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(JSON.stringify(prior??''))));
   this.store.db.prepare('INSERT INTO action_device_capabilities VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET json=excluded.json').run(input.deviceId,json);return value;
  });
 }
 declaration(deviceId:string){const value=this.read<ActionDeviceCapability>('action_device_capabilities',deviceId);return value?{...value,connectionActive:this.active(value.connectionId)}:undefined;}
 declarations():ActionDeviceCapability[]{return this.store.db.prepare('SELECT json FROM action_device_capabilities ORDER BY device_id').all().map(row=>JSON.parse(String(row.json)) as ActionDeviceCapability).map(value=>({...value,connectionActive:this.active(value.connectionId)}));}
 private centralProviders(){return this.providers().filter(provider=>provider.capability.executionLocation==='central-connector');}
 private deviceProviders(){return this.providers().filter(provider=>provider.capability.executionLocation==='device');}
 private centralProvider(target:CentralConnectorActionTarget){return this.centralProviders().find(provider=>provider.identity.packageId===target.packageId&&provider.identity.instanceId===target.instanceId&&provider.identity.instanceRevision===target.instanceRevision&&provider.capability.id===target.capabilityId&&provider.capability.version===target.capabilityVersion&&provider.calendarId===target.calendarId);}
 /** Enabled Central connector write declarations, exposed as selectable
  * execution locations. Selecting or authorizing one never executes by itself. */
 centralConnectors():ActionConnectorChoice[]{
  return this.centralProviders().map(provider=>({
   name:provider.name,
   capability:{id:provider.capability.id,version:provider.capability.version},
   target:{executionLocation:'central-connector' as const,packageId:provider.identity.packageId,instanceId:provider.identity.instanceId,instanceRevision:provider.identity.instanceRevision,capabilityId:provider.capability.id,capabilityVersion:provider.capability.version,...(provider.calendarId?{calendarId:provider.calendarId}:{})},
  }));
 }
 resolveCentralTarget(target:CentralConnectorActionTarget){return this.centralProvider(target);}
 /** A message send still requires this exact owner grant on top of the enabled
  * connector declaration. A grant never makes a send automatic. */
 messageSendGranted(target:CentralConnectorActionTarget){
  return target.capabilityId==='message.send'&&target.capabilityVersion===1&&this.grants().some(grant=>
   grant.state==='active'&&grant.capability.id==='message.send'&&grant.capability.version===1&&this.available(grant)&&
   'executionLocation' in grant.target&&grant.target.packageId===target.packageId&&grant.target.instanceId===target.instanceId&&
   grant.target.instanceRevision===target.instanceRevision&&grant.target.capabilityId===target.capabilityId&&grant.target.capabilityVersion===target.capabilityVersion);
 }
 /** Owner-safe projection of device-published capabilities. `installed` comes
  * from actual enabled plugin providers, `available` from the live declaration,
  * `authorized` from the owner grant, and `waitingDevice` only when an installed
  * capability has no live device. */
 private capabilityProjections(deviceId?:string):DeviceCapabilityProjection[]{
  const providers=this.deviceProviders(),declarations=this.declarations().filter(value=>deviceId===undefined||value.deviceId===deviceId);
  const grants=this.grants().filter(value=>!('executionLocation' in value.target)&&(deviceId===undefined||value.target.deviceId===deviceId)).map(value=>({...value,available:this.available(value)}));
  const identities=new Map<string,{id:string;version:number}>();
  for(const value of [calendarManageCapability,...providers.map(provider=>provider.capability),...declarations.map(value=>value.capability),...grants.map(grant=>grant.capability)])identities.set(value.id+'@'+value.version,{id:value.id,version:value.version});
  return [...identities.values()].sort((a,b)=>a.id.localeCompare(b.id)||a.version-b.version).map(value=>projectDeviceCapability({
    ...value,installed:providers.some(provider=>provider.capability.id===value.id&&provider.capability.version===value.version),
    declarations:declarations.filter(declaration=>declaration.capability.id===value.id&&declaration.capability.version===value.version),
    grants:grants.map(grant=>({state:grant.state,authorized:this.scopeValid(grant),target:{deviceId:(grant.target as {deviceId:string}).deviceId}})),
  }));
 }
 deviceProjection(deviceId:string){return this.capabilityProjections(deviceId).find(value=>value.id===calendarManageCapability.id&&value.version===calendarManageCapability.version)??null;}
 inventory(){
  const grants=this.grants().map(grant=>({...grant,available:this.available(grant)}));
  return {providers:this.providers(),grants,sources:this.inputs.catalog(),capabilities:[calendarManageCapability],centralConnectors:this.centralConnectors(),executionEnabled:grants.some(grant=>grant.available),deviceCapabilities:this.capabilityProjections(),declarations:this.declarations(),drafts:this.store.db.prepare('SELECT json FROM action_capability_drafts ORDER BY id').all().map(row=>JSON.parse(String(row.json)) as ActionCapabilityDraft)};
 }
 saveDraft(raw:unknown){const input=actionCapabilityDraftSchema.parse(raw);return this.command('draft',input,()=>{
  const prior=this.read<ActionCapabilityDraft>('action_capability_drafts',input.id);if((prior?.revision??0)!==input.expectedRevision||prior?.state==='revoked')throw new StoreError('Capability draft changed; refresh before retrying',409);
  if('executionLocation' in input.target){
   const provider=this.centralProvider(input.target);if(!provider||provider.capability.id!==input.capability.id||provider.capability.version!==input.capability.version)throw new StoreError('The Central connector declaration is unavailable or changed',409);
  }else{
   const target=input.target,declaration=this.declaration(target.deviceId);if(!declaration?.connectionActive||!calendarCapabilityIdentitySchema.safeParse(declaration.capability).success||declaration.permission!=='granted'||declaration.revision!==target.declarationRevision||!declaration.calendars.some(item=>item.id===target.calendarId))throw new StoreError('The device calendar declaration is unavailable or changed',409);
  }
  for(const identity of input.inputs.sources)if(!this.inputs.valid(identity))throw new StoreError('Action input source identity changed',409);
  const {operationId:_,expectedRevision:__,...fields}=input,at=new Date().toISOString(),value:ActionCapabilityDraft={...fields,revision:input.expectedRevision+1,state:'draft',executionEnabled:false,createdAt:prior?.createdAt??at,updatedAt:at};
  const json=JSON.stringify(value);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(JSON.stringify(prior??''))));this.store.db.prepare('INSERT INTO action_capability_drafts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(input.id,json);return value;
 });}
 revokeDraft(id:string,raw:unknown){const input=actionCapabilityCommandSchema.parse(raw);return this.command('revoke:'+id,input,()=>{
  const prior=this.read<ActionCapabilityDraft>('action_capability_drafts',id);if(!prior)throw new StoreError('Capability draft not found',404);if(prior.revision!==input.expectedRevision)throw new StoreError('Capability draft changed; refresh before retrying',409);
  const value={...prior,revision:prior.revision+1,state:'revoked' as const,updatedAt:new Date().toISOString()};this.store.db.prepare('UPDATE action_capability_drafts SET json=? WHERE id=?').run(JSON.stringify(value),id);return value;
 });}
 grant(id:string){return this.read<ActionGrant>('action_capability_grants',id);}
 grants():ActionGrant[]{return this.store.db.prepare('SELECT json FROM action_capability_grants ORDER BY id').all().map(row=>JSON.parse(String(row.json)));}
 private pluginAvailable(identity:ActionPluginIdentity){return this.providers().some(provider=>JSON.stringify(provider.identity)===JSON.stringify(identity));}
 private centralScopeValid(grant:ActionGrant){const provider=this.centralProvider({executionLocation:'central-connector',packageId:grant.plugin.packageId,instanceId:grant.plugin.instanceId,instanceRevision:grant.plugin.instanceRevision,capabilityId:grant.capability.id,capabilityVersion:grant.capability.version,...(grant.target.calendarId?{calendarId:grant.target.calendarId}:{})});return !!provider&&JSON.stringify(provider.identity)===JSON.stringify(grant.plugin)&&provider.capability.id===grant.capability.id&&provider.capability.version===grant.capability.version;}
 /** Owner authorization remains scoped even while the target device is offline
  * or its OS grant is withdrawn; live availability is a separate check. */
 private scopeValid(grant:ActionGrant){
  if(grant.state!=='active'||!this.pluginAvailable(grant.plugin))return false;
  if('executionLocation' in grant.target){
   if(!this.centralScopeValid(grant))return false;
  }else{
   if(!calendarCapabilityIdentitySchema.safeParse(grant.capability).success)return false;
   const target=grant.target,declaration=this.declaration(target.deviceId);
   if(!declaration||!calendarCapabilityIdentitySchema.safeParse(declaration.capability).success||declaration.connectionId!==grant.connectionId||declaration.revision!==target.declarationRevision||!declaration.calendars.some(calendar=>calendar.id===target.calendarId))return false;
  }
  return grant.inputs.sources.every(identity=>this.inputs.valid(identity));
 }
 available(grant:ActionGrant){
  if(!this.scopeValid(grant))return false;
  if('executionLocation' in grant.target)return true;
  const declaration=this.declaration(grant.target.deviceId);
  return Boolean(declaration?.connectionActive&&declaration.permission==='granted');
 }
 authorize(raw:unknown){const input=actionGrantCommandSchema.parse(raw);return this.command('grant',input,()=>{
  const previous=this.grant(input.id);if((previous?.revision??0)!==input.expectedRevision||previous?.state==='revoked')throw new StoreError('Action grant changed; refresh before authorizing',409);
  const draft=this.read<ActionCapabilityDraft>('action_capability_drafts',input.draftId);
  if(!draft||!actionPluginCapabilityIdentitySchema.safeParse(draft.capability).success||draft.state!=='draft'||draft.revision!==input.draftRevision)throw new StoreError('Action scope draft changed; review it again',409);
  let connectionId='';
  if('executionLocation' in draft.target){
   const provider=this.centralProvider(draft.target);
   if(!provider||JSON.stringify(provider.identity)!==JSON.stringify(input.plugin)||provider.capability.id!==draft.capability.id||provider.capability.version!==draft.capability.version)throw new StoreError('Central connector scope changed; review before authorizing',409);
   if(draft.capability.id==='message.send'?input.acknowledgeMessageSends!==true:input.acknowledgeCalendarWrites!==true)throw new StoreError('Acknowledge this action write scope before authorizing',400);
  }else{
   if(!calendarCapabilityIdentitySchema.safeParse(draft.capability).success||input.acknowledgeCalendarWrites!==true)throw new StoreError('Action scope draft changed; review it again',409);
   connectionId=this.declaration(draft.target.deviceId)?.connectionId??'';
  }
  const at=new Date().toISOString();
  const value:ActionGrant={...draft,id:input.id,draftId:draft.id,draftRevision:draft.revision,revision:input.expectedRevision+1,plugin:input.plugin,connectionId,inputCursor:Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM changes').get()!.seq),state:'active',executionEnabled:true,createdAt:previous?.createdAt??at,updatedAt:at};
  if(!this.available(value))throw new StoreError('Plugin, device declaration, or source scope changed; review before authorizing',409);
  const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT INTO action_capability_grants VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,json);return value;
 });}
 revokeGrant(id:string,raw:unknown){const input=actionCapabilityCommandSchema.parse(raw);return this.command('revoke-grant:'+id,input,()=>{
  const previous=this.grant(id);if(!previous)throw new StoreError('Action grant not found',404);if(previous.revision!==input.expectedRevision)throw new StoreError('Action grant changed; refresh before revoking',409);
  const value={...previous,revision:previous.revision+1,state:'revoked' as const,executionEnabled:false,updatedAt:new Date().toISOString()};
  this.store.db.prepare('UPDATE action_capability_grants SET json=? WHERE id=?').run(JSON.stringify(value),id);return value;
 });}

}
