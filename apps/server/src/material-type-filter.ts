import type {LibraryMaterialType} from '@mote/shared';
import {DOCUMENT_MIME_TYPES} from '@mote/shared/document-decoder';
import {StoreError} from './evidence-store.js';

const primary=`FROM material_members m JOIN captures c ON m.ref='capture:'||c.id
  LEFT JOIN file_versions f ON f.capture_id=c.id
  WHERE m.material_id=h.id AND m.revision=h.revision AND m.idx=0 AND m.kind='capture'
    AND (m.source_revision IS NULL OR m.source_revision=json_extract(c.json,'$.provenance.revision'))`;
const mime=`lower(trim(COALESCE(json_extract(f.manifest,'$.item.mimeType'),json_extract(c.json,'$.provenance.mimeType'),'')))`;
const originalFile=`h.kind='mote.file' AND json_extract(c.json,'$.source')='file'`;

/** SQL uses the published revision's primary original, never a newer file head,
 * attachment, title, or inferred content class. Apply before cursor/LIMIT.
 * An image reference or text transcript can match more than one filter. */
export function materialTypePredicate(type:LibraryMaterialType):{sql:string;values:string[]}{
  switch(type){
    case 'note':return {sql:'h.kind=?',values:['mote.note']};
    case 'coding':return {sql:'h.kind=?',values:['mote.coding-session']};
    case 'calendar':return {sql:'h.kind=?',values:['mote.calendar']};
    case 'document':return {sql:`EXISTS(SELECT 1 ${primary} AND ${originalFile}
      AND (${mime} LIKE 'text/%' OR ${mime} IN (${['application/json',...DOCUMENT_MIME_TYPES].map(()=>'?').join(',')})))`,values:['application/json',...DOCUMENT_MIME_TYPES]};
    case 'image':return {sql:`EXISTS(SELECT 1 ${primary} AND ${originalFile} AND ${mime} LIKE 'image/%')`,values:[]};
    case 'email':return {sql:`EXISTS(SELECT 1 ${primary} AND (
      (h.kind='mote.message' AND json_extract(c.json,'$.provenance.document.originalMetadata.provider')='gmail')
      OR ${mime}='message/rfc822'))`,values:[]};
    case 'reference':return {sql:`EXISTS(SELECT 1 ${primary} AND json_extract(c.json,'$.provenance.layer')='reference')`,values:[]};
    case 'transcript':return {sql:`EXISTS(SELECT 1 ${primary} AND (
      json_extract(c.json,'$.provenance.document.contentRole')='transcript'
      OR (h.kind='mote.file' AND EXISTS(SELECT 1 FROM material_blocks b
        WHERE b.material_id=h.id AND b.revision=h.revision AND b.kind='text'
          AND json_array_length(b.member_ids)=1 AND json_extract(b.member_ids,'$[0]')=m.id
          AND (b.format='transcript' OR (b.format='speech-text' AND json_type(b.locator,'$.startMs') IN ('integer','real')))))))`,values:[]};
    default:throw new StoreError('Invalid library material type',400);
  }
}
