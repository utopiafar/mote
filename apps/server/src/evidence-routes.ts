import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {evidenceRefId,formatEvidenceRef} from '@mote/shared';
import type {EvidenceReader} from './evidence-reader.js';
import {navigationScopeSchema} from './context-navigation.js';
import {StoreError} from './store.js';
import type {Memory} from './memory-schema.js';

function memoryText(m:Memory){return `# ${m.title}\n\n${m.statement}\n\n## Uncertainty\n\n${m.uncertainty}\n\n## Provenance\n\nStatus: ${m.status}\nTier: ${m.tier??'episode'}\nKind: ${m.kind??'episodic'}\nModel: ${m.model}\nSkill: ${m.skillVersion??'unknown'}\n\n${(m.evidence??[]).map(e=>`- ${e.id} (${e.occurredAt??e.recordedAt??e.capturedAt})${e.quote?'\n  '+e.quote.replaceAll('\n','\n  '):''}`).join('\n')}\n`;}

/** Owner authorization remains in the app hook; query filters can only narrow a read. */
export function registerEvidenceRoutes(app:FastifyInstance,reader:EvidenceReader){
 const capture=(req:FastifyRequest)=>{
  const value=reader.archivedEvidence([formatEvidenceRef('capture',z.string().uuid().parse((req.params as {id:string}).id))],navigationScopeSchema.parse(req.query))[0];
  if(!value)throw new StoreError('Capture not found',404);return value;
 };
 const memory=async(req:FastifyRequest)=>{
  const id=z.string().uuid().parse((req.params as {id:string}).id);
  const value=await reader.memoryAsync(formatEvidenceRef('memory',id),navigationScopeSchema.parse(req.query),true);
  if(!value)throw new StoreError('Memory not found',404);return value;
 };
 app.get('/api/captures/:id',async req=>capture(req));
 app.get('/api/captures/:id/image',async(req,reply)=>{
  const value=reader.imageReference(formatEvidenceRef('capture',z.string().uuid().parse((req.params as {id:string}).id)),navigationScopeSchema.parse(req.query));
  if(!value)throw new StoreError('Capture not found',404);
  const image=reader.store.image(value.id);return reply.type(image.mime).send(image.bytes);
 });
 app.get('/api/notes/:id',async req=>{const value=capture(req);if(value.source!=='note')throw new StoreError('Note not found',404);return value;});
 app.get('/api/memories',async req=>{
  const q=z.object({...navigationScopeSchema.shape,level:z.enum(['overview','detail']).default('overview'),query:z.string().max(500).optional(),tier:z.enum(['episode','consolidated']).optional(),kind:z.enum(['episodic','semantic','procedural']).optional(),status:z.enum(['proposed','published','stale']).optional(),layer:z.enum(['observation','memory']).optional(),cursor:z.string().max(1000).optional(),includeHistory:z.enum(['true','false']).optional(),asOf:z.string().datetime({offset:true}).optional(),includeStale:z.enum(['true','false']).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().parse(req.query);
  return reader.memoryPageAsync({...q,includeStale:q.includeStale==='true',includeHistory:q.includeHistory==='true'},true);
 });
 app.get('/api/memories/:id',async req=>memory(req));
 app.get('/api/memories/:id/text',async(req,reply)=>reply.type('text/markdown; charset=utf-8').header('Content-Disposition','attachment; filename=memory.md').send(memoryText(await memory(req))));
 app.get('/api/memories/:id/evidence',async req=>{const value=await memory(req);return {items:reader.archivedEvidence((value.evidenceIds as string[]).map(id=>formatEvidenceRef('capture',id)),navigationScopeSchema.parse(req.query)),status:value.status};});
}
