import {registerLibrarySourceView} from '../library-source-view.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerSourceRoutes } from '../source-routes.js';

/** sources: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{sourcePipelines,connections,credential,evidenceReader,ingress,sourceOwner,sources,store,materials}:Pick<FeatureServices,"sourcePipelines"|"connections"|"credential"|"evidenceReader"|"ingress"|"sourceOwner"|"sources"|"store"|"materials">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>sourcePipelines.tick());scope?.defer(()=>sourcePipelines.close());
app.addHook('onReady',async()=>{void scope?.run(()=>sourcePipelines.tick());});
registerLibrarySourceView(app,{store,sources,materials,evidenceReader,credential});
registerSourceRoutes(app,{store,sources,evidenceReader,ingress,connections,credential,sourceOwner});
}
