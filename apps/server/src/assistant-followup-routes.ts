import type {FastifyInstance,FastifyRequest} from 'fastify';
import {queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantFollowup} from './assistant-followup.js';
import type {AssistantChangeFeed} from './assistant-change-feed.js';
import {StoreError} from './evidence-store.js';

/** The owner retries a saved analysis under its exact scope and revision.
 * No raw executor, batch mutation or model authorization is exposed. */
export function registerAssistantFollowupRoutes(app:FastifyInstance,followup:()=>AssistantFollowup,changes:()=>AssistantChangeFeed,owner:(request:FastifyRequest)=>void){
 const id=(request:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(request.params).id;
 app.get('/api/assistant/followups/:id',async(request,reply)=>{
  owner(request);reply.header('Cache-Control','no-store');
  const {scope}=z.object({scope:z.string().max(16000)}).strict().parse(request.query);
  let value:unknown;try{value=JSON.parse(scope);}catch{throw new StoreError('Invalid assistant detail scope');}
  return followup().retryView(id(request),queryScopeSchema.parse(value));
 });
 app.post('/api/assistant/followups/:id/retry',{bodyLimit:32768},async(request,reply)=>{
  owner(request);const {expectedRevision,scope}=z.object({expectedRevision:z.number().int().positive().safe(),scope:queryScopeSchema}).strict().parse(request.body);
  const result=followup().retry(id(request),expectedRevision,scope,changes());
  return reply.code(202).header('Cache-Control','no-store').send(result);
 });
}
