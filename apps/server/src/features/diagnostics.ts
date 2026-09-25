import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diagnosticStageFilters } from '../diagnostics.js';
import type { FeatureServices } from '../feature-services.js';

/** diagnostics: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{diagnosticSnapshot,diagnostics}:Pick<FeatureServices,"diagnosticSnapshot"|"diagnostics">){
app.get('/api/diagnostics',async()=>diagnosticSnapshot());
app.get('/api/diagnostics/logs',async(req,reply)=>{const {file}=z.object({file:z.coerce.number().int().min(0).max(9).default(0)}).strict().parse(req.query);return reply.type('text/plain; charset=utf-8').send(await diagnostics.readRaw(file));});
app.get('/api/diagnostics/log-pages',async req=>{const args=z.object({file:z.coerce.number().int().min(0).max(9).default(0),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(500).default(100),stage:z.enum(diagnosticStageFilters).default('all')}).strict().parse(req.query);return diagnostics.readPage(args.file,args.page,args.pageSize,args.stage);});
app.get('/api/diagnostics/events',async req=>{const args=z.object({afterSeq:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.coerce.number().int().min(1).max(500).default(200)}).strict().parse(req.query);return diagnostics.events(args.afterSeq,args.limit);});
app.get('/api/support-bundle',async(req,reply)=>{const range=z.object({after:z.string().datetime().default(new Date(Date.now()-86400000).toISOString()),before:z.string().datetime().default(new Date(Date.now()+1).toISOString())}).strict().refine(v=>v.after<v.before).parse(req.query);diagnostics.record('support.exported',{requestId:req.id});const logs=await diagnostics.exportRange(range.after,range.before);return reply.header('Content-Disposition','attachment; filename="mote-support.json"').type('application/json').send({version:1,scope:'central-safe-support',createdAt:new Date().toISOString(),snapshot:diagnosticSnapshot(),...logs});});
}
