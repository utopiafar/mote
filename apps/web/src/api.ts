import type {RecordMetadata, SourceMetadata, OcrResult, CaptureRecord} from '@mote/shared';
export interface Connection {
  token: string;
}
export interface FileEvidence {
  captureId: string;
  revision: string;
  artifactId: string;
  chunkId: string;
  startMs?: number;
  endMs?: number;
  speaker?: string;
  uncertain?: boolean;
  overlap?: boolean;
}
export interface Capture {
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
  agent: { configured: boolean; model: string | null; provider: string; timeoutMs?: number };
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
  ) {
    super(message);
  }
}
export function createApi(connection: Connection, onUnauthorized?: () => void, isCurrentConnection: () => boolean = () => true) {
  let agentTimeoutMs = 120000;
  // Keep request budgets isolated between authenticated sessions.
  function setAgentTimeout(value: number | undefined) {
    agentTimeoutMs = Number.isSafeInteger(value) && value! >= 5000 && value! <= 600000 ? value! : 120000;
  }
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    return response.json() as Promise<T>;
  }
  async function raw(path: string, init: RequestInit = {}) {
    const modelOperation = init.method?.toUpperCase() === 'POST' && ['/api/query', '/api/insights', '/api/memories/extract'].includes(path);
    const deadline = modelOperation ? AbortSignal.timeout(agentTimeoutMs + 60000) : undefined;
    const signal = deadline ? (init.signal ? AbortSignal.any([init.signal, deadline]) : deadline) : init.signal ?? AbortSignal.timeout(180000);
    // Management requests always address the service serving this page.
    if (!path.startsWith('/api/') || path.includes('\\') || /[\r\n\t]/.test(path)) {
      throw new Error('管理请求必须使用当前服务的 API 路径。');
    }
    const response = await fetch(path, {
      ...init,
      redirect: "error",
      credentials: path.startsWith("/api/files/") ? "same-origin" : "omit",
      signal,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${connection.token}`,
      },
    });
    if (!response.ok) {
      if (response.status === 401 && !init.signal?.aborted && isCurrentConnection()) onUnauthorized?.();
      let message = response.status === 524
        ? "入口等待服务响应超时（524）。请检查节点运行诊断；较慢的模型请求可能超过代理等待上限。"
        : response.status === 413
          ? "上传超过中央节点或公网入口的大小限制（413）。可以分批上传，或将文件放到中央服务器后从目录导入。"
          : response.status === 502
            ? "入口暂时无法连接中央服务（502）。请检查中央进程和隧道的 origin 地址。"
            : `请求未完成（${response.status}）`;
      let requestId = response.headers.get("X-Request-Id") ?? undefined;
      try {
        const value = await response.json();
        if (typeof value.message === "string") message = value.message;
        else if (typeof value.error === "string") message = value.error;
        if (!requestId && typeof value.requestId === "string") requestId = value.requestId;
      } catch {
        /* response might not be JSON */
      }
      if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) requestId = undefined;
      throw new ApiError(message, response.status, requestId);
    }
    return response;
  }
  return { request, raw, setAgentTimeout };
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
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
export function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}
export function dateTime(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Date(value).toLocaleString(
    "zh-CN",
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
  if (!value) return "尚无记录";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60
    ? "刚刚"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} 小时前`
        : `${Math.floor(seconds / 86400)} 天前`;
}
export function deviceState(device: Device) {
  if (!Number.isFinite(Date.parse(device.lastSeenAt)) || Date.now() - Date.parse(device.lastSeenAt) > 90_000) return "stale";
  return device.status;
}
export const deviceLabels: Record<string, string> = {
  capturing: "正在采集",
  paused: "已暂停",
  permission_required: "等待权限",
  error: "需要处理",
  offline: "已离线",
  stale: "状态待更新",
};
export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.requestId) return `${error.message} 请求编号：${error.requestId}`;
  return error instanceof Error ? error.message : "请求未完成，请稍后重试。";
}
