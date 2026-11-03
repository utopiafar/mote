import {LayersReadModel} from '../layers-read-model.js';
import {registerLibrarySourceView} from '../library-source-view.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerSourceRoutes } from '../source-routes.js';
import type {ServerFeatureAdapter} from './index.js';

/** sources: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{sourcePipelines,connections,credential,evidenceReader,ingress,sourceOwner,sources,store,materials,memories}:Pick<FeatureServices,"sourcePipelines"|"connections"|"credential"|"evidenceReader"|"ingress"|"sourceOwner"|"sources"|"store"|"materials"|"memories">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>sourcePipelines.tick());scope?.defer(()=>sourcePipelines.close());
app.addHook('onReady',async()=>{void scope?.run(()=>sourcePipelines.tick());});
registerLibrarySourceView(app,{store,sources,materials,evidenceReader,credential});
registerSourceRoutes(app,{layers:new LayersReadModel(sources,memories),sources,evidenceReader:{fileCatalog:evidenceReader.fileCatalog.bind(evidenceReader)},ingress,connections,credential,sourceOwner});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.sources',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.sources'));
    register(app,services,scope);
  },
};
