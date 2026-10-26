import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {Store,StoreError} from './store.js';
import type {SourceStore} from './sources.js';
import type {MaterialStore} from './materials.js';
import type {EvidenceReader} from './evidence-reader.js';
import {ConnectionError,type ConnectionCredential} from './connections.js';
import {storedCaptureLibraryVersion} from './capture-library-version.js';

const identity=z.object({sourceId:z.string().min(1).max(256),externalId:z.string().min(1).max(4096),revision:z.string().min(1).max(256),deviceId:z.string().min(1).max(128),captureId:z.string().uuid().optional()}).strict();
const query=z.object({after:z.string().datetime({offset:true}),before:z.string().datetime({offset:true}),sourceId:z.string().min(1).max(256).optional(),kind:z.string().min(1).max(128).optional(),stream:z.enum(['originals','materials']),limit:z.number().int().min(1).max(20).default(20),cursor:z.string().max(4096).optional(),candidates:z.array(identity).max(20).default([])}).strict().refine(q=>Date.parse(q.after)<Date.parse(q.before)&& (q.stream==='originals'||!q.candidates.length),{message:'Invalid source library query'});

/** Owner-only, bounded metadata projection. No ingestion, ACK or material publication. */
export function registerLibrarySourceView(app:FastifyInstance,{store,sources,materials,evidenceReader,credential}:{store:Store;sources:SourceStore;materials:MaterialStore;evidenceReader:EvidenceReader;credential:(req:FastifyRequest)=>ConnectionCredential|undefined}){
  const sourceName=(id:string)=>{try{return sources.getSource(id).name;}catch{return undefined;}};
  const original=(id:string)=>{
    const record=evidenceReader.archivedEvidence(['capture:'+id])[0];
    const p=record?.provenance;
    if(!record||!p?.sourceId||!p.externalId||!p.revision||p.deleted)return undefined;
    const file=store.db.prepare('SELECT capture_id FROM file_versions WHERE capture_id=?').get(id);
    const materialRef=evidenceReader.currentMemoryMaterialRef(record);
    return {type:'original' as const,captureId:id,deviceId:record.deviceId,sourceId:p.sourceId,sourceName:sourceName(p.sourceId),externalId:p.externalId,revision:p.revision,libraryVersion:storedCaptureLibraryVersion(store,id),sortAt:record.capturedAt,title:record.windowTitle,kind:record.source,layer:p.layer,metadata:p.metadata,attribution:record.attributionContext,...(file?{fileArchive:{captureId:id}}:{}),...(materialRef?{materialRef}:{})};
  };
  app.post('/api/library/source-view',{bodyLimit:131072},req=>{
    if(credential(req))throw new ConnectionError('connection_scope_denied',403,'Owner access required');
    const q=query.parse(req.body);
    const scope=createHash('sha256').update(JSON.stringify([store.directory,q.stream,q.after,q.before,q.sourceId??null,q.kind??null,q.limit])).digest('hex');
    let cursor:string|undefined;
    if(q.cursor)try{const decoded=z.object({scope:z.string(),position:z.string()}).strict().parse(JSON.parse(Buffer.from(q.cursor,'base64url').toString()));if(decoded.scope!==scope)throw Error();cursor=decoded.position;}catch{throw new StoreError('Invalid library cursor',409);}
    let items:unknown[],nextCursor:string|null;
    try{
      if(q.stream==='originals'){
        const page=sources.listItems({...q,cursor,collectedOrder:true});items=page.items.flatMap(item=>{const row=original(item.captureId);return row?[row]:[];});nextCursor=page.nextCursor;
      }else{
        const page=materials.list({...q,cursor,order:'library'});items=page.items.map(item=>({...item,type:'material',sourceName:sourceName(item.origin.sourceId),sortAt:item.origin.lastAt??item.updatedAt}));nextCursor=page.nextCursor;
      }
    }catch(error){if(q.cursor&&error instanceof StoreError)throw new StoreError('Invalid library cursor',409);throw error;}
    const matches=q.candidates.map(candidate=>{
      const version=store.db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(candidate.sourceId,candidate.externalId,candidate.revision);
      const row=version&&(!candidate.captureId||candidate.captureId===version.capture_id)?original(String(version.capture_id)):undefined;
      const exact=row&&row.sourceId===candidate.sourceId&&row.externalId===candidate.externalId&&row.revision===candidate.revision&&row.deviceId===candidate.deviceId;
      return {...candidate,state:exact?'readable':'unavailable',...(exact?{original:row}:{})};
    });
    return {stream:q.stream,items,matches,nextCursor:nextCursor?Buffer.from(JSON.stringify({scope,position:nextCursor})).toString('base64url'):null};
  });
}
