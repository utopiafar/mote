import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { Operations,registerOperations } from '../operations.js';
import { registerProcessingRoutes } from '../processing-routes.js';

/** processing: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{credential,mediaAssets,perception,semanticSelection,store,workflows}:Pick<FeatureServices,"credential"|"mediaAssets"|"perception"|"semanticSelection"|"store"|"workflows">,scope?:ServerFeatureScope){
 scope?.defer(()=>workflows.close());
registerOperations(app,new Operations(store),req=>Boolean(credential(req)));
registerProcessingRoutes(app,{store,workflows,perception,mediaAssets,semanticFingerprint:()=>semanticSelection().fingerprint});
}
