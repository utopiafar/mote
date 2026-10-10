import {z} from 'zod';

export const ownerQuestionProviderRefSchema=z.object({id:z.string().min(1).max(128),version:z.string().min(1).max(128)}).strict();
export const ownerQuestionChoiceSchema=z.object({id:z.string().min(1).max(128),label:z.string().min(1).max(500),answer:z.string().min(1).max(6000)}).strict();
export const ownerQuestionChoicesSchema=z.array(ownerQuestionChoiceSchema).max(8).refine(choices=>new Set(choices.map(choice=>choice.id)).size===choices.length,'Choice IDs must be unique');
export const ownerQuestionEvidenceSchema=z.object({id:z.string().min(1).max(256),quote:z.string().min(1).max(2000),offset:z.number().int().nonnegative().optional(),ref:z.string().min(1).max(512).optional()}).strict();
export const ownerQuestionStateSchema=z.enum(['open','deferred','answered','closed','obsolete']);
export const ownerQuestionSchema=z.object({
 id:z.string().uuid(),provider:ownerQuestionProviderRefSchema,operationId:z.string().min(1).max(512),workId:z.string().min(1).max(512),
 materialId:z.string().min(1).max(256).optional(),materialRef:z.string().min(1).max(512).optional(),title:z.string().max(500),prompt:z.string().max(6000),reason:z.string().max(2000).optional(),
 evidence:z.array(ownerQuestionEvidenceSchema).max(20),choices:ownerQuestionChoicesSchema,state:ownerQuestionStateSchema,revision:z.number().int().positive(),createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true}),
 messages:z.array(z.object({role:z.enum(['assistant','user']),text:z.string().max(6000),createdAt:z.string().datetime({offset:true})}).strict()),continuationId:z.string().min(1).max(512).optional(),outcome:z.string().max(6000).optional(),
}).strict();
export type OwnerQuestion=z.infer<typeof ownerQuestionSchema>;
export type OwnerQuestionChoice=z.infer<typeof ownerQuestionChoiceSchema>;
export type OwnerQuestionEvidence=z.infer<typeof ownerQuestionEvidenceSchema>;
export type OwnerQuestionProviderRef=z.infer<typeof ownerQuestionProviderRefSchema>;
export const ownerQuestionReplySchema=z.object({requestId:z.string().uuid(),expectedRevision:z.number().int().positive(),action:z.enum(['answer','unknown','defer']),answer:z.string().min(1).max(6000).refine(answer=>answer.trim().length>0,'Answer cannot be blank').optional(),choiceId:z.string().min(1).max(128).optional()}).strict().superRefine((reply,ctx)=>{
 if(reply.action==='answer'&&Number(reply.answer!==undefined)+Number(reply.choiceId!==undefined)!==1)ctx.addIssue({code:z.ZodIssueCode.custom,message:'An answer requires either text or one authored choice'});
 if(reply.action!=='answer'&&(reply.answer!==undefined||reply.choiceId!==undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'This action does not accept answer text or a choice'});
});
export type OwnerQuestionReply=z.infer<typeof ownerQuestionReplySchema>;
export type OwnerQuestionPage={items:OwnerQuestion[];nextCursor:string|null};
