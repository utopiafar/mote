import type {FastifyInstance,FastifyRequest} from 'fastify';
import {registerAssistantCardRoutes} from '../assistant-card-routes.js';
import {registerAssistantWorkbenchRoutes} from '../assistant-workbench-routes.js';
import type {AssistantWorkbench} from '../assistant-workbench.js';
import type {AssistantCards} from '../assistant-cards.js';
import type {AssistantNotifications} from '../assistant-notifications.js';
import type {InsightServices} from '../plugins/insight-services.js';
import type {FeatureRoute} from './index.js';

/** C26B's run manager and `/api/insights` transport are one activation. */
export function insightFeature(service:InsightServices,cards:{store:AssistantCards;notifications:AssistantNotifications;workbench:AssistantWorkbench;credential:(request:FastifyRequest)=>unknown;assertRequestActive:(request:FastifyRequest)=>void}):FeatureRoute {
  return Object.freeze({id:'mote.insights',mount(app:FastifyInstance){
    service.routes(app);registerAssistantCardRoutes(app,cards.store,cards);
    registerAssistantWorkbenchRoutes(app,cards.workbench,{...cards,available:()=>service.available});
  }});
}
