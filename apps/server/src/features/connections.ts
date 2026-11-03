import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import type {ServerFeatureAdapter} from './index.js';

/** Pre-H14 mount point. The routes, LoginHandoffs and credential lifecycle belong
 * to the authorization platform contribution; this adapter only installs them in
 * the feature host's HTTP scope. */
export function register(app:FastifyInstance,{config,connections,connectionIdentity,serverVersion}:Pick<FeatureServices,"config"|"connections"|"connectionIdentity"|"serverVersion">){
  connections.routes(app,{serverVersion,profile:config.profile,identity:connectionIdentity});
}

export const adapter:ServerFeatureAdapter={
  descriptor:{id:'mote.connections',version:'1',surface:'data',runtime:'host'},
  factory:(app,scope,services)=>{
    scope.retire(()=>services.agentFeatures.dispose('mote.connections'));
    register(app,services);
  },
};
