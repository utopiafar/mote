import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMaterialRoutes } from '../material-routes.js';

/** materials: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{materialOrganizer,materials}:Pick<FeatureServices,"materialOrganizer"|"materials">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>materialOrganizer.tick(200));scope?.defer(()=>materialOrganizer.close());
app.addHook('onReady',async()=>{void scope?.run(()=>materialOrganizer.tick(200));});
registerMaterialRoutes(app,materials,materialOrganizer);
}
