import {calendarEventSchema,calendarExpired,type ActionProposal} from '@mote/shared';
import {Store,StoreError} from './store.js';
import type {Actions} from './actions.js';
import type {ActionCapabilities} from './action-capabilities.js';
import type {Connections,ConnectionCredential} from './connections.js';

/** Central dispatches only validated proposals; models cannot create grants or choose authority. */
export class ManagedCalendar {
 private cursor=0;
 constructor(private store:Store,private actions:Actions,private capabilities:ActionCapabilities,private connections:Connections){}
 tick(){
  const grants=this.capabilities.grants().filter(grant=>this.capabilities.available(grant));if(!grants.length)return;
  const rows=this.store.db.prepare("SELECT rowid,id FROM action_proposals WHERE rowid>? AND json_extract(json,'$.status')='proposed' ORDER BY rowid LIMIT 50").all(this.cursor);
  for(const row of rows){this.cursor=Number(row.rowid);const action=this.actions.get(String(row.id));
   if(action.status!=='proposed'||action.managed||action.resolution||action.uncertainty)continue;
   if(['calendar.create','calendar.update'].includes(action.kind)&&(!calendarEventSchema.safeParse(action.event).success||calendarExpired(action.event)))continue;
   if(action.kind!=='calendar.create'&&!action.related)continue;
   // A native relation can only use its original destination. Unexported
   // proposals may be resolved locally; this never assigns them a device.
   if(action.related?.externalId&&!action.related.target)continue;
   const records=this.actions.read(action.evidence.map(item=>item.id));if(records.length!==action.evidence.length||!records.length)continue;
   const matching=grants.filter(grant=>(!action.related?.target||action.related.target.deviceId===grant.target.deviceId&&action.related.target.calendarId===grant.target.calendarId)&&records.every(record=>this.capabilities.inputs.allows(grant,record)));
   // Overlapping grants never silently choose a different plugin or destination.
   if(matching.length!==1)continue;
   const grant=matching[0],db=this.store.db;db.exec('BEGIN IMMEDIATE');
   try{
    if(!this.capabilities.available(grant))throw new StoreError('Action authorization changed',409);
    const target=action.related?action.related.target:{deviceId:grant.target.deviceId,calendarId:grant.target.calendarId};
    const confirmed=this.actions.confirm(action.id,{version:action.version,event:action.event,...(target?{target}:{})},true);
    this.actions.bindManaged(action.id,{grantId:grant.id,grantRevision:grant.revision,connectionId:grant.connectionId,state:confirmed.status==='succeeded'?'succeeded':'waiting_device'});db.exec('COMMIT');
   }catch(error){if(db.isTransaction)db.exec('ROLLBACK');if(!(error instanceof StoreError&&[400,403,404,409].includes(error.statusCode)))throw error;}
  }
  if(rows.length<50)this.cursor=0;
 }
 private own(id:string,credential:ConnectionCredential){
  this.connections.assertActive(credential);const action=this.actions.get(id);
  if(!action.managed||action.managed.connectionId!==credential.id||action.target?.deviceId!==credential.deviceId)throw new StoreError('Managed action belongs to another connection',403);
  return action;
 }
 private authorized(action:ActionProposal){const meta=action.managed!,grant=this.capabilities.grant(meta.grantId),records=this.actions.read(action.evidence.map(item=>item.id));return !!grant&&grant.revision===meta.grantRevision&&this.capabilities.available(grant)&&action.target?.deviceId===grant.target.deviceId&&action.target.calendarId===grant.target.calendarId&&(!action.related||action.related.target?.deviceId===grant.target.deviceId&&action.related.target.calendarId===grant.target.calendarId)&&records.length>0&&records.length===action.evidence.length&&records.every(record=>this.actions.current(record.id)&&this.capabilities.inputs.allows(grant,record));}
 private atomic<T>(work:()=>T):T{const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
 manualReviewAllowed(credential:ConnectionCredential){return this.connections.isOwner(credential);}
 deliveries(credential:ConnectionCredential){
  this.connections.assertActive(credential);this.tick();
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
