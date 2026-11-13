import type {FastifyInstance,FastifyRequest} from 'fastify';
import {queryScopeSchema} from '@mote/shared';
import {z} from 'zod';
import type {AssistantDrafts} from '../../assistant-drafts.js';
import type {AssistantTasks} from '../../assistant-tasks.js';
import {StoreError} from '../../store.js';

/** Owner command envelope for a validated answer draft. Capability selection
 * and domain effects stay in the registered handler, never in model text. */
export function registerAssistantCommandRoutes(app:FastifyInstance,commands:Pick<AssistantDrafts,'command'>,
  tasks:Pick<AssistantTasks,'byTurn'|'get'>,owner:(request:FastifyRequest)=>void){
  app.post('/api/assistant/commands',{bodyLimit:65536},async request=>{owner(request);return commands.command(request.body);});
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
}
