import { moteText } from '@mote/shared/i18n';
import { appendFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import type { Status } from './contracts';
import type { DesktopProfile } from './profile';

export const stages = ['APP','CONFIG','CAPTURE','MODEL','MODEL_DOWNLOAD','OCR','PRIVACY','QUEUE','UPLOAD','HEARTBEAT','NOTE','SUPPORT','SOURCE','CONNECTION','UPDATE'] as const;
export type EventStage = typeof stages[number];
export const codes = ['STARTED','STOPPED','OK','FILTERED','WAIT_NETWORK','PERMISSION','CONFIG_INVALID','NETWORK','TIMEOUT','TLS','AUTH','CONFLICT','SERVER','RESPONSE','STORAGE','MODEL_UNAVAILABLE','SCHEDULER','CANCELLED','OTHER'] as const;
export type EventCode = typeof codes[number];
export type EventLevel = 'debug' | 'info' | 'warn' | 'error';
export function eventLevel(code: EventCode): EventLevel {
  if (code === 'STARTED') return 'debug';
  if (['STOPPED','OK','FILTERED','CANCELLED'].includes(code)) return 'info';
  if (['WAIT_NETWORK','SCHEDULER','PERMISSION','MODEL_UNAVAILABLE'].includes(code)) return 'warn';
  return 'error';
}
export interface SupportEvent { level?: EventLevel; atMs: number; stage: EventStage; code: EventCode; elapsedMs?: number; httpStatus?: number }
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
function cleanEvent(value: unknown): SupportEvent | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as SupportEvent;
  if (!number(v.atMs) || v.atMs < 0 || !stages.includes(v.stage) || !codes.includes(v.code)) return;
  return { atMs: v.atMs, stage: v.stage, code: v.code,
    ...(['debug','info','warn','error'].includes(v.level ?? '') ? { level: v.level } : {}),
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
  constructor(private readonly directory: string, private readonly enabled: () => boolean, private readonly limit = 500) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error(moteText("事件日志上限无效"));
  }
  record(stage: EventStage, code: EventCode, metrics: { elapsedMs?: number; httpStatus?: number } = {}): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    const event = cleanEvent({ atMs: Date.now(), stage, code, level: eventLevel(code), ...metrics });
    if (!event) return Promise.resolve();
    const task = this.chain.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const archive=join(this.directory,'events.0.ndjson');
      if((await stat(archive).catch(()=>({size:0}))).size>=2*1024*1024){
        await unlink(join(this.directory,'events.6.ndjson')).catch(e=>{if(e.code!=='ENOENT')throw e;});
        for(let i=5;i>=0;i--)await rename(join(this.directory,`events.${i}.ndjson`),join(this.directory,`events.${i+1}.ndjson`)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      }
      await appendFile(archive,JSON.stringify(event)+'\n',{mode:0o600});
    }).catch(() => undefined);
    this.chain = task; return task;
  }
  async exportRange(after:number,before=Date.now()):Promise<{events:SupportEvent[];after:string;before:string;oldestRetainedAt:string|null;retentionLimited:boolean}> {
    await this.chain;const rows:SupportEvent[]=[];
    for(let i=6;i>=0;i--){const path=join(this.directory,`events.${i}.ndjson`);let file;
      try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);if((await file.stat()).size>2*1024*1024+4096)throw Error('Log exceeds read limit');
        for(const line of (await file.readFile('utf8')).split('\n')){if(!line.trim())continue;const event=cleanEvent(JSON.parse(line));if(event)rows.push(event);}
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}finally{await file?.close();}
    }
    rows.sort((a,b)=>a.atMs-b.atMs);
    return {events:rows.filter(e=>e.atMs>=after&&e.atMs<before),after:new Date(after).toISOString(),before:new Date(before).toISOString(),oldestRetainedAt:rows[0]?new Date(rows[0].atMs).toISOString():null,retentionLimited:!rows.length||rows[0].atMs>after};
  }
  async readRaw(): Promise<string> {
    await this.chain;
    let file;try{file=await open(join(this.directory,'events.0.ndjson'),constants.O_RDONLY|constants.O_NOFOLLOW);
      const size=(await file.stat()).size;if(size>2*1024*1024+4096)throw Error('Log exceeds read limit');
      const buffer=Buffer.alloc(Math.min(size,256*1024)),offset=Math.max(0,size-buffer.length);
      const {bytesRead}=await file.read(buffer,0,buffer.length,offset);return buffer.subarray(0,bytesRead).toString('utf8');
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}finally{await file?.close();}
  }
  async read(_strict = false): Promise<SupportEvent[]> {return (await this.exportRange(0,Date.now()+1)).events.slice(-this.limit);}

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
  for (const key of ['nsfwEnabled','diagnosticsEnabled','pauseOnBattery','openAtLogin'] as const) if (typeof c[key] === 'boolean') config[key] = c[key];
  const modelMetrics = Object.fromEntries(['bytes','totalBytes','blockedCount','lastLoadMs','lastVisionMs','lastTokens','lastDurationMs'].flatMap(key => {
    const value = model?.[key as keyof typeof model]; return number(value) ? [[key,value]] : [];
  }));
  return { version: 1, scope: 'local-support-without-content', exportedAt: new Date().toISOString(),
    app: { platform: process.platform, version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version) ? version : 'unknown', profile: profile.name, defaultProfile: profile.defaultProfile },
    state: { running: Boolean(status.running), state: ['stopped','capturing','paused','permission_required','error'].includes(status.state) ? status.state : 'unknown', queueDepth: number(status.queueDepth) ? status.queueDepth : 0, queueBytes: number(status.queueBytes) ? status.queueBytes : 0, encryptedTokenStorage: Boolean(status.encryptedTokenStorage) },
    config, model: modelMetrics, diagnostics: metrics(status.diagnostics), events: events.map(cleanEvent).filter(Boolean),
    batteryScope: 'whole-device change, not application energy attribution' };
}
