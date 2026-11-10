import {ownerRelationSchema,sourceContextUpdateSchema,type SourceConnection} from '@mote/shared';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {moteText} from './i18n.js';
import {ConnectionError,type Connections,type ConnectionCredential} from './connections.js';
import type {LayersReadModel} from './layers-read-model.js';
import type {SourceStore,SourceRegistration} from './sources.js';
import type {SourceFileCatalogRead} from './evidence-read-ports.js';
import type {IngressService} from './ingress.js';
import {captureContextChannelSchema,readCaptureContext,updateCaptureContext} from './capture-context.js';
/** Fixed trusted C10 request binding; never an ordinary plugin service. */
export interface SourceRouteAdmission {
  assertCurrent(request:FastifyRequest):void;
  assertWritable(request:FastifyRequest):void;
  sourceItem(request:FastifyRequest,sourceId:string,input:unknown):ReturnType<IngressService['sourceItem']>;
  sourceBatch(request:FastifyRequest,sourceId:string,inputs:unknown):ReturnType<IngressService['sourceBatch']>;
}
/** Collector authorization is checked again inside transactional source writes. */
export function registerSourceRoutes(app:FastifyInstance,{layers,sources,evidenceReader,ingress,connections,credential,sourceOwner,admission}:{layers:Pick<LayersReadModel,'summary'>;sources:SourceStore;evidenceReader:SourceFileCatalogRead;ingress:IngressService;connections:Connections;credential:(request:FastifyRequest)=>ConnectionCredential|undefined;sourceOwner:(request:FastifyRequest,id:string)=>void;admission?:SourceRouteAdmission}){
  if(admission)app.addHook('onRequest',async request=>{admission.assertCurrent(request);});
  const present=(req:FastifyRequest,source:SourceConnection)=>{
    if(!credential(req))return source;
    const {ownerRelation,ownerRelationVersion,sourceContext,...intake}=source;
    return intake;
  };
  app.get('/api/sources',async req=>{const c=credential(req);if(c)connections.assertActive(c);return {items:sources.listSources().filter(s=>!c||s.deviceId===c.deviceId).map(s=>present(req,s))};});
  app.post('/api/sources',async req=>{
    const check=(input:SourceRegistration)=>{admission?.assertWritable(req);const c=credential(req);
      if(c&&('ownerRelation' in input||'ownerRelationVersion' in input))throw new ConnectionError('connection_scope_denied',403,'Only the owner may declare material attribution.');
      if(c){connections.assertOwnDevice(c,input);connections.assertPlatform(c,input.platform);if(sources.listSources().some(source=>source.id===input.id))connections.assertOwnSource(c,input.id);}};
    return present(req,sources.register(req.body,check));
  });
  app.patch('/api/sources/:id',async req=>{
    const id=(req.params as {id:string}).id;sourceOwner(req,id);
    if(credential(req)&&req.body&&typeof req.body==='object'&&'ownerRelation' in req.body)throw new ConnectionError('connection_scope_denied',403,'Only the owner may declare material attribution.');
    const patch=z.object({ownerRelation:ownerRelationSchema.nullable().optional(),name:z.string().min(1).max(200).optional(),enabled:z.boolean().optional(),initialSync:z.enum(['all','new_only']).optional(),retention:z.enum(['snapshot','reference','archive']).optional()}).strict().parse(req.body);
    return present(req,sources.update(id,patch,source=>{admission?.assertWritable(req);sourceOwner(req,source.id);}));
  });
  const contextOwner=(req:FastifyRequest,id:string)=>{const c=credential(req);if(c){connections.assertActive(c);throw new ConnectionError('connection_scope_denied',403,'Only the owner may read or declare source context.');}sourceOwner(req,id);};
  const captureContextPath=z.object({deviceId:z.string().min(1).max(128),channel:captureContextChannelSchema}).strict();
  app.get('/api/devices/:deviceId/capture-context/:channel',async req=>{contextOwner(req,'');const {deviceId,channel}=captureContextPath.parse(req.params);return readCaptureContext(sources.store,sources,deviceId,channel);});
  app.patch('/api/devices/:deviceId/capture-context/:channel',async req=>{contextOwner(req,'');const {deviceId,channel}=captureContextPath.parse(req.params);return updateCaptureContext(sources.store,sources,deviceId,channel,sourceContextUpdateSchema.parse(req.body),()=>{admission?.assertWritable(req);contextOwner(req,'');});});
  app.get('/api/sources/:id/context',async req=>{const id=(req.params as {id:string}).id;contextOwner(req,id);return sources.contexts.current(id);});
  app.patch('/api/sources/:id/context',async req=>{const id=(req.params as {id:string}).id;contextOwner(req,id);return sources.updateContext(id,sourceContextUpdateSchema.parse(req.body),()=>{admission?.assertWritable(req);contextOwner(req,id);});});
  const sourceRange=z.object({sourceId:z.string().max(128).optional(),deviceId:z.string().max(128).optional(),kind:z.string().max(40).optional(),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(200).default(50),cursor:z.string().max(4096).optional(),includeDeleted:z.enum(['true','false']).optional()}).strict();
  function scopedSourceRange(req:FastifyRequest){const q=sourceRange.parse(req.query),c=credential(req);if(c){connections.assertActive(c);if(q.deviceId&&q.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备来源。"));if(q.sourceId)sourceOwner(req,q.sourceId);q.deviceId=c.deviceId;}return {...q,includeDeleted:q.includeDeleted==='true'};}
  app.get('/api/source-items',async req=>sources.listItems(scopedSourceRange(req)));
  app.get('/api/sources/:id/items',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return sources.listItems({...scopedSourceRange(req),sourceId:id});});
  app.put('/api/sources/:id/items',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);return admission?admission.sourceItem(req,id,req.body):ingress.sourceItem(id,req.body,()=>sourceOwner(req,id));});
  app.post('/api/sources/:id/items/batch',{bodyLimit:32*1024*1024},async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const body=z.object({items:z.array(z.unknown()).min(1)}).strict().parse(req.body);return admission?admission.sourceBatch(req,id,body.items):ingress.sourceBatch(id,body.items,()=>sourceOwner(req,id));});
  app.get('/api/sources/:id/item',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {item:sources.getItem(id,externalId)??null};});
  app.get('/api/sources/:id/history',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);const {externalId}=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(req.query);return {items:sources.history(id,externalId)};});
  app.get('/api/layers',async()=>layers.summary());
  app.get('/api/sources/:id/catalog',async req=>{const id=(req.params as {id:string}).id;sourceOwner(req,id);sources.getSource(id);return evidenceReader.fileCatalog(id,z.object({parent:z.string().optional(),cursor:z.string().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).parse(req.query));});
}
