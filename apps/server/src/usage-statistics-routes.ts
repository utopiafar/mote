import type {FastifyInstance, FastifyRequest} from 'fastify';
import {usageActivityKinds, usageFailureKinds} from '@mote/shared';
import {z} from 'zod';
import {scopeFields} from './query-scope.js';
import type {UsageStatistics} from './usage-statistics.js';

const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
const timeZone=scopeFields.timeZone.default('UTC');
const range=z.object({from:day,to:day,timeZone});
const bounded=({from,to}:z.infer<typeof range>)=>from<=to&&Date.parse(to)-Date.parse(from)<30*86_400_000;
const position=z.object({at:z.string().datetime(),key:z.string().min(1).max(512)}).strict();
const page={
  limit:z.coerce.number().int().min(1).max(50).default(20),
  cursor:z.string().max(1000).transform((value,context)=>{
    try {return position.parse(JSON.parse(Buffer.from(value,'base64url').toString()));}
    catch {context.addIssue({code:'custom',message:'Invalid statistics cursor'});return z.NEVER;}
  }).optional(),
};
const summary=range.strict().refine(bounded);
const activity=z.object({day,timeZone,kind:z.enum(usageActivityKinds).optional(),...page}).strict();
const failures=range.extend({kind:z.enum(usageFailureKinds),...page}).strict().refine(bounded);

export function registerUsageStatisticsRoutes(app:FastifyInstance,statistics:UsageStatistics,owner:(req:FastifyRequest)=>void) {
  app.get('/api/usage-statistics', request=>{
    owner(request);
    return statistics.summary(summary.parse(request.query));
  });
  app.get('/api/usage-statistics/day', request=>{
    owner(request);
    const {day,timeZone,...query}=activity.parse(request.query);
    return statistics.day(day,timeZone,query);
  });
  app.get('/api/usage-statistics/failures', request=>{
    owner(request);
    const {from,to,timeZone,...query}=failures.parse(request.query);
    return statistics.failures({from,to,timeZone},query);
  });
}
