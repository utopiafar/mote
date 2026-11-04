import type {FastifyInstance} from 'fastify';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ConfigService} from '../config-service.js';
import type {MediaAssets} from '../media-assets.js';
import type {MediaConfiguration} from '../media-configuration.js';
import {MediaPreparation} from '../media-preparation.js';
import {StoreError} from '../store.js';
import type {FeatureServices} from '../feature-services.js';
import {register as registerMediaRoutes} from '../features/media.js';
import {centralServices} from './central-contracts.js';

export const ocrAsrReadinessContribution={
  id:'ocr-asr-readiness',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[{kind:'service' as const,id:centralServices.mediaReadiness.id,apiVersion:centralServices.mediaReadiness.apiVersion,cardinality:'single' as const}],
} as const satisfies ManifestContribution;
export const ocrAsrReadinessDeclaration={id:ocrAsrReadinessContribution.id,apiVersion:'1'} as const;
export const ocrAsrReadinessReplacement='hot' as const;

export type OcrAsrReadinessPhase='created'|'prepared'|'active'|'quiescing'|'stopped'|'disposed';
export type MediaReadinessPort=Pick<MediaPreparation,'status'|'statuses'|'start'|'cancel'>&{readonly phase:OcrAsrReadinessPhase;assertCurrent():void};
type PreparationOptions=ConstructorParameters<typeof MediaPreparation>[0];
export interface OcrAsrReadinessDependencies {
  readonly runtime:PreparationOptions['runtime'];
  readonly media:MediaConfiguration;
  readonly assets:MediaAssets;
  readonly configService:ConfigService;
  readonly backgroundWorker?:boolean;
  readonly repository?:string;
  readonly prepare?:PreparationOptions['prepare'];
  readonly fetch?:typeof fetch;
  readonly startupTimeoutMs?:number;
}
export interface OcrAsrReadinessBindings {readonly readiness:ServiceBinding}
export interface OcrAsrReadiness extends PluginLifecycle {
  readonly port:MediaReadinessPort;
  prepare():Promise<void>;
  start():void;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('OCR/ASR readiness is unavailable',503);

/** C18B owns native preparation, worker health requests, configuration fences
 * and the managed worker subprocesses. A stopped activation is fully closed;
 * re-enabling prepares a fresh runtime without adding another HTTP route. */
export function createOcrAsrReadiness(dependencies:OcrAsrReadinessDependencies):OcrAsrReadiness {
  let phase:OcrAsrReadinessPhase='created',current:MediaPreparation|undefined,unsubscribe:(()=>void)|undefined,closing:Promise<void>|undefined,disposed=false;
  const readable=()=>{
    if(!current||!['prepared','active','quiescing'].includes(phase))throw unavailable();
    return current;
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return readable();
  };
  const retire=(final:boolean)=>{
    if(final){disposed=true;phase='disposed';}else if(phase!=='disposed')phase='stopped';
    const owned=current,remove=unsubscribe;current=undefined;unsubscribe=undefined;remove?.();
    if(!owned)return Promise.resolve();
    if(closing)return closing;
    closing=(async()=>{await owned.close();})().finally(()=>{closing=undefined;});
    return closing;
  };
  const port:MediaReadinessPort=Object.freeze({
    get phase(){return phase;},
    assertCurrent(){readable();},
    status:role=>readable().status(role),
    statuses:()=>readable().statuses(),
    start:(role,allowInstall)=>active().start(role,allowInstall),
    cancel:role=>readable().cancel(role),
  });
  return Object.freeze({
    port,
    async prepare(){
      if(disposed||!['created','stopped'].includes(phase))throw unavailable();
      try{
        current=new MediaPreparation({runtime:dependencies.runtime,media:dependencies.media,assets:dependencies.assets,
          ...(dependencies.repository?{repository:dependencies.repository}:{}),...(dependencies.prepare?{prepare:dependencies.prepare}:{}),
          ...(dependencies.fetch?{fetch:dependencies.fetch}:{}),...(dependencies.startupTimeoutMs!==undefined?{startupTimeoutMs:dependencies.startupTimeoutMs}:{})});
        const identity=()=>{const document=dependencies.configService.document();return JSON.stringify([document.media,(document.server as {runtime?:string})?.runtime]);};
        const initial=identity(),owned=current;
        unsubscribe=dependencies.configService.onChange(()=>{try{if(identity()!==initial)owned.invalidate();}catch{owned.invalidate();}});
        phase='prepared';
      }catch(error){
        try{await retire(false);}catch(cleanup){throw new AggregateError([error,cleanup],'OCR/ASR readiness preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){
      if(phase!=='prepared')throw unavailable();
      phase='active';
      if(dependencies.backgroundWorker)current!.resume();
    },
    quiesce(_reason?:StopReason){if(phase==='active'){phase='quiescing';current?.invalidate();}},
    stop:(_reason?:StopReason)=>retire(false),
    dispose:()=>retire(true),
    close:()=>retire(true),
  });
}

/** Same-domain trusted handoff between the existing early media assembly and
 * the processing assembly, which owns the actual host installation. */
const assemblyReadiness=new WeakMap<MediaAssets,OcrAsrReadiness>();
export function registerOcrAsrReadinessForAssembly(platform:OcrAsrReadiness,assets:MediaAssets){assemblyReadiness.set(assets,platform);return platform;}
export function ocrAsrReadinessForAssembly(assets:MediaAssets){
  const platform=assemblyReadiness.get(assets);if(!platform)throw unavailable();return platform;
}

export function createOcrAsrReadinessFactory(platform:OcrAsrReadiness,onStarted?:(bindings:OcrAsrReadinessBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:platform.prepare,
      start(){
        platform.start();
        const readiness=context.provide(ocrAsrReadinessContribution.id,centralServices.mediaReadiness,platform.port);
        onStarted?.({readiness});
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),
      stop:(reason:StopReason)=>platform.stop(reason),
      dispose:platform.dispose,
    };
  };
}

/** Stable pre-H14 route table. Handlers resolve the currently leased port on
 * every request, so replacement never mounts a duplicate route. */
export function createOcrAsrReadinessRoutes(){
  let current:MediaReadinessPort|undefined;
  const mounted=new WeakSet<FastifyInstance>();
  return Object.freeze({
    activate(port:MediaReadinessPort){current=port;},
    mount(app:FastifyInstance,services?:FeatureServices){
      if(mounted.has(app))throw new StoreError('Media routes are already installed',409);
      if(!services)throw unavailable();
      mounted.add(app);
      registerMediaRoutes(app,{...services,mediaPreparation:()=>current??(()=>{throw unavailable();})()});
    },
  });
}
export type OcrAsrReadinessRoutes=ReturnType<typeof createOcrAsrReadinessRoutes>;
