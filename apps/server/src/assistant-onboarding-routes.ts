import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {queryScopeSchema} from '@mote/shared';
import type {AssistantOnboarding} from './assistant-onboarding.js';
import {StoreError} from './store.js';

/** These are owner product operations, never query tools or intake flags. */
export function registerAssistantOnboardingRoutes(app:FastifyInstance,onboarding:AssistantOnboarding,owner:(request:FastifyRequest)=>void){
 const id=(raw:unknown)=>z.object({id:z.string().uuid()}).strict().parse(raw).id;
 app.post('/api/assistant/onboarding',{bodyLimit:65536},async(request,reply)=>{
  owner(request);return reply.code(202).send(onboarding.start(request.body));
 });
 app.get('/api/assistant/onboarding/:id',async(request,reply)=>{
  owner(request);const query=z.object({scope:z.string().max(16000)}).strict().parse(request.query);
  let scope:unknown;try{scope=JSON.parse(query.scope);}catch{throw new StoreError('Invalid onboarding scope');}
  reply.header('Cache-Control','no-store');return onboarding.get(id(request.params),queryScopeSchema.parse(scope));
 });
 app.post('/api/assistant/onboarding/:id/cancel',{bodyLimit:32768},async request=>{
  owner(request);const input=z.object({expectedRevision:z.number().int().nonnegative().safe(),scope:queryScopeSchema}).strict().parse(request.body);
  return onboarding.cancel(id(request.params),input.expectedRevision,input.scope);
 });
}
