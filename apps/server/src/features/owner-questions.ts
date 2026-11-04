import type {FastifyInstance} from 'fastify';
import type {ServerFeatureHost} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 mount point. The owner-question ledger and HTTP table belong to
 * C26C's owner-question plugin; this adapter keeps feature-scoped route
 * revocation and inventory registration until the host mounts contributions
 * natively. */
export function register(app:FastifyInstance,host:ServerFeatureHost){
  host.mountDomainRoutes('mote.owner-questions',app);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.owner-questions',version:'1',surface:'data',runtime:'host'},
  factory:(app,_scope,_services,host)=>register(app,host),
};
