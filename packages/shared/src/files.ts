import {z} from 'zod';
import {sourceIdSchema,sourceItemSchema} from './sources.js';

export const initialSyncSchema=z.enum(['all','new_only']);
export const FILE_PART_BYTES=4*1024*1024;
export const FILE_MAX_BYTES=512*1024*1024;
export const fileRevisionSchema=z.object({
  sourceId:sourceIdSchema,
  previousRevision:z.string().min(1).max(200).nullable().default(null),
  item:sourceItemSchema,
  sizeBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  relativePath:z.string().max(4000).default(''),
}).strict().superRefine((v,c)=>{
  if(v.item.kind!=='file'||v.item.text||!['original','reference'].includes(v.item.layer))c.addIssue({code:'custom',message:'Files require empty text and original/reference layer'});
  if(v.item.layer==='reference'&&v.sha256)c.addIssue({code:'custom',message:'References cannot include a content digest'});
  if(!v.item.deleted&&v.item.layer==='original'&&(!v.sha256||v.sizeBytes>FILE_MAX_BYTES))c.addIssue({code:'custom',message:'Original file requires a digest and must fit file limit'});
});
export type FileRevision=z.infer<typeof fileRevisionSchema>;
export const transcriptSchema=z.object({
  durationMs:z.number().finite().nonnegative(),
  segments:z.array(z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),text:z.string().min(1).max(8000),speaker:z.string().max(100).optional()}).strict()).max(50000),
}).strict().superRefine((v,c)=>{let last=0;for(const s of v.segments){if(s.endMs<s.startMs||s.endMs>v.durationMs+1000||s.startMs<last)c.addIssue({code:'custom',message:'Invalid transcript timeline'});last=s.startMs;}});
export type Transcript=z.infer<typeof transcriptSchema>;
export const fileEvidenceSchema=z.object({captureId:z.string().uuid(),revision:z.string().max(200),artifactId:z.string().uuid(),chunkId:z.string().uuid(),startMs:z.number().nonnegative().optional(),endMs:z.number().nonnegative().optional()}).strict();
export const fileProcessingSchema=z.object({
  enabled:z.boolean().default(false),
  endpoint:z.string().max(2000).default('http://127.0.0.1:9009/transcribe'),
  allowRemote:z.boolean().default(false),
  apiKey:z.string().max(4096).optional(),
  summarize:z.boolean().default(false),
  dailyAudioMinutes:z.number().int().min(1).max(100000).default(240),
  timeoutMs:z.number().int().min(1000).max(3600000).default(600000),
}).strict().superRefine((v,c)=>{try{const u=new URL(v.endpoint);if(u.username||u.password||u.hash||u.search||!['http:','https:'].includes(u.protocol))throw Error();const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);if(!local&&(!v.allowRemote||u.protocol!=='https:'))throw Error();}catch{c.addIssue({code:'custom',message:'Use a local endpoint or explicitly allow an HTTPS remote endpoint'});}});
export type FileProcessingSettings=z.infer<typeof fileProcessingSchema>;
