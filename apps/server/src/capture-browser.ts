import { moteText } from './i18n.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import sharp from 'sharp';
import {sourceSchema} from '@mote/shared';
import {Store,StoreError} from './store.js';
import {Connections,ConnectionError,type ConnectionCredential} from './connections.js';

const range=z.object({
  after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),
  deviceId:z.string().min(1).max(128).optional(),appId:z.string().max(300).optional(),source:sourceSchema.optional(),
  collection:z.enum(['content','activity']).optional(),
  ocrStatus:z.enum(['pending','completed','disabled','failed','unknown','not_applicable']).optional(),
  limit:z.coerce.number().int().min(1).max(60).default(30),cursor:z.string().max(512).optional(),
}).strict().refine(v=>!v.after||!v.before||Date.parse(v.after)<Date.parse(v.before),{message:'Invalid time range'});
const update=z.object({status:z.enum(['completed','failed']),ocrText:z.string().max(100000)}).strict();

export function registerCaptureBrowser(app:FastifyInstance,context:{store:Store;connections:Connections;credential:(req:FastifyRequest)=>ConnectionCredential|undefined}) {
  const {store,connections,credential}=context;
  const thumbnails=new Map<string,Buffer>();let cachedBytes=0;
  const ownRecord=(req:FastifyRequest)=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id);
    const record=store.evidence([id])[0],c=credential(req);
    if(c)connections.assertActive(c);
    // Missing and foreign IDs share a response so collectors cannot probe other devices.
    if(!record||(c&&record.deviceId!==c.deviceId))throw new ConnectionError('capture_not_found',404,moteText("采集记录不存在或已被清理。"));
    return record;
  };
  app.post('/api/capture-browser/reconcile',{bodyLimit:16384},async req=>{
    const input=z.object({deviceId:z.string().min(1).max(128),ids:z.array(z.string().uuid()).max(100)}).strict().parse(req.body);
    const c=credential(req);if(c)connections.assertOwnDevice(c,input);
    const records=new Map(store.evidence(input.ids).filter(record=>record.deviceId===input.deviceId).map(record=>[record.id,record]));
    // Missing, deleted and foreign IDs are indistinguishable. Presence alone is never an upload ACK.
    return {checkedAt:new Date().toISOString(),items:input.ids.map(id=>({id,state:records.has(id)?'present':'unavailable'}))};
  });
  // Reuse the central change cursor, projecting only this collector's own records.
  app.get('/api/capture-browser/updates',async req=>{
    const q=z.object({cursor:z.coerce.number().int().min(0).default(0),deviceId:z.string().min(1).max(128),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict().parse(req.query);
    const c=credential(req);if(c)connections.assertOwnDevice(c,q);
    const changes=store.db.prepare('SELECT seq,id,operation FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(q.cursor,q.limit);
    const items=changes.flatMap(change=>{if(change.operation!=='upsert')return [];const r=store.evidence([String(change.id)])[0];if(!r||r.deviceId!==q.deviceId||r.source!=='screen')return [];return [{id:r.id,ocr:r.ocr,textPreview:r.ocrText.slice(0,1000),textLength:r.ocrText.length,summary:r.summary?.slice(0,1000),perception:(r as unknown as Record<string,unknown>).perception,perceptionJobs:(r as unknown as Record<string,unknown>).perceptionJobs}];});
    return {items,nextCursor:changes.at(-1)?.seq??q.cursor};
  });
  app.get('/api/capture-browser',async req=>{
    const query=range.parse(req.query),c=credential(req);
    if(c){
      connections.assertActive(c);
      if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备的采集记录。"));
      query.deviceId=c.deviceId;
    }
    return store.previews(query);
  });
  const galleryRange=z.object({after:z.string().datetime({offset:true}),before:z.string().datetime({offset:true}),
    deviceId:z.string().min(1).max(128).optional(),appId:z.string().max(300).optional(),
    limit:z.coerce.number().int().min(1).max(60).default(20),cursor:z.string().min(1).max(2048).optional(),
  }).strict().refine(value=>Date.parse(value.after)<Date.parse(value.before),{message:'Invalid time range'});
  for(const mode of ['albums','album-images'] as const) app.get(`/api/capture-browser/${mode}`,async req=>{
    const query=galleryRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备的采集记录。"));query.deviceId=c.deviceId;}
    if(mode==='album-images'&&query.appId===undefined)throw new StoreError('Album appId is required');
    return store.gallery(query,mode==='albums');
  });
  const sessionRange=z.object({after:z.string().datetime({offset:true}),before:z.string().datetime({offset:true}),deviceId:z.string().min(1).max(128).optional(),
    limit:z.coerce.number().int().min(1).max(60).default(20),cursor:z.string().min(1).max(2048).optional(),sessionId:z.string().uuid().optional(),
  }).strict().refine(value=>Date.parse(value.after)<Date.parse(value.before)&&Date.parse(value.before)-Date.parse(value.after)<=32*86400000,{message:'Select up to 32 days for session browsing'});
  app.get('/api/capture-browser/sessions',async req=>{
    const query=sessionRange.parse(req.query),c=credential(req);
    if(c){connections.assertActive(c);if(query.deviceId&&query.deviceId!==c.deviceId)throw new ConnectionError('connection_scope_denied',403,moteText("只能读取本设备的采集记录。"));query.deviceId=c.deviceId;}
    return store.sessions(query);
  });
  const ownImage=(req:FastifyRequest)=>{
    const id=z.string().uuid().parse((req.params as {id:string}).id),c=credential(req);
    if(c)connections.assertActive(c);
    const record=store.imageReference(id);
    if(!record||(c&&record.deviceId!==c.deviceId))throw new ConnectionError('capture_not_found',404,moteText("采集记录不存在或已被清理。"));
    return {...record,id};
  };
  app.get('/api/capture-browser/:id',async req=>ownRecord(req));
  app.get('/api/capture-browser/:id/image',async(req,reply)=>{
    const record=ownImage(req);
    const {thumbnail}=z.object({thumbnail:z.enum(['1','true']).optional()}).strict().parse(req.query);
    if(!record.blobHash)throw new StoreError('Capture has no image',404);
    if(!thumbnail){const image=store.image(record.id);return reply.type(image.mime!).send(image.bytes);}
    let bytes=thumbnails.get(record.blobHash);
    if(bytes){thumbnails.delete(record.blobHash);thumbnails.set(record.blobHash,bytes);}
    else {
      bytes=await sharp(store.image(record.id).bytes,{limitInputPixels:24_000_000}).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();
      ownImage(req); // Re-check access and retention after asynchronous image processing.
      while(thumbnails.size>=200||cachedBytes+bytes.length>16*1024*1024){
        const oldest=thumbnails.keys().next().value;if(oldest===undefined)break;
        cachedBytes-=thumbnails.get(oldest)!.length;thumbnails.delete(oldest);
      }
      const prior=thumbnails.get(record.blobHash);if(prior)cachedBytes-=prior.length;
      thumbnails.set(record.blobHash,bytes);cachedBytes+=bytes.length;
    }
    return reply.type('image/jpeg').send(bytes);
  });
  // 100,000 valid characters may expand to 600,000 bytes through JSON escaping.
  app.post('/api/capture-browser/:id/ocr',{bodyLimit:1024*1024},async req=>{
    const record=ownRecord(req);
    return store.completeOcr(record.id,update.parse(req.body));
  });
  app.addHook('onClose',async()=>{thumbnails.clear();cachedBytes=0;});
}
