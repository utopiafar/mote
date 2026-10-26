import {z} from 'zod';
import {calendarChoiceSchema} from './actions.js';

/** A declaration describes an implementation. It never authorizes execution. */
export const calendarCreateCapability={id:'calendar.create',version:1,invitesParticipants:false,updatesEvents:false,cancelsEvents:false,deletesEvents:false} as const;
const identity=z.string().min(1).max(128);
export const actionCapabilityCommandSchema=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export const actionDeviceDeclarationSchema=actionCapabilityCommandSchema.extend({deviceId:identity,capability:z.object({id:z.literal('calendar.create'),version:z.literal(1)}).strict(),permission:z.enum(['granted','required','unavailable']),calendars:z.array(calendarChoiceSchema).max(200)}).strict().superRefine((value,context)=>{
 if(new Set(value.calendars.map(item=>item.id)).size!==value.calendars.length)context.addIssue({code:'custom',message:'Calendar identities must be unique'});
 if(value.permission!=='granted'&&value.calendars.length)context.addIssue({code:'custom',message:'Unavailable calendars cannot be declared writable'});
});
export const actionSourceIdentitySchema=z.object({sourceId:identity,kind:z.string().min(1).max(200),deviceId:identity,platform:z.enum(['macos','windows','linux','android','import'])}).strict();
export const actionCapabilityDraftSchema=actionCapabilityCommandSchema.extend({id:z.string().uuid(),capability:z.object({id:z.literal('calendar.create'),version:z.literal(1)}).strict(),target:z.object({deviceId:identity,calendarId:z.string().min(1).max(1000),declarationRevision:z.number().int().positive()}).strict(),inputs:z.object({sources:z.array(actionSourceIdentitySchema).min(1).max(100),existingArchived:z.boolean(),futureInputs:z.boolean()}).strict()}).strict().superRefine((value,context)=>{
 if(!value.inputs.existingArchived&&!value.inputs.futureInputs)context.addIssue({code:'custom',message:'Choose existing archived inputs, future inputs, or both'});
 if(new Set(value.inputs.sources.map(item=>item.sourceId)).size!==value.inputs.sources.length)context.addIssue({code:'custom',message:'Source identities must be unique'});
});
export type ActionDeviceDeclaration=z.infer<typeof actionDeviceDeclarationSchema>;
export type ActionCapabilityDraftInput=z.infer<typeof actionCapabilityDraftSchema>;
export type ActionCapabilityDraft=Omit<ActionCapabilityDraftInput,'operationId'|'expectedRevision'>&{revision:number;state:'draft'|'revoked';executionEnabled:false;createdAt:string;updatedAt:string};
export type ActionDeviceCapability=Omit<ActionDeviceDeclaration,'operationId'|'expectedRevision'>&{revision:number;connectionId:string;declaredAt:string;connectionActive:boolean};
