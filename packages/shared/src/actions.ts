import { moteText } from './i18n.js';
import {z} from 'zod';
export const actionZone=z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Invalid time zone');
const date=z.string().max(64).refine(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)?Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v:z.string().datetime({offset:true}).safeParse(v).success,'Invalid date');
export const calendarDraftSchema=z.object({title:z.string().trim().min(1).max(200),start:date.nullable(),end:date.nullable(),timeZone:actionZone.nullable(),allDay:z.boolean(),location:z.string().max(1000),description:z.string().max(2000)}).strict();
export type CalendarDraft=z.infer<typeof calendarDraftSchema>;
export const calendarEventSchema=calendarDraftSchema.superRefine((e,c)=>{
  if(!e.start||!e.end||!e.timeZone){c.addIssue({code:'custom',message:'请补充开始、结束时间和时区'});return;}
  if(e.allDay!==/^\d{4}-\d{2}-\d{2}$/.test(e.start)||e.allDay!==/^\d{4}-\d{2}-\d{2}$/.test(e.end))c.addIssue({code:'custom',message:'全天日期和具体时间不能混用'});
  if(Date.parse(e.end)<=Date.parse(e.start)||Date.parse(e.end)-Date.parse(e.start)>366*86400000)c.addIssue({code:'custom',message:'结束时间必须晚于开始时间，且跨度不超过一年'});
});
export const calendarChoiceSchema=z.object({id:z.string().min(1).max(1000),title:z.string().min(1).max(200)}).strict();
export type CalendarChoice=z.infer<typeof calendarChoiceSchema>;
export type ActionStatus='proposed'|'dismissed'|'approved'|'executing'|'succeeded'|'uncertain'|'stale';
export interface ActionEvidence {id:string;quote:string;fingerprint:string;source:string;capturedAt:string}
export const messageSendDraftSchema=z.object({conversationId:z.string().min(1).max(200),conversationName:z.string().trim().max(200).optional(),text:z.string().trim().min(1).max(40000)}).strict();
export type MessageSendDraft=z.infer<typeof messageSendDraftSchema>;
/** Current local Todo input, shared by the owner editor and assistant drafts. */
export const todoInputSchema=z.object({id:z.string().uuid().optional(),title:z.string().trim().min(1).max(200),description:z.string().max(4000).default(''),dueAt:z.string().datetime({offset:true}).nullable().default(null),evidenceIds:z.array(z.string().uuid()).max(30).default([])}).strict();
export type ActionKind='calendar.create'|'calendar.update'|'calendar.cancel'|'calendar.complete'|'message.send';
/** The legacy device-calendar target keeps its exact `{deviceId,calendarId}`
 * shape. A central connector target is a separate, explicitly located shape. */
export const deviceActionProposalTargetSchema=z.object({deviceId:z.string().min(1).max(200),calendarId:z.string().min(1).max(1000)}).strict();
/** A built-in cloud calendar provider adds one explicit calendar identity to
 * the existing Central target. Installed fixture-style connectors keep their
 * exact historical shape by omitting this field. */
export const centralConnectorActionTargetSchema=z.object({executionLocation:z.literal('central-connector'),packageId:z.string().min(1).max(300),instanceId:z.string().min(1).max(128),instanceRevision:z.number().int().positive(),capabilityId:z.string().min(1).max(128),capabilityVersion:z.number().int().positive(),calendarId:z.string().min(1).max(1000).optional()}).strict();
export const actionProposalTargetSchema=z.union([deviceActionProposalTargetSchema,centralConnectorActionTargetSchema]);
export type DeviceActionProposalTarget=z.infer<typeof deviceActionProposalTargetSchema>;
export type CentralConnectorActionTarget=z.infer<typeof centralConnectorActionTargetSchema>;
export type ActionProposalTarget=z.infer<typeof actionProposalTargetSchema>;
export const isCentralConnectorActionTarget=(value:ActionProposalTarget|undefined):value is CentralConnectorActionTarget=>Boolean(value&&'executionLocation' in value&&value.executionLocation==='central-connector');
export interface ActionConnectorChoice {name:string;capability:{id:string;version:number};target:CentralConnectorActionTarget}
export interface ConnectorActionExecution {capability:{id:string;version:number};operationId:string;input:{kind:ActionKind;event:CalendarDraft;target:ActionProposalTarget;message?:MessageSendDraft;actionId?:string;externalId?:string}}
export interface ConnectorActionReceipt {status:'succeeded'|'uncertain';externalId?:string}
export interface ActionRelation {operationId?:string;actionId:string;version:number;status:ActionStatus;event:CalendarDraft;target?:ActionProposalTarget;externalId?:string}
export type ManagedActionState='waiting_device'|'executing'|'cancel_requested'|'cancelled'|'succeeded'|'uncertain';
export interface ManagedAction {cancelRequestedAt?:string;grantId:string;grantRevision:number;connectionId:string;state:ManagedActionState}
export interface ActionProposal {managed?:ManagedAction;id:string;kind:ActionKind;related?:ActionRelation;resolution?:'cancelled'|'completed';version:number;status:ActionStatus;event:CalendarDraft;message?:MessageSendDraft;uncertainty:string;evidence:ActionEvidence[];createdAt:string;updatedAt:string;operationId?:string;nativeOperationId?:string;target?:ActionProposalTarget;externalId?:string;error?:string}
export interface ActionSettings {enabled:boolean;timeZone:string;reviewDeviceIds:string[]}
export interface ActionTarget {deviceId:string;deviceName:string;calendars:CalendarChoice[];updatedAt:string}
export const moteActionMarker=(id:string)=>`[Mote:${z.string().uuid().parse(id)}]`;
export function calendarDescription(action:Pick<ActionProposal,'id'|'event'|'related'|'operationId'>):string{return moteText("{0}\n\n#Mote · 由 Mote 创建\n{1}", action.event.description, moteActionMarker(action.related?.actionId??action.id)+(action.operationId?`\n[Mote-operation:${action.operationId}]`:'')).trim();}

/** Lossless structural projection for model evidence; no semantic routing or classification. */
export function actionEvidenceText(record:{ocrText?:string;metadata?:{notification?:{title?:string;text?:string;bigText?:string;subText?:string;textLines?:string[]}}}):string {
 const n=record.metadata?.notification;
 return record.ocrText?.trim()?record.ocrText:n?[n.title,n.text,n.bigText,n.subText,...(n.textLines??[])].filter(v=>typeof v==='string'&&v.length>0).join('\n'):record.ocrText??'';
}

/** Render a wall clock in an explicitly chosen IANA zone, independent of the host zone. */
export function calendarWallTime(instant:string,zone:string):string {
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
 return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
/** DST gaps/overlaps require an explicit resolution; never silently shift an appointment. */
export function calendarInstant(wall:string,zone:string):string {
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(wall))throw Error('请选择完整的日期和时间');
 const normalized=wall.length===16?wall+':00':wall,naive=Date.parse(normalized+'Z');if(!Number.isFinite(naive))throw Error('日期无效');
 const candidates=new Set<string>();
 for(const shift of [-36,-24,-12,0,12,24,36]){const sample=naive+shift*3600000;const offset=Date.parse(calendarWallTime(new Date(sample).toISOString(),zone)+'Z')-sample;const candidate=new Date(naive-offset).toISOString();if(calendarWallTime(candidate,zone)===normalized)candidates.add(candidate);}
 if(candidates.size!==1)throw Error('此时间处于夏令时切换的缺失或重复区间，请换用 UTC 时区明确时间');
 return [...candidates][0];
}

/** Expiration uses explicit timestamps only; unresolved dates remain a human decision. */
export function calendarExpired(event:CalendarDraft,now=Date.now()):boolean {
 const value=event.end??event.start;if(!value)return false;
 try{const at=event.allDay?(event.timeZone?Date.parse(calendarInstant(value+'T00:00',event.timeZone)):NaN):Date.parse(value);return Number.isFinite(at)&&at<=now;}catch{return false;}
}
