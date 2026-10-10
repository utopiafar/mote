import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ownerQuestionReplySchema,ownerQuestionStateSchema} from '@mote/shared';
import {StoreError} from '../store.js';
import type {OwnerQuestions} from '../owner-questions.js';

/** Owner replies use the host control plane. No query-agent write tool is registered. */
export function register(app:FastifyInstance,{ownerQuestions,credential}:{ownerQuestions:OwnerQuestions;credential:(request:FastifyRequest)=>unknown}){
 const owner=(request:FastifyRequest)=>{if(credential(request))throw new StoreError('Owner access required',403);};
 const id=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
 app.get('/api/owner-questions',async request=>{owner(request);return ownerQuestions.page(z.object({state:z.string().transform(value=>value.split(',')).pipe(z.array(ownerQuestionStateSchema).min(1).max(5)).optional(),operationId:z.string().max(512).optional(),operationIds:z.string().transform((value,ctx)=>{try{return JSON.parse(value);}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid operation IDs'});return z.NEVER;}}).pipe(z.array(z.string().min(1).max(512)).min(1).max(100)).optional(),workId:z.string().max(512).optional(),materialId:z.string().max(256).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().max(1000).optional()}).strict().parse(request.query));});
 app.get('/api/owner-questions/:id',async request=>{owner(request);return ownerQuestions.get(id(request.params));});
 app.post('/api/owner-questions/:id/reply',{bodyLimit:16384},async request=>{owner(request);return ownerQuestions.reply(id(request.params),ownerQuestionReplySchema.parse(request.body));});
}
