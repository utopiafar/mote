import type {FastifyInstance} from 'fastify';
import type {ServerFeatureHost} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 mount point. The work-activity and automatic-activity route table
 * belongs to C26A's activity plugin; this adapter keeps feature-scoped route
 * revocation and inventory registration until the host mounts contributions
 * natively. */
export function register(app:FastifyInstance,host:ServerFeatureHost){
  host.mountDomainRoutes('mote.activity',app);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.activity',version:'1',surface:'data',runtime:'host'},
  factory:(app,_scope,_services,host)=>register(app,host),
};
