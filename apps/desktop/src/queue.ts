import {ensureStorageFormat,DESKTOP_STORAGE_VERSION} from './storage-format';
import {captureSchema} from '@mote/shared';
import {stateSeriesSchema,stateOnly,isStateExtension} from '@mote/shared/state-series';
import { moteText } from '@mote/shared/i18n';
import { recordMetadataSchema } from '@mote/shared/metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, rename, unlink, open, chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { archiveWork, imageWork, previewWork, type WorkProgress } from './background';
import { basename, dirname, join } from 'node:path';
import { ConnectionBindingStore } from './connection-binding';
import type { CaptureEvent, Config } from './contracts';
import { MAX_IMAGE_BYTES } from './config';
import { encodeLocalContent, readLocalContent } from './local-content';
import { builtInCaptureStages, type CapturePacket, type CapturePipelineCheckpoint, type CaptureStageRegistry } from './capture-stages';

function readFile(path: string): Promise<Buffer>;
function readFile(path: string, encoding: 'utf8'): Promise<string>;
async function readFile(path: string, encoding?: 'utf8'): Promise<Buffer | string> {
  const bytes = await readLocalContent(path); return encoding ? bytes.toString(encoding) : bytes;
}

export interface QueueRecord {
  event: CaptureEvent;
  blobHash?: string;
  blobBytes: number;
  attempts: number;
  nextAttemptAt: number;
  syncBlocked?: boolean;
  syncError?: string;
}
export interface QueueLimits { maxQueueBytes: number; maxQueueEvents: number }
export interface QueueStats { archiveAcknowledgment?:{at:string;origin:string}; depth: number; bytes: number; nextRetryAt?: string; oldestPendingAt?: string; lastUploadAt?: string; eligibleDepth: number; blocked: number }
export interface QueueArchive {
  format: 'mote-desktop-queue';
  version: 3;
  records: QueueRecord[];
  blobs: Record<string, string>;
}
interface CaptureStageJournal { version: 1; outputs: QueueRecord[]; checkpoint: CapturePipelineCheckpoint }
interface CaptureInputJournal { version: 1; transactionId: string; event: CaptureEvent; blobHash?: string; blobBytes: number; reviewHeld: boolean }
export class QueueFullError extends Error {
  constructor() { super(moteText("本地队列已达上限，采集已停止；上传后请手动重新开始")); }
}

export function imageHash(image: Buffer): string { return createHash('sha256').update(image).digest('hex'); }
export function retryDelay(attempts: number, random = Math.random): number {
  return Math.round(Math.min(15 * 60_000, 2000 * 2 ** Math.min(attempts - 1, 10)) * (0.8 + random() * 0.4));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function recordBytes(record: QueueRecord): number {return Buffer.byteLength(JSON.stringify(record));}
function activeUsage(records:Iterable<QueueRecord>):{depth:number;bytes:number}{
  const blobs=new Map<string,number>();let depth=0,bytes=0;
  for(const record of records){depth++;bytes+=recordBytes(record);if(record.blobHash)blobs.set(record.blobHash,record.blobBytes);}
  return {depth,bytes:bytes+[...blobs.values()].reduce((sum,value)=>sum+value,0)};
}

function validateEvent(value: unknown): CaptureEvent {
  if (!value || typeof value !== 'object') throw new Error(moteText("队列事件无效"));
  const v = value as CaptureEvent;
  if (!UUID.test(v.id) || !UUID.test(v.deviceId) || !['macos', 'windows', 'linux'].includes(v.platform) || !Number.isFinite(Date.parse(v.capturedAt)) || !Number.isInteger(v.durationMs) || v.durationMs < 0 || v.durationMs > 300000 || !['screen', 'note', 'activity', 'notification', 'ui_page'].includes(v.source)) throw new Error(moteText("队列事件元数据无效"));
  for (const [key, max] of [['deviceName', 128], ['appId', 256], ['appName', 200]] as const) {
    if (typeof v[key] !== 'string' || !v[key].trim() || v[key].length > max) throw new Error(moteText("队列事件应用或设备信息无效"));
  }
  if (v.ocrText !== undefined && (typeof v.ocrText !== 'string' || v.ocrText.length > 100000)) throw new Error(moteText("OCR 文本超出限制"));
  if (v.privacy?.excluded !== false || typeof v.privacy?.redacted !== 'boolean') throw new Error(moteText("队列隐私标记无效"));
  const metadata = v.metadata === undefined ? undefined : recordMetadataSchema.parse(v.metadata);
  const stateSeries=v.stateSeries?stateSeriesSchema.parse(v.stateSeries):undefined;
  if(stateSeries&&(!stateOnly(v)||Date.parse(stateSeries.samples[0].at)!==Date.parse(v.capturedAt)||stateSeries.samples[0].durationMs!==v.durationMs||stateSeries.samples.some((sample,i)=>i>0&&(Date.parse(sample.at)<=Date.parse(stateSeries.samples[i-1].at)||Date.parse(sample.at)-Date.parse(stateSeries.samples[i-1].at)>300000))||Date.parse(stateSeries.samples.at(-1)!.at)-Date.parse(v.capturedAt)>21600000))throw Error('Invalid state series');
  if(stateSeries)for(const sample of stateSeries.samples)sample.at=new Date(sample.at).toISOString();
  const base = { ...(stateSeries?{stateSeries}:{}),id: v.id, deviceId: v.deviceId, deviceName: v.deviceName, platform: v.platform,
    capturedAt: new Date(v.capturedAt).toISOString(), durationMs: v.durationMs, appId: v.appId, appName: v.appName, ...(metadata ? { metadata } : {}) };
  if(v.source==='ui_page'){captureSchema.parse({...v,ocrText:v.ocrText??''});return {...base,source:'ui_page',ocrText:v.ocrText,privacy:v.privacy};}
  if (v.source === 'notification') {
    if(v.platform!=='macos'||v.durationMs!==0||v.imageMime||v.ocrText||v.mood!==undefined||v.privacy.redacted||!metadata?.notification||!metadata.observation||metadata.collector?.method!=='accessibility'||metadata.media||metadata.capture||v.privacy.collection!=='content'||v.privacy.mode!=='none')throw new Error('Invalid notification observation');
    return {...base,source:'notification',ocrText:'',privacy:v.privacy};
  }
  if (v.source === 'activity') {
    const raw = v as unknown as Record<string, unknown>;
    if (v.privacy.collection !== 'activity' || v.privacy.mode !== 'none' || v.privacy.redacted || ['ocrText', 'imageMime', 'imageBase64', 'mood', 'title', 'windowTitle', 'provenance'].some(key => Object.hasOwn(raw, key)) || (metadata?.capture && Object.keys(metadata.capture).some(key => key !== 'intervalMs'))) throw new Error(moteText("仅活动记录不得包含屏幕或正文内容"));
    return { ...base, source: 'activity', privacy: { excluded: false, redacted: false, mode: 'none', collection: 'activity' } };
  }
  if (v.privacy.collection !== undefined && v.privacy.collection !== 'content') throw new Error(moteText("内容记录的采集级别无效"));
  if (v.source === 'note') {
    if (v.durationMs !== 0 || v.imageMime !== undefined || typeof v.ocrText !== 'string' || !v.ocrText.trim() || v.ocrText.length > 20000 || v.privacy.mode !== 'none' || v.privacy.redacted !== false || (v.mood !== undefined && (typeof v.mood !== 'string' || !v.mood.trim() || v.mood.length > 80))) throw new Error(moteText("随手记格式无效"));
    return { ...base, ocrText: v.ocrText, source: 'note', mood: v.mood, privacy: { excluded: false, redacted: false, mode: 'none' } };
  }
  if (v.imageMime !== 'image/jpeg' || v.privacy.mode !== 'local' || typeof v.privacy.reason !== 'string' || v.privacy.reason.length > 500) throw new Error(moteText("截图隐私标记无效"));
  if (v.ocr !== undefined && (!['completed', 'disabled'].includes(v.ocr.status) || (v.ocr.reason !== undefined && v.ocr.reason !== 'charging') || (v.ocr.updatedAt !== undefined && !Number.isFinite(Date.parse(v.ocr.updatedAt))))) throw new Error(moteText("OCR 状态无效"));
  const ocr = v.ocr ? { status: v.ocr.status, ...(v.ocr.reason ? { reason: v.ocr.reason } : {}), ...(v.ocr.updatedAt ? { updatedAt: v.ocr.updatedAt } : {}) } : undefined;
  return { ...base, ocrText: v.ocrText, ...(ocr ? { ocr } : {}), source: 'screen', imageMime: 'image/jpeg', privacy: { excluded: false, redacted: v.privacy.redacted, mode: 'local', ...(v.privacy.collection ? { collection: v.privacy.collection } : {}), reason: v.privacy.reason } };
}
export function validateRecord(value: unknown): QueueRecord {
  const v = value as QueueRecord;
  const event = validateEvent(v?.event);
  if ((event.source === 'screen' ? (!v.blobHash || !HASH.test(v.blobHash) || !Number.isInteger(v.blobBytes) || v.blobBytes < 4 || v.blobBytes > MAX_IMAGE_BYTES) : (v.blobHash !== undefined || v.blobBytes !== 0)) || !Number.isInteger(v.attempts) || v.attempts < 0 || !Number.isFinite(v.nextAttemptAt) || v.nextAttemptAt < 0) throw new Error(moteText("队列记录无效"));
  if(['uploaded','ocrResult','ocrRetryAt','localArchiveOnly'].some(key=>Object.hasOwn(v,key)))throw Error('Unsupported desktop queue record format');
  if ((v.syncBlocked !== undefined && typeof v.syncBlocked !== 'boolean') || (v.syncError !== undefined && (typeof v.syncError !== 'string' || v.syncError.length > 300))) throw new Error(moteText("同步失败状态无效"));
  return { event, blobHash: v.blobHash, blobBytes: v.blobBytes, attempts: v.attempts, nextAttemptAt: v.nextAttemptAt, ...(v.syncBlocked ? { syncBlocked: true, syncError: v.syncError } : {}) };
}
export function validateImage(image: Buffer, hash?: string): void {
  if (image.length < 4 || image.length > MAX_IMAGE_BYTES || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9 || (hash && imageHash(image) !== hash)) throw new Error(moteText("队列图片格式、大小或校验和不正确"));
}
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(basename(path) === 'connection-binding.json' ? data : encodeLocalContent(data)); await file.sync(); } finally { await file.close(); }
  await rename(tmp, path);
  // Persist the rename itself as well as file bytes, including sudden power loss.
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync via Node; its capture capability is disabled.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class DurableQueue {
  private records = new Map<string, QueueRecord>();
  private cachedStats?: QueueStats;
  private recordSizes = new WeakMap<QueueRecord, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private storageGuard?: () => Promise<void>;
  setStorageGuard(guard: () => Promise<void>): void { this.storageGuard = guard; }
  private storageBinding: ConnectionBindingStore;
  private storageDirectory: string;
  private lastUploadAt?: string;
  private archiveAcknowledgment?:{at:string;origin:string};
  private sourceRetryAt?: string;
  private readonly captureStages: CaptureStageRegistry;
  private captureCheckpoint?: CapturePipelineCheckpoint;
  private stageJournalPending = false;
  private inputJournalPending = false;
  constructor(directory: string, private limits: QueueLimits, stages?: CaptureStageRegistry, private readonly afterStageJournal?: () => void, private readonly afterInputJournal?: () => void) { this.captureStages = stages ?? builtInCaptureStages(); this.storageDirectory = directory; this.storageBinding = new ConnectionBindingStore(join(directory, 'connection-binding.json'), async (path, value) => { await this.storageGuard?.(); await atomicWrite(path, JSON.stringify(value)); }); }
  get directory(): string { return this.storageDirectory; }
  get binding(): ConnectionBindingStore { return this.storageBinding; }
  /** All file readers/writers queue behind this transaction; memory records keep the same IDs. */
  async relocate(target: string, storage: import('./queue-storage').QueueStorage, commitConfig: () => Promise<void>, selectedDirectory: () => Promise<string>, progress?: (value: WorkProgress) => void): Promise<void> {
    await this.exclusive(async () => {
      this.assertReady();
      await storage.migrate(this.directory, target, async () => {
        // A copied binding must exist before initialize; never synthesize an empty replacement.
        await readFile(join(target, 'connection-binding.json'));
        const binding = new ConnectionBindingStore(join(target, 'connection-binding.json'), async (path, value) => { await this.storageGuard?.(); await atomicWrite(path, JSON.stringify(value)); });
        const config = this.limits as QueueLimits & Partial<Config>;
        await binding.initialize({ serverUrl: config.serverUrl ?? '', token: config.token }, activeUsage(this.records.values()).depth > 0);
        await commitConfig();
        // No fallible operation after the durable pointer commit and before activation.
        this.storageDirectory = target; this.storageBinding = binding;
      }, selectedDirectory, progress);
    });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => { await this.storageGuard?.(); if(this.initialized&&this.stageJournalPending)await this.replayStageJournal(true);if(this.initialized&&this.inputJournalPending)await this.recoverInputJournal(); try { return await fn(); } finally { this.cachedStats = undefined; } });
    this.chain = result.catch(() => undefined);
    return result;
  }
  private eventsPath(id: string): string { return join(this.directory, 'events', `${id}.json`); }
  private blobPath(hash: string): string { return join(this.directory, 'blobs', `${hash}.jpg`); }
  private stageCheckpointPath(): string { return join(this.directory, 'capture-stage-checkpoint.json'); }
  private stageJournalPath(): string { return join(this.directory, 'capture-stage-journal.json'); }
  private inputJournalPath(): string { return join(this.directory, 'capture-input-journal.json'); }
  private async replayStageJournal(updateMemory: boolean): Promise<void> {
    let journal: CaptureStageJournal;
    try { journal = JSON.parse(await readFile(this.stageJournalPath(), 'utf8')) as CaptureStageJournal; }
    catch (error) { if((error as NodeJS.ErrnoException).code==='ENOENT'){this.stageJournalPending=false;return;}throw error; }
    if(journal.version!==1||!Array.isArray(journal.outputs)||journal.outputs.length>64||!journal.checkpoint||journal.checkpoint.version!==1)throw new Error('Invalid capture stage journal');
    const outputs=journal.outputs.map(validateRecord);
    for(const record of outputs)await atomicWrite(this.eventsPath(record.event.id),JSON.stringify(record));
    await atomicWrite(this.stageCheckpointPath(),JSON.stringify(journal.checkpoint));
    await unlink(this.stageJournalPath());await syncDirectory(this.directory);
    if(updateMemory){for(const record of outputs)this.records.set(record.event.id,record);this.captureCheckpoint=journal.checkpoint;this.cachedStats=undefined;}
    this.stageJournalPending=false;
  }
  private async recoverInputJournal(): Promise<void> {
    let journal:CaptureInputJournal;
    try { journal=JSON.parse(await readFile(this.inputJournalPath(),'utf8')) as CaptureInputJournal; }
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.inputJournalPending=false;return;}throw error;}
    if(journal.version!==1||!UUID.test(journal.transactionId)||!Number.isSafeInteger(journal.blobBytes)||journal.blobBytes<0||typeof journal.reviewHeld!=='boolean')throw new Error('Invalid capture input journal');
    const event=validateEvent(journal.event);
    const image=journal.blobHash?await readFile(this.blobPath(journal.blobHash)):undefined;
    if(journal.blobHash){if(!HASH.test(journal.blobHash)||!image||image.length!==journal.blobBytes)throw new Error('Invalid capture input image');validateImage(image,journal.blobHash);}
    else if(journal.blobBytes!==0)throw new Error('Invalid capture input image');
    if(this.captureCheckpoint?.lastInputTransaction!==journal.transactionId)await this.commitCaptureStages([{event,image,reviewHeld:journal.reviewHeld}],false,journal.transactionId);
    await unlink(this.inputJournalPath());await syncDirectory(this.directory);this.inputJournalPending=false;
  }
  private assertReady(): void { if (!this.initialized) throw new Error(moteText("持久队列尚未初始化")); }
  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      if(this.storageGuard)for(const path of [this.directory,join(this.directory,'events'),join(this.directory,'blobs')]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error(moteText('截图存储目录不完整，请连接原磁盘后重试'));}
      await ensureStorageFormat(this.directory,['events','blobs','capture-ingress-v2.json','capture-stage-checkpoint.json','capture-stage-journal.json','capture-input-journal.json','sync-checkpoint.json']);
      for (const path of [this.directory, join(this.directory, 'events'), join(this.directory, 'blobs')]) {
        if (this.storageGuard) {
          const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(moteText("截图存储目录不完整，请连接原磁盘后重试"));
        } else await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
      }
      await this.replayStageJournal(false);
      const restored = new Map<string, QueueRecord>();
      const checked = new Map<string, number>();
      for (const name of await readdir(join(this.directory, 'events'))) {
        if (name.endsWith('.tmp')) { await unlink(join(this.directory, 'events', name)); continue; }
        if (!name.endsWith('.json')) continue;
        const record = validateRecord(JSON.parse(await readFile(join(this.directory, 'events', name), 'utf8')));
        if (name !== `${record.event.id}.json`) throw new Error(moteText("队列文件名与事件 ID 不匹配"));
        if (record.blobHash && !checked.has(record.blobHash)) {
          const data = await readFile(this.blobPath(record.blobHash));
          validateImage(data); if (await imageWork.run<string>({ kind: 'hash', bytes: data }) !== record.blobHash) throw new Error(moteText("队列图片校验和不正确"));
          if (data.length !== record.blobBytes) throw new Error(moteText("队列图片长度不匹配"));
          checked.set(record.blobHash, data.length);
        }
        if (record.blobHash && checked.get(record.blobHash) !== record.blobBytes) throw new Error(moteText("同一队列图片的长度元数据不一致"));
        this.sizeOf(record); restored.set(record.event.id, record);
      }
      this.records = restored;
      try { this.captureCheckpoint=JSON.parse(await readFile(this.stageCheckpointPath(),'utf8')) as CapturePipelineCheckpoint; }
      catch (error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
      await this.recoverInputJournal();
      // Input replay may have added a screen event after the first record pass.
      for(const record of this.records.values())if(record.blobHash&&!checked.has(record.blobHash)){
        const data=await readFile(this.blobPath(record.blobHash));validateImage(data,record.blobHash);
        if(data.length!==record.blobBytes)throw new Error(moteText('队列图片长度不匹配'));
        checked.set(record.blobHash,data.length);
      }
      for (const name of await readdir(join(this.directory, 'blobs'))) {
        if (name.endsWith('.tmp') || (name.endsWith('.jpg') && HASH.test(name.slice(0, -4)) && !checked.has(name.slice(0, -4)))) await unlink(join(this.directory, 'blobs', name));
      }
      const config = this.limits as QueueLimits & Partial<Config>;
      await this.binding.initialize({ serverUrl: config.serverUrl ?? '', token: config.token }, activeUsage(restored.values()).depth > 0);
      try { const checkpoint = JSON.parse(await readFile(join(this.directory, 'sync-checkpoint.json'), 'utf8')); this.lastUploadAt = checkpoint.lastUploadAt; this.sourceRetryAt = checkpoint.nextRetryAt; this.archiveAcknowledgment = checkpoint.archiveAcknowledgment; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.initialized = true;
    });
  }
  contains(id: string): boolean { return this.records.has(id); }
  recordsForBrowser(): QueueRecord[] { return structuredClone([...this.records.values()].filter(r => r.event.source === 'screen')); }
  async pageForBrowser(after: string, before: string, offset: number, limit: number, source: 'screen'|'ui_page' = 'screen'): Promise<{ records: QueueRecord[]; total: number }> {
    // Snapshot immutable references while uploads may continue, then send only IDs/times to the worker.
    const snapshot = new Map(this.records), records: { id: string; at: string }[] = [];
    let index = 0;
    for (const record of snapshot.values()) {
      if (++index % 256 === 0) await yieldTurn();
      if (record.event.source === source) records.push({ id: record.event.id, at: record.event.capturedAt });
    }
    const page = await previewWork.run<{ ids: string[]; total: number }>({ kind: 'browse', records, after, before, offset, limit });
    return { records: page.ids.map(id => structuredClone(snapshot.get(id)!)), total: page.total };
  }
  async sessionSamples(after: string, before: string): Promise<import('@mote/shared/capture-sessions').SessionSample[]> {
    const samples: import('@mote/shared/capture-sessions').SessionSample[] = [];
    const start = Date.parse(after), end = Date.parse(before); let count = 0;
    for (const record of [...this.records.values()]) {
      if (++count % 256 === 0) await yieldTurn();
      const event = record.event, at = Date.parse(event.capturedAt);
      if (event.source === 'screen' && at >= start && at < end) samples.push({id:event.id,deviceId:event.deviceId,appId:event.appId,appName:event.appName,capturedAt:event.capturedAt,hasImage:Boolean(record.blobHash)});
    }
    return samples;
  }
  recordForBrowser(id: string): QueueRecord | undefined { const record = this.records.get(id); return record && ['screen','ui_page'].includes(record.event.source) ? structuredClone(record) : undefined; }
  private sizeOf(record: QueueRecord): number {
    let bytes = this.recordSizes.get(record);
    if (bytes === undefined) { bytes = recordBytes(record); this.recordSizes.set(record, bytes); }
    return bytes;
  }
  async imageForBrowser(id: string): Promise<Buffer | undefined> {
    return this.exclusive(async () => {
      const record = this.records.get(id);
      if (!record?.blobHash) return undefined;
      const image = await readFile(this.blobPath(record.blobHash)); validateImage(image); if (await imageWork.run<string>({ kind: 'hash', bytes: image }) !== record.blobHash) throw new Error(moteText("队列图片校验和不正确")); return image;
    });
  }
  async blockSync(id: string, message: string): Promise<void> {
    await this.exclusive(async () => {
      const prior = this.records.get(id); if (!prior) return;
      const record = { ...prior, syncBlocked: true, syncError: message.slice(0, 300), nextAttemptAt: 0 };
      await atomicWrite(this.eventsPath(id), JSON.stringify(record)); this.cachedStats = undefined; this.records.set(id, record);
    });
  }
  setLimits(limits: QueueLimits): void { this.limits = limits; }
  stats(): QueueStats {
    if (this.cachedStats) return { ...this.cachedStats };
    const blobs = new Map<string, number>();
    let metadataBytes = 0;
    let nextRetry: number | undefined = this.sourceRetryAt ? Date.parse(this.sourceRetryAt) : undefined;
    let oldestPendingAt: string | undefined;
    for (const record of this.records.values()) {
      if (!oldestPendingAt || record.event.capturedAt < oldestPendingAt) oldestPendingAt = record.event.capturedAt;
      if (record.blobHash) blobs.set(record.blobHash, record.blobBytes);
      metadataBytes += this.sizeOf(record);
      if (!record.syncBlocked && record.nextAttemptAt > 0) nextRetry = Math.min(nextRetry ?? Infinity, record.nextAttemptAt);
    }
    const values = [...this.records.values()];
    const active=values;
    this.cachedStats = { ...(this.archiveAcknowledgment?{archiveAcknowledgment:{...this.archiveAcknowledgment}}:{}), depth: active.length, bytes: [...blobs.values()].reduce((a, b) => a + b, metadataBytes), nextRetryAt: nextRetry ? new Date(nextRetry).toISOString() : undefined, oldestPendingAt, lastUploadAt: this.lastUploadAt,
      eligibleDepth: active.filter(r => !r.syncBlocked).length,
      blocked: active.filter(r => r.syncBlocked).length };
    return { ...this.cachedStats };
  }
  async syncCheckpoint(lastUploadAt = this.lastUploadAt, nextRetryAt?: string, archiveAcknowledgment=this.archiveAcknowledgment): Promise<void> {
    await this.exclusive(async () => { await atomicWrite(join(this.directory, 'sync-checkpoint.json'), JSON.stringify({ lastUploadAt, nextRetryAt, archiveAcknowledgment })); this.lastUploadAt = lastUploadAt; this.sourceRetryAt = nextRetryAt; this.archiveAcknowledgment=archiveAcknowledgment; this.cachedStats=undefined; });
  }
  atCapacity(): boolean { const usage=activeUsage(this.records.values());return usage.depth>=this.limits.maxQueueEvents||usage.bytes>=this.limits.maxQueueBytes; }
  async enqueue(event: CaptureEvent, image?: Buffer, reviewHeld = false): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertReady();
      event = validateEvent(event);
      if (event.source === 'screen') { if (!image) throw new Error(moteText("截图缺少图像")); validateImage(image); }
      else if (image) throw new Error(moteText("随手记或仅活动记录不得包含图片"));
      const transactionId=randomUUID(),blobHash=image?imageHash(image):undefined;
      if(image&&blobHash)await atomicWrite(this.blobPath(blobHash),image);
      const journal:CaptureInputJournal={version:1,transactionId,event,blobHash,blobBytes:image?.length??0,reviewHeld};
      this.inputJournalPending=true;
      await atomicWrite(this.inputJournalPath(),JSON.stringify(journal));
      this.afterInputJournal?.();
      try {
        const changed=await this.consumeCaptureStages([{event,image,reviewHeld}],false,transactionId);
        await unlink(this.inputJournalPath());await syncDirectory(this.directory);this.inputJournalPending=false;
        return changed;
      } catch(error) {
        // A committed output journal is authoritative; leave both journals for replay.
        if(!this.stageJournalPending){
          await unlink(this.inputJournalPath()).catch(()=>{});await syncDirectory(this.directory);this.inputJournalPending=false;
          if(blobHash&&![...this.records.values()].some(record=>record.blobHash===blobHash))await unlink(this.blobPath(blobHash)).catch(()=>{});
        }
        throw error;
      }
    });
  }
  /** Explicitly release a stage's held input; a scheduler may call this at a time boundary. */
  async flushCaptureStages(): Promise<number> { return this.exclusive(async()=>{this.assertReady();return this.commitCaptureStages([],true);}); }
  private async consumeCaptureStages(inputs: CapturePacket[], flush: boolean, transactionId?: string): Promise<boolean> {
    return (await this.commitCaptureStages(inputs,flush,transactionId))>0;
  }
  private async commitCaptureStages(inputs: CapturePacket[], flush: boolean, transactionId?: string): Promise<number> {
    const checkpoint=this.captureCheckpoint?structuredClone(this.captureCheckpoint):undefined;
    // An ACK can remove the old series head before the next capture. Never revise an ACKed ID.
    const state=checkpoint?.stages?.['state-series'],head=(state?.value as {head?:CaptureEvent}|undefined)?.head;
    if(head&&state){const current=this.records.get(head.id);if(!current||current.syncBlocked||!isStateExtension(head,current.event)||!isStateExtension(current.event,head))state.value={};}
    const result=this.captureStages.consume(inputs,checkpoint,flush);
    const held=Object.values(result.checkpoint.stages).some(value=>value.held);
    if(held&&inputs.some(packet=>packet.image))throw new Error('Capture stages cannot hold image inputs; emit them in this batch');
    if(inputs.some(packet=>packet.reviewHeld)&&result.outputs.length===0)throw new Error('Review-held capture cannot be held by a stage');
    const priorFloor=this.captureCheckpoint?.heldPrivacy;
    const privacyFloor={activity:Boolean(priorFloor?.activity)||inputs.some(packet=>packet.event.privacy.collection==='activity'),redacted:Boolean(priorFloor?.redacted)||inputs.some(packet=>packet.event.privacy.redacted),reviewHeld:Boolean(priorFloor?.reviewHeld)||inputs.some(packet=>packet.reviewHeld)};
    result.checkpoint.heldPrivacy=held?privacyFloor:undefined;
    if(transactionId)result.checkpoint.lastInputTransaction=transactionId;
    const updates:QueueRecord[]=[];const images=new Map<string,Buffer>();const ids=new Set<string>();
    for(const packet of result.outputs){
      if(!packet||!packet.event||ids.has(packet.event.id))throw new Error('Duplicate capture stage output ID');
      ids.add(packet.event.id);
      const output=validateEvent(packet.event),outputImage=packet.image;
      if(privacyFloor.activity&&output.privacy.collection!=='activity'||privacyFloor.redacted&&!output.privacy.redacted)throw new Error('Capture stage weakened privacy');
      if(flush&&outputImage)throw new Error('Capture stages cannot flush image bytes from a metadata checkpoint');
      if(output.source==='screen'){if(!Buffer.isBuffer(outputImage))throw new Error(moteText('截图缺少图像'));validateImage(outputImage);}
      else if(outputImage!==undefined)throw new Error(moteText('随手记或仅活动记录不得包含图片'));
      const hash=outputImage?imageHash(outputImage):undefined,existing=this.records.get(output.id);
      if(existing){
        if(existing.blobHash===hash&&JSON.stringify(existing.event)===JSON.stringify(output))continue;
        if(existing.blobHash!==hash||!isStateExtension(existing.event,output))throw new Error(moteText('相同事件 ID 的内容发生变化'));
      }
      if(hash&&outputImage)images.set(hash,outputImage);
      updates.push({...(privacyFloor.reviewHeld||packet.reviewHeld?{syncBlocked:true,syncError:'upload_review_pending'}:{}),event:output,blobHash:hash,blobBytes:outputImage?.length??0,attempts:0,nextAttemptAt:0});
    }
    if(!updates.length&&JSON.stringify(result.checkpoint)===JSON.stringify(this.captureCheckpoint))return 0;
    const projected=new Map(this.records);for(const record of updates)projected.set(record.event.id,record);
    const usage=activeUsage(projected.values());
    if(usage.depth>this.limits.maxQueueEvents||usage.bytes>this.limits.maxQueueBytes)throw new QueueFullError();
    for(const [hash,bytes] of images)if(![...this.records.values()].some(record=>record.blobHash===hash))await atomicWrite(this.blobPath(hash),bytes);
    const journal:CaptureStageJournal={version:1,outputs:updates,checkpoint:result.checkpoint};
    this.stageJournalPending=true;await atomicWrite(this.stageJournalPath(),JSON.stringify(journal));
    this.afterStageJournal?.();
    await this.replayStageJournal(true);
    return updates.length;
  }
  private async insertRecord(record: QueueRecord, image?: Buffer): Promise<void> {
    const hasBlob = [...this.records.values()].some(r => r.blobHash === record.blobHash);
    const usage=activeUsage([...this.records.values(),record]);
    if (usage.depth>this.limits.maxQueueEvents||usage.bytes>this.limits.maxQueueBytes) throw new QueueFullError();
    if (image && record.blobHash && !hasBlob) await atomicWrite(this.blobPath(record.blobHash), image);
    await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
    this.cachedStats = undefined; this.records.set(record.event.id, record);
  }
  async next(now = Date.now(), preferSince?:number): Promise<{ record: QueueRecord; image?: Buffer } | undefined> {
    return (await this.nextBatch(1, now, preferSince))[0];
  }
  async nextBatch(limit = 25, now = Date.now(), preferSince?:number): Promise<{ record: QueueRecord; image?: Buffer }[]> {
    return this.exclusive(async () => {
      this.assertReady();
      const records = [...this.records.values()].filter(r => !r.syncBlocked && r.nextAttemptAt <= now).sort((a, b) => (preferSince===undefined?0:Number(Date.parse(b.event.capturedAt)>=preferSince)-Number(Date.parse(a.event.capturedAt)>=preferSince))||a.event.capturedAt.localeCompare(b.event.capturedAt));
      const result: { record: QueueRecord; image?: Buffer }[] = []; let bytes = 0;
      for (const record of records.slice(0, Math.min(25, limit))) {
        const image = record.blobHash ? await readFile(this.blobPath(record.blobHash)) : undefined;
        const size = Buffer.byteLength(JSON.stringify(record.event)) + (image ? Math.ceil(image.length / 3) * 4 : 0) + 64;
        if (result.length && bytes + size > 4 * 1024 * 1024) break;
        if (image) { validateImage(image); if (await imageWork.run<string>({ kind: 'hash', bytes: image }) !== record.blobHash) throw new Error(moteText("队列图片校验和不正确")); }
        result.push({ record: structuredClone(record), image }); bytes += size;
      }
      return result;
    });
  }
  async acknowledge(id: string, observations?: number, reviewOnly = false): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      const record = this.records.get(id);
      if (reviewOnly && (!record || record.syncError !== 'upload_review_pending')) throw Error('Review item is unavailable');
      if (!record) return;
      if(observations!==undefined&&(record.event.stateSeries?.samples.length??0)>observations)return;
      await unlink(this.eventsPath(id));
      // The event deletion must be durable before the last referenced blob is removed.
      await syncDirectory(join(this.directory, 'events'));
      this.records.delete(id); this.cachedStats = undefined;
      if (record.blobHash && ![...this.records.values()].some(r => r.blobHash === record.blobHash)) await unlink(this.blobPath(record.blobHash)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    });
  }
  async failed(id: string, now = Date.now(), random = Math.random): Promise<void> {
    return this.exclusive(async () => {
      const prior = this.records.get(id);
      if (!prior) return;
      const record = { ...prior, attempts: prior.attempts + 1, nextAttemptAt: now + retryDelay(prior.attempts + 1, random) };
      await atomicWrite(this.eventsPath(id), JSON.stringify(record));
      this.cachedStats = undefined; this.records.set(id, record);
    });
  }
  reviewPending() { return [...this.records.values()].filter(r=>r.syncError==='upload_review_pending').map(r=>({id:r.event.id,capturedAt:r.event.capturedAt,appName:r.event.appName})); }
  async rejectReview(id:string) {await this.acknowledge(id,undefined,true);}
  async approveReview(id:string) { return this.exclusive(async()=>{const prior=this.records.get(id);if(!prior||prior.syncError!=='upload_review_pending')throw Error('Review item is unavailable');const record={...prior,syncBlocked:false,syncError:undefined};await atomicWrite(this.eventsPath(id),JSON.stringify(record));this.records.set(id,record);this.cachedStats=undefined;}); }
  async resetRetries(): Promise<void> {
    await this.syncCheckpoint();
    return this.exclusive(async () => {
      for (const prior of this.records.values()) {
        if (prior.syncError === 'upload_review_pending') continue;
        const record = { ...prior, nextAttemptAt: 0, syncBlocked: false, syncError: undefined };
        await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
        this.cachedStats = undefined; this.records.set(record.event.id, record);
      }
    });
  }
  exportMetadata() { return {format:'mote-local-metadata',version:1,exportedAt:new Date().toISOString(),records:[...this.records.values()].map(r=>({...r.event,blobHash:r.blobHash,sizeBytes:r.blobBytes}))}; }
  async exportArchiveFile(path: string, progress?: (value: WorkProgress) => void): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      if(Object.values(this.captureCheckpoint?.stages??{}).some(stage=>stage.held))throw new Error('Flush held capture stage inputs before exporting the queue');
      if (this.stats().bytes > 256 * 1024 * 1024) throw new Error(moteText("队列超过 256 MiB，请退出采集器后备份整个 queue 文件夹"));
      await archiveWork.run({ kind: 'archive-export', directory: this.directory, path }, progress);
    });
  }
  async importArchiveFile(path: string, progress?: (value: WorkProgress) => void): Promise<number> {
    return this.exclusive(async () => {
      this.assertReady();
      const staging = await mkdtemp(join(tmpdir(), 'mote-queue-import-'));
      try {
        await chmod(staging, 0o700);
        await archiveWork.run({ kind: 'archive-prepare', path, staging }, progress);
        const names = await readdir(join(staging, 'events'));
        const unique: QueueRecord[] = [];
        for (const name of names) {
          const record = validateRecord(JSON.parse(await readFile(join(staging, 'events', name), 'utf8')));
          const existing = this.records.get(record.event.id);
          if (existing) {
            if (existing.blobHash !== record.blobHash || JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error(moteText("备份包含冲突的事件 ID"));
            continue;
          }
          unique.push(record);
        }
        const usage=activeUsage([...this.records.values(),...unique]);
        if(usage.depth>this.limits.maxQueueEvents||usage.bytes>this.limits.maxQueueBytes)throw new QueueFullError();
        // Validate the entire backup, conflicts and capacity before the first queue mutation.
        const writtenBlobs = new Set([...this.records.values()].map(r => r.blobHash));
        let completed = 0;
        for (const record of unique) {
          if (record.blobHash && !writtenBlobs.has(record.blobHash)) {
            await atomicWrite(this.blobPath(record.blobHash), await readFile(join(staging, 'blobs', record.blobHash + '.jpg')));
            writtenBlobs.add(record.blobHash);
          }
          await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
          this.records.set(record.event.id, record); this.cachedStats = undefined;
          progress?.({ message: moteText("正在保存导入记录"), completed: ++completed, total: unique.length });
        }
        return unique.length;
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
  async exportArchive(): Promise<QueueArchive> {
    return this.exclusive(async () => {
      this.assertReady();
      if (this.stats().bytes > 256 * 1024 * 1024) throw new Error(moteText("队列超过 256 MiB，请退出采集器后备份整个 queue 文件夹"));
      const blobs: Record<string, string> = {};
      for (const record of this.records.values()) if (record.blobHash && !blobs[record.blobHash]) blobs[record.blobHash] = (await readFile(this.blobPath(record.blobHash))).toString('base64');
      return { format: 'mote-desktop-queue', version: DESKTOP_STORAGE_VERSION, records: structuredClone([...this.records.values()]), blobs };
    });
  }
  async importArchive(input: unknown): Promise<number> {
    return this.exclusive(async () => {
      this.assertReady();
      const archive = input as QueueArchive;
      if (archive?.format !== 'mote-desktop-queue' || archive.version !== DESKTOP_STORAGE_VERSION || !Array.isArray(archive.records) || archive.records.length > 1000000 || !archive.blobs || typeof archive.blobs !== 'object') throw new Error(moteText("不是 Mote 电脑端队列备份"));
      const unique = new Map<string, QueueRecord>();
      const images = new Map<string, Buffer>();
      // Validate every record before the first write.
      for (const [index, item] of archive.records.entries()) {
        if (index % 100 === 0) await yieldTurn();
        const record = validateRecord(item);
        if (record.blobHash) {
        const encoded = archive.blobs[record.blobHash];
        if (typeof encoded !== 'string' || encoded.length > MAX_IMAGE_BYTES * 1.4) throw new Error(moteText("备份图片缺失或太大"));
        if (!images.has(record.blobHash)) { const data = Buffer.from(encoded, 'base64'); validateImage(data); if (await imageWork.run<string>({ kind: 'hash', bytes: data }) !== record.blobHash) throw new Error(moteText("队列图片校验和不正确")); images.set(record.blobHash, data); }
        if (images.get(record.blobHash)!.length !== record.blobBytes) throw new Error(moteText("备份图片长度不匹配"));
        }
        const existing = this.records.get(record.event.id) ?? unique.get(record.event.id);
        if (existing && (existing.blobHash !== record.blobHash || JSON.stringify(existing.event) !== JSON.stringify(record.event))) throw new Error(moteText("备份包含冲突的事件 ID"));
        if (!existing) unique.set(record.event.id, { ...record, attempts: 0, nextAttemptAt: 0 });
      }
      const usage=activeUsage([...this.records.values(),...unique.values()]);
      if(usage.depth>this.limits.maxQueueEvents||usage.bytes>this.limits.maxQueueBytes)throw new QueueFullError();
      for (const record of unique.values()) await this.insertRecord(record, record.blobHash ? images.get(record.blobHash)! : undefined);
      return unique.size;
    });
  }
}
