import type {FastifyInstance,FastifyRequest} from 'fastify';
import {queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantCommitments} from '../../assistant-commitments.js';
import {StoreError} from '../../store.js';

/** The Memory browser consumes the existing commitment projection. This read does not
 * classify people, merge names, publish interpretations or start work. */
export function registerMemoryAssociationRoutes(app:FastifyInstance,commitments:Pick<AssistantCommitments,'page'>,owner:(request:FastifyRequest)=>void){
  const page=z.object({scope:z.string().max(16000),personMemoryId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().max(1000).optional()}).strict();
  if(app.hasRoute({method:'GET',url:'/api/assistant/commitments'}))return;
  app.get('/api/assistant/commitments',async(request,reply)=>{
    owner(request);
    const {scope:raw,...query}=page.parse(request.query);
    let scope:unknown;try{scope=JSON.parse(raw);}catch{throw new StoreError('Invalid Memory association scope');}
    reply.header('Cache-Control','no-store');
    return commitments.page({...query,scope:queryScopeSchema.parse(scope)});
  });
}
