import type { FastifyInstance } from 'fastify';
import { registerActions } from '../actions.js';
import type { FeatureServices } from '../feature-services.js';
import { registerTodoRoutes } from '../todos.js';

/** actions: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{actions,connections,credential,store}:Pick<FeatureServices,"actions"|"connections"|"credential"|"store">){
registerActions(app,actions,connections,credential);
registerTodoRoutes(app,store);
}
