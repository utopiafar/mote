import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {evidenceRefId,formatEvidenceRef} from '@mote/shared';
import type {EvidenceReader} from './evidence-reader.js';
import {navigationScopeSchema} from './context-navigation.js';
import {StoreError} from './store.js';

/** Owner authorization remains in the app hook; query filters can only narrow a read. */
export function registerEvidenceRoutes(app:FastifyInstance,reader:EvidenceReader){
 const capture=(req:FastifyRequest)=>{
  const value=reader.evidence([(req.params as {id:string}).id],navigationScopeSchema.parse(req.query))[0];
  if(!value)throw new StoreError('Capture not found',404);return value;
 };
 const memory=(req:FastifyRequest)=>{
  const id=evidenceRefId((req.params as {id:string}).id,'memory');
  const value=id?reader.memory(formatEvidenceRef('memory',id),navigationScopeSchema.parse(req.query)):undefined;
  if(!value)throw new StoreError('Memory not found',404);return value;
 };
 app.get('/api/captures/:id',async req=>capture(req));
 app.get('/api/captures/:id/image',async(req,reply)=>{
  const value=reader.imageReference((req.params as {id:string}).id,navigationScopeSchema.parse(req.query));
  if(!value)throw new StoreError('Capture not found',404);
  const image=reader.store.image(value.id);return reply.type(image.mime).send(image.bytes);
 });
 app.get('/api/notes/:id',async req=>{const value=capture(req);if(value.source!=='note')throw new StoreError('Note not found',404);return value;});
 app.get('/api/memories',async req=>{
  const q=z.object({...navigationScopeSchema.shape,level:z.enum(['overview','detail']).default('overview'),query:z.string().max(500).optional(),tier:z.enum(['episode','consolidated']).optional(),kind:z.enum(['episodic','semantic','procedural']).optional(),status:z.enum(['proposed','published','stale']).optional(),layer:z.enum(['observation','memory','legacy']).optional(),cursor:z.string().max(1000).optional(),includeHistory:z.enum(['true','false']).optional(),asOf:z.string().datetime({offset:true}).optional(),includeStale:z.enum(['true','false']).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).strict().parse(req.query);
  return reader.memoryPage({...q,includeStale:q.includeStale==='true',includeHistory:q.includeHistory==='true'});
 });
 app.get('/api/memories/:id',async req=>memory(req));
 app.get('/api/memories/:id/text',async(req,reply)=>reply.type('text/markdown; charset=utf-8').header('Content-Disposition','attachment; filename=memory.md').send(reader.memories.text(memory(req).id)));
 app.get('/api/memories/:id/evidence',async req=>{const value=memory(req);return {items:reader.evidence(value.evidenceIds,navigationScopeSchema.parse(req.query)),status:value.status};});
}
