import type {FastifyInstance} from 'fastify';
import type {FeatureServices} from '../feature-services.js';
import type {ServerFeatureHost,ServerFeatureScope} from '../feature-host.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 mount point. The materials route table belongs to the material-context
 * plugin, and the organizer poll belongs to its domain plugin. This adapter keeps
 * feature-scoped revocation, inventory and Agent-tool disposal until the host
 * mounts domain contributions natively. */
export function register(app:FastifyInstance,{materialOrganizer}:Pick<FeatureServices,'materialOrganizer'>,scope:ServerFeatureScope|undefined,host:ServerFeatureHost){
 app.addHook('onReady',async()=>{void scope?.run(()=>materialOrganizer.tick(200));});
 host.mountDomainRoutes('mote.materials',app);
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.materials',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services,host)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.materials'));
    register(app,services,scope,host);
  },
};
