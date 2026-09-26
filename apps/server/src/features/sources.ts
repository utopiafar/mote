import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { registerSourceRoutes } from '../source-routes.js';

/** sources: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{connections,credential,evidenceReader,fileEvidence,ingress,sourceOwner,sources,store}:Pick<FeatureServices,"connections"|"credential"|"evidenceReader"|"fileEvidence"|"ingress"|"sourceOwner"|"sources"|"store">){
registerSourceRoutes(app,{store,sources,fileEvidence,evidenceReader,ingress,connections,credential,sourceOwner});
}
