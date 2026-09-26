import type {FastifyInstance} from 'fastify';
import {registerFileRoutes} from '../file-routes.js';
import type {FeatureServices} from '../feature-services.js';
/** Owns resumable binary transport, extraction views and authenticated playback. */
export function register(app:FastifyInstance,{files,processing,ingress,sourceOwner,credential,evidenceReader,diagnostics,setPlaybackAuthorization}:Pick<FeatureServices,'files'|'processing'|'ingress'|'sourceOwner'|'credential'|'evidenceReader'|'diagnostics'|'setPlaybackAuthorization'>){
 setPlaybackAuthorization(registerFileRoutes(app,files,processing,ingress,sourceOwner,req=>credential(req)?.deviceId,evidenceReader,diagnostics));
}
