import {z} from 'zod';
import {actionCapabilityCommandSchema,type ActionCapabilityDraft} from './action-capabilities.js';

/** A fixed host adapter contract. Declaring it is never an execution grant. */
export const calendarPluginCapabilitySchema=z.object({
 id:z.literal('calendar.create'),version:z.literal(1),inputSchema:z.literal('calendar.event.v1'),outputSchema:z.literal('calendar.receipt.v1'),
 executionLocation:z.literal('device'),risk:z.literal('calendar-write'),
 constraints:z.object({writableCalendar:z.literal(true),completeEvent:z.literal(true),currentEvidence:z.literal(true),unexpiredEvent:z.literal(true),noParticipants:z.literal(true),noUpdates:z.literal(true),noDeletes:z.literal(true)}).strict(),
}).strict();
export type CalendarPluginCapability=z.infer<typeof calendarPluginCapabilitySchema>;
export const actionPluginIdentitySchema=z.object({packageId:z.string().min(1).max(300),releaseDigest:z.string().regex(/^[a-f0-9]{64}$/),instanceId:z.string().min(1).max(128),instanceRevision:z.number().int().positive(),capabilityDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ActionPluginIdentity=z.infer<typeof actionPluginIdentitySchema>;
export type ActionPluginProvider={identity:ActionPluginIdentity;name:string;capability:CalendarPluginCapability};
export const actionGrantCommandSchema=actionCapabilityCommandSchema.extend({id:z.string().uuid(),draftId:z.string().uuid(),draftRevision:z.number().int().positive(),plugin:actionPluginIdentitySchema,acknowledgeCalendarWrites:z.literal(true)}).strict();
export type ActionGrant=Omit<ActionCapabilityDraft,'id'|'state'|'executionEnabled'>&{id:string;draftId:string;draftRevision:number;plugin:ActionPluginIdentity;connectionId:string;inputCursor:number;state:'active'|'revoked';executionEnabled:boolean};
