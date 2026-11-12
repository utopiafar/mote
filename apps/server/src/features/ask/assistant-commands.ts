import type {FastifyInstance} from 'fastify';
import type {AssistantDrafts} from '../../assistant-drafts.js';

/** Owner command envelope for a validated answer draft. Capability selection
 * and domain effects stay in the registered handler, never in model text. */
export function registerAssistantCommandRoutes(app:FastifyInstance,commands:Pick<AssistantDrafts,'command'>){
  app.post('/api/assistant/commands',{bodyLimit:65536},async request=>commands.command(request.body));
}
