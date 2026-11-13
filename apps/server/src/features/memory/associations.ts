import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {AssistantCommitments} from '../../assistant-commitments.js';
import {registerAssistantCommitmentList} from '../../assistant-commitment-routes.js';

/** The Memory browser consumes the existing commitment projection. This read does not
 * classify people, merge names, publish interpretations or start work. */
export function registerMemoryAssociationRoutes(app:FastifyInstance,commitments:Pick<AssistantCommitments,'page'>,owner:(request:FastifyRequest)=>void){
  registerAssistantCommitmentList(app,commitments,owner);
}
