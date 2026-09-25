import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeatureServices } from '../feature-services.js';
import { scopeFields } from '../query-scope.js';

/** usage: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{usageLedger}:Pick<FeatureServices,"usageLedger">){
app.get('/api/usage',async req=>{
    const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
    const {from,to,timeZone,groupBy,page,pageSize,...filters}=z.object({from:day,to:day,timeZone:scopeFields.timeZone.default('UTC'),page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),groupBy:z.enum(['agent','module','skill','model','provider']).default('agent'),agentId:z.string().min(1).max(128).optional(),moduleId:z.string().min(1).max(128).optional(),skillId:z.string().min(1).max(128).optional(),provider:z.string().min(1).max(128).optional(),model:z.string().max(512).optional(),status:z.enum(['running','completed','failed']).optional()}).strict().refine(v=>v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=366*86400000).parse(req.query);
    return usageLedger.summary(from,to,timeZone,filters,groupBy,page,pageSize);
  });
app.put('/api/usage/prices',async req=>usageLedger.setPrice(req.body));
}
