import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Config} from '../config.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {FeatureRoute} from './index.js';

export interface ConnectionsFeatureDependencies {
  readonly config:Config;
  readonly connections:Connections;
  readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly serverVersion:string;
}

/** Credential and login transport owned by the authorization platform. */
export function connectionsFeature(dependencies:ConnectionsFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.connections',mount(app:FastifyInstance){
    dependencies.connections.routes(app,{serverVersion:dependencies.serverVersion,profile:dependencies.config.profile,identity:dependencies.connectionIdentity});
  }});
}
