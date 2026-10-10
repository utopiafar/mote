import {z} from 'zod';
import {ownerQuestionChoicesSchema,ownerQuestionEvidenceSchema,ownerQuestionProviderRefSchema,type OwnerQuestion,type OwnerQuestionReply} from '@mote/shared';
export {ownerQuestionSchema,ownerQuestionReplySchema,type OwnerQuestion,type OwnerQuestionReply,type OwnerQuestionPage,type OwnerQuestionChoice,type OwnerQuestionEvidence,type OwnerQuestionProviderRef} from '@mote/shared';

/** Providers are trusted installed product adapters, separate from read-only query tools. */
export const ownerQuestionCreateSchema=z.object({key:z.string().min(1).max(1024),operationId:z.string().min(1).max(512),workId:z.string().min(1).max(512),materialId:z.string().min(1).max(256).optional(),materialRef:z.string().min(1).max(512).optional(),title:z.string().min(1).max(500),prompt:z.string().min(1).max(6000),reason:z.string().max(2000).optional(),evidence:z.array(ownerQuestionEvidenceSchema).max(20),choices:ownerQuestionChoicesSchema.default([]),dependencyIds:z.array(z.string().min(1).max(256)).max(20000),context:z.unknown().optional()}).strict();
export type OwnerQuestionCreate=z.input<typeof ownerQuestionCreateSchema>;
/** data is ephemeral provider preparation, never a public response or persisted question. */
export const ownerQuestionAnswerSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('followup'),prompt:z.string().min(1).max(6000),choices:ownerQuestionChoicesSchema.optional(),data:z.unknown().optional()}).strict(),
 z.object({kind:z.literal('continued'),continuationId:z.string().min(1).max(512),outcome:z.string().max(6000).optional(),data:z.unknown().optional()}).strict(),
 z.object({kind:z.literal('closed'),outcome:z.string().max(6000).optional(),data:z.unknown().optional()}).strict(),
]);
export type OwnerQuestionAnswer=z.infer<typeof ownerQuestionAnswerSchema>;
export type OwnerQuestionRecord={question:OwnerQuestion;context:unknown};
export type ResolvedOwnerQuestionReply=OwnerQuestionReply&{answer?:string};
export type OwnerQuestionProvider={
 id:string;version:string;
 /** Durable installation identity. Reinstalling an adapter must use a new epoch. */
 installationEpoch:string;
 validate:(record:OwnerQuestionRecord)=>boolean;
 /** Read-only preparation, including optional model interpretation. No external effects. */
 answer:(record:OwnerQuestionRecord,reply:ResolvedOwnerQuestionReply)=>OwnerQuestionAnswer|Promise<OwnerQuestionAnswer>;
 /** Optional synchronous provider writes run inside the host's fenced transaction. */
 commit?:(record:OwnerQuestionRecord,reply:ResolvedOwnerQuestionReply,prepared:OwnerQuestionAnswer)=>OwnerQuestionAnswer|void;
};
export const ownerQuestionProviderInstallationSchema=ownerQuestionProviderRefSchema.extend({installationEpoch:z.string().min(1).max(256)}).strict();
