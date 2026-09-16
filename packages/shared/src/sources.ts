import {z} from 'zod';
import {sourceMetadataSchema} from './metadata.js';

const timestamp=z.string().max(64).datetime({offset:true});
// Authored/document time is independent of the time a connector observed a revision.
// Preserve provider metadata as bounded JSON evidence; it is never interpreted as instructions.
const originalMetadataSchema=z.record(z.unknown()).superRefine((value,ctx)=>{
  const stack:{value:unknown;depth:number}[]=[{value,depth:0}];let valid=true;
  while(stack.length&&valid){const item=stack.pop()!;
    if(item.depth>8){valid=false;break;}
    if(item.value===null||typeof item.value==='boolean'||typeof item.value==='string')continue;
    if(typeof item.value==='number'){valid=Number.isFinite(item.value);continue;}
    if(typeof item.value!=='object'){valid=false;break;}
    const entries=Object.entries(item.value);
    if(entries.length>200||(!Array.isArray(item.value)&&Object.getPrototypeOf(item.value)!==Object.prototype&&Object.getPrototypeOf(item.value)!==null)){valid=false;break;}
    for(const [key,child] of entries){if(['__proto__','prototype','constructor'].includes(key)){valid=false;break;}stack.push({value:child,depth:item.depth+1});}
  }
  if(!valid||JSON.stringify(value).length>32000)ctx.addIssue({code:'custom',message:'Original metadata must be bounded JSON (32,000 characters, depth 8)'});
});
export const codingEvidenceSchema=z.object({
  version:z.literal(1),provider:z.enum(['claude','codex','kimi']),sessionId:z.string().min(1).max(500),
  projectKey:z.string().min(1).max(200),cwd:z.string().max(4000).optional(),
  eventId:z.string().min(1).max(200),role:z.enum(['user','assistant','tool_call','tool_result','assistant_delta','tool_call_delta']),
  callId:z.string().max(500).optional(),parentSessionId:z.string().max(500).optional(),
  part:z.number().int().min(0),parts:z.number().int().min(1),
}).strict();
export type CodingEvidence=z.infer<typeof codingEvidenceSchema>;
export const documentSchema=z.object({
  coding:codingEvidenceSchema.optional(),
  fileId:z.string().min(1).max(200).optional(),path:z.string().max(4000).optional(),
  recordedAt:timestamp.describe('Explicit original authored/recording date; never the import or observation time. Omit when unknown.').optional(),occurredAt:timestamp.describe('Explicit time of the described event; omit when unknown.').optional(),
  timeBasis:z.enum(['recorded','occurred','unknown']).optional(),
  contentRole:z.enum(['authored','transcript','summary','reference','other']).optional(),
  attachments:z.array(z.object({id:z.string().min(1).max(200).optional(),name:z.string().max(1000).optional(),path:z.string().max(4000).optional(),uri:z.string().max(4000).optional(),mimeType:z.string().max(200).optional()}).strict()).max(100).optional(),
  originalMetadata:originalMetadataSchema.optional(),
}).strict();
export type SourceDocument=z.infer<typeof documentSchema>;
/** A document's explicit event/recording time, otherwise the actual observation time. */
export function sourceContentTime(record:{capturedAt:string;provenance?:{document?:SourceDocument}}):string {
  const document=record.provenance?.document;
  if(document?.timeBasis==='occurred'&&document.occurredAt)return document.occurredAt;
  return document?.recordedAt??record.capturedAt;
}
export const sourceIdSchema=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
export const sourceConnectionSchema=z.object({
  id:sourceIdSchema,name:z.string().trim().min(1).max(200),
  kind:z.enum(['local-calendar','local-files','coding-agent','google-calendar','mcp','upload','custom']),
  deviceId:sourceIdSchema,platform:z.enum(['macos','windows','linux','android','import']),
  initialSync:z.enum(['all','new_only']).optional(),retention:z.enum(['snapshot','reference','archive']).default('snapshot'),enabled:z.boolean().default(true),
}).strict();
export type SourceConnection=z.infer<typeof sourceConnectionSchema>&{createdAt:string;updatedAt:string;status?:{state:'idle'|'syncing'|'error'|'permission_required';code?:string;lastSyncAt?:string}};
export const calendarSchema=z.object({start:timestamp,end:timestamp,allDay:z.boolean(),timeZone:z.string().max(100).optional(),status:z.enum(['confirmed','tentative','cancelled']).default('confirmed')}).strict().refine(v=>Date.parse(v.end)>=Date.parse(v.start),{message:'Calendar end must not precede start'});
export const sourceItemSchema=z.object({
  externalId:z.string().min(1).max(1000),revision:z.string().min(1).max(200),observedAt:timestamp.describe('Actual source observation time. For document imports without an explicit source observation timestamp, copy the request importedAt exactly. Never substitute recordedAt, createdAt, modifiedAt, or an event date.'),modifiedAt:timestamp.optional(),
  title:z.string().max(2000).default(''),text:z.string().max(100000).default(''),
  uri:z.string().max(4000).optional(),kind:z.enum(['calendar','file','event','message','metric','memory']),
  layer:z.enum(['snapshot','reference','original','derived']),mimeType:z.string().max(200).optional(),calendar:calendarSchema.optional(),
  deleted:z.boolean().default(false),
  metadata:sourceMetadataSchema.optional(),
  document:documentSchema.optional(),
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
export const provenanceSchema=z.object({sourceId:sourceIdSchema,externalId:z.string().max(1000),revision:z.string().max(200),mimeType:z.string().max(200).optional(),layer:z.enum(['snapshot','reference','original','derived']),uri:z.string().max(4000).optional(),modifiedAt:timestamp.optional(),calendar:calendarSchema.optional(),deleted:z.boolean().default(false),metadata:sourceMetadataSchema.optional(),document:documentSchema.optional()}).strict();
