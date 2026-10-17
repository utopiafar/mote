import {decodeIngressBundle} from './ingress-bundle.js';
import {importDeclarationSchema} from './import-attribution.js';
import type {FastifyRequest} from 'fastify';
import {Readable} from 'node:stream';
import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync} from 'node:fs';
import {isAbsolute,parse,join} from 'node:path';
import {z} from 'zod';
import {FILE_PART_BYTES,FILE_MAX_BYTES,fileRevisionSchema,sourceIdSchema} from '@mote/shared';
import {registerUserRoute,registerAuthenticatedRoute,type ScopedRuntime} from './http.js';
import {ScopeError} from './baseline.js';
import {PrivateDataError} from './private-data-sql.js';
import {IngressHost,INGRESS_DOMAIN,type UserIngress} from './ingress.js';
import {bytesHash} from './originals.js';
import type {DatabaseSync} from 'node:sqlite';
const id=(request:FastifyRequest)=>(request.params as {id:string}).id;
const version=(request:FastifyRequest)=>{if(request.headers['x-mote-ingress-version']!=='3')throw new ScopeError('incompatible_protocol',426);};
const batch=z.object({batchId:z.string().min(1).max(256),items:z.array(z.unknown()).min(1).max(500),importDeclaration:importDeclarationSchema.optional()}).strict();

/** Restores only the version-3, account-bound ingress. Old owner transports,
 * shell execution, processor algorithms and external connectors remain closed. */
export function registerIngress(runtime:ScopedRuntime,db:DatabaseSync,directory:string){
 runtime.app.addContentTypeParser('application/x-ndjson+gzip',{parseAs:'buffer',bodyLimit:16*1024*1024},(request,body,done)=>{
  try{if(request.method!=='POST'||!/^\/api\/ingress\/sources\/[A-Za-z0-9_.:-]+\/captures$/.test(request.url))throw new PrivateDataError('invalid_data');done(null,decodeIngressBundle(body as Buffer,request.headers['x-mote-batch-id']));}
  catch(error){done(error as Error);}
 });
 const host=new IngressHost(runtime,db,directory);
 const service=(services:ReturnType<ScopedRuntime['services']['forUser']>)=>services.get<UserIngress>(INGRESS_DOMAIN);
 // Original generic Imports byte transport. Authentication stays Wire2; M03's
 // device-only credentials still cannot use these management endpoints.
 // Share byte decoding with other authenticated binary routes. Imports-only
 // validation belongs to the selected route, not the global MIME parser.
 runtime.app.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:FILE_PART_BYTES},(_request,body,done)=>done(null,body));
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/import-uploads',bodyLimit:4096,service:INGRESS_DOMAIN,handle:({services,request})=>service(services).beginImportUpload(request.body)});
 registerUserRoute(runtime,{scope:'user',method:'PUT',url:'/api/import-uploads/:id/parts/:part',bodyLimit:FILE_PART_BYTES,service:INGRESS_DOMAIN,handle:({services,request})=>{if(request.headers['content-type']?.split(';',1)[0].trim().toLowerCase()!=='application/octet-stream')throw new PrivateDataError('invalid_data');const value=z.object({id:z.string().uuid(),part:z.string().regex(/^[0-9]+$/).pipe(z.coerce.number().int().nonnegative())}).parse(request.params);return service(services).importUploadPart(value.id,value.part,request.body as Buffer);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/import-uploads/:id/commit',service:INGRESS_DOMAIN,handle:({services,request})=>{z.object({}).strict().parse(request.body??{});return service(services).commitImportUpload(z.object({id:z.string().uuid()}).parse(request.params).id);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/archived-files/:id',service:INGRESS_DOMAIN,handle:({services,request})=>service(services).archivedFile(z.object({id:z.string().uuid()}).parse(request.params).id)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/captures/:id/archived-files',service:INGRESS_DOMAIN,handle:({services,request})=>service(services).captureArchivedFiles(z.object({id:z.string().uuid()}).parse(request.params).id)});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/archived-files/:id/content',service:INGRESS_DOMAIN,handle:({services,request,reply})=>{const user=service(services),file=user.archivedFile(z.object({id:z.string().uuid()}).parse(request.params).id);return reply.type('application/octet-stream').header('Cache-Control','no-store').header('Content-Security-Policy',"default-src 'none'; sandbox").header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`).send(user.archivedBytes(file.id));}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/devices',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).registerDevice(request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/devices/heartbeat',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).heartbeat(request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/devices/:id/reconcile',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).reconcile(id(request),request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/devices',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).devices();}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/sources',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).registerSource(request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/ingress/sources/:id',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).configureSource(id(request),request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/sources/:id/context',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const query=z.object({version:z.coerce.number().int().positive().optional()}).strict().parse(request.query);return service(services).sourceContext(id(request),query.version);}});
 registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/ingress/sources/:id/context',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).configureSourceContext(id(request),request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/sources/:id/head',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const query=z.object({externalId:z.string().min(1).max(1000)}).strict().parse(request.query);return service(services).sourceHead(id(request),query.externalId);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/sources/:id/captures',bodyLimit:16*1024*1024,service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const input=batch.parse(request.body);return service(services).receiveCaptures(id(request),input.batchId,input.items,input.importDeclaration);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/sources/:id/items',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const input=batch.parse(request.body);return service(services).receiveSourceItems(id(request),input.batchId,input.items,input.importDeclaration);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/sources/:id/receipts/:batch',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).batchReceipt(id(request),(request.params as {batch:string}).batch);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/sources/:id/uploads',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).beginUpload(id(request),request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/sources/:id/recovery',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).snapshotRecovery(id(request),z.object({after:z.string().optional()}).strict().parse(request.query).after);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/sources/:id/recovery/:captureId/uploads',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).beginSnapshotRecovery(id(request),z.object({captureId:z.string().uuid()}).passthrough().parse(request.params).captureId,request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'PUT',url:'/api/ingress/uploads/:id/parts/:part',bodyLimit:6*1024*1024,service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).uploadPart(id(request),z.coerce.number().int().nonnegative().parse((request.params as {part:string}).part),request.body);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/uploads/:id/commit',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);z.object({}).strict().parse(request.body??{});return service(services).commitUpload(id(request));}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/uploads/:id',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);return service(services).uploadReceipt(id(request));}});
 registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/ingress/sources/:id/originals',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const query=z.object({after:z.string().optional(),limit:z.coerce.number().int().optional()}).strict().parse(request.query);return service(services).pageOriginals(id(request),query.after,query.limit);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/originals/:id/tickets',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);const input=z.object({mode:z.enum(['download','play']).default('download')}).strict().parse(request.body);return service(services).ticket('original:'+id(request),input.mode);}});
 registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/ingress/gc',service:INGRESS_DOMAIN,handle:({services,request})=>{version(request);z.object({}).strict().parse(request.body);return service(services).gc();}});
 registerAuthenticatedRoute(runtime,{method:'GET',url:'/api/ingress/originals/:id/content',handle:(context,request,reply)=>{
  version(request);const {ticket}=z.object({ticket:z.string().max(4096)}).strict().parse(request.query),ref='original:'+id(request),ingress=host.forUser(context),mode=ingress.verifyTicket(ref,ticket),info=ingress.readOriginal(ref,{length:0});
  let start=0,end=info.totalBytes-1;const range=request.headers.range;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||!match[1]&&!match[2])throw new PrivateDataError('invalid_data',416);if(!match[1])start=Math.max(0,info.totalBytes-Number(match[2]));else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=info.totalBytes||end<start)throw new PrivateDataError('invalid_data',416);reply.code(206).header('Content-Range',`bytes ${start}-${end}/${info.totalBytes}`);}
  const size=Math.max(0,end-start+1),mime=/^(?:audio|video)\/[A-Za-z0-9.+-]+$/.test(info.mime)?info.mime:'application/octet-stream';
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Content-Type',mime).header('Content-Length',size).header('Accept-Ranges','bytes').header('Content-Disposition',mode==='play'&&mime!=='application/octet-stream'?'inline':'attachment');
  return reply.send(Readable.from((function*(){for(let offset=start;offset<=end;){ingress.verifyTicket(ref,ticket);const part=ingress.readOriginal(ref,{offset,length:Math.min(FILE_PART_BYTES,end-offset+1)});offset+=part.bytes.length;yield part.bytes;}})()));
 }});
 registerAuthenticatedRoute(runtime,{method:'POST',url:'/api/ingress/host-import',administrator:true,handle:async(context,request)=>{
  version(request);if(runtime.accounts?.credentialInfo(context,runtime.authority).deviceId)throw new ScopeError('invalid_identity',403);const input=z.object({sourceId:sourceIdSchema,batchId:z.string().min(1).max(256),path:z.string().min(1).max(4096),revision:fileRevisionSchema}).strict().parse(request.body);
  if(!isAbsolute(input.path)||input.path.split(/[\\/]/).includes('..'))throw new PrivateDataError('invalid_data');
  let current=parse(input.path).root;for(const component of input.path.slice(current.length).split('/').filter(Boolean)){current=join(current,component);if(lstatSync(current).isSymbolicLink())throw new PrivateDataError('invalid_data');}
  const fd=openSync(input.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;
  try{const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size>FILE_MAX_BYTES||info.size!==input.revision.sizeBytes)throw new PrivateDataError('invalid_data');bytes=readFileSync(fd);}finally{closeSync(fd);}
  if(bytesHash(bytes)!==input.revision.sha256)throw new PrivateDataError('invalid_data');
  const ingress=host.forUser(context),upload=ingress.beginUpload(input.sourceId,{batchId:input.batchId,revision:input.revision});
  if(!('receipt' in upload))for(let offset=0;offset<bytes.length;offset+=FILE_PART_BYTES){const part=bytes.subarray(offset,offset+FILE_PART_BYTES);ingress.uploadPart(upload.id,offset/FILE_PART_BYTES,{bytes:part.toString('base64'),checksum:bytesHash(part)});}
  return ingress.commitUpload(upload.id);
 }});
 return host;
}
