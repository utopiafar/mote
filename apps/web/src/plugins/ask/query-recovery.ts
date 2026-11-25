import type {Api} from '../../api';
import type {ChatAttachment} from './chat-drafts';
import type {QueryRun} from './QueryProgress';
interface QueryIdentity {
 readonly id:string;
 readonly contextVersion:number;
 readonly conversationId?:string;
 readonly run?:QueryRun;
 readonly unknown:boolean;
}
export interface OwnedQuery extends QueryIdentity {
 readonly kind:'owned';
 readonly body:string;
 readonly question:string;
 readonly attachments:readonly ChatAttachment[];
 readonly draftVersion:number;
}
export interface AdoptedQuery extends QueryIdentity {
 readonly kind:'adopted';
 readonly run:QueryRun;
}
export type PendingQuery=OwnedQuery|AdoptedQuery;
interface OwnerState {pending?:PendingQuery;draftVersion:number;contextVersion:number;listeners:Set<()=>void>}
const owners=new WeakMap<Api,OwnerState>();
function state(api:Api){let value=owners.get(api);if(!value){value={draftVersion:0,contextVersion:0,listeners:new Set()};owners.set(api,value);}return value;}
/** Recovery belongs to the authenticated API. The chat tab can restore its
 * exact retained admission after a reload within the same owner view. */
export const queryRecovery={
 get:(api:Api)=>state(api).pending,
 subscribe:(api:Api,listener:()=>void)=>{const value=state(api);value.listeners.add(listener);return()=>{value.listeners.delete(listener);};},
 set:(api:Api,pending:PendingQuery|undefined)=>{const value=state(api);if(value.pending===pending)return;value.pending=pending;value.listeners.forEach(listener=>listener());},
 draftEdited:(api:Api)=>{state(api).draftVersion++;},
 contextChanged:(api:Api)=>{const value=state(api);value.contextVersion++;value.draftVersion++;},
 versions:(api:Api)=>{const value=state(api);return{draftVersion:value.draftVersion,contextVersion:value.contextVersion};},
 restore:(api:Api,pending:OwnedQuery,versions:{draftVersion:number;contextVersion:number})=>{
  const value=state(api);if(value.pending)return;
  value.draftVersion=versions.draftVersion;value.contextVersion=versions.contextVersion;
  value.pending={...pending,unknown:true};
 },
};
