import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { Operations,registerOperations } from '../operations.js';
import { registerProcessingRoutes } from '../processing-routes.js';
import type {ServerFeatureAdapter} from './index.js';

/** processing: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{withMediaOwnerBatch,withMediaOwnerIntent,config,credential,mediaAssets,mediaPreparation,perception,semanticSelection,store,workflows}:Pick<FeatureServices,'withMediaOwnerBatch'|'withMediaOwnerIntent'|'config'|'credential'|'mediaAssets'|'mediaPreparation'|'perception'|'semanticSelection'|'store'|'workflows'>,scope?:ServerFeatureScope){
 scope?.defer(()=>workflows.close());
registerOperations(app,new Operations(store),req=>Boolean(credential(req)));
registerProcessingRoutes(app,{withOwnerBatch:withMediaOwnerBatch,withOwnerIntent:withMediaOwnerIntent,store,workflows,perception,mediaAssets,mediaPreparation,media:config.media,semanticFingerprint:()=>semanticSelection().fingerprint});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.processing',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.processing'));
    register(app,services,scope);
  },
};
