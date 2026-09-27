import {z} from 'zod';
import {evidenceRefId} from '@mote/shared';
import type {Store} from './store.js';
import type {MaterialRecord,MaterialStore} from './materials.js';
import {fileAttachmentParent} from './file-attachments.js';
import type {SourceArchive} from './source-archive.js';

/** Original input identity, independent of later OCR/transcript versions. */
export const materialSourcePinSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('source-item'),sourceId:z.string().min(1).max(256),externalId:z.string().min(1).max(2048),captureId:z.string().uuid()}).strict(),
  z.object({kind:z.literal('archive-group'),sourceId:z.string().min(1).max(256),group:z.string().min(1).max(4096),checkpoint:z.string().min(1).max(256)}).strict(),
  z.object({kind:z.literal('material-revision'),ref:z.string().regex(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/)}).strict(),
]);
export type MaterialSourcePin=z.infer<typeof materialSourcePinSchema>;

function sourceHead(store:Store,materials:MaterialStore,material:MaterialRecord):string|undefined {
  const head=store.db.prepare('SELECT capture_id,deleted FROM source_heads WHERE source_id=? AND external_id=?')
    .get(material.origin.sourceId,material.origin.externalId) as {capture_id:string;deleted:number}|undefined;
  if(!head||head.deleted||!store.isCurrentEvidence(head.capture_id))return;
  let found=false;const hasAttachments=Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_files'").get());
  for(let offset=0;offset<material.memberCount;offset+=200){
    for(const member of materials.members(material.ref,{offset,limit:200}).items){
      const id=member.kind==='capture'?evidenceRefId(member.ref,'capture'):undefined;
      if(!id)return;
      if(id===head.capture_id)found=true;
      else if(!hasAttachments||fileAttachmentParent(store,id)?.record.id!==head.capture_id)return;
    }
  }
  return found?head.capture_id:undefined;
}

export function materialSourcePin(store:Store,materials:MaterialStore,material:MaterialRecord,archive?:SourceArchive):MaterialSourcePin {
  const captureId=sourceHead(store,materials,material);
  if(captureId)return {kind:'source-item',sourceId:material.origin.sourceId,externalId:material.origin.externalId,captureId};
  const work=archive?store.db.prepare("SELECT source_id,group_key,archive_checkpoint FROM source_pipeline_work WHERE material_ref=? AND state='complete'")
    .get(material.ref) as {source_id:string;group_key:string;archive_checkpoint:string|null}|undefined:undefined;
  if(work?.archive_checkpoint&&archive!.groupCheckpoint(work.source_id,work.group_key)===work.archive_checkpoint)
    return {kind:'archive-group',sourceId:work.source_id,group:work.group_key,checkpoint:work.archive_checkpoint};
  // Unknown organizers must not silently widen a pending selection on revision changes.
  return {kind:'material-revision',ref:material.ref};
}

export function materialSourceCurrent(store:Store,materials:MaterialStore,pin:MaterialSourcePin,materialId:string,archive?:SourceArchive):boolean {
  const material=materials.get(materialId);if(!material)return false;
  if(pin.kind==='material-revision')return material.ref===pin.ref;
  if(material.origin.sourceId!==pin.sourceId)return false;
  if(pin.kind==='source-item')return material.origin.externalId===pin.externalId&&sourceHead(store,materials,material)===pin.captureId;
  return material.origin.externalId===pin.group&&archive?.groupCheckpoint(pin.sourceId,pin.group)===pin.checkpoint;
}
