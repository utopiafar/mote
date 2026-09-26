import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMaterialRoutes } from '../material-routes.js';

/** materials: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{materialOrganizer,materials}:Pick<FeatureServices,"materialOrganizer"|"materials">){
registerMaterialRoutes(app,materials,materialOrganizer);
}
