import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {queryScopeSchema} from '@mote/shared';
import type {AssistantOnboarding} from './assistant-onboarding.js';
import {StoreError} from './evidence-store.js';

/** These are owner product operations, never query tools or intake flags. */
export function registerAssistantOnboardingRoutes(app:FastifyInstance,onboarding:AssistantOnboarding,owner:(request:FastifyRequest)=>void){
 const id=(raw:unknown)=>z.object({id:z.string().uuid()}).strict().parse(raw).id;
 const view=({state,counts}:ReturnType<AssistantOnboarding['get']>)=>({state,counts});
 app.post('/api/assistant/onboarding',{bodyLimit:65536},async(request,reply)=>{
  owner(request);
  const commandId=z.string().uuid().optional().parse(request.headers['idempotency-key']);
  return reply.code(202).header('Cache-Control','no-store').send(onboarding.start(request.body,commandId));
 });
 app.get('/api/assistant/onboarding/:id',async(request,reply)=>{
  owner(request);
  const query=z.object({scope:z.string().max(16000).optional()}).strict().parse(request.query);
  let scope:unknown={kind:'all'};
  if(query.scope!==undefined)try{scope=JSON.parse(query.scope);}catch{throw new StoreError('Invalid onboarding scope');}
  reply.header('Cache-Control','no-store');return view(onboarding.get(id(request.params),queryScopeSchema.parse(scope)));
 });
 app.post('/api/assistant/onboarding/:id/cancel',{bodyLimit:32768},async(request,reply)=>{
  owner(request);const input=z.object({expectedRevision:z.number().int().nonnegative().safe(),scope:queryScopeSchema}).strict().parse(request.body);
  reply.header('Cache-Control','no-store');return view(onboarding.cancel(id(request.params),input.expectedRevision,input.scope));
 });
}
