import {isDeepStrictEqual} from 'node:util';
import {transcriptSchema} from '@mote/shared';
import {fileAttachmentParent} from './file-attachments.js';
import type {FileStore} from './files.js';
import type {FileOutputRegistry,ComponentRef} from './file-recipes.js';
import {sha256} from './store.js';

/** The current format identifies privacy transformations by mode/redacted.
 * Redacted inputs have no pinned transformation revision, so conservatively
 * process them independently. A content hash never supplies read authority. */
export function fileExtractionPrivacy(files:FileStore,id:string){
 const record=files.store.evidenceMetadata([id])[0];if(!record)return;
 const attached=record.provenance?.document?.attachmentOf;
 const parent=attached?fileAttachmentParent(files.store,id,true)?.record:undefined;
 if(attached&&!parent)return;
 const privacy=[record.privacy,...(parent?[parent.privacy]:[])];
 if(privacy.some(p=>p.excluded))return;
 return {fingerprint:sha256(JSON.stringify([...new Set(privacy.map(p=>JSON.stringify({mode:p.mode,redacted:p.redacted})))].sort())),reusable:privacy.every(p=>!p.redacted)};
}
export function fileExtractionInput(files:FileStore,id:string){
 if(files.readableFile(id)!==id)return;
 const privacy=fileExtractionPrivacy(files,id);if(!privacy)return;
 const file=JSON.parse(files.version(id).manifest);
 if(!file.sha256||file.item.layer==='reference'||files.sources.getSource(file.sourceId).retention==='reference')return;
 return {sha256:file.sha256 as string,sizeBytes:file.sizeBytes as number,mime:file.item.mimeType as string,
  privacy:privacy.fingerprint,reusable:privacy.reusable};
}

/** Successful raw steps are the cache: their artifacts already have retention,
 * quota, backup and deletion ownership. No in-progress row is a cache entry.
 * Rebinding copies only validated machine output; it creates no dependency on
 * the donor's logical origin and discloses none of its identifiers. */
export function readFileExtractionCache(files:FileStore,id:string,fingerprint:string,processor:string,version:string,output:ComponentRef,outputs:FileOutputRegistry,native:boolean){
 const target=fileExtractionInput(files,id);if(!target?.reusable)return;
 const candidates=files.store.db.prepare(`SELECT s.capture_id,a.json FROM file_steps s
  JOIN file_artifacts a ON a.id=s.artifact_id AND a.capture_id=s.capture_id
  WHERE s.capture_id!=? AND s.step='extract' AND s.state='succeeded' AND s.fingerprint=?
   AND s.processor=? AND s.version=? AND a.kind IN ('image-text','text','transcript')
  ORDER BY s.updated_at DESC`).iterate(id,fingerprint,processor,version);
 for(const row of candidates){
  const origin=fileExtractionInput(files,String(row.capture_id));
  if(!origin?.reusable||!isDeepStrictEqual(origin,target))continue;
  try{
   const artifact=JSON.parse(String(row.json));
   if(artifact.uncorrected!==true||artifact.complete!==true||artifact.coverage!=='full'||!isDeepStrictEqual(artifact.output?.type,output))continue;
   const value=native?artifact.output.payload:artifact.transcript,decoded=outputs.decode(output,value);
   if(!isDeepStrictEqual(decoded.transcript,transcriptSchema.parse(artifact.transcript)))continue;
   if(decoded.transcript.extraction?decoded.transcript.extraction.status!=='ready':decoded.transcript.coverage&&decoded.transcript.coverage!=='full')continue;
   return {value:decoded.payload};
  }catch{
   // Missing/corrupt/incompatible cache entries never block normal extraction.
  }
 }
}
