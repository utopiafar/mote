import {randomBytes} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {FILE_PART_BYTES} from '@mote/shared';
import {FileStore} from './files.js';
import {FileReviews} from './file-reviews.js';
import {fileExportEntries,exportTar} from './file-export.js';
import {isLoopback,readProcessorJson} from './file-processors.js';
import {FileProcessing} from './file-processing.js';
import {StoreError} from './store.js';

export function registerFileRoutes(app:FastifyInstance,files:FileStore,processing:FileProcessing,authorize:(req:FastifyRequest,sourceId:string)=>void,device:(req:FastifyRequest)=>string|undefined){
  const reviews=new FileReviews(files,processing);
  const grants=new Map<string,{id:string;until:number;check:()=>void}>();
  const cookieName=(id:string)=>'mote_file_'+id.replace(/-/g,'');
  const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
  const check=(req:FastifyRequest)=>(sourceId:string)=>authorize(req,sourceId);
  const file=(req:FastifyRequest)=>{const v=files.version(id(req));authorize(req,v.source_id);return files.detail(id(req));};
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:FILE_PART_BYTES},(_req,body,done)=>done(null,body));
  app.get('/api/file-sync/v1/capabilities',async()=>files.capabilities());
  app.get('/api/file-sync/v1/head',{config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>{const q=z.object({sourceId:z.string().min(1).max(128),externalId:z.string().min(1).max(1000)}).strict().parse(req.query);authorize(req,q.sourceId);return {revision:files.sources.getItem(q.sourceId,q.externalId)?.revision??null,forgotten:!!files.store.db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(q.sourceId,q.externalId)};});
  app.post('/api/file-sync/v1/uploads',{bodyLimit:32768},async req=>files.begin(req.body,check(req)));
  app.get('/api/file-sync/v1/uploads/:id',async req=>files.upload(id(req),check(req)));
  app.put('/api/file-sync/v1/uploads/:id/parts/:part',{bodyLimit:FILE_PART_BYTES},async req=>{if(!Buffer.isBuffer(req.body))throw new StoreError('Binary part required');return files.part(id(req),Number((req.params as {part:string}).part),req.body,check(req));});
  app.post('/api/file-sync/v1/uploads/:id/commit',async req=>files.commit(id(req),check(req)));
  app.put('/api/file-sync/v1/revisions',{bodyLimit:32768,config:{rateLimit:{max:600,timeWindow:'1 minute'}}},async req=>files.revision(req.body,check(req)));
  app.get('/api/files',async req=>{const q=z.object({sourceId:z.string().max(128).optional(),mimePrefix:z.enum(['audio/','text/','image/']).optional(),query:z.string().max(2000).optional(),cursor:z.string().max(20).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query);if(q.sourceId)authorize(req,q.sourceId);return files.list({...q,deviceId:device(req)});});
  app.get('/api/files/:id',async req=>file(req));
  app.get('/api/files/:id/chunks',async req=>{file(req);const q=z.object({offset:z.coerce.number().int().min(0).default(0)}).strict().parse(req.query);const items=files.chunks(id(req),q.offset);return {items,nextOffset:items.length===100?q.offset+100:null};});
  app.post('/api/files/:id/playback',async(req,reply)=>{
    file(req);const token=randomBytes(32).toString('hex');for(const [key,value] of grants)if(value.until<Date.now())grants.delete(key);
    if(grants.size>=200)throw new StoreError('Too many playback sessions',429);
    const sourceId=files.version(id(req)).source_id;grants.set(token,{id:id(req),until:Date.now()+300000,check:()=>authorize(req,sourceId)});
    reply.header('Set-Cookie',`${cookieName(id(req))}=${token}; HttpOnly; SameSite=Strict; Max-Age=300; Path=/api/files/${id(req)}/content${req.protocol==='https'?'; Secure':''}`);
    return {url:'/api/files/'+id(req)+'/content'};
  });
  app.get('/api/files/:id/content',async(req,reply)=>{
    const v=file(req);if(!v.hasOriginal)throw new StoreError('Original is not archived',404);
    let start=0,end=v.sizeBytes-1;const range=req.headers.range;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))throw new StoreError('Invalid byte range',416);if(!match[1])start=Math.max(0,v.sizeBytes-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=v.sizeBytes)throw new StoreError('Invalid byte range',416);reply.code(206).header('Content-Range',`bytes ${start}-${end}/${v.sizeBytes}`);}
    const mime=v.item.mimeType?.startsWith('audio/')?v.item.mimeType:'application/octet-stream';
    return reply.header('Accept-Ranges','bytes').header('Content-Length',Math.max(0,end-start+1)).header('Content-Disposition',`${mime==='application/octet-stream'||(req.query as {download?:string}).download==='1'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(v.item.title).replace(/'/g,'%27')}`).type(mime).send(files.stream(id(req),start,end));
  });
  // Owner-only routes are excluded from the collector route allowlist.
  app.delete('/api/files/:id',async req=>files.forget(id(req)));
  app.post('/api/files/:id/allow-again',async req=>{const q=z.object({sourceId:z.string(),externalId:z.string()}).strict().parse(req.body);files.store.db.prepare('DELETE FROM file_forgotten WHERE source_id=? AND external_id=?').run(q.sourceId,q.externalId);return {allowed:true};});
  app.post('/api/files/:id/retry',async req=>{const q=z.object({stage:z.enum(['transcribe','diarize','summary']).default('transcribe')}).strict().parse(req.body??{});return processing.retry(id(req),q.stage);});
  app.get('/api/files/:id/export',async(req,reply)=>{file(req);return reply.header('Content-Disposition',`attachment; filename="mote-recording-${id(req)}.tar.gz"`).type('application/gzip').send(exportTar(fileExportEntries(files,id(req))));});
  app.get('/api/files/:id/assets',async(req,reply)=>{file(req);const q=z.object({artifactId:z.string().uuid(),name:z.string().max(100)}).strict().parse(req.query);const asset=files.asset(id(req),q.artifactId,q.name);return reply.header('Cache-Control','no-store').type(asset.mime).send(asset.bytes);});
  app.get('/api/files/:id/reviews',async req=>{file(req);return reviews.list(id(req));});
  app.post('/api/files/:id/reviews',{bodyLimit:16384,config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async req=>{file(req);return reviews.propose(id(req),req.body);});
  app.post('/api/files/:id/reviews/:reviewId',{bodyLimit:65536},async req=>{file(req);return reviews.confirm(id(req),(req.params as {reviewId:string}).reviewId,req.body);});
  app.post('/api/files/:id/speakers',{bodyLimit:16384},async req=>{file(req);return reviews.nameSpeakers(id(req),req.body);});
  app.post('/api/file-processing/test-local',async()=>{const settings=processing.currentSettings();if(!isLoopback(settings.localEndpoint))throw new StoreError('Local worker must use loopback');const endpoint=new URL(settings.localEndpoint);endpoint.pathname='/health';const response=await fetch(endpoint,{headers:settings.localWorkerApiKey?{Authorization:`Bearer ${settings.localWorkerApiKey}`}:{},signal:AbortSignal.timeout(10000),redirect:'error'});return z.object({version:z.number(),execution:z.literal('local'),asr:z.boolean(),diarization:z.boolean()}).strict().parse(await readProcessorJson(response,4096));});
  app.get('/api/file-processing',async()=>processing.view());
  app.put('/api/file-processing',{bodyLimit:16384},async req=>processing.update(req.body));
  return (req:FastifyRequest)=>{
    if(req.routeOptions.url!=='/api/files/:id/content'||!['GET','HEAD'].includes(req.method))return false;
    const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(id(req))+'='))?.split('=')[1];
    const grant=token?grants.get(token):undefined;if(!grant||grant.id!==id(req)||grant.until<Date.now())return false;
    grant.check();return true;
  };
}
