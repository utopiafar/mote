import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureHost,ServerFeatureScope} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** ask: owns its transport, data and command contributions. Query-run routes
 * are contributed by the query-runs plugin through the domain route table. */
export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.ask',version:'1',surface:'data',runtime:'host'},
  factory:(app:FastifyInstance,scope:ServerFeatureScope,services:Pick<FeatureServices,'agentFeatures'>,host:ServerFeatureHost)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.ask'));
    host.mountDomainRoutes('mote.ask',app);
  },
};
