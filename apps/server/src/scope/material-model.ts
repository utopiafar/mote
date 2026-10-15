/** Shared Material value contract; no storage or single-owner runtime. */
import {z} from 'zod';
import {documentSchema,attributionContextSchema} from '@mote/shared';

export const MATERIAL_PREFIX='mat_';
const materialIdSchema=z.string().regex(/^mat_[a-f0-9]{64}$/);
const revisionSchema=z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema=z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/);
const locatorSchema=z.record(z.unknown()).refine(value=>{
  try{return Buffer.byteLength(JSON.stringify(value))<=4096;}catch{return false;}
},'Locator is too large or not serializable');
const memberSchema=z.object({
  id:z.string().min(1).max(128),kind:nameSchema,ref:z.string().min(1).max(2048),
  revision:z.string().min(1).max(256).optional(),locator:locatorSchema.optional(),
}).strict();
/** Declared by a trusted organizer, never decoded from captured prose. */
export const materialEvidenceContextSchema=z.object({attributionContext:attributionContextSchema.optional(),observedAt:z.string().datetime({offset:true}),
  document:documentSchema.pick({recordedAt:true,occurredAt:true,timeBasis:true,contentRole:true}).strict()}).strict();
export type MaterialEvidenceContext=z.infer<typeof materialEvidenceContextSchema>;
const blockBase={id:z.string().min(1).max(128),memberIds:z.array(z.string().min(1).max(128)).max(32).default([]),locator:locatorSchema.optional(),
  /** Fine-grained inputs supplement the original members used for authorization. */
  evidenceIds:z.array(z.string().uuid()).max(32).optional()};
const blockSchema=z.discriminatedUnion('kind',[
  z.object({...blockBase,kind:z.literal('text'),format:nameSchema,text:z.string().max(250_000),evidenceContext:materialEvidenceContextSchema.optional()}).strict(),
  z.object({...blockBase,kind:z.literal('asset'),hash:revisionSchema,mimeType:z.string().min(1).max(200)}).strict(),
]);
export const materialDraftSchema=z.object({
  attributionContext:attributionContextSchema.optional(),
  id:materialIdSchema,kind:nameSchema,schemaVersion:z.number().int().min(1).max(1_000_000),
  title:z.string().min(1).max(500),
  origin:z.object({sourceId:z.string().min(1).max(128),externalId:z.string().min(1).max(2048),
    deviceId:z.string().min(1).max(128).optional(),firstAt:z.string().datetime({offset:true}).optional(),
    lastAt:z.string().datetime({offset:true}).optional(),provider:z.string().min(1).max(128).optional(),
    projectName:z.string().max(400).optional(),projectIdentity:z.enum(['workspace','session','unknown']).optional(),
    cwd:z.string().max(4000).optional(),repositoryKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),branch:z.string().max(500).optional(),
    projectKey:z.string().min(1).max(512).optional(),sessionId:z.string().min(1).max(512).optional()}).strict(),
  blocks:z.array(blockSchema),members:z.array(memberSchema),
  coverage:z.object({state:z.enum(['complete','partial','pending']),reason:z.string().max(500).optional()}).strict(),
  /** Named processing outputs let each consumer declare only the dependencies
   * it actually needs. A query may use a partial material while Memory waits. */
  artifacts:z.array(z.object({key:nameSchema,state:z.enum(['ready','pending','failed','unavailable']),revision:z.string().min(1).max(256).optional(),reason:z.string().max(500).optional(),blockIds:z.array(z.string().min(1).max(128)).max(20000).optional()}).strict()).max(256).optional(),
  fidelity:z.object({state:z.enum(['lossless','derived','summary-only']),limitations:z.array(z.string().max(500)).max(20).optional()}).strict(),
  retention:z.object({original:z.enum(['retained','unavailable']),policy:z.enum(['keep','allow-expiry'])}).strict(),
}).strict();

export const materialManifestSchema=materialDraftSchema.omit({blocks:true,members:true}).extend({members:z.array(memberSchema).optional()});
export type MaterialDraft=z.infer<typeof materialDraftSchema>;
