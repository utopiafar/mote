import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { Operations,registerOperations } from '../operations.js';
import { registerProcessingRoutes } from '../processing-routes.js';

/** processing: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{withMediaOwnerBatch,withMediaOwnerIntent,automaticActivity,config,credential,mediaAssets,perception,semanticSelection,store,workflows}:Pick<FeatureServices,'withMediaOwnerBatch'|'withMediaOwnerIntent'|"automaticActivity"|"config"|"credential"|"mediaAssets"|"perception"|"semanticSelection"|"store"|"workflows">,scope?:ServerFeatureScope){
 scope?.defer(()=>workflows.close());scope?.defer(()=>automaticActivity.close());scope?.every(5000,()=>automaticActivity.tick());
 app.get('/api/processing/activity',async()=>automaticActivity.view());
 app.put('/api/processing/activity',async req=>automaticActivity.save(req.body));
registerOperations(app,new Operations(store),req=>Boolean(credential(req)));
registerProcessingRoutes(app,{withOwnerBatch:withMediaOwnerBatch,withOwnerIntent:withMediaOwnerIntent,store,workflows,perception,mediaAssets,media:config.media,semanticFingerprint:()=>semanticSelection().fingerprint});
}
