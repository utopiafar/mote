import {storedCaptureLibraryVersion} from './capture-library-version.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {Store,StoreError} from './store.js';
import {ConnectionError,type ConnectionCredential} from './connections.js';

const sources=['screen','ui_page','activity','media','notification','device_event','note'] as const;
const request=z.object({
  after:z.string().datetime({offset:true}),before:z.string().datetime({offset:true}),
  source:z.enum(sources).optional(),limit:z.number().int().min(1).max(60).default(20),
  cursor:z.string().max(2048).optional(),
  candidates:z.array(z.object({deviceId:z.string().min(1).max(128),id:z.string().uuid()}).strict()).max(100).default([]),
}).strict().refine(v=>Date.parse(v.after)<Date.parse(v.before),{message:'Invalid time range'});

/** Capture projection only. Files, source documents and formal Materials retain their own identities. */
export function registerDeviceLibrary(app:FastifyInstance,{store,credential}:{store:Store;credential:(req:FastifyRequest)=>ConnectionCredential|undefined}) {
  app.post('/api/library/device-view',{bodyLimit:32768},req=>{
    // The connection hook also denies this route to collectors. Keep the owner
    // requirement here: device presence does not grant global archive reads.
    if(credential(req))throw new ConnectionError('connection_scope_denied',403,'Owner access required');
    const q=request.parse(req.body);
    const scope=createHash('sha256').update(JSON.stringify([store.directory,q.after,q.before,q.source??null,q.limit])).digest('hex');
    let cursor:string|undefined;
    if(q.cursor){
      try{const parsed=z.object({scope:z.string(),position:z.string()}).strict().parse(JSON.parse(Buffer.from(q.cursor,'base64url').toString()));if(parsed.scope!==scope)throw Error();cursor=parsed.position;}
      catch{throw new StoreError('Invalid library cursor',409);}
    }
    const readPage=()=>store.list({after:q.after,before:q.before,source:q.source,sources:[...sources],limit:q.limit,cursor,includeTotal:false,capturedOrder:true});
    let page:ReturnType<typeof readPage>;
    try{page=readPage();}catch(error){if(q.cursor&&error instanceof StoreError)throw new StoreError('Invalid library cursor',409);throw error;}
    const items=page.items.map(record=>({
      id:record.id,libraryVersion:storedCaptureLibraryVersion(store,record.id),deviceId:record.deviceId,deviceName:record.deviceName,platform:record.platform,
      capturedAt:record.capturedAt,sortAt:record.capturedAt,source:record.source,
      appName:record.appName,appId:record.appId,windowTitle:record.windowTitle,
      stateSeries:record.stateSeries,observationCount:record.stateSeries?.samples.length??0,hasImage:Boolean(record.blobHash),ocr:record.ocr,textPreview:record.ocrText.slice(0,160),
      metadata:record.metadata,provenance:record.provenance,
    }));
    const exact=new Map(store.evidence(q.candidates.map(c=>c.id)).map(record=>[record.id,record]));
    return {coverage:'captures',items,nextCursor:page.nextCursor?Buffer.from(JSON.stringify({scope,position:page.nextCursor})).toString('base64url'):null,
      // This is read availability, never an ingress acknowledgement.
      matches:q.candidates.map(candidate=>({...candidate,state:exact.get(candidate.id)?.deviceId===candidate.deviceId?'readable':'unavailable',...(exact.get(candidate.id)?.deviceId===candidate.deviceId?{observationCount:exact.get(candidate.id)?.stateSeries?.samples.length??0,libraryVersion:storedCaptureLibraryVersion(store,candidate.id)}:{})})),
    };
  });
}
