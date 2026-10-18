import {failureMessage} from './failure-message';
import { moteText, getLocale } from '@mote/shared/i18n';
import {httpStatusMessage,responseFailureCode} from '@mote/shared';
import type {RecordMetadata, SourceMetadata, OcrResult, CaptureRecord} from '@mote/shared';
export interface WebConnection {
  mode: 'web';
  origin: string;
  deploymentId: string;
  userId: string;
  credentialId: string;
  csrfToken: string;
  username: string;
  administrator: boolean;
  expiresAt?: number;
  viewScope?: string;
  token?: never;
}
/** Bearer transport is explicit for native/legacy consumers. Browser login uses WebConnection. */
export type Connection = WebConnection | {
  token: string;
  mode?: never;
  expiresAt?: number;
  serverExpiresAt?: number;
  viewScope?: string;
};
export const isWebConnection = (connection: Connection): connection is WebConnection => connection.mode === 'web';
export interface Api {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  raw(path: string, init?: RequestInit): Promise<Response>;
  readonly connection?: Readonly<Connection>;
  close?(): void;
}
/** Draft identity survives credential rotation, but never crosses deployment/account boundaries. */
export function apiOwnerKey(api: Api): string {
  const value=api.connection;
  return value && isWebConnection(value) ? JSON.stringify([value.origin,value.deploymentId,value.userId]) : globalThis.location?.origin ?? 'legacy-fixture';
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
export function createApi(input: Connection, onUnauthorized?: () => void, isCurrentConnection: () => boolean = () => true): Api {
  const connection=Object.freeze({...input});
  let closed=false;
  const assertCurrent=()=>{
    if(closed || !isCurrentConnection() || (connection.expiresAt!==undefined && connection.expiresAt<=Date.now()) || (isWebConnection(connection) && globalThis.location && connection.origin!==location.origin))
      throw new ApiError(moteText('登录会话已改变，请重新登录。'),401,undefined,'session_changed');
  };
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    const value=await readApiJson<T>(response);
    assertCurrent();
    if(isWebConnection(connection)&&path==='/api/auth/self'){
      const self=value as {credentialId?:string;deploymentId?:string;userId?:string};
      if(self.credentialId!==connection.credentialId||self.deploymentId!==connection.deploymentId||self.userId!==connection.userId){onUnauthorized?.();throw new ApiError(moteText('登录会话已改变，请重新登录。'),401,undefined,'session_changed');}
    }
    return value;
  }
  async function raw(path: string, init: RequestInit = {}) {
    assertCurrent();
    const modelOperation = init.method?.toUpperCase() === 'POST' && ['/api/query', '/api/insights', '/api/memories/extract'].includes(path);
    // The server accounts admitted execution time. A browser wall-clock timer
    // cannot know how long this operation waits for resources or durable work.
    const signal = modelOperation ? init.signal : init.signal ?? AbortSignal.timeout(180000);
    // Management requests always address the service serving this page.
    if (!path.startsWith('/api/') || path.includes('\\') || /[\r\n\t]/.test(path)) {
      throw new Error(moteText("管理请求必须使用当前服务的 API 路径。"));
    }
    const headers=new Headers(init.headers);
    headers.set('Accept-Language',getLocale());
    if(init.body && !headers.has('Content-Type'))headers.set('Content-Type','application/json');
    headers.set('X-Mote-Protocol-Version','2');
    if(path.startsWith('/api/ingress/'))headers.set('X-Mote-Ingress-Version','3');
    if(isWebConnection(connection)){
      headers.delete('Authorization');
      headers.set('X-Mote-Session-Id',connection.credentialId);
      headers.set('X-Mote-CSRF',connection.csrfToken);
    }else headers.set('Authorization',`Bearer ${connection.token}`);
    const response = await fetch(path, {
      ...init,
      // A held response can lock a browser cache entry before its no-store
      // response headers arrive. New-owner reads must bypass that entry too.
      cache: "no-store",
      redirect: "error",
      credentials: isWebConnection(connection) || path.startsWith("/api/files/") ? "same-origin" : "omit",
      signal,
      headers,
    });
    assertCurrent();
    if (!response.ok) {
      const error=await readApiError(response),code=error.code;
      if ((response.status === 401 && (!code || ['unauthorized','connection_revoked','invalid_identity','session_binding_required'].includes(code)) || response.status===409&&code==='session_changed') && !init.signal?.aborted && isCurrentConnection()) onUnauthorized?.();
      assertCurrent();
      throw error;
    }
    return new Proxy(response, {get(target,key){
      const value=Reflect.get(target,key,target);
      if(['json','text','blob','arrayBuffer','formData','bytes'].includes(String(key))&&typeof value==='function')return async(...args:unknown[])=>{assertCurrent();const body=await value.apply(target,args);assertCurrent();return body;};
      return typeof value==='function'?value.bind(target):value;
    }});
  }
  return { request, raw, connection, close:()=>{closed=true;} };
}
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
