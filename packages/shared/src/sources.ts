import {z} from 'zod';
import {sourceMetadataSchema} from './metadata.js';

const timestamp=z.string().max(64).datetime({offset:true});
export const sourceIdSchema=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const sourceConnectionSchema=z.object({
  id:sourceIdSchema,name:z.string().trim().min(1).max(200),
  kind:z.enum(['local-calendar','local-files','google-calendar','mcp','upload','custom']),
  deviceId:sourceIdSchema,platform:z.enum(['macos','windows','linux','android','import']),
  retention:z.enum(['snapshot','reference','archive']).default('snapshot'),enabled:z.boolean().default(true),
}).strict();
export type SourceConnection=z.infer<typeof sourceConnectionSchema>&{createdAt:string;updatedAt:string;status?:{state:'idle'|'syncing'|'error'|'permission_required';code?:string;lastSyncAt?:string}};
export const calendarSchema=z.object({start:timestamp,end:timestamp,allDay:z.boolean(),timeZone:z.string().max(100).optional(),status:z.enum(['confirmed','tentative','cancelled']).default('confirmed')}).strict().refine(v=>Date.parse(v.end)>=Date.parse(v.start),{message:'Calendar end must not precede start'});
export const sourceItemSchema=z.object({
  externalId:z.string().min(1).max(1000),revision:z.string().min(1).max(200),observedAt:timestamp,modifiedAt:timestamp.optional(),
  title:z.string().max(2000).default(''),text:z.string().max(100000).default(''),
  uri:z.string().max(4000).optional(),kind:z.enum(['calendar','file','event','message','metric','memory']),
  layer:z.enum(['snapshot','reference','original','derived']),mimeType:z.string().max(200).optional(),calendar:calendarSchema.optional(),
  deleted:z.boolean().default(false),
  metadata:sourceMetadataSchema.optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.kind==='calendar'&&!v.calendar&&!v.deleted)ctx.addIssue({code:'custom',message:'Calendar items require event times'});
  if(v.kind!=='calendar'&&v.calendar)ctx.addIssue({code:'custom',message:'Calendar metadata belongs to calendar items'});
  if(v.kind!=='file'&&v.metadata?.file)ctx.addIssue({code:'custom',message:'File metadata belongs to file items'});
  if(!v.deleted&&v.metadata?.file?.deletionObservedAt)ctx.addIssue({code:'custom',message:'Deletion observation requires a deletion revision'});
  if(v.deleted&&v.text)ctx.addIssue({code:'custom',message:'Deletion revisions retain metadata only'});
  if(v.layer==='reference'&&v.text)ctx.addIssue({code:'custom',message:'References retain metadata only'});
  if(v.uri&&(/^[\u0000-\u0020]/.test(v.uri)||/[\u0000-\u001f]/.test(v.uri)))ctx.addIssue({code:'custom',message:'Invalid source URI'});
  if(v.uri){try{const u=new URL(v.uri);if(u.username||u.password||!['https:','http:','file:','content:','mcp:','nas:','calendar:'].includes(u.protocol))throw Error();}catch{ctx.addIssue({code:'custom',message:'Use a credential-free supported source URI'});}}
});
export type SourceItem=z.infer<typeof sourceItemSchema>;
export type SourceItemRecord=SourceItem&{captureId:string;sourceId:string;receivedAt:string;current:boolean};
export const provenanceSchema=z.object({sourceId:sourceIdSchema,externalId:z.string().max(1000),revision:z.string().max(200),mimeType:z.string().max(200).optional(),layer:z.enum(['snapshot','reference','original','derived']),uri:z.string().max(4000).optional(),modifiedAt:timestamp.optional(),calendar:calendarSchema.optional(),deleted:z.boolean().default(false),metadata:sourceMetadataSchema.optional()}).strict();
