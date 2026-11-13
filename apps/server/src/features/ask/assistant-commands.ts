import type {FastifyInstance,FastifyRequest} from 'fastify';
import {assistantTaskInputSchema,queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantDrafts} from '../../assistant-drafts.js';
import type {AssistantTasks} from '../../assistant-tasks.js';
import type {AssistantRoutines} from '../../assistant-routines.js';
import {StoreError} from '../../store.js';

/** Owner command envelope for a validated answer draft. Capability selection
 * and domain effects stay in the registered handler, never in model text. */
export function registerAssistantCommandRoutes(app:FastifyInstance,commands:Pick<AssistantDrafts,'command'>,
  tasks:Pick<AssistantTasks,'byTurn'|'get'|'acceptSuggestion'>,owner:(request:FastifyRequest)=>void,routines:Pick<AssistantRoutines,'create'|'update'|'get'>){
  app.post('/api/assistant/commands',{bodyLimit:65536},async request=>{owner(request);return commands.command(request.body);});
  // The card command lends no model authority. The task service owns acceptance,
  // creation and enqueue transaction, including retries after a lost response.
  const acceptance=assistantTaskInputSchema.extend({cardId:z.string().uuid(),expectedRevision:z.number().int().positive().safe()});
  app.post('/api/assistant/tasks',{bodyLimit:65536},async request=>{
    owner(request);const {cardId,expectedRevision,...input}=acceptance.parse(request.body);
    const task=tasks.acceptSuggestion(input,{cardId,expectedRevision});
    return {requestId:input.requestId,taskId:task.id};
  });
  app.get('/api/conversations/:id/messages/:messageId/assistant-tasks',async request=>{
    owner(request);
    const {id,messageId}=z.object({id:z.string().uuid(),messageId:z.string().uuid()}).parse(request.params);
    const query=z.object({scope:z.string().max(16000)}).strict().parse(request.query);
    let value:unknown;try{value=JSON.parse(query.scope);}catch{throw new StoreError('Invalid assistant task scope');}
    return tasks.byTurn(id,messageId,queryScopeSchema.parse(value));
  });
  app.get('/api/assistant/tasks/:id',async request=>{
    owner(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const query=z.object({scope:z.string().max(16000)}).strict().parse(request.query);
    let value:unknown;try{value=JSON.parse(query.scope);}catch{throw new StoreError('Invalid assistant task scope');}
    return tasks.get(id,queryScopeSchema.parse(value));
  });
  // These owner commands configure rules; the occurrence admission itself is
  // intentionally not an HTTP or query-tool capability.
  app.post('/api/assistant/routines',{bodyLimit:65536},async request=>{owner(request);return routines.create(request.body);});
  app.post('/api/assistant/routines/:id',{bodyLimit:65536},async request=>{
    owner(request);const {id}=z.object({id:z.string().uuid()}).parse(request.params);
    const body=z.record(z.unknown()).parse(request.body);if('ruleId' in body)throw new StoreError('Routine ID belongs in the path');
    return routines.update({...body,ruleId:id});
  });
}
