import type {ServerFeatureScope} from '../feature-host.js';
import type {FastifyInstance} from 'fastify';
import {registerFileRoutes} from '../file-routes.js';
import type {FeatureServices} from '../feature-services.js';
/** Owns resumable binary transport, extraction views and authenticated playback. */
export function register(app:FastifyInstance,{executor,files,processing,ingress,sourceOwner,credential,evidenceReader,diagnostics,setPlaybackAuthorization}:Pick<FeatureServices,"executor"|'files'|'processing'|'ingress'|'sourceOwner'|'credential'|'evidenceReader'|'diagnostics'|'setPlaybackAuthorization'>,scope?:ServerFeatureScope){
 scope?.every(5000,()=>{processing.prepare();return executor.tick();});scope?.defer(()=>processing.close());scope?.defer(()=>files.close());
 setPlaybackAuthorization(registerFileRoutes(app,files,processing,ingress,sourceOwner,req=>credential(req)?.deviceId,evidenceReader,diagnostics));
}
