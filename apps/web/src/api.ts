import {log,routeCategory,safeErrorName} from './logger';
import {failureMessage} from './failure-message';
import {httpStatusMessage,responseFailureCode} from '@mote/shared';
import { moteText, getLocale } from '@mote/shared/i18n';
import type {RecordMetadata, SourceMetadata, OcrResult, CaptureRecord} from '@mote/shared';
export interface Connection {
  token: string;
  /** Browser-only expiry for a persisted management session; the server token is unchanged. */
  expiresAt?: number;
  /** Maximum deadline imposed by the shared native/server session. */
  serverExpiresAt?: number;
  /** Non-secret identity for tab view state; never sent to the server. */
  viewScope?: string;
}
export interface FileEvidence {
  captureId: string;
  revision: string;
  artifactId: string;
  chunkId: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  speakerAttribution?: {name:string;confirmedBy:'owner';confirmationId:string;confirmedAt:string};
  uncertain?: boolean;
  overlap?: boolean;
}
export interface Capture {
  evidencePresentation?: import('@mote/shared').SourceTextFormat;
  requiresMaterialForMemory?: boolean;
  memoryMaterialRef?: string;
  perceptionJobs?: Array<{kind:string;state:string;error?:string|null}>;
  revisionState?: 'current'|'historical';
  fileArchive?: {captureId:string};
  fileEvidence?: FileEvidence;
  id: string;
  capturedAt: string;
  appName: string;
  appId?: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  ocrText: string;
  ocr?: OcrResult;
  windowTitle: string;
  durationMs: number;
  blobHash: string | null;
  source: CaptureRecord['source'];
  privacy: { redacted: boolean; mode: string; reason?: string; collection?: 'content' | 'activity' };
  stateSeries?: CaptureRecord['stateSeries'];
  metadata?: RecordMetadata;
  provenance?: CaptureRecord['provenance'];
  indexingStatus: string;
  summary?: string;
  mood?: string;
}
export interface Device {
  sync?: import('@mote/shared').Heartbeat['sync'];
  metadata?: RecordMetadata;
  deviceId: string;
  deviceName: string;
  platform: string;
  status: string;
  queueDepth: number;
  lastSeenAt: string;
  lastCaptureAt?: string;
  error?: string;
}
export interface Activity {
  activityEvents?: number;
  contentCaptures?: number;
  apps: { appId?: string; appName: string; durationMs: number; captures: number }[];
  devices: {
    deviceId: string;
    deviceName: string;
    durationMs: number;
    captures: number;
  }[];
  totalDurationMs: number;
  captures: number;
}
export interface MediaActivity {
  totalDurationMs:number;
  observations:number;
  playingSamples:number;
  availability?:{available:number;disabled:number;permission_required:number;unavailable:number};
  apps:{appId:string;appName:string;durationMs:number;observations:number;evidenceIds:string[];evidenceTruncated:boolean}[];
  devices:{deviceId:string;deviceName:string;durationMs:number;observations:number;evidenceIds:string[];evidenceTruncated:boolean}[];
  visibility:{foreground:number;background:number;unknown:number};
  screenLock:{locked:number;unlocked:number;unknown:number};
  playbackType:{local:number;remote:number;unknown:number};
  evidenceIds:string[];
  evidenceTruncated:boolean;
  accounting:'union_per_device_sum_across_devices';
  coverage:'observed_intervals_only';
}
export interface Status {
  profile?: string;
  agent: { configured: boolean; model: string | null; provider: string; modelRequestTimeoutMs?: number | null; agentTimeoutMs?: number | null };
  storage: {
    captures: number;
    blobs: number;
    bytes: number;
    imageBytes: number;
    imageCaptures?: number;
    logicalBytes: number;
    maxBytes?: number;
    imagesEncrypted: boolean;
    firstCaptureAt?: string;
    lastCaptureAt?: string;
    indexing: { status: string; count: number }[];
  };
  index: { mode: string; model: string | null };
  retentionDays: number;
  insightIntervalHours: number;
  serverTime: string;
}
export interface Answer {
  snapshot?:import('@mote/shared').InsightSnapshot;
  modelSelection?: import("@mote/shared/models").ModelSelection;
  usage?:import('@mote/shared').UsageReceipt;
  answer: string;
  runId: string;
  citations: {
    id: string;
    capturedAt: string;
    appName: string;
    excerpt: string;
    contentAt?: string;
    fileEvidence?: FileEvidence;
    provenance?: {sourceId?:string;externalId?:string;revision?:string;layer?:string;document?:import('@mote/shared').SourceDocument};
  }[];
  trace: { tool: string; arguments: unknown; count: number }[];
  createdAt?: string;
  id?: string;
  artifact?: { id: string; title: string; html: string; createdAt: string; skillId: string; skillVersion: string };
}
export interface InsightPage {items:Answer[];nextCursor:string|null}
export const INSIGHT_HISTORY_PATH='/api/insights?limit=30';
export interface Range {
  after?: string;
  before?: string;
  deviceId?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
    public code?: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
export async function readApiError(response:Response):Promise<ApiError> {
  let requestId=response.headers.get('X-Request-Id')??undefined;
  let code:string|undefined;
  const retryAfter=response.headers.get('Retry-After');
  const seconds=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter):undefined;
  let retryAfterMs=seconds!==undefined&&Number.isSafeInteger(seconds*1000)?seconds*1000:undefined;
  try {
    const value=await response.json();
    code=responseFailureCode(value);
    if(value&&typeof value==='object'){
      if(!requestId&&typeof value.requestId==='string')requestId=value.requestId;
      if(retryAfterMs===undefined&&Number.isSafeInteger(value.retryAfterMs)&&value.retryAfterMs>=0)retryAfterMs=value.retryAfterMs;
    }
  }catch{/* Proxy responses may be HTML. Never display their bodies. */}
  if(!requestId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))requestId=undefined;
  return new ApiError(code?failureMessage(code,response.status):httpStatusMessage(response.status),response.status,requestId,code,retryAfterMs);
}
export async function readApiJson<T>(response:Response):Promise<T> {
  try{return await response.json() as T;}
  catch(error){if(error instanceof SyntaxError)throw new ApiError(moteText('中央响应格式无效，请刷新后重试。'),response.status,undefined,'invalid_response');throw error;}
}
export function createApi(connection: Connection, onUnauthorized?: () => void, isCurrentConnection: () => boolean = () => true) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    try { return await readApiJson<T>(response); }
    catch(error) { log('api.response_invalid','warn',{route:routeCategory(path),errorName:safeErrorName(error),status:response.status});throw error; }
  }
  async function raw(path: string, init: RequestInit = {}) {
    const modelOperation = init.method?.toUpperCase() === 'POST' && ['/api/query', '/api/insights', '/api/memories/extract'].includes(path);
    // The server accounts admitted execution time. A browser wall-clock timer
    // cannot know how long this operation waits for resources or durable work.
    const signal = modelOperation ? init.signal : init.signal ?? AbortSignal.timeout(180000);
    // Management requests always address the service serving this page.
    if (!path.startsWith('/api/') || path.includes('\\') || /[\r\n\t]/.test(path)) {
      throw new Error(moteText("管理请求必须使用当前服务的 API 路径。"));
    }
    const started=performance.now(),route=routeCategory(path),method=(init.method??'GET').toUpperCase();
    log('api.request_started','debug',{route,method});
    let response:Response;
    try { response = await fetch(path, {
      ...init,
      redirect: "error",
      credentials: path.startsWith("/api/files/") ? "same-origin" : "omit",
      signal,
      headers: {
        "Accept-Language": getLocale(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${connection.token}`,
      },
    });
    } catch(error) { log('api.request_failed','warn',{route,method,errorName:safeErrorName(error),elapsedMs:performance.now()-started});throw error; }
    if (!response.ok) {
      const error=await readApiError(response),code=error.code;
      log('api.request_rejected','warn',{route,method,status:response.status,code,requestId:error.requestId,elapsedMs:performance.now()-started});
      if (response.status === 401 && (!code || ['unauthorized','connection_revoked'].includes(code)) && !init.signal?.aborted && isCurrentConnection()) onUnauthorized?.();
      throw error;
    }
    log('api.request_completed','debug',{route,method,status:response.status,elapsedMs:performance.now()-started});
    return response;
  }
  return { request, raw };
}
export type Api = ReturnType<typeof createApi>;
export function queryString(
  range: Range,
  extra: Record<string, string | number | undefined> = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...range, ...extra }))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export function duration(ms: number) {
  if (ms < 60_000) return moteText("{0} 秒", Math.max(0, Math.round(ms / 1000)));
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60
    ? moteText("{0} 分钟", minutes)
    : moteText("{0} 小时 {1} 分钟", Math.floor(minutes / 60), minutes % 60);
}
export function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}
export function dateTime(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Date(value).toLocaleString(
    getLocale(),
    options ?? {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
  );
}
export function ago(value?: string) {
  if (!value) return moteText("尚无记录");
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60
    ? moteText("刚刚")
    : seconds < 3600
      ? moteText("{0} 分钟前", Math.floor(seconds / 60))
      : seconds < 86400
        ? moteText("{0} 小时前", Math.floor(seconds / 3600))
        : moteText("{0} 天前", Math.floor(seconds / 86400));
}
export function deviceState(device: Device) {
  if (!Number.isFinite(Date.parse(device.lastSeenAt)) || Date.now() - Date.parse(device.lastSeenAt) > 90_000) return "stale";
  return device.status;
}
export const deviceLabels: Record<string, string> = {
  capturing: moteText("正在采集"),
  paused: moteText("已暂停"),
  permission_required: moteText("等待权限"),
  error: moteText("需要处理"),
  offline: moteText("已离线"),
  stale: moteText("状态待更新"),
};
export function errorMessage(error: unknown) {
  const message=error instanceof ApiError&&error.code?failureMessage(error.code,error.status):error instanceof DOMException&&error.name==='TimeoutError'?moteText('请求等待超时，请检查节点和网络状态后重试。'):error instanceof TypeError?failureMessage('network'):error instanceof Error?error.message:moteText("请求未完成，请稍后重试。");
  return error instanceof ApiError&&error.requestId?moteText("{0} 请求编号：{1}",message,error.requestId):message;
}
