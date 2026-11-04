/** Mac capability publication: one owner for the device facts Mac declares to
 * Central and the native status projections its clients consume.
 *
 * A declaration describes an implementation and never grants execution.
 * Permission loss is published as a new revision with no writable calendars
 * and a blocked local fact, so no stale available state survives. */
import {randomUUID} from 'node:crypto';
import {
  actionDeviceDeclarationSchema,
  deviceCapabilityProjectionSchema,
  sourceCapabilities,
  type ActionDeviceCapability,
  type DeviceCapabilityProjection,
  type SourceCapabilities,
} from '@mote/shared';
import {nativeStatusView, type NativeStatusView} from '@mote/shared/native-status';
import {connectionToken} from '../login-session';
import type {CalendarActions} from '../calendar-actions';
import type {Config, SyncStatus} from '../contracts';
import type {SourceStatus} from '../source-types';
import {capabilityPublisherChannels, desktopJobIds} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

type DeviceCapabilityResponse={connectionId:string;declaration:ActionDeviceCapability|null;projection:DeviceCapabilityProjection};
export type PublishedCalendarCapability={
  declaration:ActionDeviceCapability;
  projection:DeviceCapabilityProjection;
  /** Local publication verdict; it is never an execution grant. */
  state:'available'|'blocked';
};
export type CapabilityRequest=(path:string,body?:unknown)=>Promise<any>;

const publicationState=(declaration:ActionDeviceCapability,projection:DeviceCapabilityProjection):'available'|'blocked'=>
  declaration.permission==='granted'&&projection.available?'available':'blocked';

/** Permission inspection never requests OS permission. Unchanged declarations
 * keep their revision; the server projection is consumed as four separate
 * facts instead of guessing availability from a declaration alone. */
export async function publishCalendarCapability(deviceId:string,raw:unknown,request:CapabilityRequest):Promise<PublishedCalendarCapability|undefined>{
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
 if(declaration?.connectionActive&&projection.available&&projection.grant==='granted'&&declaration.capability?.id===input.capability.id&&declaration.capability.version===input.capability.version&&declaration.connectionId===current.connectionId&&declaration.permission===permission&&JSON.stringify([...declaration.calendars].sort((a,b)=>a.id.localeCompare(b.id)))===JSON.stringify(calendars))return {declaration,projection,state:publicationState(declaration,projection)};
 const published=await request('/api/device-action-capabilities',input) as ActionDeviceCapability;
 const next=await request('/api/device-action-capabilities') as DeviceCapabilityResponse;
 const nextProjection=deviceCapabilityProjectionSchema.parse(next.projection);
 return {declaration:published,projection:nextProjection,state:publicationState(published,nextProjection)};
}

/** A registered source adapter is the capability fact. A missing adapter is a
 * blocked source, not an empty or successful scan. */
export function sourceCapability(source:Pick<SourceStatus['source'],'kind'|'platform'|'retention'>):SourceCapabilities|undefined{
  try{return sourceCapabilities.describe(source as never);}catch{return undefined;}
}

/** Local source facts stay separate: archive acknowledgment, central
 * processing, synchronization and scan coverage never collapse into one. */
export function sourceStatusView(row:SourceStatus,connected:boolean):NativeStatusView{
  const capability=sourceCapability(row.source);
  const syncState=!connected?'unconfigured':!capability?'blocked':row.blocked&&row.state!=='syncing'?'blocked':row.state==='permission_required'?'blocked':row.state==='syncing'?'uploading':row.state==='idle'&&row.pending>0?'waiting':row.state;
  const errorCode=!capability?'source_unavailable':row.blocked?'retained_conflict':row.state==='permission_required'?'permission_required':row.state==='error'?'source_unavailable':null;
  return nativeStatusView({pending:row.pending+(row.blocked??0),lastAcknowledgedAt:row.lastAcknowledgedAt,syncState,errorCode,
    scanComplete:row.scanComplete,knownItems:row.items,skipped:row.skipped});
}

/** Collector facts use the same projection as sources; a missing inventory is
 * blocked rather than an optimistic zero. */
export function collectorStatusView(sync:SyncStatus,blocked=0,inventoryAvailable=true):NativeStatusView{
  return nativeStatusView({pending:inventoryAvailable?sync.pendingRecords:null,lastAcknowledgedAt:sync.lastUploadAt,
    syncState:!inventoryAvailable?'blocked':blocked?'blocked':sync.state==='manual'?'waiting':sync.state,
    errorCode:!inventoryAvailable?'local_state_unavailable':blocked?'retained_conflict':null,retryAt:sync.nextUploadAt});
}

export const capabilityPublisherCapability='capabilities.publish';
export {capabilityPublisherChannels};

type PublisherSettings=Pick<Config,'deviceId'|'serverUrl'|'token'|'syncPaused'|'syncMode'|'authSignedOut'|'authExpiresAt'>;
export interface CapabilityPublisherPluginOptions{
  readonly settings:()=>PublisherSettings;
  /** The calendar action owner publishes through this plugin; callers only
   * supply the current connection. */
  readonly calendar:()=>Pick<CalendarActions,'connectAndDeliver'|'deliver'>;
  readonly serialize?:<T>(operation:()=>Promise<T>)=>Promise<T>;
  readonly platform?:NodeJS.Platform;
  readonly intervalMs?:number;
}
export interface CapabilityPublisherPlugin extends BuiltinDesktopPlugin{
  connect():Promise<{deviceId:string}>;
  deliver():Promise<void>;
  close():void;
}

export function createCapabilityPublisherPlugin(options:CapabilityPublisherPluginOptions):CapabilityPublisherPlugin{
  const platform=options.platform??process.platform;
  let timer:ReturnType<typeof setInterval>|undefined;
  let inFlight:Promise<void>|undefined;
  let closed=false;
  const canPublish=()=>{
    const settings=options.settings();
    return platform==='darwin'&&!settings.syncPaused&&settings.syncMode!=='manual'
      &&Boolean(settings.serverUrl)&&Boolean(connectionToken(settings));
  };
  const connect=async():Promise<{deviceId:string}>=>{
    if(closed)throw Error('Capability publisher is stopped');
    const operation=()=>options.calendar().connectAndDeliver(()=>options.settings().syncPaused===true);
    return options.serialize?options.serialize(operation):operation();
  };
  const deliver=async():Promise<void>=>{
    if(closed)throw Error('Capability publisher is stopped');
    if(inFlight)return inFlight;
    if(!canPublish())return;
    const task=options.calendar().deliver();
    inFlight=task;
    try{await task;}finally{if(inFlight===task)inFlight=undefined;}
  };
  const close=()=>{
    if(closed)return;
    closed=true;
    if(timer){clearInterval(timer);timer=undefined;}
  };
  return {
    id:'mote.capability-publisher',
    connect,
    deliver,
    close,
    async register({host,pageUrl}:BuiltinPluginContext):Promise<void>{
      const scope=host.createScope({instanceId:'mote.capability-publisher',capabilities:[capabilityPublisherCapability]});
      const outcome=await host.startPlugin(scope,plugin=>{
        plugin.registerIpc({channel:capabilityPublisherChannels.calendarConnect,capability:capabilityPublisherCapability,
          windowRoles:['main'],callerCapability:capabilityPublisherCapability,roleFrameUrls:{main:[pageUrl]}},()=>connect());
        plugin.registerJob({id:desktopJobIds.capabilityPublication,durable:true,drain:async()=>{close();await inFlight?.catch(()=>{});}});
        plugin.defer(close);
        timer=setInterval(()=>{void deliver().catch(()=>{});},options.intervalMs??60000);
        timer.unref();
      });
      if(!outcome.started)throw outcome.error;
    },
  };
}
