import type {FastifyInstance,FastifyRequest} from 'fastify';
import {goalCreateInputSchema,queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantGoals} from './assistant-goals.js';

const scopeParam=z.string().max(16000).transform((raw,context)=>{
 try{return queryScopeSchema.parse(JSON.parse(raw));}
 catch{context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid goal scope'});return z.NEVER;}
});
const timeZone=z.string().max(100).refine(value=>{
 try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}
},{message:'Unknown time zone'});
const id=(request:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(request.params).id;
const revision=z.number().int().positive().safe();

/** Owner-only goal surface. Reads and commands only touch the existing
 * commitment, Todo, calendar Action and routine services. */
export function registerAssistantGoalRoutes(app:FastifyInstance,deps:{goals:Pick<AssistantGoals,'view'|'follow'|'create'|'correct'>;owner:(request:FastifyRequest)=>void}){
 const {goals,owner}=deps;
 app.get('/api/assistant/goals',async(request,reply)=>{
  owner(request);
  const query=z.object({group:z.enum(['matter','person']),scope:scopeParam,tz:timeZone.optional()}).strict().parse(request.query);
  reply.header('Cache-Control','no-store');
  return goals.view({group:query.group,scope:query.scope,...(query.tz?{timeZone:query.tz}:{})});
 });
 app.post('/api/assistant/goals',{bodyLimit:16384},async(request,reply)=>{
  owner(request);return reply.code(201).send(goals.create(goalCreateInputSchema.parse(request.body)));
 });
 app.post('/api/assistant/goals/:id/follow',{bodyLimit:16384},async(request,reply)=>{
  owner(request);
  const body=z.object({expectedRevision:revision,scope:queryScopeSchema.optional()}).strict().parse(request.body);
  const result=goals.follow({id:id(request),...body});
  return reply.header('Cache-Control','no-store').send(result);
 });
 app.post('/api/assistant/goals/:id/action',{bodyLimit:16384},async(request,reply)=>{
  owner(request);
  const body=z.object({kind:z.enum(['commitment','todo','event']),action:z.enum(['complete','dismiss','reject']),
   expectedRevision:revision,scope:queryScopeSchema.optional()}).strict().parse(request.body);
  const result=goals.correct({id:id(request),...body});
  return reply.header('Cache-Control','no-store').send(result);
 });
}
