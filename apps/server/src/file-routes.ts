import type {CaptureRead} from './evidence-read-ports.js';
import {navigationScopeSchema} from './context-navigation.js';
import type {ServerDiagnostics,Operation} from './diagnostics.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {FILE_PART_BYTES,formatEvidenceRef,fileDiarizationOptionsSchema} from '@mote/shared';
import {FileStore} from './files.js';
import {FILE_THUMBNAIL_MAX_ORIGINAL_BYTES,FILE_THUMBNAIL_TYPES,createFileThumbnails,readAll,renderFileThumbnail} from './file-thumbnails.js';
import {FileReviews} from './file-reviews.js';
import {fileExportEntries,exportTar} from './file-export.js';
import {isLoopback,requestLocalJson} from './local-http.js';
import {FileProcessing} from './file-processing.js';
import {StoreError} from './store.js';
import {FileAttachments} from './file-attachments.js';
import {PlaybackGrants,type FilePlaybackGrants} from './plugins/files-source.js';
import type {IngressService} from './ingress.js';

export function registerFileRoutes(app:FastifyInstance,files:FileStore,processing:FileProcessing,ingress:IngressService,authorize:(req:FastifyRequest,sourceId:string)=>void,device:(req:FastifyRequest)=>string|undefined,reader:Pick<CaptureRead,'evidence'>,diagnostics?:ServerDiagnostics,withOwnerIntent:<T>(id:string,task:()=>T|Promise<T>)=>Promise<T>=async(_id,task)=>task(),withOwnerBatch:<T>(ids:readonly string[],task:()=>T)=>Promise<T>=async(_ids,task)=>task(),playback?:FilePlaybackGrants){
  const measure=<T>(operation:Operation,task:()=>T|Promise<T>)=>diagnostics?diagnostics.measure('file',operation,task):Promise.resolve().then(task);
  const reviews=new FileReviews(files,processing);
  const attachments=new FileAttachments(files);
  const thumbnails=createFileThumbnails();
  // C11's files-source plugin owns the grant scope. The local registry is only
  // for current callers that have not migrated to the plugin assembly yet.
  const grants:FilePlaybackGrants=playback??new PlaybackGrants();
  const ownsGrants=playback===undefined;
  const cookieName=(id:string)=>'mote_file_'+id.replace(/-/g,'');
  const id=(req:FastifyRequest)=>(req.params as {id:string}).id;
  const check=(req:FastifyRequest)=>(sourceId:string)=>authorize(req,sourceId);
  const fileId=(req:FastifyRequest)=>z.string().uuid().parse(id(req));
  const file=(req:FastifyRequest)=>{
    const id=fileId(req),v=files.version(id);authorize(req,v.source_id);
    if(!reader.evidence([formatEvidenceRef('capture',id)],navigationScopeSchema.strip().parse(req.query)).length)throw new StoreError('File not found',404);
    return files.detail(id);
  };
  app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:FILE_PART_BYTES},(_req,body,done)=>done(null,body));
  app.get('/api/file-sync/v1/capabilities',async()=>files.capabilities());
  app.get('/api/file-sync/v1/head',async req=>{const q=z.object({sourceId:z.string().min(1).max(128),externalId:z.string().min(1).max(1000)}).strict().parse(req.query);authorize(req,q.sourceId);return files.syncHead(q.sourceId,q.externalId);});
  app.get('/api/file-sync/v1/recovery',async req=>{const q=z.object({sourceId:z.string().min(1).max(128)}).strict().parse(req.query);authorize(req,q.sourceId);return files.snapshotRecovery(q.sourceId);});
  app.post('/api/file-sync/v1/recovery/:id/uploads',{bodyLimit:1024},async req=>{z.object({}).strict().parse(req.body??{});return ingress.fileRecovery(fileId(req),check(req));});
  app.post('/api/file-sync/v1/manifests',{bodyLimit:8*1024*1024},async req=>measure('file_revision',()=>ingress.fileManifests(req.body,check(req))));
  app.post('/api/file-sync/v1/uploads',{bodyLimit:32768},async req=>measure('file_upload',()=>ingress.fileBegin(req.body,check(req))));
  app.get('/api/file-sync/v1/uploads/:id',async req=>ingress.fileUpload(id(req),check(req)));
  app.put('/api/file-sync/v1/uploads/:id/parts/:part',{bodyLimit:FILE_PART_BYTES},async req=>{if(!Buffer.isBuffer(req.body))throw new StoreError('Binary part required');return measure('file_part',()=>files.part(id(req),Number((req.params as {part:string}).part),req.body as Buffer,check(req)));});
  app.post('/api/file-sync/v1/uploads/:id/commit',async(req,reply)=>{
    const controller=new AbortController(),abort=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',abort);reply.raw.once('close',abort);
    try{return await measure('file_commit',()=>ingress.fileCommit(id(req),check(req),controller.signal));}
    finally{req.raw.off('aborted',abort);reply.raw.off('close',abort);}
  });
  app.put('/api/file-sync/v1/revisions',{bodyLimit:1024*1024},async req=>measure('file_revision',()=>ingress.fileRevision(req.body,check(req))));
  app.get('/api/files',async req=>{const q=z.object({sourceId:z.string().max(128).optional(),mimePrefix:z.enum(['audio/','text/','image/']).optional(),query:z.string().max(2000).optional(),cursor:z.string().max(20).optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query);if(q.sourceId)authorize(req,q.sourceId);return files.list({...q,deviceId:device(req)});});
  app.get('/api/files/:id',async req=>({...file(req),processingPolicy:processing.explain(fileId(req)),cancellation:processing.cancellation(fileId(req))}));
  app.get('/api/files/:id/chunks',async req=>{file(req);const q=z.object({...navigationScopeSchema.shape,offset:z.coerce.number().int().min(0).default(0)}).strict().parse(req.query);const items=files.chunks(fileId(req),q.offset);return {items,nextOffset:items.length===100?q.offset+100:null};});
  app.post('/api/files/:id/playback',async(req,reply)=>{
    const id=fileId(req);file(req);
    const sourceId=files.version(id).source_id,issued=grants.issue(id,sourceId,()=>authorize(req,sourceId));
    const maxAge=Math.max(0,Math.ceil((issued.until-Date.now())/1000));
    reply.header('Set-Cookie',`${cookieName(id)}=${issued.token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Path=/api/files/${id}/content${req.protocol==='https'?'; Secure':''}`);
    return {url:'/api/files/'+id+'/content'};
  });
  app.get('/api/files/:id/content',async(req,reply)=>{
    const v=file(req);if(!v.hasOriginal)throw new StoreError('Original is not archived',404);
    let start=0,end=v.sizeBytes-1;const range=req.headers.range;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))throw new StoreError('Invalid byte range',416);if(!match[1])start=Math.max(0,v.sizeBytes-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=v.sizeBytes)throw new StoreError('Invalid byte range',416);reply.code(206).header('Content-Range',`bytes ${start}-${end}/${v.sizeBytes}`);}
    const mime=v.item.mimeType?.startsWith('audio/')?v.item.mimeType:'application/octet-stream';
    return reply.header('Accept-Ranges','bytes').header('Content-Length',Math.max(0,end-start+1)).header('Content-Disposition',`${mime==='application/octet-stream'||(req.query as {download?:string}).download==='1'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(v.item.title).replace(/'/g,'%27')}`).type(mime).send(files.stream(fileId(req),start,end));
  });
  app.get('/api/files/:id/thumbnail',async(req,reply)=>{
    const v=file(req),mime=v.item.mimeType??'';
    if(!v.hasOriginal||!FILE_THUMBNAIL_TYPES.has(mime))throw new StoreError('Thumbnail is unavailable',404);
    if(v.sizeBytes>FILE_THUMBNAIL_MAX_ORIGINAL_BYTES)throw new StoreError('Original is too large for a thumbnail',413);
    const controller=new AbortController(),abort=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',abort);reply.raw.once('close',abort);
    try{
      let bytes:Buffer;
      try{bytes=await thumbnails.get(`${v.captureId}:${v.sha256??v.item.revision}`,async()=>renderFileThumbnail(await readAll(files.stream(fileId(req),0,v.sizeBytes-1)),mime),controller.signal);}
      finally{file(req);} // Fresh access overrides both cached results and read/render failures.
      return reply.type('image/jpeg').send(bytes);
    }finally{req.raw.off('aborted',abort);reply.raw.off('close',abort);}
  });
  app.addHook('onClose',async()=>{thumbnails.clear();if(ownsGrants)grants.retire();});
  // Owner-only routes are excluded from the collector route allowlist.
  app.post('/api/records/:id/attachments/:attachmentId/processing',{bodyLimit:1024},async req=>attachments.prepare(id(req),(req.params as {attachmentId:string}).attachmentId,req.body,check(req)));
  app.delete('/api/files/:id',async req=>files.forget(fileId(req)));
  app.post('/api/files/:id/allow-again',async req=>{const q=z.object({sourceId:z.string(),externalId:z.string()}).strict().parse(req.body);return files.allowAgain(q.sourceId,q.externalId);});
  app.post('/api/files/:id/cancel',async req=>{if(device(req))throw new StoreError('Owner access required',403);z.object({}).strict().parse(req.body??{});file(req);return processing.cancel(fileId(req));});
  app.post('/api/files/:id/retry',async req=>{if(device(req))throw new StoreError('Owner access required',403);const q=z.object({stage:z.enum(['transcribe','diarize','summary']).default('transcribe'),confirmUnknown:z.boolean().default(false),diarization:z.object({artifactId:z.string().uuid(),options:fileDiarizationOptionsSchema.nullable()}).strict().optional()}).strict().parse(req.body??{});file(req);return withOwnerIntent(fileId(req),()=>processing.retry(fileId(req),q.stage,false,q.confirmUnknown,q.diarization));});
  app.get('/api/files/:id/export',async(req,reply)=>{file(req);return reply.header('Content-Disposition',`attachment; filename="mote-recording-${fileId(req)}.tar.gz"`).type('application/gzip').send(exportTar(fileExportEntries(files,fileId(req))));});
  app.get('/api/files/:id/assets',async(req,reply)=>{file(req);const q=z.object({artifactId:z.string().uuid(),name:z.string().max(100)}).strict().parse(req.query);const asset=files.asset(fileId(req),q.artifactId,q.name);return reply.header('Cache-Control','no-store').type(asset.mime).send(asset.bytes);});
  app.get('/api/files/:id/reviews',async req=>{file(req);return reviews.list(fileId(req));});
  app.post('/api/files/:id/reviews',{bodyLimit:16384},async req=>{file(req);return reviews.propose(fileId(req),req.body);});
  app.post('/api/files/:id/reviews/:reviewId',{bodyLimit:65536},async req=>{file(req);return reviews.confirm(fileId(req),(req.params as {reviewId:string}).reviewId,req.body);});
  app.post('/api/files/:id/corrections',{bodyLimit:131072},async req=>{if(device(req))throw new StoreError('Owner access required',403);file(req);return reviews.correct(fileId(req),req.body);});
  app.post('/api/files/:id/speakers',{bodyLimit:16384},async req=>{file(req);return reviews.nameSpeakers(fileId(req),req.body);});
  app.post('/api/file-processing/test-local',async req=>{const q=z.object({serviceId:z.string().max(100).optional()}).strict().parse(req.body??{}),settings=processing.localService(q.serviceId);if(!isLoopback(settings.endpoint))throw new StoreError('Local worker must use loopback');const endpoint=new URL(settings.endpoint);endpoint.pathname='/health';return z.object({version:z.number(),execution:z.literal('local'),asr:z.boolean(),diarization:z.boolean(),wespeaker:z.boolean().optional()}).parse(await requestLocalJson(endpoint,{headers:settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{},signal:AbortSignal.timeout(10000),limit:4096}));});
  app.get('/api/file-processing',async()=>processing.view());
  app.post('/api/file-processing/match',async req=>processing.match(req.body));
  app.post('/api/file-processing/preview',async req=>processing.preview(req.body));
  app.post('/api/file-processing/reprocess',async req=>{const targets=processing.reprocessTargets(req.body);return targets.length?withOwnerBatch(targets,()=>processing.reprocess(req.body)):processing.reprocess(req.body);});
  app.put('/api/file-processing',{bodyLimit:262144},async req=>processing.save(req.body));
  return (req:FastifyRequest)=>{
    if(req.routeOptions.url!=='/api/files/:id/content'||!['GET','HEAD'].includes(req.method))return false;
    const parsed=z.string().uuid().safeParse(id(req));if(!parsed.success)return false;
    const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName(parsed.data)+'='))?.split('=')[1];
    return grants.verify(parsed.data,token);
  };
}
