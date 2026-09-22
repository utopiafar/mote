import {uiPageSchema} from './ui-page.js';
import { moteText } from './i18n.js';
import { z } from 'zod';

const timestamp = z.string().max(64).datetime({ offset: true });
const label = z.string().min(1).max(200);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Provider-reported media facts. No inferred genre, activity, or listening intent. */
export const mediaSessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  appId: z.string().min(1).max(300), appName: label.refine(value => value.trim().length > 0, 'Application name cannot be blank'),
  playbackState: z.enum(['playing', 'paused', 'stopped', 'buffering', 'connecting', 'seeking', 'skipping', 'error', 'none', 'unknown']),
  appVisibility: z.enum(['foreground', 'background', 'unknown']),
  playbackType: z.enum(['local', 'remote', 'unknown']),
  title: z.string().max(1000).optional(), artist: z.string().max(1000).optional(),
  album: z.string().max(1000).optional(), displaySubtitle: z.string().max(1000).optional(), mediaId: z.string().max(1000).optional(),
  durationMs: bytes.optional(), positionMs: bytes.optional(), playbackSpeed: z.number().finite().min(-16).max(16).optional(),
}).strict();
export type MediaSession = z.infer<typeof mediaSessionSchema>;
export const mediaMetadataSchema = z.object({
  status: z.enum(['available', 'disabled', 'permission_required', 'unavailable']),
  observedAt: timestamp.optional(),
  sessions: z.array(mediaSessionSchema).max(16),
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'available' && value.sessions.length)
    ctx.addIssue({code:'custom', message:'Unavailable media observations cannot contain sessions'});
  if (new Set(value.sessions.map(session => session.sessionId)).size !== value.sessions.length)
    ctx.addIssue({code:'custom', message:'Media session identities must be unique within an observation'});
});
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;

/** Original Android fields; category is provider-reported, not an inferred activity. */
export const notificationEventSchema = z.object({
  action: z.enum(['posted','updated','removed']), notificationKey: z.string().regex(/^[a-f0-9]{64}$/),
  postedAt: timestamp, ongoing: z.boolean(), groupSummary: z.boolean(),
  category: z.string().max(200).optional(), channelId: z.string().max(300).optional(),
  removalReason: z.number().int().min(0).max(1000).optional(),
  title: z.string().max(4000).optional(), text: z.string().max(4000).optional(),
  bigText: z.string().max(4000).optional(), subText: z.string().max(4000).optional(),
  textLines: z.array(z.string().max(2000)).max(20).optional(),
}).strict();
export const deviceEventSchema = z.object({
  action: z.enum(['screen_on','screen_off','user_present','state_observed']),
  keyguardLocked: z.boolean(), screenInteractive: z.boolean(),
}).strict();

/** Processing state is part of the record, independent of optional device telemetry. */
export const ocrSchema = z.object({
  status: z.enum(['pending', 'completed', 'disabled', 'failed']),
  reason: z.literal('charging').optional(),
  updatedAt: timestamp.optional(),
}).strict();
export type OcrResult = z.infer<typeof ocrSchema>;
export type OcrState = Omit<OcrResult, 'status'> & { status: OcrResult['status'] | 'unknown' | 'not_applicable' };
export function captureOcrState(record: {source: string; ocr?: OcrResult; ocrText?: string; metadata?: RecordMetadata}): OcrState {
  if (record.source !== 'screen') return {status: 'not_applicable'};
  if (record.ocr) return record.ocr;
  if (record.ocrText?.trim()) return {status: 'completed'};
  if (record.metadata?.capture?.ocrEnabled === false) return {status: 'disabled'};
  return {status: 'unknown'};
}

/** Explicit, bounded fields only: never an arbitrary bag of device identifiers or content. */
export const memoryScopeRefSchema=z.object({sourceId:z.string().max(128).optional(),deviceId:z.string().max(200).optional(),repositoryKey:z.string().regex(/^[a-f0-9]{64}$/).optional(),branch:z.string().max(500).optional(),provider:z.enum(['claude','codex','kimi']),sessionId:z.string().max(500),projectKey:z.string().max(200)}).strict();
export const recordMetadataSchema = z.object({
  memoryCorrection:z.object({memoryId:z.string().uuid(),domain:z.enum(['personal','coding']),scopeRefs:z.array(memoryScopeRefSchema).max(30),coding:z.object({kind:z.enum(['pitfall','decision','principle','preference']),scope:z.enum(['session','project','shared']),applicability:z.string().max(2000),validation:z.literal('user_confirmed')}).strict().optional()}).strict().optional(),
  uiPage: uiPageSchema.optional(),
  attachments: z.array(z.string().uuid()).max(10).optional(),
  version: z.literal(1),
  observedAt: timestamp,
  collector: z.object({
    version: label.optional(),
    method: z.enum(['accessibility', 'media_projection', 'screen_capture', 'media_session', 'notification_listener', 'manual', 'file', 'calendar', 'mcp', 'import']).optional(),
  }).strict().optional(),
  device: z.object({
    osVersion: label.optional(), osBuild: label.optional(), manufacturer: label.optional(),
    model: label.optional(), architecture: label.optional(), locale: label.optional(), timeZone: label.optional(),
  }).strict().optional(),
  state: z.object({
    batteryPercent: z.number().min(0).max(100).optional(), charging: z.boolean().optional(),
    onBattery: z.boolean().optional(), powerSave: z.boolean().optional(),
    thermalState: z.enum(['unknown', 'nominal', 'fair', 'serious', 'critical']).optional(),
    networkType: z.enum(['none', 'wifi', 'cellular', 'ethernet', 'other', 'unknown']).optional(),
    networkMetered: z.boolean().optional(), screenInteractive: z.boolean().optional(), screenLocked: z.boolean().optional(),
    idleSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), availableStorageBytes: bytes.optional(),
  }).strict().optional(),
  capture: z.object({
    intervalMs: z.number().int().min(0).max(300000).optional(),
    width: z.number().int().min(1).max(32768).optional(), height: z.number().int().min(1).max(32768).optional(),
    displayScale: z.number().positive().max(16).optional(), ocrEnabled: z.boolean().optional(),
    deduplication: z.object({mode: z.enum(['exact', 'conservative', 'balanced', 'aggressive']), duplicate: z.literal(true)}).strict().optional(),
    maskCount: z.number().int().min(0).max(200).optional(),
  }).strict().optional(),
  media: mediaMetadataSchema.optional(),
  notification: notificationEventSchema.optional(),
  deviceEvent: deviceEventSchema.optional(),
  observation: z.object({sessionId:z.string().uuid(),elapsedRealtimeMs:bytes}).strict().optional(),
}).strict();
export type RecordMetadata = z.infer<typeof recordMetadataSchema>;

/** Stable source attributes; observation time and modifiedAt already belong to SourceItem. */
export const sourceMetadataSchema = z.object({
  version: z.literal(1),
  file: z.object({
    sizeBytes: bytes.optional(), createdAt: timestamp.optional(), accessedAt: timestamp.optional(),
    metadataChangedAt: timestamp.optional(), deletionObservedAt: timestamp.optional(),
  }).strict().optional(),
  provider: z.object({ createdAt: timestamp.optional(), updatedAt: timestamp.optional() }).strict().optional(),
}).strict();
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

/** Display raw event fields; this does not infer activity or intent. */
export function systemEventText(metadata?: RecordMetadata): string {
  const n=metadata?.notification,e=metadata?.deviceEvent;
  if(n) return [({posted:moteText("收到通知（首次观察）"),updated:moteText("通知更新"),removed:moteText("通知移除")})[n.action],n.title,n.text,n.bigText,n.subText,...(n.textLines??[])].filter(Boolean).join('\n');
  if(e) return `${({screen_on:moteText("亮屏"),screen_off:moteText("熄屏"),user_present:moteText("用户解锁 / 在场"),state_observed:moteText("锁定状态观察")})[e.action]} · ${e.keyguardLocked?moteText("系统报告已锁定"):moteText("系统报告未锁定")} · ${e.screenInteractive?moteText("屏幕可交互"):moteText("屏幕不可交互")}`;
  return '';
}
