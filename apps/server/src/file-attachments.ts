import {z} from 'zod';
import type {CaptureRecord,FileRevision} from '@mote/shared';
import {StoreError,sha256,type Store} from './store.js';
import type {FileStore} from './files.js';
import {ArchivedFileStore} from './archived-files.js';
import {linkOperationParent} from './operation-projection.js';

/** The declaration is not authority. Resolve only the host's retained lineage,
 * exact archived bytes and original parent attachment link. */
export function fileAttachmentParent(store:Store,id:string):{record:CaptureRecord;fileId:string}|undefined {
 const row=store.db.prepare(`SELECT p.id,a.id file_id FROM file_versions v
  JOIN file_evidence_links l ON l.capture_id=v.capture_id
  JOIN captures p ON p.id=l.parent_id
  JOIN capture_files f ON f.capture_id=p.id
  JOIN archived_files a ON a.id=f.file_id AND a.hash=v.object_hash
  WHERE v.capture_id=? AND json_extract(v.manifest,'$.item.document.attachmentOf.captureId')=p.id
   AND json_extract(v.manifest,'$.item.document.attachmentOf.fileId')=a.id
   AND v.source_id=json_extract(p.json,'$.provenance.sourceId')
   AND EXISTS(SELECT 1 FROM json_each(p.json,'$.provenance.document.attachments') d WHERE json_extract(d.value,'$.id')=a.id)
  LIMIT 1`).get(id) as {id:string;file_id:string}|undefined;
 if(!row||!store.isCurrentEvidence(row.id)||!store.isCurrentEvidence(id))return;
 const record=store.evidence([row.id])[0];return record?{record,fileId:row.file_id}:undefined;
}
export function fileAttachmentChildren(store:Store,parentId:string){
 return store.db.prepare('SELECT capture_id FROM file_evidence_links WHERE parent_id=? ORDER BY capture_id LIMIT 101').all(parentId)
  .flatMap(row=>{const id=String(row.capture_id),parent=fileAttachmentParent(store,id),record=parent&&store.evidence([id])[0];return parent?.record.id===parentId&&record?[{record,fileId:parent.fileId}]:[];});
}
export function fileAttachmentAvailable(store:Store,id:string){
 const row=store.db.prepare(`SELECT v.capture_id,json_extract(v.manifest,'$.item.document.attachmentOf') parent
  FROM file_versions v WHERE v.capture_id=? OR v.capture_id=(SELECT capture_id FROM file_chunks WHERE id=?) LIMIT 1`).get(id,id);
 return !row?.parent||Boolean(fileAttachmentParent(store,String(row.capture_id)));
}

/** Explicit admission composes archive retention with the existing file pipeline.
 * No bytes are uploaded again, and merely installing this service scans nothing. */
export class FileAttachments {
 private readonly archived:ArchivedFileStore;
 constructor(private readonly files:FileStore){this.archived=new ArchivedFileStore(files.store);}
 async prepare(parentId:string,fileId:string,raw:unknown,authorize:(sourceId:string)=>void){
  z.string().uuid().parse(parentId);z.string().uuid().parse(fileId);
  const options=z.object({mimeType:z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).max(200).optional()}).strict().parse(raw??{}),store=this.files.store;
  const parent=()=>{
   const record=store.evidence([parentId])[0],p=record?.provenance;
   if(!p)throw new StoreError('Attachment parent is unavailable',404);authorize(p.sourceId);
   if(!store.isCurrentEvidence(parentId)||p.deleted||p.document?.attachmentOf||!p.document?.attachments?.some(a=>a.id===fileId)||
    !store.db.prepare('SELECT 1 FROM capture_files WHERE capture_id=? AND file_id=?').get(parentId,fileId))throw new StoreError('Attachment relationship is unavailable',404);
   return record;
  };
  const record=parent(),p=record.provenance!,original=this.archived.get(fileId);
  const mime=options.mimeType??original.mimeType;
  if(mime==='application/octet-stream')throw new StoreError('Declare the attachment media type before processing',400);
  if(original.mimeType!=='application/octet-stream'&&mime!==original.mimeType)throw new StoreError('Attachment media type conflicts with its declaration',409);
  const externalId='attachment:'+sha256(JSON.stringify([parentId,fileId])),revision=sha256(JSON.stringify([original.hash,mime]));
  const existing=this.files.sources.getItem(p.sourceId,externalId),document=p.document!;
  // The date is the authored record's attachment context, not a claim about when
  // the image was captured or its described event happened.
  const input:FileRevision={sourceId:p.sourceId,relativePath:original.relativePath,previousRevision:existing?.revision===revision?null:existing?.revision??null,
   item:{externalId,revision,kind:'file',layer:'original',title:original.name,observedAt:record.capturedAt,mimeType:mime,text:'',deleted:false,
    document:{attachmentOf:{captureId:parentId,fileId},contentRole:'other',recordedAt:document.recordedAt,timeBasis:document.recordedAt?'recorded':'unknown'}},
   sha256:original.hash,sizeBytes:original.sizeBytes};
  const previous=existing&&store.db.prepare('SELECT manifest FROM file_versions WHERE capture_id=?').get(existing.captureId);
  if(existing?.revision===revision&&previous)input.previousRevision=JSON.parse(String(previous.manifest)).previousRevision;
  const release=store.assets.hold(original.hash);
  try{
   if(store.assets.get(original.hash).bytes!==original.sizeBytes)throw new StoreError('Attachment byte size changed',409);
   const ack=await this.files.revision(input,()=>{parent();},captureId=>{
    store.db.prepare('INSERT OR IGNORE INTO file_evidence_links VALUES(?,?)').run(parentId,captureId);
    linkOperationParent(store,'capture:'+parentId,'file:'+captureId);
    store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(parentId,new Date().toISOString());
    return {id:captureId,captureId,sourceId:p.sourceId,externalId,revision,duplicate:false};
   });
   if(!fileAttachmentParent(store,ack.id))throw new StoreError('Attachment processing relationship changed',409);
   return {captureId:ack.id,parentId,attachmentId:fileId,duplicate:ack.duplicate,processing:this.files.detail(ack.id,false).job};
  }finally{release();}
 }
}
