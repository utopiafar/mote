import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {queryScopeSchema,type QueryScope} from '@mote/shared';
import {AssistantCards,assistantCardFeedbackSchema} from './assistant-cards.js';
import {StoreError} from './store.js';
import type {AssistantNotifications} from './assistant-notifications.js';

/** Owner feed and feedback project the same persisted card. Producers use the
 * domain service directly; this transport does not accept model publications. */
export function registerAssistantCardRoutes(app:FastifyInstance,cards:AssistantCards,options:{credential:(request:FastifyRequest)=>unknown;assertRequestActive:(request:FastifyRequest)=>void;notifications:AssistantNotifications}){
 const owner=(request:FastifyRequest)=>{options.assertRequestActive(request);if(options.credential(request))throw new StoreError('Owner access required',403);};
 const id=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
 const scope=(raw:string):QueryScope=>{
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new StoreError('Invalid assistant card scope');}
  return queryScopeSchema.parse(parsed);
 };
 const page=z.object({scope:z.string().max(16000),limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(1000).optional()}).strict();
 const single=z.object({scope:z.string().max(16000)}).strict();
 app.get('/api/assistant-notifications',async(request,reply)=>{owner(request);const q=single.parse(request.query);reply.header('Cache-Control','no-store');return options.notifications.snapshot(scope(q.scope));});
 app.get('/api/assistant-cards',async request=>{owner(request);const q=page.parse(request.query);return cards.page({scope:scope(q.scope),limit:q.limit,cursor:q.cursor});});
 app.get('/api/assistant-cards/:id',async request=>{owner(request);const q=single.parse(request.query);return cards.get(id(request.params),scope(q.scope));});
 app.get('/api/assistant-cards/:id/history',async request=>{owner(request);const q=page.parse(request.query);return cards.history(id(request.params),{scope:scope(q.scope),limit:q.limit,cursor:q.cursor});});
 app.post('/api/assistant-cards/:id/feedback',{bodyLimit:16384},async request=>{owner(request);const q=single.parse(request.query);return cards.feedback(id(request.params),assistantCardFeedbackSchema.parse(request.body),scope(q.scope));});
}
