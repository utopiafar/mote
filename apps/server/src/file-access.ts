import type {DatabaseSync} from 'node:sqlite';

/** Host-owned SQL expressions only. Device-origin absence is an observation,
 * not a revocation of a previously retained file. */
export const readableFileSql=(capture:string)=>`EXISTS (SELECT 1 FROM file_versions fv
  JOIN file_heads fh ON fh.capture_id=fv.capture_id
  JOIN source_connections fs ON fs.id=fv.source_id
  JOIN source_heads sh ON sh.source_id=fv.source_id AND sh.external_id=fv.external_id
  WHERE fv.capture_id=${capture} AND json_extract(fs.json,'$.enabled')=1
    AND (json_extract(fs.json,'$.retention')!='reference' OR json_extract(fv.manifest,'$.item.layer')='reference')
    AND (sh.capture_id=fv.capture_id AND sh.deleted=0 OR fh.origin_missing=1 AND sh.deleted=1
      AND EXISTS(SELECT 1 FROM file_versions missing WHERE missing.capture_id=sh.capture_id AND missing.source_id=fv.source_id AND missing.external_id=fv.external_id)))`;

/** The SQL candidate and coverage counts must use the same attachment lineage
 * as fileAttachmentAvailable, before a vector worker sees any candidates. */
export function availableFileAttachmentSql(db:DatabaseSync,capture:string){
  // The standalone Store can be used before the archive owner is assembled.
  // It cannot prove an attachment relationship until both archive tables exist.
  const tables=db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('capture_files','archived_files')").get();
  if(Number(tables?.count)!==2)return `NOT EXISTS(SELECT 1 FROM file_versions av WHERE av.capture_id=${capture} AND json_extract(av.manifest,'$.item.document.attachmentOf') IS NOT NULL)`;
  return `(
  NOT EXISTS(SELECT 1 FROM file_versions av WHERE av.capture_id=${capture} AND json_extract(av.manifest,'$.item.document.attachmentOf') IS NOT NULL)
  OR EXISTS(SELECT 1 FROM file_versions av JOIN file_evidence_links l ON l.capture_id=av.capture_id
    JOIN captures parent ON parent.id=l.parent_id JOIN capture_files cf ON cf.capture_id=parent.id
    JOIN archived_files original ON original.id=cf.file_id AND original.hash=av.object_hash
    WHERE av.capture_id=${capture} AND json_extract(av.manifest,'$.item.document.attachmentOf.captureId')=parent.id
      AND json_extract(av.manifest,'$.item.document.attachmentOf.fileId')=original.id
      AND av.source_id=json_extract(parent.json,'$.provenance.sourceId')
      AND EXISTS(SELECT 1 FROM json_each(parent.json,'$.provenance.document.attachments') d WHERE json_extract(d.value,'$.id')=original.id)
      AND (NOT EXISTS(SELECT 1 FROM source_versions pv WHERE pv.capture_id=parent.id) OR EXISTS(SELECT 1 FROM source_heads ph WHERE ph.capture_id=parent.id AND ph.deleted=0))
      AND (NOT EXISTS(SELECT 1 FROM source_versions cv WHERE cv.capture_id=av.capture_id) OR EXISTS(SELECT 1 FROM source_heads ch WHERE ch.capture_id=av.capture_id AND ch.deleted=0)))
)`;
}
