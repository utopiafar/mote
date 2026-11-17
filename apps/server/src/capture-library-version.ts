import {createHash} from 'node:crypto';
import type {EvidenceStore as Store} from './evidence-store.js';

/** Original facts only: derived OCR and local presentation never identify an original version. */
export function captureLibraryVersion(original:Record<string,any>,blobHash:string|null=null):string {
  const fields=['id','deviceId','deviceName','platform','capturedAt','durationMs','appId','appName','windowTitle','ocrText','source','stateSeries','ocr','mood','provenance','metadata','privacy'];
  const value:Record<string,any>={};for(const key of fields)if(original[key]!==undefined)value[key]=structuredClone(original[key]);
  for(const key of ['appId','appName','windowTitle','ocrText'])value[key]??='';value.source??='screen';
  value.privacy={excluded:false,redacted:false,mode:'local',...value.privacy};
  if(value.provenance)value.provenance.deleted??=false;
  value.capturedAt=new Date(value.capturedAt).toISOString();
  for(const sample of value.stateSeries?.samples??[])sample.at=new Date(sample.at).toISOString();
  if(value.metadata?.uiPage?.version===3){value.metadata.observedAt=new Date(value.metadata.observedAt).toISOString();value.metadata.uiPage.observations.firstAt=new Date(value.metadata.uiPage.observations.firstAt).toISOString();value.metadata.uiPage.observations.lastAt=value.capturedAt;}
  value.blobHash=blobHash;
  const canonical=(entry:any):string=>Array.isArray(entry)?'['+entry.map(canonical).join(',')+']':entry&&typeof entry==='object'?'{'+Object.keys(entry).sort().map(key=>JSON.stringify(key)+':'+canonical(entry[key])).join(',')+'}':JSON.stringify(entry);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function storedCaptureLibraryVersion(store:Store,id:string):string|undefined {
  const row=store.db.prepare('SELECT json,blob_hash FROM captures WHERE id=?').get(id);
  return row?captureLibraryVersion(JSON.parse(String(row.json)),row.blob_hash===null?null:String(row.blob_hash)):undefined;
}

/** The owner reader also serves host Material blocks under evidence UUIDs.
 * Their existing immutable view pin is an opaque version, never an invented
 * original-capture hash. Confirm the returned pin and bytes against that exact
 * stored revision; looking up a newer head could pair old text with a new pin. */
export function materialEvidenceLibraryVersion(store:Store,record:{id:string;ocrText:string;provenance?:{uri?:string}}):string|undefined {
  const uri=record.provenance?.uri,match=uri?.match(/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})#(.+)$/);
  if(!match)return;
  const [,materialId,revision,blockId]=match;
  const anchor=store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(record.id);
  if(anchor?.material_id!==materialId)return;
  const blocks=store.db.prepare(`SELECT p.text FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
    WHERE b.material_id=? AND b.revision=? AND b.block_id=? AND b.anchor_id=?
    UNION ALL SELECT p.text FROM material_block_versions b JOIN material_block_payloads p ON p.hash=b.payload_hash
    JOIN material_revisions r ON r.material_id=b.material_id AND r.revision=?
    WHERE b.material_id=? AND b.block_id=? AND b.anchor_id=? AND b.from_sequence<=r.sequence
      AND (b.until_sequence IS NULL OR b.until_sequence>r.sequence)`)
    .all(materialId,revision,blockId,record.id,revision,materialId,blockId,record.id);
  return blocks.length===1&&blocks[0].text===record.ocrText?uri:undefined;
}
