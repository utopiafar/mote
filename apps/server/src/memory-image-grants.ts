import type {QueryInput} from '@mote/agent';
import type {MaterialInputPin} from './material-readiness.js';
import {fileAttachmentAvailable} from './file-attachments.js';
import {StoreError,type Store} from './store.js';
import type {QueryResult} from '@mote/shared';
import type {MaterialStore} from './materials.js';
import type {MemoryEvidence} from './memory-schema.js';

export type MemoryImageGrant=NonNullable<QueryInput['processingImages']>[number];
const hasImageAnchors=(store:Store)=>Number(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('material_blocks','material_heads','material_evidence')").get()?.n)===3;
/** Host locator identity, never text inspection, distinguishes a fallible image
 * interpretation from OCR or an original-image locator. */
export function memoryImageInterpretation(store:Store,id:string):boolean {
 if(!hasImageAnchors(store))return false;
 const row=store.db.prepare(`SELECT b.locator FROM material_blocks b JOIN material_heads h ON h.id=b.material_id AND h.revision=b.revision
  JOIN material_evidence e ON e.id=b.anchor_id WHERE b.anchor_id=? AND e.invalidated=0 AND h.retired=0`).get(id);
 const locator=row?.locator&&JSON.parse(String(row.locator));return Boolean(locator&&locator.imageEvidence&&typeof locator.productVersion==='string');
}
export type MemoryImageLocator={captureId:string;sha256:string};
/** Resolve each distinct original once per read. Every call reads current
 * state; returned identities are a planning snapshot, not an authority grant. */
export function memoryImageLocators(store:Store,ids:readonly string[]):Map<string,MemoryImageLocator> {
 const result=new Map<string,MemoryImageLocator>();if(!ids.length||!hasImageAnchors(store))return result;
 const read=store.db.prepare(`SELECT b.locator,b.member_ids,b.material_id,b.revision FROM material_evidence e JOIN material_heads h ON h.id=e.material_id
  JOIN material_blocks b ON b.material_id=h.id AND b.revision=h.revision AND b.anchor_id=e.id WHERE e.id=? AND e.invalidated=0 AND h.retired=0`);
 const member=store.db.prepare("SELECT 1 FROM material_members WHERE material_id=? AND revision=? AND id=? AND kind='capture' AND ref=?");
 for(const id of new Set(ids)){
  const row=read.get(id),locator=row?.locator&&JSON.parse(String(row.locator)).memoryImageOriginal;
  if(!locator||typeof locator.captureId!=='string'||typeof locator.sha256!=='string'||!/^[a-f0-9]{64}$/.test(locator.sha256)||!JSON.parse(String(row!.member_ids)).includes(locator.captureId))continue;
  if(member.get(row!.material_id,row!.revision,locator.captureId,'capture:'+locator.captureId))result.set(id,{captureId:locator.captureId,sha256:locator.sha256});
 }
 return result;
}
export function memoryImageLocator(store:Store,id:string):MemoryImageLocator|undefined {
 return memoryImageLocators(store,[id]).get(id);
}
/** Only organizer-owned locators in the frozen selected output can mint an
 * image grant. Model text, a same-source UUID and interpretation regions cannot. */
export function memoryImageGrants(store:Store,pins:readonly MaterialInputPin[]):MemoryImageGrant[]{
 if(!hasImageAnchors(store))return [];
 const result:MemoryImageGrant[]=[],locators=memoryImageLocators(store,pins.flatMap(pin=>pin.evidenceIds));
 const read=store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?');
 for(const pin of pins)for(const id of pin.evidenceIds){
  const locator=locators.get(id);if(!locator||read.get(id)?.material_id!==pin.materialId)continue;
  result.push({id,materialId:pin.materialId,required:[...pin.required],fingerprint:pin.fingerprint,originalSha256:locator.sha256});
 }
 return [...new Map(result.map(grant=>[JSON.stringify(grant),grant])).values()];
}
/** Resolve the original from the immutable host block, then check its current
 * physical identity. This function never reads or discloses capture text. */
export function memoryImageOriginal(store:Store,grant:MemoryImageGrant):string|undefined {
 if(!hasImageAnchors(store))return;
 const row=store.db.prepare(`SELECT b.locator FROM material_blocks b JOIN material_heads h ON h.id=b.material_id AND h.revision=b.revision
  JOIN material_evidence e ON e.id=b.anchor_id WHERE b.material_id=? AND b.anchor_id=? AND e.invalidated=0 AND h.retired=0`).get(grant.materialId,grant.id);
 const locator=row&&memoryImageLocator(store,grant.id);
 if(!locator||locator.sha256!==grant.originalSha256||typeof locator.captureId!=='string'||!store.isCurrentEvidence(locator.captureId)||!fileAttachmentAvailable(store,locator.captureId))return;
 const capture=store.db.prepare('SELECT blob_hash FROM captures WHERE id=?').get(locator.captureId),file=store.db.prepare('SELECT object_hash,manifest FROM file_versions WHERE capture_id=?').get(locator.captureId);
 // Snapshot expiry can release bytes while keeping current OCR and its original
 // identity. Reading pixels still requires actual bytes in readEvidenceImage;
 // an unused visual option must not block a sufficient retained OCR proof.
 const identity=file?.object_hash??(file?JSON.parse(String(file.manifest)).sha256:undefined)??capture?.blob_hash;
 if(identity!==grant.originalSha256)return;
 return locator.captureId;
}
export function assertMemoryImageGrants(store:Store,pins:readonly MaterialInputPin[],grants:readonly MemoryImageGrant[]){
 if(!grants.length)return;
 const current=memoryImageGrants(store,pins);
 if(grants.some(grant=>!current.some(value=>JSON.stringify(value)===JSON.stringify(grant))||!memoryImageOriginal(store,grant)))throw new StoreError('Memory original image changed or is unavailable',409);
}

/** Consolidation derives this optional read capability only from its exact
 * selected cards' persisted visual proofs, never arbitrary catalog rows. */
export function memoryIntegrationImageInputs(store:Store,materials:MaterialStore,evidence:readonly MemoryEvidence[]):Pick<QueryInput,'processingImages'|'processingMaterialInputs'|'processingEvidence'>{
 const visual=evidence.filter(span=>span.image);if(!visual.length)return {};
 const pins:MaterialInputPin[]=[],fingerprints:Record<string,string>={};
 for(const span of visual){
  const locator=memoryImageLocator(store,span.id),row=store.db.prepare('SELECT material_id FROM material_evidence WHERE id=?').get(span.id),material=row&&materials.get(String(row.material_id));
  if(!locator||!material||locator.sha256!==span.image!.original.sha256)throw new StoreError('Selected Memory original-image proof changed',409);
  const required=materials.requirementsForEvidence(material.ref,[span.id]),pin=materials.input(material.ref,required);
  if(!pin?.ready||!pin.evidenceIds.includes(span.id))throw new StoreError('Selected Memory original-image output is unavailable',409);
  pins.push({...pin,evidenceIds:[span.id]});fingerprints[span.id]=span.contentHash;
 }
 const inputs=[...new Map(pins.map(pin=>[JSON.stringify(pin),pin])).values()],images=memoryImageGrants(store,inputs);
 if(images.length!==new Set(visual.map(span=>span.id)).size)throw new StoreError('Selected Memory original-image grant is unavailable',409);
 return {processingMaterialInputs:inputs,processingImages:images,processingEvidence:fingerprints};
}

/** Selected original-image targets account for pixels, while OCR targets
 * account for their exact text. OCR from this or any other original cannot
 * certify unseen visual contents. Context-only image grants add no target. */
export function uninspectedMemoryImageTargets(grants:readonly MemoryImageGrant[],result:QueryResult,delivered:readonly {id:string;offset:number;length:number}[],targets:readonly {id:string;key:string}[]=[]):string[]{
 let value:any;try{value=JSON.parse(result.answer);}catch{return [];}
 const coverage=Array.isArray(value.coverage)?value.coverage:[];
 return grants.filter(grant=>{
  const keys=new Set(targets.filter(member=>member.id===grant.id).map(member=>member.key));
  const assessed=coverage.length?coverage.some((row:any)=>keys.has(row.key)&&['checked','no_candidates'].includes(row.state)):delivered.some(range=>range.id===grant.id);
  return assessed&&!result.imageReadReceipts?.some(receipt=>receipt.id===grant.id&&receipt.imageView.original.sha256===grant.originalSha256&&receipt.imageView.output&&receipt.imageView.transform!=='metadata@1'&&
   (receipt.imageView.region===null||receipt.imageView.region.x===0&&receipt.imageView.region.y===0&&receipt.imageView.region.width===receipt.imageView.original.width&&receipt.imageView.region.height===receipt.imageView.original.height));
 }).map(grant=>grant.id);
}
