import {z} from 'zod';
import {evidenceDependenciesSchema,sourceContextDeclarationSchema} from '@mote/shared';
import type {Store} from './store.js';
import type {SourceContextStore} from './source-context.js';
import {assertSourceContextDependencies} from './source-context-lineage.js';

/** Host-owned, immutable publication provenance. Independent delivery groups
 * retain their strict original/pixel reads alongside exact Memory bodies.
 * These references restrict reads; they cannot grant a source or native scope. */
export const materialDerivationSchema=z.object({
  version:z.literal(1),
  sourceItem:z.object({captureId:z.string().uuid(),revision:z.string().min(1).max(200)}).strict(),
  groups:z.array(z.object({
    evidenceDependencies:evidenceDependenciesSchema.refine(value=>value.complete,'Derived publication requires complete privacy lineage'),
    originalEvidenceIds:z.array(z.string().uuid()),
    sourceContextDependencies:z.array(sourceContextDeclarationSchema),
    memoryPins:z.array(z.object({id:z.string().uuid(),fingerprint:z.string().min(1),version:z.number().int().nonnegative().optional()}).strict()),
  }).strict()),
}).strict();
export type MaterialDerivation=z.infer<typeof materialDerivationSchema>;

/** Uses the real current read consumer supplied by the Material/Evidence owner.
 * No native session identity, activation, state namespace or persisted grant is
 * consulted when an independently accepted product is read. */
export function materialDerivationAllowed(input:{store:Store;sourceContexts:SourceContextStore;sourceId:string;externalId:string;derivation:MaterialDerivation;evidenceAllowed:(ids:readonly string[])=>boolean}):boolean {
  const {store,sourceContexts,sourceId,externalId,derivation,evidenceAllowed}=input;
  try{
    const source=store.db.prepare("SELECT json_extract(json,'$.kind') kind FROM source_connections WHERE id=?").get(sourceId);
    const item=store.db.prepare('SELECT v.capture_id,h.deleted FROM source_versions v JOIN source_heads h ON h.source_id=v.source_id AND h.external_id=v.external_id JOIN captures c ON c.id=v.capture_id WHERE v.source_id=? AND v.external_id=? AND v.revision=? AND v.capture_id=?').get(sourceId,externalId,derivation.sourceItem.revision,derivation.sourceItem.captureId);
    if(!source||!item||item.deleted)return false;
    for(const group of derivation.groups){
      assertSourceContextDependencies(sourceContexts,group.sourceContextDependencies);
      for(const pin of group.memoryPins){
        const row=store.db.prepare('SELECT json FROM memories WHERE id=?').get(pin.id);if(!row)return false;const memory=JSON.parse(String(row.json));
        if(memory.status!=='published'||memory.fingerprint!==pin.fingerprint||pin.version!==undefined&&memory.version!==pin.version)return false;
      }
      if(!evidenceAllowed(group.evidenceDependencies.ids)||group.originalEvidenceIds.some(id=>!evidenceAllowed([id])))return false;
    }
    return true;
  }catch{return false;}
}
