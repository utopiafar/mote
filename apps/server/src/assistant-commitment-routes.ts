import type {FastifyInstance,FastifyRequest} from 'fastify';
import {queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantCommitments} from './assistant-commitments.js';
import {StoreError} from './store.js';

/** Shared owner read of the existing commitment projection. Memory and
 * matter details use the same list; register it once per server. */
const registeredServers=new WeakSet<object>();
const listQuery=z.object({
  scope:z.string().max(16000),
  limit:z.coerce.number().int().min(1).max(100).optional(),
  cursor:z.string().max(1000).optional(),
  matterId:z.string().uuid().optional(),
  personMemoryId:z.string().uuid().optional(),
}).strict();

export function registerAssistantCommitmentList(
  app:FastifyInstance,
  commitments:Pick<AssistantCommitments,'page'>,
  owner:(request:FastifyRequest)=>void,
){
  const key=app.server;
  if(registeredServers.has(key))return;
  registeredServers.add(key);
  app.get('/api/assistant/commitments',async(request,reply)=>{
    owner(request);
    const {scope:raw,...query}=listQuery.parse(request.query);
    let scope:unknown;try{scope=JSON.parse(raw);}catch{throw new StoreError('Invalid assistant detail scope');}
    reply.header('Cache-Control','no-store');
    return commitments.page({...query,scope:queryScopeSchema.parse(scope)});
  });
}
