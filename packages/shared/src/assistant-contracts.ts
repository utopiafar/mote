import {z} from 'zod';
import {workStateSchema} from './activity.js';
import {evidenceDependenciesSchema} from './evidence-dependencies.js';
import {queryScopeSchema} from './query-scope.js';
import {provenanceSchema} from './sources.js';
import {sourceContextDeclarationSchema} from './material-context.js';

const uuid=z.string().uuid();
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ownerText=z.string().min(1).max(8000).refine(value=>value.trim().length>0,{message:'Input cannot be blank'});

/** Identifies one original source revision; neither this pin nor its capture
 * ID confers access. Artifact refs and workRecords are never originals. */
export const sourceEvidenceRevisionSchema=provenanceSchema.pick({sourceId:true,externalId:true,revision:true}).extend({
  externalId:z.string().min(1).max(1000),revision:z.string().min(1).max(200),captureId:uuid,
  layer:provenanceSchema.shape.layer.exclude(['derived']),
}).strict();
export type SourceEvidenceRevision=z.infer<typeof sourceEvidenceRevisionSchema>;

/** The key is stable across retries. The host must return the original result
 * for the same key and input, and reject the same key with different input. */
const conversationMessageFields={
  conversationId:uuid,clientRequestId:uuid,question:ownerText,scope:queryScopeSchema,
  attachmentIds:z.array(uuid).max(4).optional(),
  anchorEvidenceIds:z.array(uuid).min(1).max(30).optional(),
  anchorMaterialRef:z.string().regex(/^material:mat_[a-f0-9]{64}@[a-f0-9]{64}$/).optional(),
};
const singleAnchor=(value:{anchorEvidenceIds?:string[];anchorMaterialRef?:string})=>!(value.anchorEvidenceIds&&value.anchorMaterialRef);
export const conversationMessageInputSchema=z.object(conversationMessageFields).strict().refine(singleAnchor,{message:'Choose one anchor'});
export type ConversationMessageInput=z.infer<typeof conversationMessageInputSchema>;
export const conversationMessageStateSchema=z.enum(['accepted','queued','running','completed','failed','cancelled']);
/** Result bodies and recovery are outside this admission contract. */
export const conversationMessageSchema=z.object({
  ...conversationMessageFields,id:uuid,seq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revision,status:conversationMessageStateSchema,createdAt:z.string().datetime({offset:true}),runId:z.string().min(1).max(200).optional(),
  evidenceDeleted:z.boolean().optional(),evidenceStale:z.boolean().optional(),evidenceUnavailable:z.boolean().optional(),
  historyEvidenceDependencies:evidenceDependenciesSchema.optional(),
}).strict().refine(singleAnchor,{message:'Choose one anchor'});
export type ConversationMessage=z.infer<typeof conversationMessageSchema>;

/** The owner explicitly starts work; model-generated text is not a command.
 * Same requestId + same input is one request; different input is a conflict. */
const assistantTaskFields={requestId:uuid,goal:ownerText,scope:queryScopeSchema};
export const assistantTaskInputSchema=z.object(assistantTaskFields).strict();
export type AssistantTaskInput=z.infer<typeof assistantTaskInputSchema>;
export const assistantTaskRecordSchema=z.object({
  id:uuid,...assistantTaskFields,revision,state:workStateSchema,
  evidenceDependencies:evidenceDependenciesSchema,
  sourceEvidenceRevisions:z.array(sourceEvidenceRevisionSchema).optional(),
  sourceContextDependencies:z.array(sourceContextDeclarationSchema).optional(),
}).strict();
export type AssistantTaskRecord=z.infer<typeof assistantTaskRecordSchema>;

/** A model may propose a goal, never an identity, scope, permission or effect.
 * The host binds the remaining fields after validating the current answer. */
export const assistantDraftProposalSchema=z.object({goal:ownerText}).strict();
export type AssistantDraftProposal=z.infer<typeof assistantDraftProposalSchema>;

/** Commands the host can offer for a validated draft. The model never chooses
 * these; they are computed from the handlers installed by the product host. */
export const assistantDraftCapabilitySchema=z.enum(['assistant.task.start','assistant.task.preview']);
export type AssistantDraftCapability=z.infer<typeof assistantDraftCapabilitySchema>;

/** One host-validated draft attached to a completed answer. `requestId` is
 * stable for retries; `revision` changes only for an explicit owner edit. */
export const assistantDraftSchema=z.object({
  requestId:uuid,revision,goal:ownerText,scope:queryScopeSchema,
  capabilities:z.array(assistantDraftCapabilitySchema).min(1).refine(values=>new Set(values).size===values.length,{message:'Draft capabilities must be unique'}),
}).strict();
export type AssistantDraft=z.infer<typeof assistantDraftSchema>;

/** An owner command for a stored answer draft. The command carries the same
 * requestId/goal/scope core as the task input, plus the exact stored answer and
 * the draft version the owner acted on. The host compares both with the stored
 * draft before dispatching to a domain handler. */
export const assistantDraftCommandSchema=assistantTaskInputSchema.extend({
  conversationId:uuid,turnId:uuid,expectedRevision:revision,
  capability:assistantDraftCapabilitySchema,
}).strict();
export type AssistantDraftCommand=z.infer<typeof assistantDraftCommandSchema>;
