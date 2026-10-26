import {ManagedCalendar} from '../managed-calendar.js';
import type {ServerFeatureScope} from '../feature-host.js';
import type { FastifyInstance } from 'fastify';
import { registerActions } from '../actions.js';
import type { FeatureServices } from '../feature-services.js';
import { registerTodoRoutes } from '../todos.js';
import {ActionCapabilities} from '../action-capabilities.js';
import {registerActionCapabilityRoutes} from '../action-capability-routes.js';

/** actions: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{actions,connections,credential,store,sources,connectionIdentity,pluginCenter}:Pick<FeatureServices,"actions"|"connections"|"credential"|"store"|"sources"|"connectionIdentity"|"pluginCenter">,scope?:ServerFeatureScope){
 const capabilities=new ActionCapabilities(store,sources,connections,()=>pluginCenter.actionProviders()),managed=new ManagedCalendar(store,actions,capabilities,connections);
 scope?.every(15000,async()=>{await actions.tick();managed.tick();});scope?.defer(()=>actions.close());
registerActions(app,actions,connections,credential);
registerTodoRoutes(app,store);
registerActionCapabilityRoutes(app,{capabilities,managed,connections,connectionIdentity});
}
