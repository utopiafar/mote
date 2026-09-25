import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerMemoryRoutes } from '../memory-routes.js';

/** memory: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{files,lifecycle,memories,memoryPipeline,modelSettings,queryAgent,reviewExtraction,store}:Pick<FeatureServices,"files"|"lifecycle"|"memories"|"memoryPipeline"|"modelSettings"|"queryAgent"|"reviewExtraction"|"store">){
registerMemoryRoutes(app,{store,files,memories,memoryPipeline,lifecycle,modelSettings,query:input=>queryAgent(input,'query','memories'),reviewExtraction});
}
