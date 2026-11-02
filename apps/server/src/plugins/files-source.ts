import {randomBytes} from 'node:crypto';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {Store,StoreError} from '../store.js';
import {SourceStore} from '../sources.js';
import {FileStore} from '../files.js';
import {FileEvidence} from '../file-evidence.js';
import {FileAttachments} from '../file-attachments.js';
import {ArchivedFileStore} from '../archived-files.js';
import {FileRawReader,type FileRawAccess} from '../file-raw-reader.js';
import {centralServices,type FileOriginalRead} from './central-contracts.js';

/** C11's actual data-contribution fragment. H03 owns the package Manifest; H05
 * owns HTTP/topology. C02 keeps the SQLite/blob/lock ownership behind these
 * borrowed handles. */
export const filesSourceContribution={
  id:'files-source',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[centralServices.fileOriginalRead].map(service=>({kind:'service' as const,id:service.id,apiVersion:service.apiVersion,cardinality:'single' as const})),
} as const satisfies ManifestContribution;
export const filesSourceDeclaration={id:filesSourceContribution.id,apiVersion:'1'} as const;
/** Frozen C01 migration contract keeps files hot; no storage format changes. */
export const filesSourceReplacement='hot' as const;

export interface PlaybackGrant {readonly token:string;readonly until:number;readonly maxAgeSeconds:number}
/** The trusted route host binds an already admitted request/source check. This
 * registry never invents authorization: it replays the caller's C04-backed
 * check and expires with the issuing plugin scope. */
export interface FilePlaybackGrants {
  issue(fileId:string,sourceId:string,check:()=>void):PlaybackGrant;
  verify(fileId:string,token:string|undefined):boolean;
  purge():void;
  retire():void;
  readonly active:boolean;
}
export interface PlaybackGrantOptions {
  readonly ttlMs?:number;
  readonly clock?:()=>number;
  readonly token?:()=>string;
}
export class PlaybackGrants implements FilePlaybackGrants {
  private readonly ttlMs:number;
  private readonly clock:()=>number;
  private readonly token:()=>string;
  private readonly grants=new Map<string,{fileId:string;sourceId:string;until:number;check:()=>void}>();
  private retired=false;
  constructor(options:PlaybackGrantOptions={}){
    this.ttlMs=options.ttlMs??300_000;this.clock=options.clock??Date.now;this.token=options.token??(()=>randomBytes(32).toString('hex'));
    if(!Number.isSafeInteger(this.ttlMs)||this.ttlMs<=0)throw new StoreError('Invalid playback grant lifetime');
  }
  get active(){return !this.retired;}
  issue(fileId:string,sourceId:string,check:()=>void):PlaybackGrant {
    if(this.retired)throw new StoreError('File playback is unavailable',503);
    if(typeof check!=='function')throw new StoreError('File playback authorization is unavailable',503);
    this.purge();
    let token=this.token();
    for(let attempt=0;this.grants.has(token)&&attempt<4;attempt++)token=this.token();
    if(this.grants.has(token))throw new StoreError('File playback token conflict',503);
    const until=this.clock()+this.ttlMs;
    this.grants.set(token,{fileId,sourceId,until,check});
    return {token,until,maxAgeSeconds:Math.max(1,Math.ceil(this.ttlMs/1000))};
  }
  /** Missing, expired, retired, mismatched or no-longer-authorized grants fail closed.
   * A token presented for another file is rejected without revoking its real grant. */
  verify(fileId:string,token:string|undefined):boolean {
    if(this.retired||!token)return false;
    const grant=this.grants.get(token);
    if(!grant)return false;
    if(grant.until<=this.clock()){this.grants.delete(token);return false;}
    if(grant.fileId!==fileId)return false;
    try{grant.check();}catch{this.grants.delete(token);return false;}
    return true;
  }
  purge(){
    const now=this.clock();for(const [token,grant] of this.grants)if(grant.until<=now)this.grants.delete(token);
  }
  retire(){this.retired=true;this.grants.clear();}
}

/** Borrowed C02 storage, borrowed C10 source catalogue and the trusted C04/C19D
 * original-read policy. The plugin never closes its dependencies or publishes
 * raw bytes/a Store. */
export interface FilesSourceDependencies {
  readonly store:Store;
  readonly sources:SourceStore;
  readonly archivedFiles:ArchivedFileStore;
  readonly rawAccess:FileRawAccess;
}
export interface FilesSourceOptions {
  /** Periodic upload/snapshot sweep. 0 disables the timer for tests/manual hosts. */
  readonly sweepIntervalMs?:number;
  readonly playbackTtlMs?:number;
  readonly clock?:()=>number;
  readonly playbackToken?:()=>string;
}
/** Trusted feature wiring only; never a published service. */
export interface FilesSourceAssembly {
  readonly files:FileStore;
  readonly evidence:FileEvidence;
  readonly attachments:FileAttachments;
  readonly originalRead:FileOriginalRead;
  readonly playback:FilePlaybackGrants;
  sweep():void;
}
export interface FilesSource extends PluginLifecycle {
  assemblyForRoutes():FilesSourceAssembly;
  sweep():void;
  close():Promise<void>;
}

/** Construction, close and sweep all belong to this owner. prepare acquires the
 * domain objects; start admits sweep/playback; quiesce revokes playback and the
 * timer; stop drains or aborts uploads before close. */
export function createFilesSource(dependencies:FilesSourceDependencies,options:FilesSourceOptions={}):FilesSource {
  const {store,sources,archivedFiles,rawAccess}=dependencies;
  if(!store||!sources||!archivedFiles||!rawAccess)throw new StoreError('Files source dependencies are unavailable',503);
  const sweepIntervalMs=options.sweepIntervalMs??3_600_000;
  if(!Number.isSafeInteger(sweepIntervalMs)||sweepIntervalMs<0)throw new StoreError('Invalid file sweep interval');
  let phase:'created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let files:FileStore|undefined,evidence:FileEvidence|undefined,attachments:FileAttachments|undefined,reader:FileRawReader|undefined;
  let playback:PlaybackGrants|undefined,timer:ReturnType<typeof setInterval>|undefined,closing:Promise<void>|undefined;
  const unavailable=()=>new StoreError('Files source is unavailable',503);
  const stopTimer=()=>{if(timer){clearInterval(timer);timer=undefined;}};
  const closeOnce=()=>closing??=(async()=>{
    stopTimer();playback?.retire();
    const errors:unknown[]=[];
    try{await files?.close();}catch(error){errors.push(error);}
    phase='stopped';
    if(errors.length)throw new AggregateError(errors,'Files source disposal failed');
  })();
  return Object.freeze({
    async prepare(){
      if(phase!=='created')throw unavailable();
      try{
        files=new FileStore(store,sources);
        evidence=new FileEvidence(sources);
        attachments=new FileAttachments(files);
        reader=new FileRawReader(store,files,archivedFiles,rawAccess);
        playback=new PlaybackGrants({...(options.playbackTtlMs===undefined?{}:{ttlMs:options.playbackTtlMs}),...(options.clock?{clock:options.clock}:{}),...(options.playbackToken?{token:options.playbackToken}:{})});
        phase='prepared';
      }catch(error){
        try{await closeOnce();}catch(cleanup){throw new AggregateError([error,cleanup],'Files source preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      phase='active';
      if(sweepIntervalMs>0){
        timer=setInterval(()=>{try{files?.sweep();}catch{/* the next tick retries; failures stay observable at close/health */}},sweepIntervalMs);
        (timer as unknown as {unref?:()=>unknown}).unref?.();
      }
    },
    quiesce(_reason?:StopReason){
      if(phase==='active')phase='quiescing';
      stopTimer();playback?.retire();
    },
    async stop(){if(phase!=='disposed')await closeOnce();},
    dispose:closeOnce,
    close:closeOnce,
    sweep(){if(!files||phase==='created'||phase==='disposed')throw unavailable();files.sweep();},
    assemblyForRoutes(){
      if(!files||!evidence||!attachments||!reader||!playback||phase==='created'||phase==='stopped'||phase==='disposed')throw unavailable();
      return Object.freeze({files,evidence,attachments,originalRead:Object.freeze({read:reader.read.bind(reader)}),playback,sweep:()=>files!.sweep()});
    },
  });
}

/** Trusted H04/H05 wiring. Only the read-only original port is published. */
export function createFilesSourceFactory(dependencies:FilesSourceDependencies,options:FilesSourceOptions={}){
  return (context:HostPluginContext):PluginLifecycle=>{
    const source=createFilesSource(dependencies,options);
    context.scope.defer(()=>source.close());
    return {
      prepare:async()=>{await source.prepare();},
      start:async()=>{
        await source.start();
        context.provide(filesSourceContribution.id,centralServices.fileOriginalRead,source.assemblyForRoutes().originalRead);
      },
      quiesce:(reason:StopReason)=>source.quiesce(reason),
      stop:(reason:StopReason)=>source.stop(reason),
      dispose:()=>source.dispose(),
    };
  };
}
