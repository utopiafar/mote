import type {ServerFeatureScope} from '../feature-host.js';
import type {FastifyInstance} from 'fastify';
import type {FeatureServices} from '../feature-services.js';
import {filesSourceRoutesFor,type FilePlaybackGrants} from '../plugins/files-source.js';
import {StoreError} from '../store.js';
import type {ServerFeatureAdapter} from './index.js';

/** C11's files-source factory owns FileStore creation/close/sweep, the
 * playback-grant scope and the file transport. This feature only mounts the
 * plugin's single route contribution inside the feature host's HTTP scope.
 * Pre-H14 bridge: the published playback scope keys that contribution; H14
 * removes this member together with the feature adapter. */
export interface FilesFeatureSource {readonly playback:FilePlaybackGrants}

/** Owns resumable binary transport, extraction views and authenticated playback. */
export function register(app:FastifyInstance,{withMediaOwnerBatch,withMediaOwnerIntent,processing,ingress,sourceOwner,credential,evidenceReader,diagnostics,setPlaybackAuthorization,filesSource}:Pick<FeatureServices,'withMediaOwnerBatch'|'withMediaOwnerIntent'|'processing'|'ingress'|'sourceOwner'|'credential'|'evidenceReader'|'diagnostics'|'setPlaybackAuthorization'>&{filesSource?:FilesFeatureSource},scope?:ServerFeatureScope){
  const source=filesSource?filesSourceRoutesFor(filesSource.playback):undefined;
  if(!source)throw new StoreError('Files source routes are unavailable',503);
  source.routes(app,{processing,ingress,authorize:sourceOwner,device:req=>credential(req)?.deviceId,evidence:evidenceReader,diagnostics,withOwnerIntent:withMediaOwnerIntent,withOwnerBatch:withMediaOwnerBatch,setPlaybackAuthorization});
  // The app-level bypass must not outlive this route contribution. The plugin
  // separately retires the token registry when its own scope quiesces.
  scope?.defer(()=>setPlaybackAuthorization(()=>false));
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.files',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.files'));
    register(app,services,scope);
  },
};
