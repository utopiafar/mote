import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {moteText} from './i18n.js';
import {ConnectionError,type Connections,type ConnectionCredential} from './connections.js';
import type {Store} from './store.js';
import type {SourceStore} from './sources.js';
import type {FileEvidenceRequests} from './file-evidence.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {IngressService} from './ingress.js';
/** Collector authorization is checked again inside transactional source writes. */
export function registerSourceRoutes(app:FastifyInstance,{store,sources,fileEvidence,evidenceReader,ingress,connections,credential,sourceOwner}:{store:Store;sources:SourceStore;fileEvidence:FileEvidenceRequests;evidenceReader:EvidenceReader;ingress:IngressService;connections:Connections;credential:(request:FastifyRequest)=>ConnectionCredential|undefined;sourceOwner:(request:FastifyRequest,id:string)=>void}){
  app.get('/api/sources/:id/read-requests',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return fileEvidence.pending(id);});
  app.put('/api/sources/:id/read-requests/:requestId',async req=>{const {id,requestId}=req.params as {id:string;requestId:string};sourceOwner(req,id);return fileEvidence.complete(id,requestId,req.body);});
  app.get('/api/sources',async req=>{const c=credential(req);if(c)connections.assertActive(c);return {items:sources.listSources().filter(s=>!c||s.deviceId===c.deviceId)};});
  app.post('/api/sources',async req=>{const c=credential(req);if(c){connections.assertOwnDevice(c,req.body);const id=(req.body as {id?:unknown}).id;if(typeof id==='string'&&sources.listSources().some(s=>s.id===id))connections.assertOwnSource(c,id);}return sources.register(req.body);});
  app.patch('/api/sources/:id',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.update(id,z.object({name:z.string().min(1).max(200).optional(),enabled:z.boolean().optional(),initialSync:z.enum(['all','new_only']).optional(),retention:z.enum(['snapshot','reference','archive']).optional()}).strict().parse(req.body));});
  const sourceRange=z.object({sourceId:z.string().max(128).optional(),deviceId:z.string().max(128).optional(),kind:z.string().max(40).optional(),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().max(100).optional(),includeDeleted:z.enum(['true','false']).optional()}).strict();
  function scopedSourceRange(req:FastifyRequest){const q=sourceRange.parse(req.query),c=credential(req);if(c){connections.assertActive(c);if(q.deviceId&&q.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备来源。"));if(q.sourceId)sourceOwner(req,q.sourceId);q.deviceId=c.deviceId;}return {...q,includeDeleted:q.includeDeleted==='true'};}
  app.get('/api/source-items',async req=>sources.listItems(scopedSourceRange(req)));
  app.get('/api/sources/:id/items',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.listItems({...scopedSourceRange(req),sourceId:id});});
  app.put('/api/sources/:id/items',{config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return ingress.sourceItem(id,req.body,credential(req)?()=>sourceOwner(req,id):undefined);});
  app.post('/api/sources/:id/items/batch',{bodyLimit:32*1024*1024},async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const body=z.object({items:z.array(z.unknown()).min(1).max(500)}).strict().parse(req.body);return ingress.sourceBatch(id,body.items,credential(req)?()=>sourceOwner(req,id):undefined);});
  app.get('/api/sources/:id/item',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {item:sources.getItem(id,externalId)??null};});
  app.get('/api/sources/:id/history',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {items:sources.history(id,externalId)};});
  app.get('/api/layers',async()=>({...sources.summary(),memories:Number((store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as {n:number}).n)}));
  app.get('/api/sources/:id/catalog',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);sources.getSource(id);return evidenceReader.fileCatalog(id,z.object({parent:z.string().optional(),cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).parse(req.query));});
}
