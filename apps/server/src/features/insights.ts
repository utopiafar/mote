import type {FastifyInstance} from 'fastify';
import type {InsightServices} from '../plugins/insight-services.js';
import type {FeatureRoute} from './index.js';

/** C26B's run manager and `/api/insights` transport are one activation. */
export function insightFeature(service:InsightServices):FeatureRoute {
  return Object.freeze({id:'mote.insights',mount(app:FastifyInstance){service.routes(app);}});
}
