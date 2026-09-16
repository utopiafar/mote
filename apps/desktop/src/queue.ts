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
  /** Original event stays immutable across POST retries; deferred OCR uses its own update. */
  uploaded?: boolean;
  ocrResult?: string;
  ocrRetryAt?: number;
  syncBlocked?: boolean;
  syncError?: string;
}
export interface QueueLimits { maxQueueBytes: number; maxQueueEvents: number }
export interface QueueStats { depth: number; bytes: number; nextRetryAt?: string; oldestPendingAt?: string; lastUploadAt?: string; eligibleDepth: number; waitingOcr: number; blocked: number }
export interface QueueArchive {
  format: 'mote-desktop-queue';
  version: 1;
  records: QueueRecord[];
  blobs: Record<string, string>;
}
export class QueueFullError extends Error {
  constructor() { super('本地队列已达上限，采集已停止；上传后请手动重新开始'); }
}

export function imageHash(image: Buffer): string { return createHash('sha256').update(image).digest('hex'); }
export function retryDelay(attempts: number, random = Math.random): number {
  return Math.round(Math.min(15 * 60_000, 2000 * 2 ** Math.min(attempts - 1, 10)) * (0.8 + random() * 0.4));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
// A 100,000-character OCR result can expand to six bytes per JSON-escaped character.
// Reserve before accepting a pending image, so a full queue can still persist OCR and release it.
export const OCR_RESULT_RESERVE_BYTES = 600128;
// Reserve envelope/escape overhead even for mixed-mode files so a later OCR rewrite
// cannot exceed the quota merely because the user enabled content encryption.
const CONTENT_FILE_ALLOWANCE = 64;
function recordBytes(record: QueueRecord): number {
  return Buffer.byteLength(JSON.stringify(record)) + CONTENT_FILE_ALLOWANCE + (record.event.ocr?.status === 'pending' && record.ocrResult === undefined ? OCR_RESULT_RESERVE_BYTES : 0);
}

function validateEvent(value: unknown): CaptureEvent {
  if (!value || typeof value !== 'object') throw new Error('队列事件无效');
  const v = value as CaptureEvent;
  if (!UUID.test(v.id) || !UUID.test(v.deviceId) || !['macos', 'windows', 'linux'].includes(v.platform) || !Number.isFinite(Date.parse(v.capturedAt)) || !Number.isInteger(v.durationMs) || v.durationMs < 0 || v.durationMs > 300000 || !['screen', 'note', 'activity'].includes(v.source)) throw new Error('队列事件元数据无效');
  for (const [key, max] of [['deviceName', 128], ['appId', 256], ['appName', 200]] as const) {
    if (typeof v[key] !== 'string' || !v[key] || v[key].length > max) throw new Error('队列事件应用或设备信息无效');
  }
  if (v.ocrText !== undefined && (typeof v.ocrText !== 'string' || v.ocrText.length > 100000)) throw new Error('OCR 文本超出限制');
  if (v.privacy?.excluded !== false || typeof v.privacy?.redacted !== 'boolean') throw new Error('队列隐私标记无效');
  const metadata = v.metadata === undefined ? undefined : recordMetadataSchema.parse(v.metadata);
  const base = { id: v.id, deviceId: v.deviceId, deviceName: v.deviceName, platform: v.platform,
    capturedAt: new Date(v.capturedAt).toISOString(), durationMs: v.durationMs, appId: v.appId, appName: v.appName, ...(metadata ? { metadata } : {}) };
  if (v.source === 'activity') {
    const raw = v as unknown as Record<string, unknown>;
    if (v.privacy.collection !== 'activity' || v.privacy.mode !== 'none' || v.privacy.redacted || ['ocrText', 'imageMime', 'imageBase64', 'mood', 'title', 'windowTitle', 'provenance'].some(key => Object.hasOwn(raw, key)) || (metadata?.capture && Object.keys(metadata.capture).some(key => key !== 'intervalMs'))) throw new Error('仅活动记录不得包含屏幕或正文内容');
    return { ...base, source: 'activity', privacy: { excluded: false, redacted: false, mode: 'none', collection: 'activity' } };
  }
  if (v.privacy.collection !== undefined && v.privacy.collection !== 'content') throw new Error('内容记录的采集级别无效');
  if (v.source === 'note') {
    if (v.durationMs !== 0 || v.imageMime !== undefined || typeof v.ocrText !== 'string' || !v.ocrText.trim() || v.ocrText.length > 20000 || v.privacy.mode !== 'none' || v.privacy.redacted !== false || (v.mood !== undefined && (typeof v.mood !== 'string' || !v.mood.trim() || v.mood.length > 80))) throw new Error('随手记格式无效');
    return { ...base, ocrText: v.ocrText, source: 'note', mood: v.mood, privacy: { excluded: false, redacted: false, mode: 'none' } };
  }
  if (v.imageMime !== 'image/jpeg' || v.privacy.mode !== 'local' || typeof v.privacy.reason !== 'string' || v.privacy.reason.length > 500) throw new Error('截图隐私标记无效');
  if (v.ocr !== undefined && (!['pending', 'completed', 'disabled', 'failed'].includes(v.ocr.status) || (v.ocr.reason !== undefined && v.ocr.reason !== 'charging') || (v.ocr.updatedAt !== undefined && !Number.isFinite(Date.parse(v.ocr.updatedAt))))) throw new Error('OCR 状态无效');
  const ocr = v.ocr ? { status: v.ocr.status, ...(v.ocr.reason ? { reason: v.ocr.reason } : {}), ...(v.ocr.updatedAt ? { updatedAt: v.ocr.updatedAt } : {}) } : undefined;
  return { ...base, ocrText: v.ocrText, ...(ocr ? { ocr } : {}), source: 'screen', imageMime: 'image/jpeg', privacy: { excluded: false, redacted: v.privacy.redacted, mode: 'local', ...(v.privacy.collection ? { collection: v.privacy.collection } : {}), reason: v.privacy.reason } };
}
export function validateRecord(value: unknown): QueueRecord {
  const v = value as QueueRecord;
  const event = validateEvent(v?.event);
  if ((event.source === 'screen' ? (!v.blobHash || !HASH.test(v.blobHash) || !Number.isInteger(v.blobBytes) || v.blobBytes < 4 || v.blobBytes > MAX_IMAGE_BYTES) : (v.blobHash !== undefined || v.blobBytes !== 0)) || !Number.isInteger(v.attempts) || v.attempts < 0 || !Number.isFinite(v.nextAttemptAt) || v.nextAttemptAt < 0) throw new Error('队列记录无效');
  if ((v.uploaded !== undefined && typeof v.uploaded !== 'boolean') || (v.ocrResult !== undefined && (typeof v.ocrResult !== 'string' || v.ocrResult.length > 100000)) || (v.ocrRetryAt !== undefined && (!Number.isFinite(v.ocrRetryAt) || v.ocrRetryAt < 0)) || ((v.uploaded || v.ocrResult !== undefined) && event.ocr?.status !== 'pending')) throw new Error('OCR 补做队列状态无效');
  if ((v.syncBlocked !== undefined && typeof v.syncBlocked !== 'boolean') || (v.syncError !== undefined && (typeof v.syncError !== 'string' || v.syncError.length > 300))) throw new Error('同步失败状态无效');
  return { event, blobHash: v.blobHash, blobBytes: v.blobBytes, attempts: v.attempts, nextAttemptAt: v.nextAttemptAt, ...(v.uploaded ? { uploaded: true } : {}), ...(v.ocrResult !== undefined ? { ocrResult: v.ocrResult } : {}), ...(v.ocrRetryAt ? { ocrRetryAt: v.ocrRetryAt } : {}), ...(v.syncBlocked ? { syncBlocked: true, syncError: v.syncError } : {}) };
}
export function validateImage(image: Buffer, hash?: string): void {
  if (image.length < 4 || image.length > MAX_IMAGE_BYTES || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9 || (hash && imageHash(image) !== hash)) throw new Error('队列图片格式、大小或校验和不正确');
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
  private sourceRetryAt?: string;
  constructor(directory: string, private limits: QueueLimits) { this.storageDirectory = directory; this.storageBinding = new ConnectionBindingStore(join(directory, 'connection-binding.json'), async (path, value) => { await this.storageGuard?.(); await atomicWrite(path, JSON.stringify(value)); }); }
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
        await binding.initialize({ serverUrl: config.serverUrl ?? '', token: config.token }, this.records.size > 0);
        await commitConfig();
        // No fallible operation after the durable pointer commit and before activation.
        this.storageDirectory = target; this.storageBinding = binding;
      }, selectedDirectory, progress);
    });
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => { await this.storageGuard?.(); try { return await fn(); } finally { this.cachedStats = undefined; } });
    this.chain = result.catch(() => undefined);
    return result;
  }
  withContentMaintenance<T>(work: () => Promise<T>): Promise<T> { return this.exclusive(work); }
  private eventsPath(id: string): string { return join(this.directory, 'events', `${id}.json`); }
  private blobPath(hash: string): string { return join(this.directory, 'blobs', `${hash}.jpg`); }
  private assertReady(): void { if (!this.initialized) throw new Error('持久队列尚未初始化'); }
  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      for (const path of [this.directory, join(this.directory, 'events'), join(this.directory, 'blobs')]) {
        if (this.storageGuard) {
          const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('截图存储目录不完整，请连接原磁盘后重试');
        } else await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
      }
      const restored = new Map<string, QueueRecord>();
      const checked = new Map<string, number>();
      for (const name of await readdir(join(this.directory, 'events'))) {
        if (name.endsWith('.tmp')) { await unlink(join(this.directory, 'events', name)); continue; }
        if (!name.endsWith('.json')) continue;
        const record = validateRecord(JSON.parse(await readFile(join(this.directory, 'events', name), 'utf8')));
        if (name !== `${record.event.id}.json`) throw new Error('队列文件名与事件 ID 不匹配');
        if (record.blobHash && !checked.has(record.blobHash)) {
          const data = await readFile(this.blobPath(record.blobHash));
          validateImage(data); if (await imageWork.run<string>({ kind: 'hash', bytes: data }) !== record.blobHash) throw new Error('队列图片校验和不正确');
          if (data.length !== record.blobBytes) throw new Error('队列图片长度不匹配');
          checked.set(record.blobHash, data.length);
        }
        if (record.blobHash && checked.get(record.blobHash) !== record.blobBytes) throw new Error('同一队列图片的长度元数据不一致');
        this.sizeOf(record); restored.set(record.event.id, record);
      }
      this.records = restored;
      for (const name of await readdir(join(this.directory, 'blobs'))) {
        if (name.endsWith('.tmp') || (name.endsWith('.jpg') && HASH.test(name.slice(0, -4)) && !checked.has(name.slice(0, -4)))) await unlink(join(this.directory, 'blobs', name));
      }
      const config = this.limits as QueueLimits & Partial<Config>;
      await this.binding.initialize({ serverUrl: config.serverUrl ?? '', token: config.token }, restored.size > 0);
      try { const checkpoint = JSON.parse(await readFile(join(this.directory, 'sync-checkpoint.json'), 'utf8')); this.lastUploadAt = checkpoint.lastUploadAt; this.sourceRetryAt = checkpoint.nextRetryAt; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.initialized = true;
    });
  }
  contains(id: string): boolean { return this.records.has(id); }
  recordsForBrowser(): QueueRecord[] { return structuredClone([...this.records.values()].filter(r => r.event.source === 'screen')); }
  async pageForBrowser(after: string, before: string, offset: number, limit: number): Promise<{ records: QueueRecord[]; total: number }> {
    // Snapshot immutable references while uploads may continue, then send only IDs/times to the worker.
    const snapshot = new Map(this.records), records: { id: string; at: string }[] = [];
    let index = 0;
    for (const record of snapshot.values()) {
      if (++index % 256 === 0) await yieldTurn();
      if (record.event.source === 'screen') records.push({ id: record.event.id, at: record.event.capturedAt });
    }
    const page = await previewWork.run<{ ids: string[]; total: number }>({ kind: 'browse', records, after, before, offset, limit });
    return { records: page.ids.map(id => structuredClone(snapshot.get(id)!)), total: page.total };
  }
  recordForBrowser(id: string): QueueRecord | undefined { const record = this.records.get(id); return record?.event.source === 'screen' ? structuredClone(record) : undefined; }
  private sizeOf(record: QueueRecord): number {
    let bytes = this.recordSizes.get(record);
    if (bytes === undefined) { bytes = recordBytes(record); this.recordSizes.set(record, bytes); }
    return bytes;
  }
  async imageForBrowser(id: string): Promise<Buffer | undefined> {
    return this.exclusive(async () => {
      const record = this.records.get(id);
      if (!record?.blobHash) return undefined;
      const image = await readFile(this.blobPath(record.blobHash)); validateImage(image); if (await imageWork.run<string>({ kind: 'hash', bytes: image }) !== record.blobHash) throw new Error('队列图片校验和不正确'); return image;
    });
  }
  async nextOcr(now = Date.now()): Promise<{ record: QueueRecord; image: Buffer } | undefined> {
    return this.exclusive(async () => {
      const record = [...this.records.values()].find(r => !r.syncBlocked && r.event.ocr?.status === 'pending' && r.ocrResult === undefined && (r.ocrRetryAt ?? 0) <= now);
      if (!record?.blobHash) return undefined;
      const image = await readFile(this.blobPath(record.blobHash)); validateImage(image); if (await imageWork.run<string>({ kind: 'hash', bytes: image }) !== record.blobHash) throw new Error('队列图片校验和不正确');
      return { record: structuredClone(record), image };
    });
  }
  async saveOcr(id: string, text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > 100000) throw new Error('OCR 文本超出限制');
    await this.exclusive(async () => {
      const prior = this.records.get(id); if (!prior || prior.event.ocr?.status !== 'pending') return;
      const record = { ...prior, ocrResult: text, ocrRetryAt: 0, nextAttemptAt: 0 };
      // This consumes the record's pre-reserved budget, even if the user since lowered the limit.
      await atomicWrite(this.eventsPath(id), JSON.stringify(record)); this.cachedStats = undefined; this.records.set(id, record);
    });
  }
  async deferOcr(id: string): Promise<void> {
    await this.exclusive(async () => {
      const prior = this.records.get(id); if (!prior) return;
      const record = { ...prior, ocrRetryAt: Date.now() + 60000 };
      await atomicWrite(this.eventsPath(id), JSON.stringify(record)); this.cachedStats = undefined; this.records.set(id, record);
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
      if (record.blobHash) blobs.set(record.blobHash, record.blobBytes + CONTENT_FILE_ALLOWANCE);
      metadataBytes += this.sizeOf(record);
      if (!record.syncBlocked && record.nextAttemptAt > 0) nextRetry = Math.min(nextRetry ?? Infinity, record.nextAttemptAt);
    }
    const values = [...this.records.values()];
    this.cachedStats = { depth: this.records.size, bytes: [...blobs.values()].reduce((a, b) => a + b, metadataBytes), nextRetryAt: nextRetry ? new Date(nextRetry).toISOString() : undefined, oldestPendingAt, lastUploadAt: this.lastUploadAt,
      eligibleDepth: values.filter(r => !r.syncBlocked && (!r.uploaded || r.ocrResult !== undefined)).length,
      waitingOcr: values.filter(r => r.uploaded && r.ocrResult === undefined).length, blocked: values.filter(r => r.syncBlocked).length };
    return { ...this.cachedStats };
  }
  async syncCheckpoint(lastUploadAt = this.lastUploadAt, nextRetryAt?: string): Promise<void> {
    await this.exclusive(async () => { await atomicWrite(join(this.directory, 'sync-checkpoint.json'), JSON.stringify({ lastUploadAt, nextRetryAt })); this.lastUploadAt = lastUploadAt; this.sourceRetryAt = nextRetryAt; });
  }
  atCapacity(): boolean { const stats = this.stats(); return stats.depth >= this.limits.maxQueueEvents || stats.bytes >= this.limits.maxQueueBytes; }
  async enqueue(event: CaptureEvent, image?: Buffer): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertReady();
      event = validateEvent(event);
      if (event.source === 'screen') { if (!image) throw new Error('截图缺少图像'); validateImage(image); }
      else if (image) throw new Error('随手记或仅活动记录不得包含图片');
      const hash = image ? await imageWork.run<string>({ kind: 'hash', bytes: image }) : undefined;
      const existing = this.records.get(event.id);
      if (existing) {
        if (existing.blobHash !== hash || JSON.stringify(existing.event) !== JSON.stringify(event)) throw new Error('相同事件 ID 的内容发生变化');
        return false;
      }
      const record: QueueRecord = { event, blobHash: hash, blobBytes: image?.length ?? 0, attempts: 0, nextAttemptAt: 0 };
      await this.insertRecord(record, image);
      return true;
    });
  }
  private async insertRecord(record: QueueRecord, image?: Buffer): Promise<void> {
    const hasBlob = [...this.records.values()].some(r => r.blobHash === record.blobHash);
    const size = this.stats();
    if (size.depth + 1 > this.limits.maxQueueEvents || size.bytes + (hasBlob || !image ? 0 : image.length + CONTENT_FILE_ALLOWANCE) + recordBytes(record) > this.limits.maxQueueBytes) throw new QueueFullError();
    if (image && record.blobHash && !hasBlob) await atomicWrite(this.blobPath(record.blobHash), image);
    await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
    this.cachedStats = undefined; this.records.set(record.event.id, record);
  }
  async next(now = Date.now()): Promise<{ record: QueueRecord; image?: Buffer } | undefined> {
    return this.exclusive(async () => {
      this.assertReady();
      const record = [...this.records.values()].filter(r => !r.syncBlocked && r.nextAttemptAt <= now && (!r.uploaded || r.ocrResult !== undefined)).sort((a, b) => a.event.capturedAt.localeCompare(b.event.capturedAt))[0];
      if (!record) return undefined;
      const image = record.blobHash ? await readFile(this.blobPath(record.blobHash)) : undefined;
      if (image) { validateImage(image); if (await imageWork.run<string>({ kind: 'hash', bytes: image }) !== record.blobHash) throw new Error('队列图片校验和不正确'); }
      return { record: structuredClone(record), image };
    });
  }
  async acknowledge(id: string, ocrComplete = false): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      const record = this.records.get(id);
      if (!record) return;
      if (record.event.ocr?.status === 'pending' && !ocrComplete) {
        const retained = { ...record, uploaded: true, attempts: 0, nextAttemptAt: 0 };
        await atomicWrite(this.eventsPath(id), JSON.stringify(retained)); this.cachedStats = undefined; this.records.set(id, retained); return;
      }
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
  async resetRetries(): Promise<void> {
    await this.syncCheckpoint();
    return this.exclusive(async () => {
      for (const prior of this.records.values()) {
        const record = { ...prior, nextAttemptAt: 0, syncBlocked: false, syncError: undefined };
        await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
        this.cachedStats = undefined; this.records.set(record.event.id, record);
      }
    });
  }
  async exportArchiveFile(path: string, progress?: (value: WorkProgress) => void): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      const reservation = [...this.records.values()].filter(r => r.event.ocr?.status === 'pending' && r.ocrResult === undefined).length * OCR_RESULT_RESERVE_BYTES;
      if (this.stats().bytes - reservation > 256 * 1024 * 1024) throw new Error('队列超过 256 MiB，请退出采集器后备份整个 queue 文件夹');
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
        const knownBlobs = new Set([...this.records.values()].map(r => r.blobHash));
        let extraBytes = 0;
        for (const name of names) {
          const record = validateRecord(JSON.parse(await readFile(join(staging, 'events', name), 'utf8')));
          const existing = this.records.get(record.event.id);
          if (existing) {
            if (existing.blobHash !== record.blobHash || JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error('备份包含冲突的事件 ID');
            continue;
          }
          unique.push(record); extraBytes += this.sizeOf(record);
          if (record.blobHash && !knownBlobs.has(record.blobHash)) { extraBytes += record.blobBytes + CONTENT_FILE_ALLOWANCE; knownBlobs.add(record.blobHash); }
        }
        const stats = this.stats();
        if (stats.depth + unique.length > this.limits.maxQueueEvents || stats.bytes + extraBytes > this.limits.maxQueueBytes) throw new QueueFullError();
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
          progress?.({ message: '正在保存导入记录', completed: ++completed, total: unique.length });
        }
        return unique.length;
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
  async exportArchive(): Promise<QueueArchive> {
    return this.exclusive(async () => {
      this.assertReady();
      const reservation = [...this.records.values()].filter(r => r.event.ocr?.status === 'pending' && r.ocrResult === undefined).length * OCR_RESULT_RESERVE_BYTES;
      if (this.stats().bytes - reservation > 256 * 1024 * 1024) throw new Error('队列超过 256 MiB，请退出采集器后备份整个 queue 文件夹');
      const blobs: Record<string, string> = {};
      for (const record of this.records.values()) if (record.blobHash && !blobs[record.blobHash]) blobs[record.blobHash] = (await readFile(this.blobPath(record.blobHash))).toString('base64');
      return { format: 'mote-desktop-queue', version: 1, records: structuredClone([...this.records.values()]), blobs };
    });
  }
  async importArchive(input: unknown): Promise<number> {
    return this.exclusive(async () => {
      this.assertReady();
      const archive = input as QueueArchive;
      if (archive?.format !== 'mote-desktop-queue' || archive.version !== 1 || !Array.isArray(archive.records) || archive.records.length > 1000000 || !archive.blobs || typeof archive.blobs !== 'object') throw new Error('不是 Mote 电脑端队列备份');
      const unique = new Map<string, QueueRecord>();
      const images = new Map<string, Buffer>();
      // Validate every record before the first write.
      for (const [index, item] of archive.records.entries()) {
        if (index % 100 === 0) await yieldTurn();
        const record = validateRecord(item);
        if (record.blobHash) {
        const encoded = archive.blobs[record.blobHash];
        if (typeof encoded !== 'string' || encoded.length > MAX_IMAGE_BYTES * 1.4) throw new Error('备份图片缺失或太大');
        if (!images.has(record.blobHash)) { const data = Buffer.from(encoded, 'base64'); validateImage(data); if (await imageWork.run<string>({ kind: 'hash', bytes: data }) !== record.blobHash) throw new Error('队列图片校验和不正确'); images.set(record.blobHash, data); }
        if (images.get(record.blobHash)!.length !== record.blobBytes) throw new Error('备份图片长度不匹配');
        }
        const existing = this.records.get(record.event.id) ?? unique.get(record.event.id);
        if (existing && (existing.blobHash !== record.blobHash || JSON.stringify(existing.event) !== JSON.stringify(record.event))) throw new Error('备份包含冲突的事件 ID');
        // A restored archive may target a new node: re-ACK the immutable original before OCR patching.
        if (!existing) unique.set(record.event.id, { ...record, uploaded: false, attempts: 0, nextAttemptAt: 0 });
      }
      const knownBlobs = new Set([...this.records.values()].map(r => r.blobHash));
      const stats = this.stats();
      let extraBytes = 0;
      for (const record of unique.values()) {
        extraBytes += recordBytes(record);
        if (record.blobHash && !knownBlobs.has(record.blobHash)) { extraBytes += record.blobBytes + CONTENT_FILE_ALLOWANCE; knownBlobs.add(record.blobHash); }
      }
      if (stats.depth + unique.size > this.limits.maxQueueEvents || stats.bytes + extraBytes > this.limits.maxQueueBytes) throw new QueueFullError();
      for (const record of unique.values()) await this.insertRecord(record, record.blobHash ? images.get(record.blobHash)! : undefined);
      return unique.size;
    });
  }
}
