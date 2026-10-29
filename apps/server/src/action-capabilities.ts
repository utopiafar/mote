import {ActionInputScope} from './action-input-scope.js';
import {actionGrantCommandSchema,type ActionGrant,type ActionPluginProvider,type ActionPluginIdentity} from '@mote/shared';
import {actionCapabilityCommandSchema,actionCapabilityDraftSchema,actionDeviceDeclarationSchema,calendarManageCapability,calendarCapabilityIdentitySchema,type ActionCapabilityDraft,type ActionDeviceCapability} from '@mote/shared';
import {Store,StoreError,sha256} from './store.js';
import type {SourceStore} from './sources.js';
import type {Connections,ConnectionCredential} from './connections.js';

/** Owner control plane; installing a plugin or saving a draft never authorizes execution. */
export class ActionCapabilities {
 readonly inputs:ActionInputScope;
 constructor(private store:Store,private sources:SourceStore,private connections:Connections,private providers:()=>ActionPluginProvider[]=()=>[]){this.inputs=new ActionInputScope(store,sources);store.db.exec(`
  CREATE TABLE IF NOT EXISTS action_device_capabilities(device_id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_grants(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_drafts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS action_capability_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL);`);}
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
 inventory(){return {providers:this.providers(),grants:this.grants().map(grant=>({...grant,available:this.available(grant)})),sources:this.inputs.catalog(),capabilities:[calendarManageCapability],executionEnabled:this.grants().some(grant=>this.available(grant)),declarations:this.store.db.prepare('SELECT device_id FROM action_device_capabilities ORDER BY device_id').all().map(row=>this.declaration(String(row.device_id))),drafts:this.store.db.prepare('SELECT json FROM action_capability_drafts ORDER BY id').all().map(row=>JSON.parse(String(row.json)) as ActionCapabilityDraft)};}
 saveDraft(raw:unknown){const input=actionCapabilityDraftSchema.parse(raw);return this.command('draft',input,()=>{
  const prior=this.read<ActionCapabilityDraft>('action_capability_drafts',input.id);if((prior?.revision??0)!==input.expectedRevision||prior?.state==='revoked')throw new StoreError('Capability draft changed; refresh before retrying',409);
  const declaration=this.declaration(input.target.deviceId);if(!declaration?.connectionActive||!calendarCapabilityIdentitySchema.safeParse(declaration.capability).success||declaration.permission!=='granted'||declaration.revision!==input.target.declarationRevision||!declaration.calendars.some(item=>item.id===input.target.calendarId))throw new StoreError('The device calendar declaration is unavailable or changed',409);
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
 available(grant:ActionGrant){
  if(grant.state!=='active'||!calendarCapabilityIdentitySchema.safeParse(grant.capability).success||!this.pluginAvailable(grant.plugin))return false;
  const declaration=this.declaration(grant.target.deviceId);
  if(!declaration?.connectionActive||!calendarCapabilityIdentitySchema.safeParse(declaration.capability).success||declaration.connectionId!==grant.connectionId||declaration.revision!==grant.target.declarationRevision||declaration.permission!=='granted'||!declaration.calendars.some(calendar=>calendar.id===grant.target.calendarId))return false;
  if(!grant.inputs.sources.every(identity=>this.inputs.valid(identity)))return false;
  return true;
 }
 authorize(raw:unknown){const input=actionGrantCommandSchema.parse(raw);return this.command('grant',input,()=>{
  const previous=this.grant(input.id);if((previous?.revision??0)!==input.expectedRevision||previous?.state==='revoked')throw new StoreError('Action grant changed; refresh before authorizing',409);
  const draft=this.read<ActionCapabilityDraft>('action_capability_drafts',input.draftId);
  if(!draft||!calendarCapabilityIdentitySchema.safeParse(draft.capability).success||draft.state!=='draft'||draft.revision!==input.draftRevision)throw new StoreError('Action scope draft changed; review it again',409);
  const declaration=this.declaration(draft.target.deviceId),at=new Date().toISOString();
  const value:ActionGrant={...draft,id:input.id,draftId:draft.id,draftRevision:draft.revision,revision:input.expectedRevision+1,plugin:input.plugin,connectionId:declaration?.connectionId??'',inputCursor:Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM changes').get()!.seq),state:'active',executionEnabled:true,createdAt:previous?.createdAt??at,updatedAt:at};
  if(!this.available(value))throw new StoreError('Plugin, device declaration, or source scope changed; review before authorizing',409);
  const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT INTO action_capability_grants VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,json);return value;
 });}
 revokeGrant(id:string,raw:unknown){const input=actionCapabilityCommandSchema.parse(raw);return this.command('revoke-grant:'+id,input,()=>{
  const previous=this.grant(id);if(!previous)throw new StoreError('Action grant not found',404);if(previous.revision!==input.expectedRevision)throw new StoreError('Action grant changed; refresh before revoking',409);
  const value={...previous,revision:previous.revision+1,state:'revoked' as const,executionEnabled:false,updatedAt:new Date().toISOString()};
  this.store.db.prepare('UPDATE action_capability_grants SET json=? WHERE id=?').run(JSON.stringify(value),id);return value;
 });}

}
