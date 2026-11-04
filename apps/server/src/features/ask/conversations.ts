import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {ConversationRepository} from '../../plugins/central-contracts.js';

/** Conversation routes dispatch through the current plugin activation. */
export function registerConversationRoutes(app:FastifyInstance,conversations:()=>ConversationRepository){
  app.get('/api/conversations',async req=>conversations().list(z.object({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(1000).optional()}).strict().parse(req.query)));
  app.get('/api/conversations/:id',async req=>conversations().page(z.object({id:z.string().uuid()}).parse(req.params).id,z.object({limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().optional()}).parse(req.query)));
  app.get('/api/conversations/:id/references/:evidenceId',async req=>{const {id,evidenceId}=z.object({id:z.string().uuid(),evidenceId:z.string().uuid()}).parse(req.params);return conversations().referenceAvailability(id,evidenceId);});
  app.delete('/api/conversations/:id',async req=>conversations().delete(z.object({id:z.string().uuid()}).parse(req.params).id));
}
