export * from './usage.js';
export * from './ui-page.js';
import {uiPageText} from './ui-page.js';
import { z } from 'zod';
import {provenanceSchema} from './sources.js';
import {stateOnly,stateSeriesSchema} from './state-series.js';
export * from './state-series.js';
import {recordMetadataSchema,ocrSchema,type OcrState,type MediaMetadata} from './metadata.js';
export * from './sources.js';
export * from './file-index.js';
export * from './metadata.js';
export * from './imports.js';
export type { ServerConfiguration, ConfigurationGroup, ConfigurationField, ConfigurationValue, ConfigurationSource } from './configuration.js';

export const platformSchema = z.enum(['macos', 'windows', 'linux', 'android', 'import']);
export const sourceSchema = z.enum(['screen', 'ui_page', 'activity', 'media', 'notification', 'device_event', 'file', 'note', 'calendar', 'event', 'message', 'metric', 'memory']);
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
  stateSeries: stateSeriesSchema.optional(),
  capturedAt: z.string().max(64).datetime({offset:true}), durationMs: z.number().int().min(0).max(300000),
  appId: z.string().max(300).default(''), appName: z.string().max(200).default(''),
  windowTitle: z.string().max(2000).default(''),
  imageBase64: z.string().max(11_000_000).optional(), imageMime: z.enum(['image/jpeg','image/png','image/webp']).optional(),
  ocrText: z.string().max(100000).default(''), source: sourceSchema.default('screen'),
  ocr: ocrSchema.optional(),
  mood: moodSchema.optional(),
  provenance: provenanceSchema.optional(),
  metadata: recordMetadataSchema.optional(),
  privacy: privacySchema.default({excluded:false,redacted:false,mode:'local'}),
}).strict().superRefine((v,ctx) => {
  if (v.metadata?.uiPage && v.source !== 'ui_page') ctx.addIssue({code:'custom',message:'Page evidence belongs to ui_page'});
  if (v.source === 'ui_page') {
    const p=v.metadata?.uiPage;
    if (!p || !['android','macos'].includes(v.platform) || !v.appId || v.durationMs!==0 || v.imageBase64 || v.imageMime || v.windowTitle || v.provenance || v.mood || v.privacy.collection!=='content' || v.metadata?.collector?.method!=='accessibility' || v.metadata?.capture || v.metadata?.media || v.metadata?.notification || v.metadata?.deviceEvent || p && v.ocrText!==uiPageText(p)) ctx.addIssue({code:'custom',message:'Invalid UI page observation'});
  }
  if (v.appId && !v.appName.trim()) ctx.addIssue({code:'custom',path:['appName'],message:'An application identifier requires a nonblank application name'});
  if(v.stateSeries){const series=v.stateSeries.samples;const first=series[0];if(!first){ctx.addIssue({code:'custom',message:'Empty state series'});return;}if(!stateOnly(v)||first.at!==v.capturedAt||first.durationMs!==v.durationMs||series.some((s,i)=>i>0&&(Date.parse(s.at)<=Date.parse(series[i-1].at)||Date.parse(s.at)-Date.parse(series[i-1].at)>300000))||Date.parse(series.at(-1)!.at)-Date.parse(first.at)>21600000)ctx.addIssue({code:'custom',message:'Invalid state observation series'});}
  if (v.metadata?.capture?.deduplication && (v.source !== 'screen' || v.imageBase64 || v.imageMime || v.ocrText || v.ocr?.status !== 'disabled')) ctx.addIssue({code:'custom',message:'Duplicate screenshots require metadata only and disabled OCR'});
  if (v.ocr && v.source !== 'screen') ctx.addIssue({code:'custom',message:'OCR processing state belongs only to screenshots'});
  if (v.ocr?.status === 'pending' && (!v.imageBase64 || v.ocrText)) ctx.addIssue({code:'custom',message:'Pending OCR requires a screenshot without recognized text'});
  if (Boolean(v.imageBase64) !== Boolean(v.imageMime)) ctx.addIssue({code:'custom',message:'imageBase64 and imageMime must be supplied together'});
  if (v.privacy.excluded) ctx.addIssue({code:'custom',message:'Excluded captures must never be uploaded'});
  if (!v.imageBase64 && !v.ocrText.trim() && !v.provenance && !v.metadata?.capture?.deduplication && !['activity','media','notification','device_event'].includes(v.source)) ctx.addIssue({code:'custom',message:'An image or text is required'});
  if (v.source === 'activity') {
    if (v.privacy.collection !== 'activity' || !v.appId.trim() || v.imageBase64 !== undefined || v.imageMime !== undefined || v.ocrText || v.windowTitle || v.mood !== undefined || v.provenance || v.privacy.redacted)
      ctx.addIssue({code:'custom',message:'Activity records require an app identity and activity collection, without content, images or source references'});
    if (v.metadata?.capture && Object.keys(v.metadata.capture).some(key => key !== 'intervalMs'))
      ctx.addIssue({code:'custom',path:['metadata','capture'],message:'Activity metadata cannot describe screen content processing'});
  } else if (v.privacy.collection === 'activity' && !['media','notification'].includes(v.source)) ctx.addIssue({code:'custom',message:'Activity collection must use the activity or media source'});
  if (v.privacy.collection === 'activity' && v.metadata?.media?.sessions.some(session =>
    ['title','artist','album','displaySubtitle','mediaId'].some(key => key in session)))
    ctx.addIssue({code:'custom',path:['metadata','media'],message:'Activity collection cannot contain media titles or content identifiers'});
  if (v.source === 'media') {
    const media = v.metadata?.media;
    if (!media || v.imageBase64 !== undefined || v.imageMime !== undefined || v.ocrText || v.windowTitle || v.mood !== undefined || v.provenance || v.privacy.redacted)
      ctx.addIssue({code:'custom',message:'Media observations require media metadata without images, OCR, titles, notes or source references'});
    if (v.metadata?.capture && Object.keys(v.metadata.capture).some(key => key !== 'intervalMs'))
      ctx.addIssue({code:'custom',path:['metadata','capture'],message:'Media metadata cannot describe screen content processing'});
    if (v.durationMs > 60000 || (v.durationMs > 0 && (media?.status !== 'available' || media.sessions.length !== 1 || media.sessions[0]?.playbackState !== 'playing' || media.sessions[0]?.appId !== v.appId || media.sessions[0]?.appName !== v.appName)))
      ctx.addIssue({code:'custom',message:'Media intervals require one matching playing session and at most 60 seconds of observed time'});
  }
  if (v.metadata?.notification && v.source !== 'notification' || v.metadata?.deviceEvent && v.source !== 'device_event')
    ctx.addIssue({code:'custom',message:'System event payload must match its source'});
  if (v.source === 'notification' || v.source === 'device_event') {
    if (v.durationMs !== 0 || !['android','macos'].includes(v.platform) || v.imageBase64 !== undefined || v.ocrText || v.windowTitle || v.mood !== undefined || v.provenance || v.metadata?.media || v.metadata?.capture)
      ctx.addIssue({code:'custom',message:'System observations require zero duration and no unrelated content'});
    if (!v.metadata?.observation || !(v.metadata.collector?.method === 'notification_listener' || v.platform === 'macos' && v.metadata.collector?.method === 'accessibility'))
      ctx.addIssue({code:'custom',message:'System observations require observer provenance'});
    if (v.source === 'notification') {
      const n=v.metadata?.notification;
      if (!n || !v.appId.trim()) ctx.addIssue({code:'custom',message:'Notifications require payload and source app'});
      if ((v.privacy.collection === 'activity' || n?.action === 'removed') && n && ['title','text','bigText','subText','textLines','channelId'].some(key=>key in n))
        ctx.addIssue({code:'custom',message:'Activity-only and removed notifications cannot contain content'});
      if (n?.removalReason !== undefined && n.action !== 'removed') ctx.addIssue({code:'custom',message:'Removal reason requires removal action'});
    } else if (!v.metadata?.deviceEvent || v.privacy.collection === 'activity' || v.appId || v.appName)
      ctx.addIssue({code:'custom',message:'Device observations require device state without app attribution'});
  }
  if(v.provenance&&(v.provenance.layer==='reference'||v.provenance.deleted)&&v.ocrText)ctx.addIssue({code:'custom',message:'Reference and deletion records must not contain original text'});
  if(v.provenance&&(v.durationMs!==0||v.imageBase64||['screen','activity','note'].includes(v.source)))ctx.addIssue({code:'custom',message:'Versioned source records require zero duration and no screen/activity/note payload'});
  if (v.provenance?.metadata?.file && v.source !== 'file') ctx.addIssue({code:'custom',message:'File metadata belongs to file sources'});
  if (v.provenance?.metadata?.file?.deletionObservedAt && !v.provenance.deleted) ctx.addIssue({code:'custom',message:'Deletion observation requires a deletion revision'});
  if (v.mood !== undefined && v.source !== 'note') ctx.addIssue({code:'custom',path:['mood'],message:'Mood must be explicitly supplied for a user note'});
  if (v.source === 'note' && (v.durationMs !== 0 || v.imageBase64 || !v.ocrText.trim())) ctx.addIssue({code:'custom',message:'Notes require original text, zero duration and no image'});
});
export type CaptureInput = z.infer<typeof captureSchema>;
export const noteSchema = z.object({
  client: z.literal('web').optional(),
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
    source:'note',durationMs:0,appId:note.client === 'web' ? 'dev.mote.web.notes' : 'dev.mote.notes',appName:'随手记',windowTitle:'',ocrText:note.text,
    ...(note.mood === undefined ? {} : {mood:note.mood}),privacy:{excluded:false,redacted:false,mode:'none'},
    ...(note.metadata === undefined ? {} : {metadata:note.metadata}),
  });
}
export type CaptureRecord = Omit<CaptureInput,'imageBase64'|'imageMime'> & {
  receivedAt: string; blobHash: string | null; imageMime: string | null;
  indexingStatus: 'text_ready'|'pending'|'indexed'|'failed'; summary?: string;
};
export type CapturePreview = Pick<CaptureRecord,'id'|'deviceId'|'deviceName'|'platform'|'capturedAt'|'source'|'appId'|'appName'|'windowTitle'|'durationMs'> & {
  stateSummary?: {count:number;lastAt:string}; hasImage: boolean; ocr: OcrState; textPreview: string; sizeBytes?: number;
  media?: MediaMetadata;
};
export const heartbeatSchema = z.object({
  deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/), deviceName: z.string().min(1).max(200), platform: platformSchema,
  status: z.enum(['capturing','paused','permission_required','error','offline']),
  queueDepth: z.number().int().min(0).max(1000000), lastCaptureAt: z.string().max(64).datetime({offset:true}).nullable().optional(),
  error: z.string().max(1000).nullable().optional(),
  metadata: recordMetadataSchema.optional(),
  sync: z.object({
    mode: z.enum(['realtime','interval','batch','manual']),
    state: z.enum(['unconfigured','idle','waiting','uploading','error','manual']),
    intervalMinutes: z.number().int().min(1).max(1440),
    batchSize: z.number().int().min(1).max(500),
    pendingRecords: z.number().int().min(0).max(1000000),
    blockedRecords: z.number().int().min(0).max(1000000).optional(),
    awaitingOcrRecords: z.number().int().min(0).max(1000000).optional(),
    retainedRecords: z.number().int().min(0).max(1000000).optional(),
    lastUploadAt: z.string().max(64).datetime({offset:true}).optional(),
    nextUploadAt: z.string().max(64).datetime({offset:true}).optional(),
  }).strict().optional(),
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
export type QueryResult = {modelSelection?:import('./model-providers.js').ModelSelection;usage?:import('./usage.js').UsageReceipt;answer:string; citations:{id:string;capturedAt:string;appName:string;excerpt:string}[]; trace:{tool:string;arguments:unknown;count:number}[];runId:string};
export type ActivityCounts = {activityEvents?:number;contentCaptures?:number};
export type Activity = ActivityCounts & {apps:(ActivityCounts & {appId?:string;appName:string;durationMs:number;captures:number})[];devices:(ActivityCounts & {deviceId:string;deviceName:string;durationMs:number;captures:number})[];totalDurationMs:number;captures:number};
export * from './connection.js';

export * from './files.js';
export * from './file-policy.js';

export * from './capture-sessions.js';

export * from './actions.js';
export * from './execution.js';
export type {LarkSelection,LarkJob,LarkStatus,LarkCalendar} from './lark.js';

export * from './ui-builtins.js';

export type {ProcessingJobView,ProcessingView} from './ui-contracts.js';

export * from './source-capabilities.js';

export * from './operations.js';
export * from './provider-failure.js';
export * from './evidence-ref.js';
