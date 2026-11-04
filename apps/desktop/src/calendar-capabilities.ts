import {randomUUID} from 'node:crypto';
import {actionDeviceDeclarationSchema,deviceCapabilityProjectionSchema,type ActionDeviceCapability,type DeviceCapabilityProjection} from '@mote/shared';

type DeviceCapabilityResponse={connectionId:string;declaration:ActionDeviceCapability|null;projection:DeviceCapabilityProjection};
export type PublishedCalendarCapability={declaration:ActionDeviceCapability;projection:DeviceCapabilityProjection};

/** Permission inspection never requests OS permission. Unchanged declarations
 * keep their revision; the server projection is consumed as four separate
 * facts instead of guessing availability from a declaration alone. */
export async function publishCalendarCapability(deviceId:string,raw:unknown,request:(path:string,body?:unknown)=>Promise<any>):Promise<PublishedCalendarCapability|undefined>{
 const identity=await request('/api/connections/self');
 // An unbound owner session retains manual review; it cannot attest a device capability.
 if(!identity.credential?.deviceId)return;
 if(identity.credential.deviceId!==deviceId)throw Error('Calendar capability belongs to another device');
 const value=raw as {permission?:string;calendars?:{id:string;title:string;writable?:boolean}[]};
 const permission=value?.permission==='granted'?'granted':'required';
 const calendars=permission==='granted'?(value.calendars??[]).filter(c=>c.writable===true).map(({id,title})=>({id,title})).sort((a,b)=>a.id.localeCompare(b.id)):[];
 const current=await request('/api/device-action-capabilities') as DeviceCapabilityResponse;
 const declaration=current.declaration;
 const projection=deviceCapabilityProjectionSchema.parse(current.projection);
 const input=actionDeviceDeclarationSchema.parse({operationId:randomUUID(),expectedRevision:declaration?.revision??0,deviceId,capability:{id:'calendar.manage',version:1},permission,calendars});
 if(declaration?.connectionActive&&projection.available&&projection.grant==='granted'&&declaration.capability?.id===input.capability.id&&declaration.capability.version===input.capability.version&&declaration.connectionId===current.connectionId&&declaration.permission===permission&&JSON.stringify([...declaration.calendars].sort((a,b)=>a.id.localeCompare(b.id)))===JSON.stringify(calendars))return {declaration,projection};
 const published=await request('/api/device-action-capabilities',input) as ActionDeviceCapability;
 const next=await request('/api/device-action-capabilities') as DeviceCapabilityResponse;
 return {declaration:published,projection:deviceCapabilityProjectionSchema.parse(next.projection)};
}
