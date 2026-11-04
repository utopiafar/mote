import {registerLibrarySourceView} from '../library-source-view.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureAdapter} from './index.js';

/** sources: retains polling and the library view; C10 owns source transport. */
export function register(app:FastifyInstance,{sourcePipelines,credential,evidenceReader,sources,store,materials}:Pick<FeatureServices,"sourcePipelines"|"credential"|"evidenceReader"|"sources"|"store"|"materials">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>sourcePipelines.tick());scope?.defer(()=>sourcePipelines.close());
app.addHook('onReady',async()=>{void scope?.run(()=>sourcePipelines.tick());});
registerLibrarySourceView(app,{store,sources,materials,evidenceReader,credential});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.sources',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.sources'));
    register(app,services,scope);
  },
};
