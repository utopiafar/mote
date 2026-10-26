import {registerContextTreeRoutes} from '../context-trees.js';
import { skillCatalog } from '@mote/agent';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { navigationScopeSchema } from '../context-navigation.js';
import { ContextQuery } from '../context-query.js';
import { registerContextRoutes } from '../context-routes.js';
import { registerEvidenceRoutes } from '../evidence-routes.js';
import type { FeatureServices } from '../feature-services.js';

/** context: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{contextTrees,evidenceReader,files,sources,store}:Pick<FeatureServices,"contextTrees"|"evidenceReader"|"files"|"sources"|"store">){
registerEvidenceRoutes(app,evidenceReader);
contextTrees.initializeAutomatic(store,evidenceReader);
registerContextTreeRoutes(app,evidenceReader,contextTrees);
app.get('/api/context/segments',async req=>evidenceReader.segments(z.object({...navigationScopeSchema.shape,id:z.string().max(1600).optional(),query:z.string().max(500).optional(),cursor:z.string().max(4096).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query)));
app.get('/api/context-index',async req=>evidenceReader.catalogAsync(z.object({path:z.string().max(100).optional(),query:z.string().max(500).optional(),limit:z.coerce.number().int().min(1).max(12).optional(),...navigationScopeSchema.shape}).strict().parse(req.query)));
registerContextRoutes(app,new ContextQuery(store,sources,files,evidenceReader));
app.get('/api/skills',async()=>({items:skillCatalog()}));
}
