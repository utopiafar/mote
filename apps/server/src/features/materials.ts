import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import {registerOwnerLibraryBrowse} from '../owner-library-browse.js';
import { registerMaterialRoutes } from '../material-routes.js';
import { registerSourceMaterialView } from '../source-material-view.js';
import type {ServerFeatureAdapter} from './index.js';

/** materials: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{materialOrganizer,materials,evidenceReader}:Pick<FeatureServices,"materialOrganizer"|"materials"|"evidenceReader">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>materialOrganizer.tick(200));scope?.defer(()=>materialOrganizer.close());
app.addHook('onReady',async()=>{void scope?.run(()=>materialOrganizer.tick(200));});
registerMaterialRoutes(app,materials,materialOrganizer);
registerOwnerLibraryBrowse(app,materials,evidenceReader);
registerSourceMaterialView(app,materials);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.materials',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.materials'));
    register(app,services,scope);
  },
};
