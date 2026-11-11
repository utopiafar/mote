import {calendarEventSchema,calendarExpired,isCentralConnectorActionTarget,type ActionConnectorChoice,type ActionGrant,type ActionProposal,type ActionProposalTarget,type CentralConnectorActionTarget,type ConnectorActionExecution,type ConnectorActionReceipt} from '@mote/shared';
import {Store,StoreError} from './store.js';
import type {Actions} from './actions.js';
import type {ActionCapabilities} from './plugins/action-capabilities.js';
import type {Connections,ConnectionCredential} from './connections.js';

type ConnectorDispatch=(input:{target:CentralConnectorActionTarget;request:ConnectorActionExecution})=>Promise<ConnectorActionReceipt>;

/** Central dispatches only validated proposals; models cannot create grants or choose authority. */
export class ManagedCalendar {
 private cursor=0;
 constructor(private store:Store,private actions:Actions,private capabilities:ActionCapabilities,private connections:Connections,private connectorAction?:ConnectorDispatch){}
 private sameTarget(a:ActionProposalTarget,b:ActionProposalTarget){
  if(isCentralConnectorActionTarget(a)||isCentralConnectorActionTarget(b))return isCentralConnectorActionTarget(a)&&isCentralConnectorActionTarget(b)&&a.packageId===b.packageId&&a.instanceId===b.instanceId&&a.instanceRevision===b.instanceRevision&&a.capabilityId===b.capabilityId&&a.capabilityVersion===b.capabilityVersion&&a.calendarId===b.calendarId;
  return a.deviceId===b.deviceId&&a.calendarId===b.calendarId;
 }
 private grantTarget(grant:ActionGrant):ActionProposalTarget{
  if('executionLocation' in grant.target)return {executionLocation:'central-connector',packageId:grant.plugin.packageId,instanceId:grant.plugin.instanceId,instanceRevision:grant.plugin.instanceRevision,capabilityId:grant.capability.id,capabilityVersion:grant.capability.version,...(grant.target.calendarId?{calendarId:grant.target.calendarId}:{})};
  return {deviceId:grant.target.deviceId,calendarId:grant.target.calendarId};
 }
 /** A grant matches only its declared calendar action kinds and its one exact
   * target. A message.send grant is never eligible for automatic execution. */
 private matches(grant:ActionGrant,action:ActionProposal,records:ReturnType<Actions['read']>){
  if(grant.capability.id!=='calendar.manage'||!['calendar.create','calendar.update','calendar.cancel','calendar.complete'].includes(action.kind))return false;
  const target=this.grantTarget(grant),proposalTargets=[action.target,action.related?.target].filter((value):value is ActionProposalTarget=>Boolean(value));
  if(proposalTargets.some(value=>!this.sameTarget(value,target)))return false;
  return records.length>0&&records.every(record=>this.capabilities.inputs.allows(grant,record));
 }
 async tick(){
  const grants=this.capabilities.grants().filter(grant=>this.capabilities.available(grant));
  if(grants.length){
   const rows=this.store.db.prepare("SELECT rowid,id FROM action_proposals WHERE rowid>? AND json_extract(json,'$.status')='proposed' ORDER BY rowid LIMIT 50").all(this.cursor);
   for(const row of rows){this.cursor=Number(row.rowid);const action=this.actions.get(String(row.id));
    if(action.status!=='proposed'||action.managed||action.resolution||action.uncertainty)continue;
    if(['calendar.create','calendar.update'].includes(action.kind)&&(!calendarEventSchema.safeParse(action.event).success||calendarExpired(action.event)))continue;
    if(action.kind!=='calendar.create'&&!action.related)continue;
    // Any fixed proposal or native relation retains its original destination.
    // Unexported proposals may be resolved locally; this never assigns them a device.
    if(action.related?.externalId&&!action.related.target)continue;
    const records=this.actions.read(action.evidence.map(item=>item.id));if(records.length!==action.evidence.length||!records.length)continue;
    const matching=grants.filter(grant=>this.matches(grant,action,records));
    // Overlapping grants never silently choose a different plugin or destination.
    if(matching.length!==1)continue;
    const grant=matching[0];
    if('executionLocation' in grant.target){
     // v1 message sends are always individually confirmed by the owner.
     if(grant.capability.id!=='calendar.manage')continue;
     await this.dispatchAutomatic(action,grant);
    }else{
     const db=this.store.db;db.exec('BEGIN IMMEDIATE');
     try{
      if(!this.capabilities.available(grant))throw new StoreError('Action authorization changed',409);
      const target=action.related?action.related.target:this.grantTarget(grant);
      const confirmed=this.actions.confirm(action.id,{version:action.version,event:action.event,...(target?{target}:{})},true);
      this.actions.bindManaged(action.id,{grantId:grant.id,grantRevision:grant.revision,connectionId:grant.connectionId,state:confirmed.status==='succeeded'?'succeeded':'waiting_device'});db.exec('COMMIT');
     }catch(error){if(db.isTransaction)db.exec('ROLLBACK');if(!(error instanceof StoreError&&[400,403,404,409].includes(error.statusCode)))throw error;}
    }
   }
   if(rows.length<50)this.cursor=0;
  }
  // Owner-confirmed Central actions have no device claim step. The host records
  // the operation before dispatch and never retries an already claimed one.
  await this.dispatchApproved();
 }
 private async dispatchAutomatic(action:ActionProposal,grant:ActionGrant){
  const target=this.grantTarget(grant);if(!isCentralConnectorActionTarget(target)||!this.connectorAction)return;
  const db=this.store.db;db.exec('BEGIN IMMEDIATE');
  let confirmed:ActionProposal;
  try{
   if(!this.capabilities.available(grant))throw new StoreError('Action authorization changed',409);
   confirmed=this.actions.confirm(action.id,{version:action.version,event:action.event,target},true);
   this.actions.bindManaged(action.id,{grantId:grant.id,grantRevision:grant.revision,connectionId:grant.connectionId,state:'executing'});db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');if(!(error instanceof StoreError&&[400,403,404,409].includes(error.statusCode)))throw error;return;}
  await this.dispatch(confirmed);
 }
 private async dispatchApproved(){
  for(const row of this.store.db.prepare("SELECT id FROM action_proposals WHERE json_extract(json,'$.status')='approved' AND json_extract(json,'$.target.executionLocation')='central-connector' ORDER BY rowid LIMIT 20").all() as {id:string}[]){
   const action=this.actions.get(row.id);if(action.status!=='approved'||!action.target||!isCentralConnectorActionTarget(action.target))continue;
   if(action.kind==='message.send'&&!this.capabilities.messageSendGranted(action.target))continue;
   await this.dispatch(action);
  }
 }
 private async dispatch(action:ActionProposal){
  const target=action.target,operationId=action.operationId;
  if(!target||!isCentralConnectorActionTarget(target)||!operationId||!this.connectorAction)return;
  if(action.kind==='message.send'&&!this.capabilities.messageSendGranted(target))return;
  const choice:ActionConnectorChoice|undefined=this.capabilities.centralConnectors().find(value=>this.sameTarget(value.target,target));
  if(!choice)return;
  let claimed:ActionProposal;
  try{claimed=this.actions.connectorClaim(action.id,operationId);}catch{return;}
  try{
   const externalId=action.related?.externalId??action.externalId;
   const receipt=await this.connectorAction({target,request:{capability:choice.capability,operationId,input:{kind:action.kind,event:action.event,target,...(action.message?{message:action.message}:{}),actionId:action.id,...(externalId?{externalId}:{})}}});
   if(receipt.status==='succeeded'&&receipt.externalId){
    this.actions.connectorReceipt(action.id,operationId,{operationId,status:'succeeded',externalId:receipt.externalId});
    if(claimed.managed)this.actions.bindManaged(action.id,{...claimed.managed,state:'succeeded'});
   }else{
    this.actions.connectorReceipt(action.id,operationId,{operationId,status:'uncertain'});
    if(claimed.managed)this.actions.bindManaged(action.id,{...claimed.managed,state:'uncertain'});
   }
  }catch{
   try{this.actions.connectorReceipt(action.id,operationId,{operationId,status:'uncertain'});}catch{/* A retained receipt is not proof of success. */}
   if(claimed.managed){try{this.actions.bindManaged(action.id,{...claimed.managed,state:'uncertain'});}catch{}}
  }
 }
 private own(id:string,credential:ConnectionCredential){
  this.connections.assertActive(credential);const action=this.actions.get(id);
  if(!action.managed||action.managed.connectionId!==credential.id||!action.target||isCentralConnectorActionTarget(action.target)||action.target.deviceId!==credential.deviceId)throw new StoreError('Managed action belongs to another connection',403);
  return action;
 }
 private authorized(action:ActionProposal){
  const meta=action.managed!,grant=this.capabilities.grant(meta.grantId),records=this.actions.read(action.evidence.map(item=>item.id)),target=action.target,related=action.related?.target;
  if(!grant||grant.revision!==meta.grantRevision||!this.capabilities.available(grant)||!target||isCentralConnectorActionTarget(target)||'executionLocation' in grant.target)return false;
  if(target.deviceId!==grant.target.deviceId||target.calendarId!==grant.target.calendarId)return false;
  if(related&&(isCentralConnectorActionTarget(related)||related.deviceId!==grant.target.deviceId||related.calendarId!==grant.target.calendarId))return false;
  return records.length>0&&records.length===action.evidence.length&&records.every(record=>this.actions.current(record.id)&&this.capabilities.inputs.allows(grant,record));
 }
 private atomic<T>(work:()=>T):T{const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
 manualReviewAllowed(credential:ConnectionCredential){return this.connections.isOwner(credential);}
 deliveries(credential:ConnectionCredential){
  this.connections.assertActive(credential);void this.tick().catch(()=>{});
  return this.store.db.prepare("SELECT id FROM action_proposals WHERE json_extract(json,'$.managed.connectionId')=? AND json_extract(json,'$.status') IN ('approved','executing','uncertain') ORDER BY rowid LIMIT 50").all(credential.id).flatMap(row=>{
   const action=this.own(String(row.id),credential);if(action.status==='approved'&&!this.authorized(action))return [];
   // In-flight metadata permits a retained receipt to reach Central after grant withdrawal.
   return [{id:action.id,operationId:action.operationId,state:action.managed!.state}];
  });
 }
 claim(id:string,credential:ConnectionCredential){return this.atomic(()=>{
  const action=this.own(id,credential);
  if(!this.authorized(action)||action.managed!.state==='cancelled'||action.managed!.state==='cancel_requested')throw new StoreError('Action execution authorization is unavailable; only retained receipts may be sent',403);
  const claimed=this.actions.claim(id,credential.deviceId!,true);
  this.actions.bindManaged(id,{...action.managed!,state:claimed.status==='succeeded'?'succeeded':'executing'});
  return {...claimed,managed:{...action.managed!,state:claimed.status==='succeeded'?'succeeded':'executing'},evidence:[],uncertainty:''};
 });}
 receipt(id:string,credential:ConnectionCredential,raw:unknown){return this.atomic(()=>{
  const action=this.own(id,credential),result=this.actions.receipt(id,credential.deviceId!,raw,true);
  const state=result.status==='succeeded'?'succeeded':action.managed!.state==='cancel_requested'?'cancel_requested':'uncertain';
  const updated=this.actions.bindManaged(id,{...action.managed!,state});return {id:updated.id,status:updated.status,managed:updated.managed,operationId:updated.operationId,externalId:updated.externalId};
 });}
 cancel(id:string,version:number){return this.actions.cancelManaged(id,version);}
}
