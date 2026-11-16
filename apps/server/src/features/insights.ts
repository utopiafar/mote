import type {FastifyInstance,FastifyRequest} from 'fastify';
import {registerAssistantCardRoutes} from '../assistant-card-routes.js';
import {registerAssistantWorkbenchRoutes} from '../assistant-workbench-routes.js';
import type {AssistantWorkbench} from '../assistant-workbench.js';
import type {AssistantCards} from '../assistant-cards.js';
import type {AssistantNotifications} from '../assistant-notifications.js';
import type {AssistantOnboarding} from '../assistant-onboarding.js';
import {registerAssistantOnboardingRoutes} from '../assistant-onboarding-routes.js';
import {StoreError} from '../store.js';
import type {InsightServices} from '../plugins/insight-services.js';
import type {FeatureRoute} from './index.js';
import {PluginHostError} from '@mote/plugin-host';

/** The domain activation supplies its route alongside its lifecycle. */
export function insightFeature(service:InsightServices):FeatureRoute {
  return Object.freeze({id:'mote.insights',mount:(app:FastifyInstance)=>service.routes(app)});
}

/** Existing assistant surfaces share the insights HTTP feature. Their resource
 * owners remain separate; assembly contributes these after they are ready. */
export function insightAssistantFeature(service:InsightServices,cards:{store:AssistantCards;notifications:AssistantNotifications;workbench:AssistantWorkbench;onboarding:AssistantOnboarding;credential:(request:FastifyRequest)=>unknown;assertRequestActive:(request:FastifyRequest)=>void}):FeatureRoute {
  const available=()=>{try{return service.available;}catch(error){if(error instanceof PluginHostError)return false;throw error;}};
  return Object.freeze({id:'mote.insights',mount(app:FastifyInstance){app.register(async child=>{
    child.addHook('onRequest',async(_request,reply)=>{if(!available())return reply.code(503).send({error:'feature_unavailable'});});
    registerAssistantCardRoutes(child,cards.store,cards);
    registerAssistantWorkbenchRoutes(child,cards.workbench,{...cards,available});
    registerAssistantOnboardingRoutes(child,cards.onboarding,request=>{cards.assertRequestActive(request);if(cards.credential(request))throw new StoreError('Owner access required',403);});
  });
  }});
}
