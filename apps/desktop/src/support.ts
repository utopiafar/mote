import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Status } from './contracts';
import type { DesktopProfile } from './profile';

export const stages = ['APP','CONFIG','CAPTURE','MODEL','MODEL_DOWNLOAD','OCR','PRIVACY','QUEUE','UPLOAD','HEARTBEAT','NOTE','SUPPORT'] as const;
export type EventStage = typeof stages[number];
export const codes = ['STARTED','STOPPED','OK','FILTERED','WAIT_NETWORK','PERMISSION','CONFIG_INVALID','NETWORK','TIMEOUT','TLS','AUTH','CONFLICT','SERVER','RESPONSE','STORAGE','MODEL_UNAVAILABLE','SCHEDULER','CANCELLED','OTHER'] as const;
export type EventCode = typeof codes[number];
export interface SupportEvent { atMs: number; stage: EventStage; code: EventCode; elapsedMs?: number; httpStatus?: number }
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
function cleanEvent(value: unknown): SupportEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as SupportEvent;
  if (!number(v.atMs) || v.atMs < 0 || !stages.includes(v.stage) || !codes.includes(v.code)) return;
  return { atMs: v.atMs, stage: v.stage, code: v.code,
    ...(number(v.elapsedMs) && v.elapsedMs >= 0 ? { elapsedMs: v.elapsedMs } : {}),
    ...(Number.isInteger(v.httpStatus) && v.httpStatus! >= 100 && v.httpStatus! <= 599 ? { httpStatus: v.httpStatus } : {}) };
}
export function httpFailure(status: number): EventCode { return status === 401 || status === 403 ? 'AUTH' : status === 409 || status === 410 ? 'CONFLICT' : status >= 500 ? 'SERVER' : 'RESPONSE'; }
export class TransportFailure extends Error {
  constructor(message: string, readonly classification: EventCode, readonly httpStatus?: number) { super(message); this.name = 'TransportFailure'; }
}
/** Classify structured error types/codes only; error messages can contain personal content. */
export function failureCode(error: unknown, stage: EventStage): EventCode {
  let cause = error;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 8; depth++) {
    if (cause instanceof TransportFailure) return cause.classification;
    const e = cause as { name?: string; code?: string; cause?: unknown };
    if (e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
    if (e.name === 'AbortError') return 'CANCELLED';
    if (['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(e.code ?? '')) return 'TLS';
    if (['EACCES','EPERM'].includes(e.code ?? '')) return 'PERMISSION';
    if (['ENOSPC','EIO','EROFS','ENOENT'].includes(e.code ?? '')) return 'STORAGE';
    if (['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ENETUNREACH'].includes(e.code ?? '')) return 'NETWORK';
    cause = e.cause;
  }
  if (stage === 'CONFIG') return 'CONFIG_INVALID';
  if (stage === 'MODEL') return 'MODEL_UNAVAILABLE';
  if (stage === 'QUEUE' || stage === 'NOTE' || stage === 'SUPPORT') return 'STORAGE';
  if (stage === 'UPLOAD' || stage === 'HEARTBEAT' || stage === 'MODEL_DOWNLOAD') return 'RESPONSE';
  return 'OTHER';
}
/** Opt-in fixed events only. Its failures must never change capture or ACK semantics. */
export class EventJournal {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly temporary: string;
  private cleaned = false;
  constructor(private readonly directory: string, private readonly enabled: () => boolean, private readonly limit = 500) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('事件日志上限无效');
    this.path = join(directory, 'events.json'); this.temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
  }
  private async cleanOrphanedWrites(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const entry of await readdir(this.directory, { withFileTypes: true }).catch(() => [])) {
      const match = /^events\.json\.([1-9][0-9]*)\.([0-9a-f-]{36})\.tmp$/.exec(entry.name);
      if (!entry.isFile() || !match || !Number.isSafeInteger(Number(match[1]))) continue;
      try { process.kill(Number(match[1]), 0); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      await unlink(join(this.directory, entry.name)).catch(() => undefined);
    }
  }
  private async load(strict = false): Promise<SupportEvent[]> {
    try {
      if ((await stat(this.path)).size > 256 * 1024) { if (strict) throw new Error('日志文件超出读取上限'); return []; }
      const raw = await readFile(this.path, 'utf8');
      if (Buffer.byteLength(raw) > 256 * 1024) return [];
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.map(cleanEvent).filter((e): e is SupportEvent => Boolean(e)).slice(-this.limit) : [];
    } catch (error) { if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return []; }
  }
  record(stage: EventStage, code: EventCode, metrics: { elapsedMs?: number; httpStatus?: number } = {}): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    const event = cleanEvent({ atMs: Date.now(), stage, code, ...metrics });
    if (!event) return Promise.resolve();
    const task = this.chain.then(async () => {
      await this.cleanOrphanedWrites();
      const rows = [...await this.load(), event].slice(-this.limit);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = await open(this.temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(rows)); await file.sync(); } finally { await file.close(); }
      try { await rename(this.temporary, this.path); } finally { await unlink(this.temporary).catch(() => undefined); }
    }).catch(() => undefined);
    this.chain = task; return task;
  }
  async read(strict = false): Promise<SupportEvent[]> { await this.chain; return this.load(strict); }
}
const metricKeys = ['sampleCount','fileBytes','queueBytes','modelBytes','rssBytes','cpuUserMicros','cpuSystemMicros','batteryPercent','deviceBatteryDeltaPct','queueDeltaBytes','saved','blocked','failed','imageBytes','uploadedBytes','inferenceMs','ocrMs','captureMs'];
function metrics(value: unknown): Record<string, number | boolean | object> {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const out: Record<string, number | boolean | object> = {};
  for (const key of metricKeys) if (number(v[key])) out[key] = v[key] as number;
  for (const key of ['enabled','charging','onBattery']) if (typeof v[key] === 'boolean') out[key] = v[key];
  for (const key of ['counters','latest']) if (v[key]) out[key] = metrics(v[key]);
  return out;
}
export function buildSupportBundle(profile: DesktopProfile, version: string, status: Status, events: SupportEvent[]): object {
  const c = status.config, model = status.nsfw;
  const config: Record<string, number | boolean> = {};
  for (const key of ['intervalMs','maxQueueBytes','maxQueueEvents','idlePauseSeconds','diagnosticIntervalSeconds','jpegQuality','captureMaxSide','batteryPauseBelowPct','reviewMaxTokens','reviewMaxSide','nsfwThreads','nsfwTimeoutMs'] as const) if (number(c[key])) config[key] = c[key];
  for (const key of ['ocrEnabled','nsfwEnabled','diagnosticsEnabled','pauseOnBattery','openAtLogin'] as const) if (typeof c[key] === 'boolean') config[key] = c[key];
  const modelMetrics = Object.fromEntries(['bytes','totalBytes','blockedCount','lastLoadMs','lastVisionMs','lastTokens','lastDurationMs'].flatMap(key => {
    const value = model?.[key as keyof typeof model]; return number(value) ? [[key,value]] : [];
  }));
  return { version: 1, scope: 'local-support-without-content', exportedAt: new Date().toISOString(),
    app: { platform: process.platform, version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : 'unknown', profile: profile.name, legacy: profile.legacy },
    state: { running: Boolean(status.running), state: ['stopped','capturing','paused','permission_required','error'].includes(status.state) ? status.state : 'unknown', queueDepth: number(status.queueDepth) ? status.queueDepth : 0, queueBytes: number(status.queueBytes) ? status.queueBytes : 0, encryptedTokenStorage: Boolean(status.encryptedTokenStorage) },
    config, model: modelMetrics, diagnostics: metrics(status.diagnostics), events: events.map(cleanEvent).filter(Boolean).slice(-500),
    batteryScope: 'whole-device change, not application energy attribution' };
}
