import { z } from 'zod';

const timestamp = z.string().max(64).datetime({ offset: true });
const label = z.string().min(1).max(200);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
export const recordMetadataSchema = z.object({
  version: z.literal(1),
  observedAt: timestamp,
  collector: z.object({
    version: label.optional(),
    method: z.enum(['accessibility', 'media_projection', 'screen_capture', 'manual', 'file', 'calendar', 'mcp', 'import']).optional(),
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
    maskCount: z.number().int().min(0).max(200).optional(),
  }).strict().optional(),
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
