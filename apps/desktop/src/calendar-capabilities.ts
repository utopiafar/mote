import {randomUUID} from 'node:crypto';
import {actionDeviceDeclarationSchema,type ActionDeviceCapability} from '@mote/shared';

/** Permission inspection never requests OS permission. Unchanged declarations keep their revision. */
export async function publishCalendarCapability(deviceId:string,raw:unknown,request:(path:string,body?:unknown)=>Promise<any>){
 const identity=await request('/api/connections/self');
 // An unbound owner session retains manual review; it cannot attest a device capability.
 if(!identity.credential?.deviceId)return;
 if(identity.credential.deviceId!==deviceId)throw Error('Calendar capability belongs to another device');
 const value=raw as {permission?:string;calendars?:{id:string;title:string;writable?:boolean}[]};
 const permission=value?.permission==='granted'?'granted':'required';
 const calendars=permission==='granted'?(value.calendars??[]).filter(c=>c.writable===true).map(({id,title})=>({id,title})).sort((a,b)=>a.id.localeCompare(b.id)):[];
 const current=await request('/api/device-action-capabilities') as {connectionId:string;declaration:ActionDeviceCapability|null};
 const declaration=current.declaration;
 const input=actionDeviceDeclarationSchema.parse({operationId:randomUUID(),expectedRevision:declaration?.revision??0,deviceId,capability:{id:'calendar.create',version:1},permission,calendars});
 if(declaration?.connectionActive&&declaration.connectionId===current.connectionId&&declaration.permission===permission&&JSON.stringify([...declaration.calendars].sort((a,b)=>a.id.localeCompare(b.id)))===JSON.stringify(calendars))return declaration;
 return request('/api/device-action-capabilities',input);
}
