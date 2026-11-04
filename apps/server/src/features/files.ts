import type {FastifyInstance,FastifyRequest} from 'fastify';
import {filesSourceRoutesFor,type FilePlaybackGrants} from '../plugins/files-source.js';
import {StoreError} from '../store.js';
import type {ConnectionCredential} from '../connections.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {FileProcessing} from '../file-processing.js';
import type {IngressService} from '../ingress.js';
import type {FeatureRoute} from './index.js';

/** C11's files-source factory owns FileStore creation/close/sweep, the
 * playback-grant scope and the file transport. This feature only mounts the
 * plugin's single route contribution. */
export interface FilesFeatureSource {readonly playback:FilePlaybackGrants}

export interface FilesFeatureDependencies {
  readonly withMediaOwnerBatch:<T>(ids:readonly string[],task:()=>T)=>Promise<T>;
  readonly withMediaOwnerIntent:<T>(id:string,task:()=>Promise<T>|T)=>Promise<T>;
  readonly processing:FileProcessing;
  readonly ingress:IngressService;
  readonly sourceOwner:(request:FastifyRequest,id:string)=>void;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly evidenceReader:EvidenceReader;
  readonly diagnostics:ServerDiagnostics;
  readonly setPlaybackAuthorization:(authorize:(request:FastifyRequest)=>boolean)=>void;
  readonly filesSource?:FilesFeatureSource;
}

/** Owns resumable binary transport, extraction views and authenticated playback. */
export function filesFeature(dependencies:FilesFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.files',mount(app:FastifyInstance,scope:import('./index.js').FeatureScope){
    const source=dependencies.filesSource?filesSourceRoutesFor(dependencies.filesSource.playback):undefined;
    if(!source)throw new StoreError('Files source routes are unavailable',503);
    source.routes(app,{processing:dependencies.processing,ingress:dependencies.ingress,authorize:dependencies.sourceOwner,device:req=>dependencies.credential(req)?.deviceId,evidence:dependencies.evidenceReader,diagnostics:dependencies.diagnostics,withOwnerIntent:dependencies.withMediaOwnerIntent,withOwnerBatch:dependencies.withMediaOwnerBatch,setPlaybackAuthorization:dependencies.setPlaybackAuthorization});
    // The app-level bypass must not outlive this route contribution. The plugin
    // separately retires the token registry when its own scope quiesces.
    scope.defer(()=>dependencies.setPlaybackAuthorization(()=>false));
  }});
}
