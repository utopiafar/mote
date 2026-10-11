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
  readiness?: 'ready'|'pending'|'failed'|'unknown'|'metadata';
  hasImage?:boolean; retainsOriginal?:boolean; truncated?:boolean;
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
  if (!response.ok) { await response.body?.cancel(); if (response.status === 404 || response.status === 410) throw Error(moteText('归档内容不存在或已按保留策略清理；同步凭据仍可查看。')); if (response.status === 401 || response.status === 403) {const error=Error(moteText('无法访问采集记录，请检查中央连接权限'));error.name='ArchiveAuthorizationError';throw error;} throw Error(moteText('中央节点返回 HTTP {0}，请稍后重试', response.status)); }
  return response;
}
async function json(config: Config, path: string): Promise<Record<string, unknown>> { const value: unknown = JSON.parse(await readResponseText(await request(config, path), 4 * 1024 * 1024)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid archive response'); return value as Record<string, unknown>; }
export async function syncContent(history: SyncHistory, queue: DurableQueue, sources: LocalSourceManager, config: Config, runId: string, key: string, chunkOffset = 0, includeImage = true): Promise<SyncContent> {
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
      if (record) { const bytes = includeImage ? await queue.imageForBrowser(item.captureId) : undefined; return { item, location: 'local', hasImage:Boolean(record.blobHash), text: recordText(item.source, record.event as unknown as Record<string, unknown>), ...(bytes && includeImage ? { image: await previewWork.run<string>({ kind: 'preview', bytes, thumbnail: false }) } : {}), metadata: JSON.stringify(record.event.metadata ?? {}, null, 2) }; }
    }
    // A later retry can have cleared the local copy. Resolve only a receipt from this same node/device.
    const receipt = history.receivedCapture(config, item.key);
    item.captureId = receipt;
  }
  return readCentralContent(config,item,chunkOffset,includeImage);
}
export async function readCentralContent(config:Config,item:SyncHistoryItem,chunkOffset=0,includeImage=false):Promise<SyncContent>{
  if (!item.captureId || !uuid.test(item.captureId)) throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
  const record = await json(config, `/api/capture-browser/${item.captureId}`);
  if (record.id !== item.captureId || record.deviceId !== config.deviceId) throw Error(moteText('记录不属于当前设备'));
  if(typeof record.source==='string'&&['screen','ui_page','note','activity','notification','file','calendar','message'].includes(record.source)) item.source=record.source==='message'?'coding':record.source as SyncHistoryItem['source'];
  item.title=typeof record.windowTitle==='string'?record.windowTitle:typeof record.appName==='string'?record.appName:item.title;
  item.observedAt=typeof record.capturedAt==='string'?record.capturedAt:item.observedAt;
  const provenance = record.provenance as Record<string, unknown> | undefined;
  if (item.sourceId && provenance?.sourceId !== item.sourceId) throw Error(moteText('记录不属于当前设备'));
  const result: SyncContent = { truncated:typeof record.ocrText==='string'&&record.ocrText.length>100000,item, location: 'central', captureId: item.captureId, text: recordText(item.source, record), metadataOnly: item.layer === 'reference'||provenance?.layer==='reference', metadata: JSON.stringify({ capturedAt: record.capturedAt, appName: record.appName, provenance, metadata: record.metadata }, null, 2).slice(0, 100000) };
  const ocr = record.ocr as { status?: string } | undefined;
  result.processing = ocr?.status === 'pending';
  result.hasImage=Boolean(record.imageMime && item.source==='screen'); if(record.imageMime)result.retainsOriginal=true;
  if(record.fileArchive&&item.source==='file'){
    try { const file=await json(config,`/api/files/${item.captureId}`);if(typeof file.hasOriginal==='boolean')result.retainsOriginal=file.hasOriginal;const manifestItem=file.item as {layer?:string}|undefined;result.metadataOnly=manifestItem?.layer==='reference'||result.metadataOnly; }
    catch(error){if(error instanceof Error&&error.name==='ArchiveAuthorizationError')throw error;}
  }
  result.readiness=result.metadataOnly?'metadata':'unknown';
  const materialRef=record.memoryMaterialRef;
  if(typeof materialRef==='string'&&/^material:[a-zA-Z0-9_-]+@[a-zA-Z0-9_-]+$/.test(materialRef)){
    try { const id=materialRef.slice(9).split('@')[0],material=await json(config,`/api/materials/${encodeURIComponent(id)}`),coverage=material.coverage as {state?:string}|undefined,indexing=material.indexing as {state?:string;revision?:string}|undefined;
      if(material.ref===materialRef) result.readiness=coverage?.state==='complete'&&indexing?.state==='indexed'&&indexing.revision===material.revision?'ready':indexing?.state==='failed'?'failed':coverage?.state==='pending'||coverage?.state==='partial'||indexing?.state==='pending'||indexing?.state==='running'?'pending':'unknown';
    } catch(error) { if(error instanceof Error&&error.name==='ArchiveAuthorizationError')throw error; /* Content stays readable while readiness cannot be confirmed. */ }
  }
  if(result.readiness==='unknown'&&ocr?.status==='pending')result.readiness='pending';
  if(result.readiness==='unknown'&&ocr?.status==='failed')result.readiness='failed';
  if (includeImage && record.imageMime && item.source === 'screen') {
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
    const body=page.items.map(value=>(value as {ocrText?:unknown}).ocrText).filter((value):value is string=>typeof value==='string').join('\n\n');result.truncated=body.length>100000;result.text=body.slice(0,100000);
    if (Number.isSafeInteger(page.nextOffset) && Number(page.nextOffset) > chunkOffset) result.nextChunkOffset = Number(page.nextOffset);
    const document = provenance?.document as { fileIndex?: { status?: string } } | undefined;
    result.processing = !result.text && document?.fileIndex?.status === 'pending';
  }
  return result;
}
