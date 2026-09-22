import {navigationScopeSchema,MAX_CONTEXT_REF_LENGTH} from './context-navigation.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {ContextQuery} from './context-query.js';

const scope=navigationScopeSchema.shape;
const query=z.object({...scope,query:z.string().max(2000).optional(),cursor:z.string().max(4096).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),maxCharacters:z.coerce.number().int().min(1000).max(16000).optional()}).strict();
const read=z.object({...scope,refs:z.array(z.string().min(1).max(MAX_CONTEXT_REF_LENGTH)).min(1).max(50),offset:z.number().int().min(0).max(100000).default(0),length:z.number().int().min(1).max(12000).default(4000)}).strict();
/** Mounted behind the application's owner authorization hook, never a public API. */
export function registerContextRoutes(app:FastifyInstance,context:ContextQuery){
  app.get('/api/context/browse',async req=>context.browse(query.parse(req.query)));
  app.get('/api/context/retrieve',async req=>context.retrieve(query.parse(req.query)));
  app.get('/api/context/search',async req=>context.search(query.parse(req.query)));
  app.get('/api/context/bundle',async req=>context.context(query.parse(req.query)));
  app.post('/api/context/read',{bodyLimit:32768},async req=>{const {refs,offset,length,...scope}=read.parse(req.body);return context.read(refs,offset,length,scope);});
}
