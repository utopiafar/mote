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
  if(v.item.kind!=='file'||(!['snapshot'].includes(v.item.layer)&&v.item.text)||!['original','reference','snapshot'].includes(v.item.layer)||v.item.layer==='snapshot'&&!v.item.document?.fileIndex)c.addIssue({code:'custom',message:'Files require empty text and original/reference layer'});
  if(v.item.layer==='reference'&&v.sha256)c.addIssue({code:'custom',message:'References cannot include a content digest'});
  if(!v.item.deleted&&v.item.layer==='original'&&(!v.sha256||v.sizeBytes>FILE_MAX_BYTES))c.addIssue({code:'custom',message:'Original file requires a digest and must fit file limit'});
});
export type FileRevision=z.infer<typeof fileRevisionSchema>;
export const transcriptSegmentSchema=z.object({
  startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),text:z.string().min(1).max(8000),
  speaker:z.string().max(100).optional(),uncertain:z.boolean().optional(),overlap:z.boolean().optional(),
  words:z.array(z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),text:z.string().max(1000),probability:z.number().min(0).max(1).optional()}).strict()).max(8000).optional(),
}).strict();
export const transcriptSchema=z.object({
  durationMs:z.number().finite().nonnegative(),
  segments:z.array(transcriptSegmentSchema).max(50000),
  engine:z.string().max(200).optional(),uncorrected:z.literal(true).optional(),warnings:z.array(z.string().max(1000)).max(30).optional(),
}).strict().superRefine((v,c)=>{let last=0;for(const s of v.segments){if(s.endMs<s.startMs||s.endMs>v.durationMs+1000||s.startMs<last)c.addIssue({code:'custom',message:'Invalid transcript timeline'});last=s.startMs;let wordLast=s.startMs;for(const w of s.words??[]){if(w.endMs<w.startMs||w.startMs<wordLast||w.startMs<s.startMs||w.endMs>s.endMs+1)c.addIssue({code:'custom',message:'Invalid word timeline'});wordLast=w.startMs;}}});
export type Transcript=z.infer<typeof transcriptSchema>;
const speakerLabel=z.string().regex(/^SPEAKER_(?:[0-9]{1,2}|UNKNOWN)$/);
export const diarizationSchema=z.object({
  durationMs:z.number().finite().nonnegative(),engine:z.string().min(1).max(200),
  expectedSpeakers:z.number().int().min(1).max(16).nullable(),observedSpeakers:z.number().int().min(0).max(16),
  overlapDetection:z.enum(['available','unknown']),
  segments:z.array(z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),speaker:speakerLabel}).strict()).max(100000),
  samples:z.array(z.object({speaker:speakerLabel,startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),wavBase64:z.string().max(1024*1024)}).strict()).max(16).default([]),
  warnings:z.array(z.string().max(1000)).max(30).default([]),
}).strict().superRefine((v,c)=>{for(const s of [...v.segments,...v.samples])if(s.endMs<=s.startMs||s.endMs>v.durationMs+1000)c.addIssue({code:'custom',message:'Invalid diarization timeline'});});
export type Diarization=z.infer<typeof diarizationSchema>;
export const fileEvidenceSchema=z.object({captureId:z.string().uuid(),revision:z.string().max(200),artifactId:z.string().uuid(),chunkId:z.string().uuid(),startMs:z.number().nonnegative().optional(),endMs:z.number().nonnegative().optional(),speaker:z.string().max(100).optional(),uncertain:z.boolean().optional(),overlap:z.boolean().optional()}).strict();
export const fileProcessingSchema=z.object({
  enabled:z.boolean().default(false),
  endpoint:z.string().max(2000).default('http://127.0.0.1:9009/transcribe'),
  allowRemote:z.boolean().default(false),
  apiKey:z.string().max(4096).optional(),
  summarize:z.boolean().default(false),
  audioProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('audio.http'),
  diarizationProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('audio.diarize'),
  imageProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('image.http'),
  imageEndpoint:z.string().max(2000).default(''),
  localEndpoint:z.string().max(2000).default('http://127.0.0.1:9009/transcribe'),
  localWorkerApiKey:z.string().max(4096).optional(),
  speakerCount:z.number().int().min(1).max(16).nullable().default(null),
  semanticTurns:z.boolean().default(false),
  localModelEndpoint:z.string().max(2000).default('http://127.0.0.1:8080/v1'),
  localModelName:z.string().max(200).default(''),
  localModelApiKey:z.string().max(4096).optional(),
  sourceProfiles:z.record(sourceIdSchema,z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/)).default({}),
  typeProfiles:z.record(z.string().regex(/^[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*)$/),z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/)).default({}),
  dailyAudioMinutes:z.number().int().min(1).max(100000).default(240),
  timeoutMs:z.number().int().min(1000).max(3600000).default(600000),
}).strict().superRefine((v,c)=>{
  for(const endpoint of [v.endpoint,v.imageEndpoint].filter(Boolean))try{const u=new URL(endpoint);if(u.username||u.password||u.hash||u.search||!['http:','https:'].includes(u.protocol))throw Error();const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);if(!local&&(!v.allowRemote||u.protocol!=='https:'))throw Error();}catch{c.addIssue({code:'custom',message:'Use a local endpoint or explicitly allow an HTTPS remote endpoint'});}
  for(const endpoint of [v.localModelEndpoint,v.localEndpoint])try{const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw Error();}catch{c.addIssue({code:'custom',message:'Local processing endpoints must use loopback'});}
});
export type FileProcessingSettings=z.infer<typeof fileProcessingSchema>;
