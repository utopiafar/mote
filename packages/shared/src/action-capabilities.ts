import {z} from 'zod';
import {calendarChoiceSchema,centralConnectorActionTargetSchema,deviceActionProposalTargetSchema} from './actions.js';
import {platformSchema} from './sources.js';

/** A declaration describes an implementation. It never authorizes execution. */
export const calendarManageCapability={id:'calendar.manage',version:1,operations:['calendar.create','calendar.update','calendar.cancel','calendar.complete'],invitesParticipants:false,updatesEvents:true,cancelsEvents:true,completesInMote:true,existingMoteEventsOnly:true,sameDeviceCalendar:true} as const;
export const calendarCapabilityIdentitySchema=z.object({id:z.literal('calendar.manage'),version:z.literal(1)}).strict();
export const actionPluginCapabilityIdentitySchema=z.object({id:z.enum(['calendar.manage','message.send']),version:z.literal(1)}).strict();
export type ActionPluginCapabilityIdentity=z.infer<typeof actionPluginCapabilityIdentitySchema>;
export const deviceActionCapabilityTargetSchema=deviceActionProposalTargetSchema.extend({declarationRevision:z.number().int().positive()}).strict();
export const centralConnectorActionCapabilityTargetSchema=centralConnectorActionTargetSchema;
export const actionCapabilityTargetSchema=z.union([deviceActionCapabilityTargetSchema,centralConnectorActionCapabilityTargetSchema]);
export type ActionCapabilityTarget=z.infer<typeof actionCapabilityTargetSchema>;
const identity=z.string().min(1).max(128);
export const actionCapabilityCommandSchema=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export const actionDeviceDeclarationSchema=actionCapabilityCommandSchema.extend({deviceId:identity,capability:calendarCapabilityIdentitySchema,permission:z.enum(['granted','required','unavailable']),calendars:z.array(calendarChoiceSchema).max(200)}).strict().superRefine((value,context)=>{
 if(new Set(value.calendars.map(item=>item.id)).size!==value.calendars.length)context.addIssue({code:'custom',message:'Calendar identities must be unique'});
 if(value.permission!=='granted'&&value.calendars.length)context.addIssue({code:'custom',message:'Unavailable calendars cannot be declared writable'});
});
export const actionSourceIdentitySchema=z.object({sourceId:identity,kind:z.string().min(1).max(200),deviceId:identity,platform:platformSchema}).strict();
export const actionCapabilityDraftSchema=actionCapabilityCommandSchema.extend({id:z.string().uuid(),capability:actionPluginCapabilityIdentitySchema,target:actionCapabilityTargetSchema,inputs:z.object({sources:z.array(actionSourceIdentitySchema).min(1).max(100),existingArchived:z.boolean(),futureInputs:z.boolean()}).strict()}).strict().superRefine((value,context)=>{
 if('executionLocation' in value.target){
  if(value.target.capabilityId!==value.capability.id||value.target.capabilityVersion!==value.capability.version)context.addIssue({code:'custom',message:'Connector target must match the declared action capability'});
 }else if(!calendarCapabilityIdentitySchema.safeParse(value.capability).success)context.addIssue({code:'custom',message:'A device target requires the device calendar capability'});
 if(!value.inputs.existingArchived&&!value.inputs.futureInputs)context.addIssue({code:'custom',message:'Choose existing archived inputs, future inputs, or both'});
 if(new Set(value.inputs.sources.map(item=>item.sourceId)).size!==value.inputs.sources.length)context.addIssue({code:'custom',message:'Source identities must be unique'});
});
export type ActionDeviceDeclaration=z.infer<typeof actionDeviceDeclarationSchema>;
export type ActionCapabilityDraftInput=z.infer<typeof actionCapabilityDraftSchema>;
export type ActionCapabilityDraft=Omit<ActionCapabilityDraftInput,'operationId'|'expectedRevision'>&{revision:number;state:'draft'|'revoked';executionEnabled:false;createdAt:string;updatedAt:string};
export type ActionDeviceCapability=Omit<ActionDeviceDeclaration,'operationId'|'expectedRevision'>&{revision:number;connectionId:string;declaredAt:string;connectionActive:boolean};

/** Device-published capability facts. `grant` is the device/OS grant, never the
 * owner's execution authorization. Installation, live availability, owner
 * authorization and a missing device stay separate fields so no client can
 * collapse one fact into another. */
export const deviceCapabilityGrantSchema=z.enum(['granted','required','unavailable']);
const deviceCapabilityDeviceSchema=z.object({
  deviceId:identity,revision:z.number().int().positive(),connectionActive:z.boolean(),
  grant:deviceCapabilityGrantSchema,available:z.boolean(),authorized:z.boolean(),waitingDevice:z.boolean(),
}).strict();
export const deviceCapabilityProjectionSchema=z.object({
  id:identity,version:z.number().int().positive(),installed:z.boolean(),
  grant:deviceCapabilityGrantSchema,available:z.boolean(),authorized:z.boolean(),waitingDevice:z.boolean(),
  devices:z.array(deviceCapabilityDeviceSchema).max(500),
}).strict();
export type DeviceCapabilityDevice=z.infer<typeof deviceCapabilityDeviceSchema>;
export type DeviceCapabilityProjection=z.infer<typeof deviceCapabilityProjectionSchema>;
type DeviceCapabilityDeclarationFact=Pick<ActionDeviceCapability,'deviceId'|'revision'|'connectionActive'|'permission'|'calendars'>;
type DeviceCapabilityGrantFact={state:'active'|'revoked';authorized:boolean;target:{deviceId:string}};

/** Pure projection over stored declarations, providers and grants. A live
 * declaration means the device is present even when permission is missing;
 * waiting-device is reserved for an installed capability with no live device. */
export function projectDeviceCapability(input:{
  readonly id:string;
  readonly version:number;
  readonly installed:boolean;
  readonly declarations:readonly DeviceCapabilityDeclarationFact[];
  readonly grants:readonly DeviceCapabilityGrantFact[];
}):DeviceCapabilityProjection{
  const live=input.declarations.filter(value=>value.connectionActive);
  const usable=(value:DeviceCapabilityDeclarationFact)=>value.connectionActive&&value.permission==='granted'&&value.calendars.length>0;
  const authorized=(deviceId?:string)=>input.grants.some(grant=>grant.state==='active'&&grant.authorized&&(deviceId===undefined||grant.target.deviceId===deviceId));
  const grant=live.some(value=>value.permission==='granted')?'granted' as const:live.some(value=>value.permission==='required')?'required' as const:'unavailable' as const;
  const available=input.declarations.some(usable);
  return {
    id:input.id,version:input.version,installed:input.installed,grant,available,
    authorized:authorized(),waitingDevice:input.installed&&!available&&live.length===0,
    devices:[...input.declarations].sort((a,b)=>a.deviceId.localeCompare(b.deviceId)).map(value=>({
      deviceId:value.deviceId,revision:value.revision,connectionActive:value.connectionActive,
      grant:value.connectionActive?value.permission:'unavailable',
      available:usable(value),authorized:authorized(value.deviceId),
      waitingDevice:input.installed&&!usable(value)&&!value.connectionActive,
    })),
  };
}
