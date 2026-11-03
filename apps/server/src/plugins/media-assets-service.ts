import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {StoreError} from '../store.js';
import {MediaAssets} from '../media-assets.js';
import {centralServices,type MediaAssetsRead} from './central-contracts.js';

/** C18A's actual data-contribution fragment. H03 owns the package Manifest; H05
 * owns install topology. The plugin owns the managed asset directory itself:
 * downloads, checksum verification and atomic version publication. */
export const mediaAssetsServiceContribution={
  id:'media-assets-service',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[centralServices.mediaAssetsRead].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const mediaAssetsServiceDeclaration={id:mediaAssetsServiceContribution.id,apiVersion:'1'} as const;
export const mediaAssetsServiceReplacement='hot' as const;

export interface MediaAssetsServiceOptions {readonly root:string}
export interface MediaAssetsService extends PluginLifecycle {
  /** The published port's read-only view: asset state only, never installs,
   * cancellation, the managed root or a raw MediaAssets. */
  readonly assetsRead:MediaAssetsRead;
  /** Trusted composition bridge until the remaining media consumers migrate. */
  readonly assetsForAssembly:MediaAssets;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Media assets service is unavailable',503);

/** Construction, install admission and close all belong to this owner. prepare
 * creates the managed directory; start admits installs; quiesce rejects new
 * installs while accepted downloads keep draining; stop/close cancels and waits
 * so partial downloads fold into resumable cache files. */
export function createMediaAssetsService(options:MediaAssetsServiceOptions):MediaAssetsService {
  if(typeof options?.root!=='string'||!options.root)throw new StoreError('Invalid media assets directory');
  let phase:'created'|'prepared'|'active'|'quiescing'|'disposed'='created';
  let assets:MediaAssets|undefined,closing:Promise<void>|undefined;
  const active=()=>{if(phase!=='active')throw unavailable();};
  const reading=()=>{if(phase!=='active'&&phase!=='quiescing')throw unavailable();};
  const close=()=>closing??=(async()=>{const owned=assets;phase='disposed';await owned?.close();})();
  return Object.freeze({
    prepare(){
      if(phase!=='created')throw unavailable();
      try{
        const instance=new MediaAssets(options.root);
        // New-work admission checks the owning phase even for transitional
        // bridge callers; ready/status reads stay direct disk state.
        const install=instance.install.bind(instance),installAsync=instance.installAsync.bind(instance),importBundle=instance.importBundle.bind(instance);
        instance.install=(...args:Parameters<MediaAssets['install']>)=>{active();return install(...args);};
        instance.installAsync=(...args:Parameters<MediaAssets['installAsync']>)=>{active();return installAsync(...args);};
        instance.importBundle=(...args:Parameters<MediaAssets['importBundle']>)=>{active();return importBundle(...args);};
        assets=instance;phase='prepared';
      }catch(error){
        // A failed directory creation owns no lock, file handle or timer yet.
        phase='disposed';throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    get assetsForAssembly(){if(!assets||phase==='created'||phase==='disposed')throw unavailable();return assets;},
    assetsRead:Object.freeze<MediaAssetsRead>({
      ready:role=>{reading();return assets!.ready(role);},
      status:role=>{reading();return assets!.status(role);},
      statuses:()=>{reading();return assets!.statuses();},
    }),
  });
}

/** Trusted H04/H05 wiring. Only the read-only asset-state port is published. */
export function createMediaAssetsServiceFactory(options:MediaAssetsServiceOptions){
  return (context:HostPluginContext):PluginLifecycle=>{
    const service=createMediaAssetsService(options);
    context.scope.defer(()=>service.close());
    return {
      prepare:()=>service.prepare(),
      start(){service.start();context.provide(mediaAssetsServiceContribution.id,centralServices.mediaAssetsRead,service.assetsRead);},
      quiesce:(reason:StopReason)=>service.quiesce(reason),
      stop:(reason:StopReason)=>service.stop(reason),
      dispose:()=>service.dispose(),
    };
  };
}
