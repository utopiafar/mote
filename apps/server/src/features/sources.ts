import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerSourceRoutes } from '../source-routes.js';

/** sources: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{sourcePipelines,connections,credential,evidenceReader,fileEvidence,ingress,sourceOwner,sources,store}:Pick<FeatureServices,"sourcePipelines"|"connections"|"credential"|"evidenceReader"|"fileEvidence"|"ingress"|"sourceOwner"|"sources"|"store">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>sourcePipelines.tick());scope?.defer(()=>sourcePipelines.close());
app.addHook('onReady',async()=>{void scope?.run(()=>sourcePipelines.tick());});
registerSourceRoutes(app,{store,sources,fileEvidence,evidenceReader,ingress,connections,credential,sourceOwner});
}
