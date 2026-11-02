import type {FastifyInstance,FastifyRequest} from 'fastify';
import {heartbeatSchema,type DeviceRecord,type Heartbeat} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError} from '../store.js';
import type {RequestAuthority} from './central-contracts.js';
import type {AuthorizationPlatform} from './authorization-platform.js';
import {firstDeviceData} from '../first-device-data.js';
type FirstDeviceData=ReturnType<typeof firstDeviceData>;

/** Trusted C04 members only. Request pins come from the host's bindRequest hook. */
export type DeviceRequestAuthority=Pick<AuthorizationPlatform,'bindRequest'|'releaseRequest'|'requests'>;

/** Narrow device repository. Implemented by trusted assembly over the real
 * Store; the plugin never receives the raw Store or SQL handle. */
export interface DeviceHeartbeatStore {
  heartbeat(beat:Heartbeat):{ok:boolean};
  devices():DeviceRecord[];
}

/** Collector identity checks stay in trusted assembly because platform ownership
 * is not part of the frozen RequestAuthorization contract yet (C01 decision). */
export interface DeviceIdentityCheck {
  assertOwnDevice(request:RequestAuthority,beat:Heartbeat):void;
  assertOwnPlatform(request:RequestAuthority,platform:Heartbeat['platform']):void;
}
export interface DeviceRouteContext {
  readonly request:(request:FastifyRequest)=>RequestAuthority|undefined;
}

export interface DeviceSourceOptions {
  /** Narrow existing diagnostics sink; no writer or trace surface is published. */
  readonly recordQueueSnapshot?:(beat:Heartbeat)=>void;
}
export interface DeviceSourceDependencies {
  readonly devices:DeviceHeartbeatStore;
  /** Owner-only view from first-device-data.ts; assembly supplies its real reads. */
  readonly firstData:()=>FirstDeviceData;
  readonly authority:DeviceRequestAuthority;
  readonly identity:DeviceIdentityCheck;
}

export const devicesSourceContribution={
  id:'devices-source',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'},{kind:'host',id:'mote.owner-authorization',version:'1.0.0'}],
  provides:[],
} as const satisfies ManifestContribution;
export const devicesSourceDeclaration={id:devicesSourceContribution.id,apiVersion:'1'} as const;
export const devicesSourceReplacement='restart' as const;

const unavailable=()=>new StoreError('Devices source is unavailable',503);

/** Owns the devices HTTP contribution. Heartbeats are writes and stop at quiesce;
 * read views keep working until close. Archived device/capture rows are never
 * deleted here, so disabling the plugin cannot erase history. */
export function createDevicesSource(options:DeviceSourceOptions,dependencies:DeviceSourceDependencies){
  const {devices,firstData,authority,identity}=dependencies;
  let phase:'created'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let routesInstalled=false,closing:Promise<void>|undefined;
  const reading=()=>{if(phase!=='active'&&phase!=='quiescing')throw unavailable();};
  const writing=()=>{if(phase!=='active')throw unavailable();};
  const close=()=>closing??=(async()=>{phase='disposed';})();
  function routes(app:FastifyInstance,context:DeviceRouteContext){
    if(routesInstalled)throw new StoreError('Device routes are already installed',409);
    if(phase!=='created'&&phase!=='active')throw unavailable();
    routesInstalled=true;
    const pin=(request:FastifyRequest)=>{
      const value=context.request(request);
      if(!value)throw new StoreError('Owner authorization is required',401);
      return value;
    };
    app.post('/api/devices/heartbeat',async request=>{
      const beat=heartbeatSchema.parse(request.body),requestPin=pin(request);
      writing();
      // Collector scope still follows the existing device/platform ownership
      // rules; owner credentials skip both checks inside the trusted assembly.
      identity.assertOwnDevice(requestPin,beat);
      identity.assertOwnPlatform(requestPin,beat.platform);
      const result=devices.heartbeat(beat);
      options.recordQueueSnapshot?.(beat);
      return result;
    });
    app.get('/api/devices',async request=>{
      pin(request);reading();
      return {items:devices.devices()};
    });
    // Owner-only through the host's default-deny collector allowlist. This module
    // never loosens it: no collector/MCP route is registered for first data.
    app.get('/api/devices/first-data',async request=>{
      pin(request);reading();
      return firstData();
    });
  }
  return Object.freeze({
    start(){if(phase!=='created')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    /** Trusted assembly registers these on the feature child app, never globally. */
    routes,
  });
}
export type DevicesSource=ReturnType<typeof createDevicesSource>;

/** Compiled trusted H04 owner. The host never infers routes from contributions. */
export function createDevicesSourceFactory(options:DeviceSourceOptions,dependencies:DeviceSourceDependencies,registerRoutes?:((platform:DevicesSource)=>void)){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createDevicesSource(options,dependencies);
    context.scope.defer(()=>platform.close());
    return {
      prepare(){},
      start(){platform.start();registerRoutes?.(platform);},
      quiesce:(reason?:StopReason)=>platform.quiesce(reason),stop:(reason?:StopReason)=>platform.stop(reason),dispose:()=>platform.close(),
    };
  };
}
