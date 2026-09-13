import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, open, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CaptureEvent } from './contracts';
import { MAX_IMAGE_BYTES } from './config';

export interface QueueRecord {
  event: CaptureEvent;
  blobHash?: string;
  blobBytes: number;
  attempts: number;
  nextAttemptAt: number;
}
export interface QueueLimits { maxQueueBytes: number; maxQueueEvents: number }
export interface QueueStats { depth: number; bytes: number; nextRetryAt?: string }
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

function validateEvent(value: unknown): CaptureEvent {
  if (!value || typeof value !== 'object') throw new Error('队列事件无效');
  const v = value as CaptureEvent;
  if (!UUID.test(v.id) || !UUID.test(v.deviceId) || !['macos', 'windows', 'linux'].includes(v.platform) || !Number.isFinite(Date.parse(v.capturedAt)) || !Number.isInteger(v.durationMs) || v.durationMs < 0 || v.durationMs > 300000 || !['screen', 'note'].includes(v.source)) throw new Error('队列事件元数据无效');
  for (const [key, max] of [['deviceName', 128], ['appId', 256], ['appName', 200]] as const) {
    if (typeof v[key] !== 'string' || !v[key] || v[key].length > max) throw new Error('队列事件应用或设备信息无效');
  }
  if (v.ocrText !== undefined && (typeof v.ocrText !== 'string' || v.ocrText.length > 100000)) throw new Error('OCR 文本超出限制');
  if (v.privacy?.excluded !== false || typeof v.privacy?.redacted !== 'boolean') throw new Error('队列隐私标记无效');
  const base = { id: v.id, deviceId: v.deviceId, deviceName: v.deviceName, platform: v.platform,
    capturedAt: new Date(v.capturedAt).toISOString(), durationMs: v.durationMs, appId: v.appId, appName: v.appName, ocrText: v.ocrText };
  if (v.source === 'note') {
    if (v.durationMs !== 0 || v.imageMime !== undefined || typeof v.ocrText !== 'string' || !v.ocrText.trim() || v.ocrText.length > 20000 || v.privacy.mode !== 'none' || v.privacy.redacted !== false || (v.mood !== undefined && (typeof v.mood !== 'string' || !v.mood.trim() || v.mood.length > 80))) throw new Error('随手记格式无效');
    return { ...base, source: 'note', mood: v.mood, privacy: { excluded: false, redacted: false, mode: 'none' } };
  }
  if (v.imageMime !== 'image/jpeg' || v.privacy.mode !== 'local' || typeof v.privacy.reason !== 'string' || v.privacy.reason.length > 500) throw new Error('截图隐私标记无效');
  return { ...base, source: 'screen', imageMime: 'image/jpeg', privacy: { excluded: false, redacted: v.privacy.redacted, mode: 'local', reason: v.privacy.reason } };
}
function validateRecord(value: unknown): QueueRecord {
  const v = value as QueueRecord;
  const event = validateEvent(v?.event);
  if ((event.source === 'screen' ? (!v.blobHash || !HASH.test(v.blobHash) || !Number.isInteger(v.blobBytes) || v.blobBytes < 4 || v.blobBytes > MAX_IMAGE_BYTES) : (v.blobHash !== undefined || v.blobBytes !== 0)) || !Number.isInteger(v.attempts) || v.attempts < 0 || !Number.isFinite(v.nextAttemptAt) || v.nextAttemptAt < 0) throw new Error('队列记录无效');
  return { event, blobHash: v.blobHash, blobBytes: v.blobBytes, attempts: v.attempts, nextAttemptAt: v.nextAttemptAt };
}
function validateImage(image: Buffer, hash?: string): void {
  if (image.length < 4 || image.length > MAX_IMAGE_BYTES || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9 || (hash && imageHash(image) !== hash)) throw new Error('队列图片格式、大小或校验和不正确');
}
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
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
  private chain: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(readonly directory: string, private limits: QueueLimits) {}
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => undefined);
    return result;
  }
  private eventsPath(id: string): string { return join(this.directory, 'events', `${id}.json`); }
  private blobPath(hash: string): string { return join(this.directory, 'blobs', `${hash}.jpg`); }
  private assertReady(): void { if (!this.initialized) throw new Error('持久队列尚未初始化'); }
  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      for (const path of [this.directory, join(this.directory, 'events'), join(this.directory, 'blobs')]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
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
          validateImage(data, record.blobHash);
          if (data.length !== record.blobBytes) throw new Error('队列图片长度不匹配');
          checked.set(record.blobHash, data.length);
        }
        if (record.blobHash && checked.get(record.blobHash) !== record.blobBytes) throw new Error('同一队列图片的长度元数据不一致');
        restored.set(record.event.id, record);
      }
      this.records = restored;
      for (const name of await readdir(join(this.directory, 'blobs'))) {
        if (name.endsWith('.tmp') || (name.endsWith('.jpg') && HASH.test(name.slice(0, -4)) && !checked.has(name.slice(0, -4)))) await unlink(join(this.directory, 'blobs', name));
      }
      this.initialized = true;
    });
  }
  setLimits(limits: QueueLimits): void { this.limits = limits; }
  stats(): QueueStats {
    const blobs = new Map<string, number>();
    let metadataBytes = 0;
    let nextRetry: number | undefined;
    for (const record of this.records.values()) {
      if (record.blobHash) blobs.set(record.blobHash, record.blobBytes);
      metadataBytes += Buffer.byteLength(JSON.stringify(record));
      if (record.nextAttemptAt > 0) nextRetry = Math.min(nextRetry ?? Infinity, record.nextAttemptAt);
    }
    return { depth: this.records.size, bytes: [...blobs.values()].reduce((a, b) => a + b, metadataBytes), nextRetryAt: nextRetry ? new Date(nextRetry).toISOString() : undefined };
  }
  atCapacity(): boolean { const stats = this.stats(); return stats.depth >= this.limits.maxQueueEvents || stats.bytes >= this.limits.maxQueueBytes; }
  async enqueue(event: CaptureEvent, image?: Buffer): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertReady();
      event = validateEvent(event);
      if (event.source === 'screen') { if (!image) throw new Error('截图缺少图像'); validateImage(image); }
      else if (image) throw new Error('随手记不得包含图片');
      const hash = image ? imageHash(image) : undefined;
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
    if (size.depth + 1 > this.limits.maxQueueEvents || size.bytes + (hasBlob ? 0 : image?.length ?? 0) + Buffer.byteLength(JSON.stringify(record)) > this.limits.maxQueueBytes) throw new QueueFullError();
    if (image && record.blobHash && !hasBlob) await atomicWrite(this.blobPath(record.blobHash), image);
    await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
    this.records.set(record.event.id, record);
  }
  async next(now = Date.now()): Promise<{ record: QueueRecord; image?: Buffer } | undefined> {
    return this.exclusive(async () => {
      this.assertReady();
      const record = [...this.records.values()].filter(r => r.nextAttemptAt <= now).sort((a, b) => a.event.capturedAt.localeCompare(b.event.capturedAt))[0];
      if (!record) return undefined;
      const image = record.blobHash ? await readFile(this.blobPath(record.blobHash)) : undefined;
      if (image) validateImage(image, record.blobHash);
      return { record: structuredClone(record), image };
    });
  }
  async acknowledge(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.assertReady();
      const record = this.records.get(id);
      if (!record) return;
      await unlink(this.eventsPath(id));
      // The event deletion must be durable before the last referenced blob is removed.
      await syncDirectory(join(this.directory, 'events'));
      this.records.delete(id);
      if (record.blobHash && ![...this.records.values()].some(r => r.blobHash === record.blobHash)) await unlink(this.blobPath(record.blobHash)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    });
  }
  async failed(id: string, now = Date.now(), random = Math.random): Promise<void> {
    return this.exclusive(async () => {
      const prior = this.records.get(id);
      if (!prior) return;
      const record = { ...prior, attempts: prior.attempts + 1, nextAttemptAt: now + retryDelay(prior.attempts + 1, random) };
      await atomicWrite(this.eventsPath(id), JSON.stringify(record));
      this.records.set(id, record);
    });
  }
  async resetRetries(): Promise<void> {
    return this.exclusive(async () => {
      for (const prior of this.records.values()) {
        const record = { ...prior, nextAttemptAt: 0 };
        await atomicWrite(this.eventsPath(record.event.id), JSON.stringify(record));
        this.records.set(record.event.id, record);
      }
    });
  }
  async exportArchive(): Promise<QueueArchive> {
    return this.exclusive(async () => {
      this.assertReady();
      if (this.stats().bytes > 256 * 1024 * 1024) throw new Error('队列超过 256 MiB，请退出采集器后备份整个 queue 文件夹');
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
      for (const item of archive.records) {
        const record = validateRecord(item);
        if (record.blobHash) {
        const encoded = archive.blobs[record.blobHash];
        if (typeof encoded !== 'string' || encoded.length > MAX_IMAGE_BYTES * 1.4) throw new Error('备份图片缺失或太大');
        if (!images.has(record.blobHash)) { const data = Buffer.from(encoded, 'base64'); validateImage(data, record.blobHash); images.set(record.blobHash, data); }
        if (images.get(record.blobHash)!.length !== record.blobBytes) throw new Error('备份图片长度不匹配');
        }
        const existing = this.records.get(record.event.id) ?? unique.get(record.event.id);
        if (existing && (existing.blobHash !== record.blobHash || JSON.stringify(existing.event) !== JSON.stringify(record.event))) throw new Error('备份包含冲突的事件 ID');
        if (!existing) unique.set(record.event.id, { ...record, attempts: 0, nextAttemptAt: 0 });
      }
      const knownBlobs = new Set([...this.records.values()].map(r => r.blobHash));
      const stats = this.stats();
      let extraBytes = 0;
      for (const record of unique.values()) {
        extraBytes += Buffer.byteLength(JSON.stringify(record));
        if (!knownBlobs.has(record.blobHash)) { extraBytes += record.blobBytes; knownBlobs.add(record.blobHash); }
      }
      if (stats.depth + unique.size > this.limits.maxQueueEvents || stats.bytes + extraBytes > this.limits.maxQueueBytes) throw new QueueFullError();
      for (const record of unique.values()) await this.insertRecord(record, record.blobHash ? images.get(record.blobHash)! : undefined);
      return unique.size;
    });
  }
}
