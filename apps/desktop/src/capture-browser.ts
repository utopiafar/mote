import { moteText, getLocale } from '@mote/shared/i18n';
import {captureSessions,type CaptureSession} from '@mote/shared/capture-sessions';
import { previewWork } from './background';
import type { Config, CaptureEvent } from './contracts';
import type { DurableQueue, QueueRecord } from './queue';
import { MAX_IMAGE_BYTES, validateServerUrl } from './config';
import { readResponseText } from './response-body';
import { captureOcrState } from '@mote/shared/metadata';

export type CaptureLocation = 'local' | 'central';
export interface BrowseRequest { location: CaptureLocation; day: string; cursor?: string; grouping?: 'sessions' | 'records'; sessionId?: string }
export interface BrowserCapture {
  id: string; capturedAt: string; appName: string; appId: string;
  ocr: { status: 'pending' | 'completed' | 'disabled' | 'failed' | 'unknown'; reason?: 'charging' };
  textPreview: string; sizeBytes?: number; uploaded?: boolean; hasImage: boolean; syncError?: string;
}
export interface BrowserPage { items: BrowserCapture[]; totalCount: number; nextCursor?: string; sessions?: CaptureSession[]; sessionCount?: number }
export interface BrowserDetail extends BrowserCapture { ocrText: string; deviceName?: string }
const PAGE_SIZE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function captureDayRange(day: string): { after: string; before: string } {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(moteText("请选择有效日期"));
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(year, month - 1, date);
  if (year < 2000 || year > 2100 || start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) throw new Error(moteText("请选择有效日期"));
  const end = new Date(year, month - 1, date + 1);
  return { after: start.toISOString(), before: end.toISOString() };
}
function location(value: unknown): asserts value is CaptureLocation { if (value !== 'local' && value !== 'central') throw new Error(moteText("记录来源无效")); }
function validId(id: unknown): asserts id is string { if (typeof id !== 'string' || !UUID.test(id)) throw new Error(moteText("记录标识无效")); }
function preview(event: Partial<CaptureEvent> & { hasImage?: boolean; textPreview?: string; sizeBytes?: number }, record?: QueueRecord): BrowserCapture {
  validId(event.id);
  if (typeof event.capturedAt !== 'string' || !Number.isFinite(Date.parse(event.capturedAt))) throw new Error(moteText("中央记录时间无效"));
  const status = record?.ocrResult !== undefined ? 'completed' : record?.ocrRetryAt ? 'failed' : captureOcrState({ ...event, source: 'screen' }).status;
  const normalizedStatus = status === 'pending' || status === 'completed' || status === 'disabled' || status === 'failed' ? status : 'unknown';
  const ocr: BrowserCapture['ocr'] = { status: normalizedStatus, ...(event.ocr?.reason === 'charging' ? { reason: 'charging' as const } : {}) };
  const text = record?.ocrResult ?? event.ocrText ?? event.textPreview ?? '';
  return { id: event.id, capturedAt: event.capturedAt, appName: String(event.appName ?? '').slice(0, 200), appId: String(event.appId ?? '').slice(0, 256), ocr, textPreview: String(text).slice(0, 160), sizeBytes:record?record.blobBytes+Buffer.byteLength(text):event.sizeBytes, hasImage: record ? Boolean(record.blobHash) : Boolean(event.hasImage), ...(record ? { uploaded: Boolean(record.uploaded), syncError: record.syncError } : {}) };
}
async function request(config: Config, path: string): Promise<Response> {
  if (!config.token || !config.serverUrl) throw new Error(moteText("请先连接中央节点；本机记录仍可查看"));
  const response = await fetch(`${validateServerUrl(config.serverUrl)}${path}`, { headers: { 'Accept-Language': getLocale(), Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new Error(moteText("记录不存在，或中央节点需要升级才能浏览采集记录"));
    if (response.status === 401 || response.status === 403) throw new Error(moteText("无法访问采集记录，请检查中央连接权限"));
    throw new Error(moteText("中央节点返回 HTTP {0}，请稍后重试", response.status));
  }
  return response;
}
async function remoteDetail(config: Config, id: string): Promise<Partial<CaptureEvent>> {
  const value = JSON.parse(await readResponseText(await request(config, `/api/capture-browser/${id}`), 1024 * 1024)) as Partial<CaptureEvent>;
  if (value.id !== id || value.deviceId !== config.deviceId || value.source !== 'screen') throw new Error(moteText("记录不属于当前设备的截图"));
  return value;
}
async function imageBytes(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error(moteText("图片超过大小限制")); }
  if (!response.body) throw new Error(moteText("图片为空"));
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const value = await reader.read(); if (value.done) break; size += value.value.length; if (size > maximum) throw new Error(moteText("图片超过大小限制")); chunks.push(value.value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function browseCaptures(queue: DurableQueue, config: Config, input: BrowseRequest): Promise<BrowserPage> {
  location(input?.location); const range = captureDayRange(input.day);
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 2048)) throw new Error(moteText("分页参数无效"));
  if (input.grouping !== undefined && !['sessions','records'].includes(input.grouping)) throw new Error(moteText("分组方式无效"));
  if (input.sessionId) validId(input.sessionId);
  if (input.grouping === 'sessions') {
    if (input.location === 'central') {
      const params = new URLSearchParams({...range,deviceId:config.deviceId,limit:String(PAGE_SIZE),...(input.cursor?{cursor:input.cursor}:{}),...(input.sessionId?{sessionId:input.sessionId}:{})});
      const value = JSON.parse(await readResponseText(await request(config, `/api/capture-browser/sessions?${params}`),512*1024));
      if (!Array.isArray(value.items) || value.items.length>PAGE_SIZE || !Number.isSafeInteger(value.totalCount) || value.items.some((item: CaptureSession)=>item.deviceId!==config.deviceId)) throw new Error(moteText("中央 Session 数据无效"));
      return input.sessionId?{items:value.items.map((item: Partial<CaptureEvent>)=>preview(item)),totalCount:value.totalCount,nextCursor:value.nextCursor??undefined}:{items:[],sessions:value.items,sessionCount:value.sessionCount,totalCount:value.totalCount,nextCursor:value.nextCursor??undefined};
    }
    const samples = await queue.sessionSamples(range.after,range.before), sessions = captureSessions(samples);
    const position = input.cursor ? JSON.parse(Buffer.from(input.cursor,'base64url').toString()) as {at:string;id:string} : undefined;
    if (position && (!Number.isFinite(Date.parse(position.at)) || !UUID.test(position.id))) throw new Error(moteText("Session 分页参数无效"));
    if (!input.sessionId) {
      const page = sessions.filter(s=>!position || Date.parse(s.firstAt)<Date.parse(position.at) || Date.parse(s.firstAt)===Date.parse(position.at)&&s.id>position.id).slice(0,PAGE_SIZE+1),last=page.slice(0,PAGE_SIZE).at(-1);
      return {items:[],sessions:page.slice(0,PAGE_SIZE),sessionCount:sessions.length,totalCount:samples.length,nextCursor:page.length>PAGE_SIZE&&last?Buffer.from(JSON.stringify({at:last.firstAt,id:last.id})).toString('base64url'):undefined};
    }
    const selected = sessions.find(s=>s.id===input.sessionId);
    if (!selected) throw new Error(moteText("Session 已变化或被清理，请返回并刷新分组"));
    // The first/last IDs disambiguate switches sharing the same millisecond.
    const ordered = samples.filter(s=>s.deviceId===selected.deviceId).sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.id.localeCompare(b.id));
    const members=ordered.slice(ordered.findIndex(s=>s.id===selected.id),ordered.findIndex(s=>s.id===selected.id)+selected.count).reverse();
    const page=members.filter(s=>!position||Date.parse(s.capturedAt)<Date.parse(position.at)||Date.parse(s.capturedAt)===Date.parse(position.at)&&s.id<position.id).slice(0,PAGE_SIZE+1),last=page.slice(0,PAGE_SIZE).at(-1);
    return {items:page.slice(0,PAGE_SIZE).flatMap(s=>{const record=queue.recordForBrowser(s.id);return record?[preview(record.event,record)]:[];}),totalCount:members.length,nextCursor:page.length>PAGE_SIZE&&last?Buffer.from(JSON.stringify({at:last.capturedAt,id:last.id})).toString('base64url'):undefined};
  }
  if (input.location === 'local') {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(moteText("分页参数无效"));
    const page = await queue.pageForBrowser(range.after, range.before, offset, PAGE_SIZE);
    return { items: page.records.map(r => preview(r.event, r)), totalCount: page.total, ...(offset + PAGE_SIZE < page.total ? { nextCursor: String(offset + PAGE_SIZE) } : {}) };
  }
  const params = new URLSearchParams({ ...range, deviceId: config.deviceId, source: 'screen', limit: String(PAGE_SIZE), ...(input.cursor ? { cursor: input.cursor } : {}) });
  const response = JSON.parse(await readResponseText(await request(config, `/api/capture-browser?${params}`), 512 * 1024)) as { items?: (Partial<CaptureEvent> & { hasImage?: boolean; textPreview?: string; sizeBytes?: number })[]; totalCount?: number; nextCursor?: string | null };
  if (!Array.isArray(response.items) || response.items.length > PAGE_SIZE || !Number.isSafeInteger(response.totalCount) || response.totalCount! < 0 || (response.nextCursor != null && (typeof response.nextCursor !== 'string' || response.nextCursor.length > 2048))) throw new Error(moteText("中央分页数据无效"));
  if (response.items.some(v => v.deviceId !== config.deviceId || v.source !== 'screen')) throw new Error(moteText("中央返回了其他设备的记录"));
  return { items: response.items.map(v => preview(v)), totalCount: response.totalCount!, nextCursor: response.nextCursor ?? undefined };
}
export async function captureDetail(queue: DurableQueue, config: Config, source: CaptureLocation, id: string): Promise<BrowserDetail> {
  location(source); validId(id);
  if (source === 'local') {
    const record = queue.recordForBrowser(id); if (!record) throw new Error(moteText("该记录已完成同步，请切换到中央已归档查看"));
    return { ...preview(record.event, record), ocrText: record.ocrResult ?? record.event.ocrText ?? '', deviceName: record.event.deviceName };
  }
  const value = await remoteDetail(config, id);
  return { ...preview({ ...value, hasImage: Boolean(value.imageMime) }), ocrText: String(value.ocrText ?? '').slice(0, 100000), deviceName: String(value.deviceName ?? '').slice(0, 128) };
}
export async function captureImage(queue: DurableQueue, config: Config, source: CaptureLocation, id: string, thumbnail: boolean): Promise<string> {
  location(source); validId(id); if (typeof thumbnail !== 'boolean') throw new Error(moteText("图片参数无效"));
  let bytes: Buffer | undefined;
  if (source === 'local') bytes = await queue.imageForBrowser(id);
  else { await remoteDetail(config, id); bytes = await imageBytes(await request(config, `/api/capture-browser/${id}/image${thumbnail ? '?thumbnail=1' : ''}`), thumbnail ? 1024 * 1024 : MAX_IMAGE_BYTES); }
  if (!bytes) throw new Error(moteText("图片已同步，请切换到中央已归档查看"));
  return previewWork.run<string>({ kind: 'preview', bytes, thumbnail });
}
