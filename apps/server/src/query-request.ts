import {z} from 'zod';
import {sourceIdSchema} from '@mote/shared';
import {modelProfileIdSchema} from './model-settings.js';
import {scopeFields,validRange} from './query-scope.js';

const querySchema=z.object({modelProfileId:modelProfileIdSchema.optional(),modelOverride:z.string().trim().min(1).max(512).refine(v=>!/[\u0000-\u001f\u007f]/.test(v)).optional(),question:z.string().trim().min(1).max(8000),conversationId:z.string().uuid().optional(),anchorMaterialRef:z.string().regex(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/).nullable().optional(),anchorEvidenceIds:z.array(z.string().uuid()).min(1).max(30).refine(ids=>new Set(ids).size===ids.length).nullable().optional(),evidenceIds:z.array(z.string().uuid()).min(1).max(30).refine(ids=>new Set(ids).size===ids.length).nullable().optional(),after:scopeFields.after.nullable(),before:scopeFields.before.nullable(),deviceId:scopeFields.deviceId.nullable(),timeZone:scopeFields.timeZone.nullable()}).strict();
export const queryWithAttachmentsSchema=querySchema.extend({attachmentIds:z.array(z.string().uuid()).max(4).refine(ids=>new Set(ids).size===ids.length).optional()}).refine(input=>[input.evidenceIds,input.anchorEvidenceIds,input.anchorMaterialRef].filter(Boolean).length<=1,{message:"Choose one reference selection or a strict evidence selection"});
// Only the product queue supplies this reader grant. Legacy query HTTP input
// still uses queryWithAttachmentsSchema and cannot manufacture host grants.
const queuedSourceIds=z.array(sourceIdSchema).optional();
type QueuedQuery=z.output<typeof queryWithAttachmentsSchema>&{sourceIds?:string[]};
/** Product messages can express an empty evidence intersection and an anchor
 * inside a strict selection. Validate both through the existing query schema;
 * the public legacy query endpoint retains its own admission contract. */
export function parseQueuedQuery(raw:unknown):QueuedQuery{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return queryWithAttachmentsSchema.parse(raw);
  const {sourceIds,...input}=raw as Record<string,unknown>;
  if(sourceIds!==undefined)return {...parseQueuedQuery(input),sourceIds:queuedSourceIds.parse(sourceIds)};
  const ids=input.evidenceIds,anchor=input.anchorEvidenceIds;
  if(!Array.isArray(ids)||ids.length>0&&!anchor)return queryWithAttachmentsSchema.parse(raw);
  if(anchor&&input.anchorMaterialRef)return queryWithAttachmentsSchema.parse(raw);
  const parsed=queryWithAttachmentsSchema.parse({...input,evidenceIds:ids.length?ids:null,...(anchor?{anchorEvidenceIds:null}:{})});
  const selectedAnchor=anchor?queryWithAttachmentsSchema.parse({...input,evidenceIds:null,anchorMaterialRef:null}).anchorEvidenceIds:parsed.anchorEvidenceIds;
  return {...parsed,evidenceIds:ids.length?parsed.evidenceIds:[],...(anchor?{anchorEvidenceIds:selectedAnchor}:{})};
}
export const insightSchema=z.object(scopeFields).strict().refine(validRange,{message:'Invalid time range'});
export const insightRequestSchema=z.object({...scopeFields,modelProfileId:modelProfileIdSchema.optional(),prompt:z.string().trim().max(8000).optional()}).strict().refine(validRange,{message:'Invalid time range'});
export type QueryRequest=z.output<typeof queryWithAttachmentsSchema>;
