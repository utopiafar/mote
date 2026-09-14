import { z } from 'zod';
import {provenanceSchema} from './sources.js';
import {recordMetadataSchema} from './metadata.js';
export * from './sources.js';
export * from './metadata.js';
export type { ServerConfiguration, ConfigurationGroup, ConfigurationField, ConfigurationValue, ConfigurationSource } from './configuration.js';

export const platformSchema = z.enum(['macos', 'windows', 'linux', 'android', 'import']);
export const sourceSchema = z.enum(['screen', 'activity', 'file', 'note', 'calendar', 'event', 'message', 'metric', 'memory']);
// A mood is the author's own label, never inferred from note text or app identity.
export const moodSchema = z.string().max(80).refine(value => value.trim().length > 0, 'Mood cannot be blank');
export const privacySchema = z.object({
  excluded: z.boolean().default(false), redacted: z.boolean().default(false),
  mode: z.enum(['local', 'none', 'model', 'masked']).default('local'), reason: z.string().max(500).optional(),
  collection: z.enum(['content', 'activity']).optional(),
}).strict();
export const captureSchema = z.object({
  id: z.string().uuid(), deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  deviceName: z.string().min(1).max(200), platform: platformSchema,
  capturedAt: z.string().max(64).datetime({offset:true}), durationMs: z.number().int().min(0).max(300000),
  appId: z.string().max(300).default(''), appName: z.string().max(200).default(''),
  windowTitle: z.string().max(2000).default(''),
  imageBase64: z.string().max(11_000_000).optional(), imageMime: z.enum(['image/jpeg','image/png','image/webp']).optional(),
  ocrText: z.string().max(100000).default(''), source: sourceSchema.default('screen'),
  mood: moodSchema.optional(),
  provenance: provenanceSchema.optional(),
  metadata: recordMetadataSchema.optional(),
  privacy: privacySchema.default({excluded:false,redacted:false,mode:'local'}),
}).strict().superRefine((v,ctx) => {
  if (Boolean(v.imageBase64) !== Boolean(v.imageMime)) ctx.addIssue({code:'custom',message:'imageBase64 and imageMime must be supplied together'});
  if (v.privacy.excluded) ctx.addIssue({code:'custom',message:'Excluded captures must never be uploaded'});
  if (!v.imageBase64 && !v.ocrText.trim() && !v.provenance && v.source !== 'activity') ctx.addIssue({code:'custom',message:'An image or text is required'});
  if (v.source === 'activity') {
    if (v.privacy.collection !== 'activity' || !v.appId.trim() || v.imageBase64 !== undefined || v.imageMime !== undefined || v.ocrText || v.windowTitle || v.mood !== undefined || v.provenance || v.privacy.redacted)
      ctx.addIssue({code:'custom',message:'Activity records require an app identity and activity collection, without content, images or source references'});
    if (v.metadata?.capture && Object.keys(v.metadata.capture).some(key => key !== 'intervalMs'))
      ctx.addIssue({code:'custom',path:['metadata','capture'],message:'Activity metadata cannot describe screen content processing'});
  } else if (v.privacy.collection === 'activity') ctx.addIssue({code:'custom',message:'Activity collection must use the activity source'});
  if(v.provenance&&(v.provenance.layer==='reference'||v.provenance.deleted)&&v.ocrText)ctx.addIssue({code:'custom',message:'Reference and deletion records must not contain original text'});
  if(v.provenance&&(v.durationMs!==0||v.imageBase64||['screen','activity','note'].includes(v.source)))ctx.addIssue({code:'custom',message:'Versioned source records require zero duration and no screen/activity/note payload'});
  if (v.provenance?.metadata?.file && v.source !== 'file') ctx.addIssue({code:'custom',message:'File metadata belongs to file sources'});
  if (v.provenance?.metadata?.file?.deletionObservedAt && !v.provenance.deleted) ctx.addIssue({code:'custom',message:'Deletion observation requires a deletion revision'});
  if (v.mood !== undefined && v.source !== 'note') ctx.addIssue({code:'custom',path:['mood'],message:'Mood must be explicitly supplied for a user note'});
  if (v.source === 'note' && (v.durationMs !== 0 || v.imageBase64 || !v.ocrText.trim())) ctx.addIssue({code:'custom',message:'Notes require original text, zero duration and no image'});
});
export type CaptureInput = z.infer<typeof captureSchema>;
export const noteSchema = z.object({
  id: z.string().uuid(), deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  deviceName: z.string().min(1).max(200), platform: platformSchema,
  capturedAt: z.string().max(64).datetime({offset:true}),
  text: z.string().max(100000).refine(value => value.trim().length > 0, 'Note text cannot be blank'),
  mood: moodSchema.optional(),
  metadata: recordMetadataSchema.optional(),
}).strict();
export type NoteInput = z.infer<typeof noteSchema>;
export function noteCapture(note: NoteInput): CaptureInput {
  return captureSchema.parse({
    id:note.id,deviceId:note.deviceId,deviceName:note.deviceName,platform:note.platform,capturedAt:note.capturedAt,
    source:'note',durationMs:0,appId:'dev.mote.notes',appName:'随手记',windowTitle:'',ocrText:note.text,
    ...(note.mood === undefined ? {} : {mood:note.mood}),privacy:{excluded:false,redacted:false,mode:'none'},
    ...(note.metadata === undefined ? {} : {metadata:note.metadata}),
  });
}
export type CaptureRecord = Omit<CaptureInput,'imageBase64'|'imageMime'> & {
  receivedAt: string; blobHash: string | null; imageMime: string | null;
  indexingStatus: 'text_ready'|'pending'|'indexed'|'failed'; summary?: string;
};
export const heartbeatSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/), deviceName: z.string().min(1).max(200), platform: platformSchema,
  status: z.enum(['capturing','paused','permission_required','error','offline']),
  queueDepth: z.number().int().min(0).max(1000000), lastCaptureAt: z.string().max(64).datetime({offset:true}).nullable().optional(),
  error: z.string().max(1000).nullable().optional(),
  metadata: recordMetadataSchema.optional(),
}).strict();
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type DeviceRecord = Heartbeat & {lastSeenAt:string};
export const rangeSchema = z.object({
  after: z.string().max(64).datetime({offset:true}).optional(), before: z.string().max(64).datetime({offset:true}).optional(),
  deviceId: z.string().max(128).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  source: sourceSchema.optional(),
  appId: z.string().min(1).max(300).optional(),
  collection: z.enum(['content','activity']).optional(),
}).refine(v => !v.after || !v.before || Date.parse(v.after)<Date.parse(v.before), {message:'after must be earlier than before'});
export type TimeRange = z.input<typeof rangeSchema>;
export type QueryResult = {answer:string; citations:{id:string;capturedAt:string;appName:string;excerpt:string}[]; trace:{tool:string;arguments:unknown;count:number}[];runId:string};
export type ActivityCounts = {activityEvents?:number;contentCaptures?:number};
export type Activity = ActivityCounts & {apps:(ActivityCounts & {appId?:string;appName:string;durationMs:number;captures:number})[];devices:(ActivityCounts & {deviceId:string;deviceName:string;durationMs:number;captures:number})[];totalDurationMs:number;captures:number};
export * from './connection.js';
