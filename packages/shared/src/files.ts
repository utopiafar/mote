import {z} from 'zod';
import {fileCoverageSchema} from './file-view.js';
import type {ExecutionEnvelope} from './execution.js';
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
  /** Explicit item/batch override; omission preserves source/default inheritance. */
  processingProfileId:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).optional(),
}).strict().superRefine((v,c)=>{
  if(v.item.kind!=='file'||(!['snapshot'].includes(v.item.layer)&&v.item.text)||!['original','reference','snapshot'].includes(v.item.layer)||v.item.layer==='snapshot'&&!v.item.document?.fileIndex)c.addIssue({code:'custom',message:'Files require empty text and original/reference layer'});
  // Digest-addressed snapshots arrive through the multipart original path, which
  // already bounds parts and total bytes to FILE_MAX_BYTES. A smaller inline
  // payload limit must not reject ordinary recordings.
  if(v.item.layer==='snapshot'&&v.sha256&&(v.sizeBytes>FILE_MAX_BYTES||v.item.text||v.item.document?.fileIndex?.status!=='pending'||v.item.document?.fileIndex?.contentVersion!==v.sha256))c.addIssue({code:'custom',message:'Snapshot processing input must be pending, empty and within the file limit'});
  if(v.item.layer==='reference'&&v.sha256)c.addIssue({code:'custom',message:'References cannot include a content digest'});
  if(!v.item.deleted&&v.item.layer==='original'&&(!v.sha256||v.sizeBytes>FILE_MAX_BYTES))c.addIssue({code:'custom',message:'Original file requires a digest and must fit file limit'});
});
export type FileRevision=z.infer<typeof fileRevisionSchema>;
export const documentLocationSchema=z.object({pageNumber:z.number().int().positive().optional(),paragraphNumber:z.number().int().positive().optional(),endParagraphNumber:z.number().int().positive().optional(),sheetName:z.string().max(200).optional(),rowNumber:z.number().int().positive().optional(),columnNumber:z.number().int().positive().optional(),endColumnNumber:z.number().int().positive().optional(),offset:z.number().int().nonnegative(),length:z.number().int().nonnegative()}).strict().refine(value=>(value.endColumnNumber===undefined||value.columnNumber!==undefined&&value.endColumnNumber>=value.columnNumber)&&(value.endParagraphNumber===undefined||value.paragraphNumber!==undefined&&value.endParagraphNumber>=value.paragraphNumber),{message:'Coordinate ranges require ordered starting positions'});
/** Pixel coordinates in the original image, not in an OCR tile. Geometry is
 * evidence for model interpretation, never an inferred speaker or UI role. */
export const imageLocationSchema=z.object({
  width:z.number().int().positive().max(1_000_000),height:z.number().int().positive().max(1_000_000),
  polygon:z.array(z.tuple([z.number().finite().min(-1_000_000).max(1_000_000),z.number().finite().min(-1_000_000).max(1_000_000)])).min(3).max(16),
}).strict();
export const transcriptSegmentSchema=z.object({
  startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),text:z.string().min(1).max(8000),
  untimed:z.literal(true).optional(),speaker:z.string().max(100).optional(),uncertain:z.boolean().optional(),overlap:z.boolean().optional(),
  documentLocation:documentLocationSchema.optional(),
  imageLocation:imageLocationSchema.optional(),
  words:z.array(z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),text:z.string().max(1000),probability:z.number().min(0).max(1).optional()}).strict()).max(8000).optional(),
}).strict();
export const transcriptSchema=z.object({
  durationMs:z.number().finite().nonnegative(),
  segments:z.array(transcriptSegmentSchema).max(50000),
  coverage:z.enum(['full','partial','none']).optional(),extraction:fileCoverageSchema.optional(),engine:z.string().max(200).optional(),uncorrected:z.literal(true).optional(),warnings:z.array(z.string().max(1000)).max(30).optional(),
}).strict().superRefine((v,c)=>{let last=0;for(const s of v.segments){if(s.endMs<s.startMs||s.endMs>v.durationMs+1000||s.startMs<last)c.addIssue({code:'custom',message:'Invalid transcript timeline'});last=s.startMs;
  // Native ASR can place a word outside its sentence while both remain within
  // the recording. Preserve that raw timing; alignment must use the sentence
  // with explicit uncertainty rather than shifting or discarding model words.
  let wordLast=0;for(const w of s.words??[]){if(w.endMs<w.startMs||w.startMs<wordLast||w.endMs>v.durationMs+1000)c.addIssue({code:'custom',message:'Invalid word timeline'});wordLast=w.startMs;}
}});
export type Transcript=z.infer<typeof transcriptSchema>;
const speakerLabel=z.string().regex(/^SPEAKER_(?:[0-9]{1,5}|UNKNOWN)$/);
export const speakerRangeSchema=z.object({min:z.number().int().min(1).max(16),max:z.number().int().min(1).max(16)}).strict().refine(v=>v.min<=v.max,'Invalid speaker range');
export const fileDiarizationOptionsSchema=z.object({processor:z.enum(['audio.diarize','audio.diarize-wespeaker']),speakerCount:z.number().int().min(1).max(16).nullable(),range:speakerRangeSchema.nullable()}).strict().refine(v=>!(v.speakerCount&&v.range),'Choose exact count or range');
export type FileDiarizationOptions=z.infer<typeof fileDiarizationOptionsSchema>;
const acousticSegmentSchema=z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),speaker:speakerLabel}).strict();
export const diarizationSchema=z.object({
  durationMs:z.number().finite().nonnegative(),engine:z.string().min(1).max(200),
  // Model labels are unverified clusters. Their bounded count is independent of
  // the configured person-count constraint and the 16-clip preview allowance.
  expectedSpeakers:z.number().int().min(1).max(16).nullable(),observedSpeakers:z.number().int().min(0).max(100000),
  declaredRange:speakerRangeSchema.optional(),
  modelProvenance:z.object({embedding:z.enum(['3d-speaker','wespeaker-zh']),embeddingSha256:z.string().regex(/^[a-f0-9]{64}$/),segmentationSha256:z.string().regex(/^[a-f0-9]{64}$/),runtime:z.string().max(100),threshold:z.literal(0.5),minDurationOn:z.literal(0.1),minDurationOff:z.literal(0.3),threads:z.number().int().min(1).max(32)}).strict().optional(),
  estimate:z.object({method:z.literal('bounded-silhouette-v1'),selectedClusters:z.number().int().min(-1).max(16),needsReview:z.literal(true),scoreGap:z.number().finite().nullable(),candidates:z.array(z.object({clusters:z.number().int().min(-1).max(16),observedSpeakers:z.number().int().min(0).max(100000),score:z.number().min(-1).max(1).nullable(),segments:z.array(acousticSegmentSchema).max(100000)}).strict()).min(1).max(17)}).strict().optional(),
  overlapDetection:z.enum(['available','unknown']),
  segments:z.array(z.object({startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),speaker:speakerLabel}).strict()).max(100000),
  samples:z.array(z.object({speaker:speakerLabel,startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),wavBase64:z.string().max(1024*1024)}).strict()).max(16).default([]),
  warnings:z.array(z.string().max(1000)).max(30).default([]),
}).strict().superRefine((v,c)=>{for(const s of [...v.segments,...v.samples,...(v.estimate?.candidates.flatMap(candidate=>candidate.segments)??[])])if(s.endMs<=s.startMs||s.endMs>v.durationMs+1000)c.addIssue({code:'custom',message:'Invalid diarization timeline'});});
export type Diarization=z.infer<typeof diarizationSchema>;
export const fileSpeakerAttributionSchema=z.object({name:z.string().trim().min(1).max(100),confirmedBy:z.literal('owner'),confirmationId:z.string().uuid(),confirmedAt:z.string().datetime()}).strict();
export const fileEvidenceSchema=z.object({documentLocation:documentLocationSchema.optional(),imageLocation:imageLocationSchema.optional(),captureId:z.string().uuid(),revision:z.string().max(200),artifactId:z.string().uuid(),chunkId:z.string().uuid(),startMs:z.number().nonnegative().optional(),endMs:z.number().nonnegative().optional(),speaker:z.string().max(100).optional(),speakerAttribution:fileSpeakerAttributionSchema.optional(),uncertain:z.boolean().optional(),overlap:z.boolean().optional()}).strict();
export const fileProcessingSchema=z.object({
  enabled:z.boolean().default(true),
  endpoint:z.string().max(2000).default('http://127.0.0.1:9009/transcribe'),
  allowRemote:z.boolean().default(false),
  apiKey:z.string().max(4096).optional(),
  summarize:z.boolean().default(false),
  audioProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('audio.local-dialogue'),
  diarizationProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('audio.diarize'),
  imageProcessor:z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/).default('archive'),
  imageEndpoint:z.string().max(2000).default(''),
  localEndpoint:z.string().max(2000).default('http://127.0.0.1:9009/transcribe'),
  localWorkerApiKey:z.string().max(4096).optional(),
  speakerCount:z.number().int().min(1).max(16).nullable().default(null),
  speakerMin:z.number().int().min(1).max(16).nullable().default(null),
  speakerMax:z.number().int().min(1).max(16).nullable().default(null),
  semanticTurns:z.boolean().default(false),
  sourceProfiles:z.record(sourceIdSchema,z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/)).default({}),
  typeProfiles:z.record(z.string().regex(/^[a-z0-9.+-]+\/(?:[a-z0-9.+-]+|\*)$/),z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/)).default({}),
  maxAudioMinutes:z.number().int().min(1).max(1440).default(120),
  // Call protection only; durable file workflows have no overall deadline.
  timeoutMs:z.number().int().min(1000).max(3600000).default(3600000),
}).strict().superRefine((v,c)=>{
  if((v.speakerMin===null)!==(v.speakerMax===null)||v.speakerMin!==null&&(v.speakerCount!==null||v.speakerMax!<v.speakerMin))c.addIssue({code:'custom',message:'Choose unknown, exact count or a complete ordered range'});
  for(const endpoint of [v.endpoint,v.imageEndpoint].filter(Boolean))try{const u=new URL(endpoint);if(u.username||u.password||u.hash||u.search||!['http:','https:'].includes(u.protocol))throw Error();const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);if(!local&&(!v.allowRemote||u.protocol!=='https:'))throw Error();}catch{c.addIssue({code:'custom',message:'Use a local endpoint or explicitly allow an HTTPS remote endpoint'});}
  for(const endpoint of [v.localEndpoint])try{const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw Error();}catch{c.addIssue({code:'custom',message:'Local processing endpoints must use loopback'});}
});
export type FileProcessingSettings=z.infer<typeof fileProcessingSchema>;

/** Independent canonical receipts for archived-file processing and summary work. */
export type FileProcessingJobView={
 state:string;stage?:string;attempts?:number;error?:string|null;summary_state:string;availableAt?:number;inputVersion?:string|null;
 execution?:ExecutionEnvelope;summaryExecution?:ExecutionEnvelope;summaryAvailableAt?:number;
};
