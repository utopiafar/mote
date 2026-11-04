import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { Operations,registerOperations } from '../operations.js';
import { registerProcessingRoutes } from '../processing-routes.js';
import type {ServerFeatureAdapter} from './index.js';

/** processing: owns perception/media transport while the processing-services
 * plugin contributes the job receipt and command table. */
export function register(app:FastifyInstance,{withMediaOwnerBatch,withMediaOwnerIntent,config,credential,mediaAssets,perception,store}:Pick<FeatureServices,'withMediaOwnerBatch'|'withMediaOwnerIntent'|'config'|'credential'|'mediaAssets'|'perception'|'store'>,scope?:ServerFeatureScope){
registerOperations(app,new Operations(store),req=>Boolean(credential(req)));
registerProcessingRoutes(app,{withOwnerBatch:withMediaOwnerBatch,withOwnerIntent:withMediaOwnerIntent,perception,mediaAssets,media:config.media});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.processing',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services,host)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.processing'));
    host.mountDomainRoutes('mote.processing',app);
    register(app,services,scope);
  },
};
