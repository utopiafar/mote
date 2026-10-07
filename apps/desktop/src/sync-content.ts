import { getLocale, moteText } from '@mote/shared/i18n';
import { previewWork, sourceWork } from './background';
import { readResponseText } from './response-body';
import { requireConnectionToken } from './login-session';
import { MAX_IMAGE_BYTES, validateServerUrl } from './config';
import type { Config } from './contracts';
import type { DurableQueue } from './queue';
import type { LocalSourceManager } from './source-manager';
import type { SyncHistory, SyncHistoryItem } from './sync-history';

export interface SyncContent {
  item: SyncHistoryItem; location: 'local' | 'central'; text: string; image?: string;
  processing?: boolean; metadataOnly?: boolean; nextChunkOffset?: number;
  metadata?: string; captureId?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function text(value: unknown, max = 100000): string { return typeof value === 'string' ? value.slice(0, max) : ''; }
function recordText(source: SyncHistoryItem['source'], record: Record<string, unknown>): string {
  if (source === 'notification') {
    const notification = (record.metadata as { notification?: Record<string, unknown> } | undefined)?.notification;
    if (notification) return ['title', 'text', 'bigText', 'subText'].map(key => text(notification[key])).concat(Array.isArray(notification.textLines) ? notification.textLines.slice(0, 100).map(line => text(line)) : []).filter(Boolean).join('\n').slice(0, 100000);
  }
  if (source === 'activity') return JSON.stringify({ appName: record.appName, appId: record.appId, capturedAt: record.capturedAt, durationMs: record.durationMs, stateSeries: record.stateSeries }, null, 2).slice(0, 100000);
  return text(record.ocrText);
}
async function request(config: Config, path: string): Promise<Response> {
  const response = await fetch(`${validateServerUrl(config.serverUrl)}${path}`, { headers: { 'Accept-Language': getLocale(), Authorization: `Bearer ${requireConnectionToken(config)}` }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); if (response.status === 404 || response.status === 410) throw Error(moteText('归档内容不存在或已按保留策略清理；同步凭据仍可查看。')); if (response.status === 401 || response.status === 403) throw Error(moteText('无法访问采集记录，请检查中央连接权限')); throw Error(moteText('中央节点返回 HTTP {0}，请稍后重试', response.status)); }
  return response;
}
async function json(config: Config, path: string): Promise<Record<string, unknown>> { const value: unknown = JSON.parse(await readResponseText(await request(config, path), 4 * 1024 * 1024)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid archive response'); return value as Record<string, unknown>; }
export async function syncContent(history: SyncHistory, queue: DurableQueue, sources: LocalSourceManager, config: Config, runId: string, key: string, chunkOffset = 0): Promise<SyncContent> {
  if (!Number.isSafeInteger(chunkOffset) || chunkOffset < 0 || chunkOffset > 1000000) throw Error(moteText('分页参数无效'));
  const item = history.item(config, runId, key);
  if (item.outcome !== 'received') {
    if (item.sourceId && item.versionKey) {
      const pending = sources.pendingForHistory(item.sourceId, item.versionKey);
      if (pending) {
        let body = pending.text;
        if (!body && pending.mimeType?.startsWith('text/')) {
          if (pending.localOriginal && pending.localOriginal.sizeBytes <= 512 * 1024) body = new TextDecoder('utf-8', { fatal: true }).decode(await sourceWork.run<Uint8Array>({ kind: 'original-part', spool: pending.localOriginal, part: 0 }));
          else if (pending.localOriginalBase64 && pending.localOriginalBase64.length < 700000) body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(pending.localOriginalBase64, 'base64'));
        }
        return { item, location: 'local', text: body.slice(0, 100000), metadataOnly: pending.layer === 'reference', metadata: JSON.stringify({ title: pending.title, modifiedAt: pending.modifiedAt, mimeType: pending.mimeType, calendar: pending.calendar, document: pending.document, metadata: pending.metadata }, null, 2) };
      }
    } else if (item.captureId) {
      const record = queue.recordForHistory(item.captureId);
      if (record) { const bytes = await queue.imageForBrowser(item.captureId); return { item, location: 'local', text: recordText(item.source, record.event as unknown as Record<string, unknown>), ...(bytes ? { image: await previewWork.run<string>({ kind: 'preview', bytes, thumbnail: false }) } : {}), metadata: JSON.stringify(record.event.metadata ?? {}, null, 2) }; }
    }
    // A later retry can have cleared the local copy. Resolve only a receipt from this same node/device.
    const receipt = history.receivedCapture(config, item.key);
    item.captureId = receipt;
  }
  if (!item.captureId || !uuid.test(item.captureId)) throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
  const record = await json(config, `/api/capture-browser/${item.captureId}`);
  if (record.id !== item.captureId || record.deviceId !== config.deviceId) throw Error(moteText('记录不属于当前设备'));
  const provenance = record.provenance as Record<string, unknown> | undefined;
  if (item.sourceId && provenance?.sourceId !== item.sourceId) throw Error(moteText('记录不属于当前设备'));
  const result: SyncContent = { item, location: 'central', captureId: item.captureId, text: recordText(item.source, record), metadataOnly: item.layer === 'reference', metadata: JSON.stringify({ capturedAt: record.capturedAt, appName: record.appName, provenance, metadata: record.metadata }, null, 2).slice(0, 100000) };
  const ocr = record.ocr as { status?: string } | undefined;
  result.processing = ocr?.status === 'pending';
  if (record.imageMime && item.source === 'screen') {
    const response = await request(config, `/api/capture-browser/${item.captureId}/image`);
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw Error(moteText('图片超过大小限制')); }
    if (!response.body) throw Error(moteText('图片为空'));
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_IMAGE_BYTES) throw Error(moteText('图片超过大小限制')); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    result.image = await previewWork.run<string>({ kind: 'preview', bytes: Buffer.concat(chunks), thumbnail: false });
  }
  if (record.fileArchive && item.source === 'file' && !result.metadataOnly) {
    const page = await json(config, `/api/files/${item.captureId}/chunks?offset=${chunkOffset}`);
    if (!Array.isArray(page.items) || page.items.length > 100) throw Error('Invalid file content page');
    result.text = page.items.map(value => text((value as { ocrText?: unknown }).ocrText)).join('\n\n').slice(0, 100000);
    if (Number.isSafeInteger(page.nextOffset) && Number(page.nextOffset) > chunkOffset) result.nextChunkOffset = Number(page.nextOffset);
    const document = provenance?.document as { fileIndex?: { status?: string } } | undefined;
    result.processing = !result.text && document?.fileIndex?.status === 'pending';
  }
  return result;
}
