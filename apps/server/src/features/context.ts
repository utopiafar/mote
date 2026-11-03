import type {FastifyInstance} from 'fastify';
import type {ServerFeatureHost,ServerFeatureScope} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 mount point. The context route table and context-tree registry belong
 * to the evidence-context-reader plugin; this adapter keeps feature-scoped route
 * revocation and Agent-tool disposal until the host mounts them natively. */
export function register(app:FastifyInstance,scope:ServerFeatureScope|undefined,host:ServerFeatureHost){
 scope?.assertCurrent();
 host.mountDomainRoutes('mote.context',app);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.context',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services,host)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.context'));
    register(app,scope,host);
  },
};
