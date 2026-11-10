import {z} from 'zod';
import {actionCapabilityCommandSchema,actionPluginCapabilityIdentitySchema,type ActionCapabilityDraft} from './action-capabilities.js';

const calendarOperations=z.tuple([z.literal('calendar.create'),z.literal('calendar.update'),z.literal('calendar.cancel'),z.literal('calendar.complete')]);
const calendarConstraints=z.object({writableCalendar:z.literal(true),completeEvent:z.literal(true),currentEvidence:z.literal(true),unexpiredCreatesAndUpdates:z.literal(true),noParticipants:z.literal(true),existingMoteEventsOnly:z.literal(true),sameDeviceCalendar:z.literal(true),completionInMoteOnly:z.literal(true)}).strict();
/** A fixed host adapter contract. Declaring it is never an execution grant. */
export const calendarPluginCapabilitySchema=z.object({
 id:z.literal('calendar.manage'),version:z.literal(1),inputSchema:z.literal('calendar.event.v1'),outputSchema:z.literal('calendar.receipt.v1'),
 operations:calendarOperations,
 executionLocation:z.literal('device'),risk:z.literal('calendar-write'),
 constraints:calendarConstraints,
}).strict();
export type CalendarPluginCapability=z.infer<typeof calendarPluginCapabilitySchema>;
/** A cloud calendar write runs in the enabled Central connector, not on a
 * paired device. It keeps the existing calendar action kinds and safety
 * constraints; only the device-local constraint is replaced by the explicit
 * central-connector execution location. */
export const centralCalendarPluginCapabilitySchema=z.object({
 id:z.literal('calendar.manage'),version:z.literal(1),inputSchema:z.literal('calendar.event.v1'),outputSchema:z.literal('calendar.receipt.v1'),
 operations:calendarOperations,
 executionLocation:z.literal('central-connector'),risk:z.literal('calendar-write'),
 constraints:z.object({writableCalendar:z.literal(true),completeEvent:z.literal(true),currentEvidence:z.literal(true),unexpiredCreatesAndUpdates:z.literal(true),noParticipants:z.literal(true),existingMoteEventsOnly:z.literal(true),completionInMoteOnly:z.literal(true)}).strict(),
}).strict();
export type CentralCalendarPluginCapability=z.infer<typeof centralCalendarPluginCapabilitySchema>;
/** Message sends are always individually confirmed in v1. A grant scopes which
 * sources and connector may propose a send; it never authorizes automatic send. */
export const messageSendPluginCapabilitySchema=z.object({
 id:z.literal('message.send'),version:z.literal(1),inputSchema:z.literal('message.send.v1'),outputSchema:z.literal('message.receipt.v1'),
 operations:z.tuple([z.literal('message.send')]),
 executionLocation:z.literal('central-connector'),risk:z.literal('message-send'),
 constraints:z.object({confirmsEveryMessage:z.literal(true),currentEvidence:z.literal(true)}).strict(),
}).strict();
export type MessageSendPluginCapability=z.infer<typeof messageSendPluginCapabilitySchema>;
export const actionPluginCapabilitySchema=z.union([calendarPluginCapabilitySchema,centralCalendarPluginCapabilitySchema,messageSendPluginCapabilitySchema]);
export type ActionPluginCapability=z.infer<typeof actionPluginCapabilitySchema>;
export const actionPluginIdentitySchema=z.object({packageId:z.string().min(1).max(300),releaseDigest:z.string().regex(/^[a-f0-9]{64}$/),instanceId:z.string().min(1).max(128),instanceRevision:z.number().int().positive(),capabilityDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ActionPluginIdentity=z.infer<typeof actionPluginIdentitySchema>;
export type ActionPluginProvider={identity:ActionPluginIdentity;name:string;capability:ActionPluginCapability};
export const actionGrantCommandSchema=actionCapabilityCommandSchema.extend({id:z.string().uuid(),draftId:z.string().uuid(),draftRevision:z.number().int().positive(),plugin:actionPluginIdentitySchema,acknowledgeCalendarWrites:z.literal(true).optional(),acknowledgeMessageSends:z.literal(true).optional()}).strict().superRefine((value,context)=>{
 if(!value.acknowledgeCalendarWrites&&!value.acknowledgeMessageSends)context.addIssue({code:'custom',message:'Acknowledge the action write scope'});
});
export type ActionGrant=Omit<ActionCapabilityDraft,'id'|'state'|'executionEnabled'>&{id:string;draftId:string;draftRevision:number;plugin:ActionPluginIdentity;connectionId:string;inputCursor:number;state:'active'|'revoked';executionEnabled:boolean};
