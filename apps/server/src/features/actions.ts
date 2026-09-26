import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import { registerActions } from '../actions.js';
import type { FeatureServices } from '../feature-services.js';
import { registerTodoRoutes } from '../todos.js';

/** actions: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{actions,connections,credential,store}:Pick<FeatureServices,"actions"|"connections"|"credential"|"store">,scope?:ServerFeatureScope){
 scope?.every(15000,()=>actions.tick());scope?.defer(()=>actions.close());
registerActions(app,actions,connections,credential);
registerTodoRoutes(app,store);
}
