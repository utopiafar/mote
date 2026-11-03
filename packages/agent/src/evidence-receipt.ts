import {createHash} from 'node:crypto';
import {
  attributionContextSchema,
  documentSchema,
  fileEvidenceSchema,
  recordMetadataSchema,
  sourceContentTime,
  sourceMetadataSchema,
  stateSeriesSchema,
} from '@mote/shared';
import {projectEvidencePresentation} from './evidence-ledger.js';
import {displayTime} from './time.js';
import type {ContextRecord} from './types.js';

/** Deliberately projects public evidence fields; no file paths, tokens, or images reach the model. */
export function projectEvidence(record: ContextRecord, offset = 0, length = 600, timeZone = 'UTC'): ContextRecord {
  const text = String(record.ocrText ?? "");
  let start = Math.min(offset, text.length), end = Math.min(start + length, text.length);
  // Offsets are UTF-16 units, as in stored JS strings; never split an emoji pair.
  const splitsPair = (at: number) => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
  if (splitsPair(start)) start--;
  if (splitsPair(end)) end--;
  if (end <= start && start < text.length) end = Math.min(start + 2, text.length);
  const duration = typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs > 0 ? record.durationMs : 0;
  const intervalStart = duration ? new Date(Date.parse(record.capturedAt) - duration).toISOString() : undefined;
  const metadata = recordMetadataSchema.safeParse(record.metadata);
  const sourceMetadata = sourceMetadataSchema.safeParse((record.provenance as Record<string, unknown> | undefined)?.metadata);
  const document = documentSchema.safeParse((record.provenance as Record<string, unknown> | undefined)?.document);
  const attribution = attributionContextSchema.safeParse(record.attributionContext);
  const contentAt = sourceContentTime({capturedAt:record.capturedAt,...(document.success?{provenance:{document:document.data}}:{})});
  const projected:ContextRecord = {
    ...(fileEvidenceSchema.safeParse(record.fileEvidence).success?{fileEvidence:fileEvidenceSchema.parse(record.fileEvidence)}:{}),
    ...(stateSeriesSchema.safeParse(record.stateSeries).success?{stateSeries:stateSeriesSchema.parse(record.stateSeries)}:{}),
    evidenceFingerprint:createHash('sha256').update(JSON.stringify([text,record.provenance,record.fileEvidence,...(attribution.success&&(attribution.data.basis!=='default'||attribution.data.correction||attribution.data.sourceDeclaration||attribution.data.materialDeclarations||attribution.data.declarations||attribution.data.ownerStatements||attribution.data.importDeclarations||attribution.data.importStatements||attribution.data.sourceContextDeclarations?.length||attribution.data.sourceContextStatements?.length||attribution.data.recordContextDeclarations?.length||attribution.data.recordContextStatements?.length)?[attribution.data]:[])])).digest('hex'),
    ...(attribution.success?{attributionContext:attribution.data}:{}),
    ...(record.retrieval?{retrieval:record.retrieval}:{}),
    estimatedReadCharacters:text.length,
    id: record.id,
    capturedAt: record.capturedAt,
    displayCapturedAt: displayTime(record.capturedAt, timeZone),
    contentAt,displayContentAt:displayTime(contentAt,timeZone),
    timeZone,
    ...(intervalStart ? { sampleInterval: {
      start: intervalStart, end: record.capturedAt,
      displayStart: displayTime(intervalStart, timeZone), displayEnd: displayTime(record.capturedAt, timeZone),
    } } : {}),
    appName: record.appName,
    ...(record.contentLayer?{contentLayer:record.contentLayer}:{}),
    ...(record.perception?{perception:record.perception}:{}),
    ...(record.perceptionJobs?{perceptionJobs:record.perceptionJobs}:{}),
    availableLayers: ['text',...(record.blobHash?['image_on_request']:[])],
    ...(typeof record.appId === 'string' ? {appId: record.appId.slice(0, 300)} : {}),
    ...(metadata.success ? {metadata: {...metadata.data, displayObservedAt: displayTime(metadata.data.observedAt, timeZone)}} : {}),
    ...(record.privacy && typeof record.privacy === 'object' && ['content', 'activity'].includes(String((record.privacy as Record<string,unknown>).collection))
      ? {collection: (record.privacy as Record<string,unknown>).collection} : {}),
    ...(record.revisionState?{revisionState:record.revisionState}:{}),
    ...(typeof record.windowTitle==='string'?{title:record.windowTitle.slice(0,2000)}:{}),
    ...(record.provenance&&typeof record.provenance==='object'?{provenance:{
      sourceId:(record.provenance as Record<string,unknown>).sourceId,
      externalId:(record.provenance as Record<string,unknown>).externalId,
      ...(document.success?{document:document.data}:{}),
      layer:(record.provenance as Record<string,unknown>).layer,
      deleted:(record.provenance as Record<string,unknown>).deleted,
      revision:(record.provenance as Record<string,unknown>).revision,
      calendar:(record.provenance as Record<string,unknown>).calendar,
      modifiedAt:(record.provenance as Record<string,unknown>).modifiedAt,
      ...(sourceMetadata.success ? {metadata:sourceMetadata.data} : {}),
      originalAvailable:(record.provenance as Record<string,unknown>).layer!=='reference',
    }}:{}),
    ocrText: text.slice(start, end),
    textRange: { start, end, total: text.length, nextOffset: end < text.length ? end : null },
    ...(record.summary === undefined
      ? {}
      : { summary: String(record.summary).slice(0, 400) }),
    ...(record.deviceId === undefined ? {} : { deviceId: record.deviceId }),
    ...(record.sourceType === undefined
      ? {}
      : { sourceType: record.sourceType }),
    ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
      ? { durationMs: record.durationMs } : {}),
    ...(typeof record.mood === "string"
      ? { mood: record.mood.slice(0, 80) }
      : {}),
  };
  return projectEvidencePresentation(record,projected);
}

/** Host adapters may create receipts only from a freshly authorized full original. */
export function originalEvidenceReceipt(record:ContextRecord,offset=0,length=600,timeZone='UTC'){return projectEvidence(record,offset,length,timeZone);}
