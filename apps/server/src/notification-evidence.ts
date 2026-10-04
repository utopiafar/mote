import type {CaptureInput} from '@mote/shared';

/** Exact provider-field projection. Original transport JSON stays immutable;
 * all textual readers share this surface and its stable quotation offsets.
 * Notification contents remain untrusted third-party evidence. */
export function notificationEvidenceText(record:Pick<CaptureInput,'source'|'ocrText'|'metadata'>){
  if(record.source!=='notification'||!record.metadata?.notification)return record.ocrText;
  return JSON.stringify({notification:record.metadata.notification,...(record.ocrText?{capturedText:record.ocrText}:{})});
}
