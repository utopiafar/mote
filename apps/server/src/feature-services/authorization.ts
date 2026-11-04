import type {FastifyRequest} from 'fastify';
import type {ModelConnection} from '../background-model-authorization.js';
import type {ConnectionCredential,Connections} from '../connections.js';
import type {ModelAuthorizationHost} from '../model-authorization-host.js';

/** C04 authorization members, including request-scope closures. */
export interface AuthorizationFeatureServices {
  connections:Connections;
  connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
  credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  assertRequestActive:(request:FastifyRequest)=>void;
  sourceOwner:(request:FastifyRequest,id:string)=>void;
  modelAuthorizationHost:ModelAuthorizationHost;
  availableModelConnections:()=>ModelConnection[];
}

export const authorizationFeatureServiceMembers = ['connections','connectionIdentity','credential','assertRequestActive','sourceOwner','modelAuthorizationHost','availableModelConnections'] as const satisfies readonly (keyof AuthorizationFeatureServices)[];
