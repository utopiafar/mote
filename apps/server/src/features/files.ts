import type {ServerFeatureScope} from '../feature-host.js';
import type {FastifyInstance} from 'fastify';
import {registerFileRoutes} from '../file-routes.js';
import type {FeatureServices} from '../feature-services.js';
import type {FilePlaybackGrants} from '../plugins/files-source.js';

/** C11's files-source factory owns FileStore creation/close/sweep and the
 * playback-grant scope. This feature only registers the existing HTTP protocol. */
export interface FilesFeatureSource {readonly playback:FilePlaybackGrants}

/** Owns resumable binary transport, extraction views and authenticated playback. */
export function register(app:FastifyInstance,{withMediaOwnerBatch,withMediaOwnerIntent,executor,files,processing,ingress,sourceOwner,credential,evidenceReader,diagnostics,setPlaybackAuthorization,filesSource}:Pick<FeatureServices,'withMediaOwnerBatch'|'withMediaOwnerIntent'|"executor"|'files'|'processing'|'ingress'|'sourceOwner'|'credential'|'evidenceReader'|'diagnostics'|'setPlaybackAuthorization'>&{filesSource?:FilesFeatureSource},scope?:ServerFeatureScope){
 scope?.every(5000,()=>{processing.prepare();return executor.tick();});scope?.defer(()=>processing.close());
 const playbackAuthorization=registerFileRoutes(app,files,processing,ingress,sourceOwner,req=>credential(req)?.deviceId,evidenceReader,diagnostics,withMediaOwnerIntent,withMediaOwnerBatch,filesSource?.playback);
 setPlaybackAuthorization(playbackAuthorization);
 // The app-level bypass must not outlive this route contribution. The plugin
 // separately retires the token registry when its own scope quiesces.
 scope?.defer(()=>setPlaybackAuthorization(()=>false));
}
