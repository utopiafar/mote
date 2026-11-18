import type {QueryInput} from '@mote/agent';
import {calendarEventSchema,type ActionStatus,type CalendarDraft} from '@mote/shared';
import {z} from 'zod';

export const externalCalendarRequestId=z.string().uuid().toLowerCase().describe('One stable UUID for this current user request. Keep it for retries and receipt lookup.');
export const externalCalendarCreateSchema=z.object({
  requestId:externalCalendarRequestId,
  instruction:z.string().min(1).max(12000).refine(text=>Boolean(text.trim())).describe('The latest user message verbatim, including any quotation boundaries. Use it only when the user explicitly requests creation now.'),
  event:calendarEventSchema.describe('One complete event. Timed events use ISO timestamps with offsets. All-day events use dates and an exclusive end date. Supply an IANA time zone and empty strings for omitted location or description.'),
}).strict();
export type ExternalCalendarCreate=z.infer<typeof externalCalendarCreateSchema>;
export type ExternalCalendarContext=Required<Pick<QueryInput,'openingMemories'|'contextEvidenceDependencies'>>;
export type ExternalCalendarReview=(input:{
  instruction:string;
  event:CalendarDraft;
  calendarName:string;
  signal:AbortSignal;
  assertCurrent:()=>void;
})=>Promise<ExternalCalendarContext|undefined>;

export interface ExternalCalendarReceipt {
  requestId:string;
  actionId:string;
  operationId:string;
  status:ActionStatus;
  externalId?:string;
}

export interface ExternalCalendarPort {
  target(connectionId:string):{calendarName:string;available:boolean};
  create(connectionId:string,input:ExternalCalendarCreate,signal:AbortSignal):Promise<ExternalCalendarReceipt>;
  receipt(connectionId:string,requestId:string):ExternalCalendarReceipt;
}
