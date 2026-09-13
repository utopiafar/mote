export interface Connection {
  url: string;
  token: string;
}
export interface Capture {
  id: string;
  capturedAt: string;
  appName: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  ocrText: string;
  windowTitle: string;
  durationMs: number;
  blobHash: string | null;
  source: string;
  privacy: { redacted: boolean; mode: string; reason?: string };
  indexingStatus: string;
  summary?: string;
  mood?: string;
}
export interface Device {
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
  apps: { appName: string; durationMs: number; captures: number }[];
  devices: {
    deviceId: string;
    deviceName: string;
    durationMs: number;
    captures: number;
  }[];
  totalDurationMs: number;
  captures: number;
}
export interface Status {
  profile?: string;
  agent: { configured: boolean; model: string | null; provider: string };
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
  answer: string;
  runId: string;
  citations: {
    id: string;
    capturedAt: string;
    appName: string;
    excerpt: string;
  }[];
  trace: { tool: string; arguments: unknown; count: number }[];
  createdAt?: string;
  id?: string;
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
export function createApi(connection: Connection, onUnauthorized?: () => void) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await raw(path, init);
    return response.json() as Promise<T>;
  }
  async function raw(path: string, init: RequestInit = {}) {
    const response = await fetch(`${connection.url}${path}`, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal: init.signal ?? AbortSignal.timeout(180000),
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
        Authorization: `Bearer ${connection.token}`,
      },
    });
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      let message = `请求未完成（${response.status}）`;
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
  if (Date.now() - Date.parse(device.lastSeenAt) > 90_000) return "offline";
  return device.status;
}
export const deviceLabels: Record<string, string> = {
  capturing: "正在采集",
  paused: "已暂停",
  permission_required: "等待权限",
  error: "需要处理",
  offline: "已离线",
};
export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.requestId) return `${error.message} 请求编号：${error.requestId}`;
  return error instanceof Error ? error.message : "请求未完成，请稍后重试。";
}
