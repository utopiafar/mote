import {randomUUID} from 'node:crypto';
import {calendarEventSchema,currentCalendarProposalSchema,type ActionConnectorChoice,type ActionPluginProvider,type CentralConnectorActionTarget,type ActionProposal,type CurrentActionReference,type CurrentCalendarProposal} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import type {Actions} from './actions.js';
import type {ConversationRepository} from './plugins/central-contracts.js';
import {currentInstructionHash} from './assistant-current-instruction.js';
import {canonicalRecipeJson} from './recipe-contract.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {sha256,StoreError,type Store} from './store.js';

type History=NonNullable<QueryInput['historyContext']>;
type OfferedTarget={id:string;choice:ActionConnectorChoice;identity:ActionPluginProvider['identity'];change?:{kind:'calendar.update'|'calendar.cancel';original:NonNullable<ActionProposal['related']>}};
type OwnerMessage=ReturnType<OwnerCalendarAuthority['conversations']['message']>;
type OwnerReceipt={
 messageId:string;conversationId:string;inputHash:string;actionId:string;
 targets:OfferedTarget[];sourceIds?:string[];
 phase:'offered'|'proposed'|'accepted';
 proposal?:CurrentCalendarProposal;payloadHash?:string;runId?:string;operationId?:string;
 history?:History;
};
export type OwnerCalendarAuthority={
 conversations:Pick<ConversationRepository,'message'|'page'|'historyContext'>;
 assertContext:(input:QueryInput)=>void;
};
export interface OwnerCalendarPort {
 offerOwnerCalendar(messageId:string,sourceIds?:readonly string[]):NonNullable<QueryInput['ownerActionTargets']>;
 proposeOwnerCalendar(messageId:string,proposal:CurrentCalendarProposal,runId:string):CurrentActionReference;
 acceptOwnerCalendar(messageId:string,reference:CurrentActionReference,runId:string):CurrentActionReference;
 wakeOwnerCalendar(id:string):void;
}
const key=(id:string)=>'owner-calendar:'+id;
const payloadHash=(action:Pick<ActionProposal,'kind'|'event'|'target'|'related'>)=>sha256(canonicalRecipeJson({kind:action.kind,event:action.event,target:action.target,...(action.related?{related:action.related}:{})}));

/** One current owner message can authorize one exact existing Action. Offers
 * and semantic proposals are private preparation, never executable grants. */
export class OwnerCalendarInstructions {
 constructor(private store:Store,private actions:Actions,private authority:OwnerCalendarAuthority,private targetIdentity:(target:CentralConnectorActionTarget)=>ActionPluginProvider['identity']|undefined){}
 private read(messageId:string){const row=this.store.db.prepare('SELECT json FROM action_meta WHERE key=?').get(key(messageId));return row?decodeMemoryPrivate<OwnerReceipt>(this.store,JSON.parse(String(row.json)).private):undefined;}
 private save(receipt:OwnerReceipt){this.store.db.prepare('INSERT INTO action_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key(receipt.messageId),JSON.stringify({private:encodeMemoryPrivate(this.store,receipt)}));}
 private atomic<T>(work:()=>T){const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=work();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
 private message(receipt:OwnerReceipt){
  const message=this.authority.conversations.message(receipt.messageId);
  if(message.conversationId!==receipt.conversationId||currentInstructionHash(message)!==receipt.inputHash||message.attachments?.length||message.evidenceDeleted||message.evidenceStale||message.evidenceUnavailable||message.supersededBy?.length||message.amendedBy?.length)throw new StoreError('Current owner action input is no longer available',409);
  return message;
 }
 private originalSnapshot(action:ActionProposal):NonNullable<ActionProposal['related']>{return {actionId:action.id,version:action.version,status:action.status,event:structuredClone(action.event),target:action.target,externalId:action.externalId,operationId:action.nativeOperationId};}
 private originalCurrent(action:ActionProposal,message:OwnerMessage){
  if(action.kind!=='calendar.create'||action.status!=='succeeded'||action.resolution||action.evidence.length||!action.externalId||!action.nativeOperationId||action.ownerInstruction?.conversationId!==message.conversationId)return false;
  const receipt=this.read(action.ownerInstruction.messageId);if(!receipt||receipt.actionId!==action.id)return false;
  const original=this.message(receipt);if(canonicalRecipeJson(original.scope)!==canonicalRecipeJson(message.scope))return false;
  this.assertAccepted(receipt);return true;
 }
 private targets(message:OwnerMessage){
  const targets=this.actions.connectorTargets().filter(choice=>choice.capability.id==='calendar.manage'&&choice.capability.version===1).slice(0,20).flatMap(choice=>{const identity=this.targetIdentity(choice.target);return identity?[{id:randomUUID(),choice:structuredClone(choice),identity:structuredClone(identity)}] as OfferedTarget[]:[];});
  if(!targets.length)return targets;
  // Read current-owner metadata only. Actions.list validates archived proof;
  // offering these private events must not open any original evidence reader.
  const rows=this.store.db.prepare("SELECT p.json FROM action_proposals p WHERE json_extract(p.json,'$.kind')='calendar.create' AND json_extract(p.json,'$.status')='succeeded' AND json_extract(p.json,'$.ownerInstruction.conversationId')=? AND json_extract(p.json,'$.resolution') IS NULL AND json_array_length(p.json,'$.evidence')=0 AND NOT EXISTS(SELECT 1 FROM action_proposals c WHERE json_extract(c.json,'$.related.actionId')=p.id AND json_extract(c.json,'$.status') IN ('approved','executing','uncertain')) ORDER BY p.rowid DESC LIMIT 200").all(message.conversationId);
  // Keep the existing Actions catalog's eight-item / 24 KB model context bound.
  let count=0,bytes=0;
  for(const row of rows){
   if(count>=8)break;const action=JSON.parse(String(row.json)) as ActionProposal;
   try{
    if(!this.originalCurrent(action,message))continue;
    const target=targets.find(target=>!target.change&&canonicalRecipeJson(target.choice.target)===canonicalRecipeJson(action.target));if(!target)continue;
    calendarEventSchema.parse(action.event);
    for(const kind of ['calendar.update','calendar.cancel'] as const){
     if(count>=8)continue;
     const next:OfferedTarget={id:randomUUID(),choice:structuredClone(target.choice),identity:structuredClone(target.identity),change:{kind,original:this.originalSnapshot(action)}};
     const size=Buffer.byteLength(JSON.stringify(this.targetView(next)));if(bytes+size>24000)continue;
     targets.push(next);bytes+=size;count++;
    }
   }catch{/* A withdrawn original supplies neither text nor a change target. */}
  }
  return targets;
 }
 private targetView(target:OfferedTarget):NonNullable<QueryInput['ownerActionTargets']>[number]{return {id:target.id,name:target.change?target.choice.name+' · '+target.change.original.event.title:target.choice.name,kind:target.change?.kind??'calendar.create',...(target.change?{event:calendarEventSchema.parse(target.change.original.event)}:{})};}
 offer(messageId:string,sourceIds?:readonly string[]){return this.atomic(()=>{
  const message=this.authority.conversations.message(messageId);if(message.status!=='running'||message.attachments?.length)throw new StoreError('A current owner message is required',409);
  let receipt=this.read(messageId);
  if(!receipt){receipt={messageId,conversationId:message.conversationId,inputHash:currentInstructionHash(message),actionId:randomUUID(),phase:'offered',...(sourceIds?{sourceIds:[...sourceIds]}:{}),targets:this.targets(message)};this.save(receipt);}
  this.message(receipt);
  // Reuse the original exact snapshot. A changed/re-enabled instance cannot
  // inherit its former opaque target or an accepted single-use authorization.
  return receipt.targets.filter(target=>this.targetCurrent(target,message)).map(target=>this.targetView(target));
 });}
 private targetCurrent(target:OfferedTarget,message:OwnerMessage){
  const identity=this.targetIdentity(target.choice.target);
  if(!identity||canonicalRecipeJson(identity)!==canonicalRecipeJson(target.identity)||!this.actions.connectorTargets().some(current=>canonicalRecipeJson(current)===canonicalRecipeJson(target.choice)))return false;
  if(!target.change)return true;
  try{const row=this.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(target.change.original.actionId);if(!row)return false;const original=JSON.parse(String(row.json)) as ActionProposal;return this.originalCurrent(original,message)&&canonicalRecipeJson(this.originalSnapshot(original))===canonicalRecipeJson(target.change.original);}catch{return false;}
 }
 propose(messageId:string,raw:CurrentCalendarProposal,runId:string){return this.atomic(()=>{
  const proposal=currentCalendarProposalSchema.parse(raw),receipt=this.read(messageId);if(!receipt)throw new StoreError('Current owner calendar offer is missing',409);
  const message=this.message(receipt),target=receipt.targets.find(value=>value.id===proposal.action.targetId);if(message.status!=='running'||!target||proposal.action.kind!==(target.change?.kind??'calendar.create')||!this.targetCurrent(target,message))throw new StoreError('Current owner calendar target changed',409);
  if(proposal.action.kind==='calendar.cancel'&&canonicalRecipeJson(proposal.action.event)!==canonicalRecipeJson(target.change!.original.event))throw new StoreError('Cancellation must retain its original calendar event',409);
  const hash=payloadHash({kind:proposal.action.kind,event:proposal.action.event,target:target.choice.target,...(target.change?{related:target.change.original}:{})});
  if(receipt.payloadHash&&receipt.payloadHash!==hash)throw new StoreError('The owner message already selected a different Action payload',409);
  if(receipt.phase!=='accepted'){receipt.proposal=proposal;receipt.payloadHash=hash;receipt.runId=runId;receipt.phase='proposed';this.save(receipt);}
  return {id:receipt.actionId,kind:proposal.action.kind};
 });}
 accept(messageId:string,reference:CurrentActionReference,runId:string){
  if(!this.store.db.isTransaction)throw new StoreError('Owner Action acceptance requires the query commit transaction',409);
  const receipt=this.read(messageId);if(!receipt||receipt.actionId!==reference.id||!receipt.proposal||reference.kind!==receipt.proposal.action.kind||receipt.runId!==runId)throw new StoreError('Current owner Action proposal changed',409);
  const message=this.message(receipt);if(message.status!=='completed'||message.result?.runId!==runId||message.result.currentAction?.id!==reference.id)throw new StoreError('Owner Action requires its accepted current message',409);
  if(receipt.phase==='accepted')return reference;
  const target=receipt.targets.find(value=>value.id===receipt.proposal!.action.targetId);if(!target||!this.targetCurrent(target,message))throw new StoreError('Current owner calendar target changed',409);
  // Pin this turn through the owner's canonical visible projection, which
  // omits private routing/control fields and retains inherited Memory/raw roles.
  const conversation=this.authority.conversations.page(message.conversationId,{anchor:message.id,limit:1}),turn=conversation.turns.find(value=>value.id===message.id);
  if(!turn||turn.evidenceDeleted||turn.evidenceStale||turn.evidenceUnavailable)throw new StoreError('Current owner Action context changed',409);
  receipt.history=this.authority.conversations.historyContext(conversation,[turn]);
  receipt.phase='accepted';this.save(receipt);this.assertAccepted(receipt);
  const action=this.actions.proposeCurrentCalendar(receipt.actionId,receipt.proposal.action.event,target.choice.target,{conversationId:message.conversationId,messageId},target.change);
  const confirmed=this.actions.confirm(action.id,{version:action.version,event:action.event,target:action.target});receipt.operationId=confirmed.operationId;this.save(receipt);return reference;
 }
 private assertAccepted(receipt:OwnerReceipt){
  const message=this.message(receipt);if(receipt.phase!=='accepted'||message.status!=='completed'||!receipt.history||!message.result||message.result.runId!==receipt.runId||message.result.currentAction?.id!==receipt.actionId)throw new StoreError('Owner Action authorization is unavailable',409);
  this.authority.assertContext({question:'',executionLane:'interactive',historyContext:receipt.history,contextEvidenceDependencies:receipt.history.evidenceDependencies,contextSourceContextDependencies:message.result.sourceContextDependencies,...(receipt.sourceIds?{sourceIds:receipt.sourceIds}:{})} as QueryInput);
 }
 current(action:ActionProposal){
  if(!action.ownerInstruction)return false;
  try{const receipt=this.read(action.ownerInstruction.messageId);if(!receipt||receipt.actionId!==action.id||receipt.conversationId!==action.ownerInstruction.conversationId||receipt.proposal?.action.kind!==action.kind||action.evidence.length||payloadHash(action)!==receipt.payloadHash||receipt.operationId&&receipt.operationId!==action.operationId)return false;
   this.assertAccepted(receipt);const target=receipt.targets.find(value=>value.id===receipt.proposal!.action.targetId);return Boolean(target&&this.targetCurrent(target,this.message(receipt)));
  }catch{return false;}
 }
 accepted(id:string){const row=this.store.db.prepare('SELECT json FROM action_proposals WHERE id=?').get(id);if(!row)return false;const action=JSON.parse(String(row.json)) as ActionProposal;return action.status==='approved'&&this.current(action);}
 /** A former process cannot know the result of a claimed effect. Retain its
  * operation identity and expose uncertainty; never turn it back into queued. */
 recover(){for(const row of this.store.db.prepare("SELECT id,json FROM action_proposals WHERE json_type(json,'$.ownerInstruction')='object' AND json_extract(json,'$.status')='executing'").iterate()){const action=JSON.parse(String(row.json)) as ActionProposal;if(action.operationId)this.actions.connectorReceipt(String(row.id),action.operationId,{operationId:action.operationId,status:'uncertain'});}}
}
