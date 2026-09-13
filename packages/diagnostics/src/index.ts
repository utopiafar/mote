import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface DiagnosticsOptions { enabled: boolean; intervalMs: number; maxSamples?: number }
export interface DeviceSnapshot { queueBytes: number; modelBytes: number; batteryPercent?: number; charging?: boolean; onBattery?: boolean }
export interface CaptureMeasurement { outcome: 'saved' | 'blocked' | 'failed'; imageBytes?: number; inferenceMs?: number; ocrMs?: number; durationMs?: number }
export interface Counters { saved: number; blocked: number; failed: number; imageBytes: number; uploadedBytes: number; inferenceMs: number; ocrMs: number; captureMs: number }
export interface DiagnosticSample extends DeviceSnapshot {
  at: string; processId: number; rssBytes: number; cpuUserMicros: number; cpuSystemMicros: number;
  deviceBatteryDeltaPct?: number; queueDeltaBytes?: number; counters: Counters;
}
export interface DiagnosticsStatus { enabled: boolean; sampleCount: number; fileBytes: number; counters: Counters; latest?: DiagnosticSample; error?: string }
const initialCounters = (): Counters => ({ saved:0, blocked:0, failed:0, imageBytes:0, uploadedBytes:0, inferenceMs:0, ocrMs:0, captureMs:0 });
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function cleanCounters(value: unknown): Counters {
  const v = value && typeof value === 'object' ? value as Record<string,unknown> : {};
  return Object.fromEntries(Object.keys(initialCounters()).map(k => [k, nonnegative(v[k]) ? v[k] : 0])) as unknown as Counters;
}
function cleanDevice(value: unknown): DeviceSnapshot {
  if (!value || typeof value !== 'object') throw new Error('device metrics unavailable');
  const v = value as Record<string, unknown>;
  if (!nonnegative(v.queueBytes) || !nonnegative(v.modelBytes)) throw new Error('storage metrics unavailable');
  return {
    queueBytes: v.queueBytes, modelBytes: v.modelBytes,
    ...(nonnegative(v.batteryPercent) && v.batteryPercent <= 100 ? { batteryPercent: v.batteryPercent } : {}),
    ...(typeof v.charging === 'boolean' ? {charging:v.charging}:{}),
    ...(typeof v.onBattery === 'boolean' ? {onBattery:v.onBattery}:{}),
  };
}
function cleanSample(value: unknown): DiagnosticSample | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at) || !Number.isFinite(Date.parse(v.at)) || ![v.rssBytes,v.cpuUserMicros,v.cpuSystemMicros,v.processId].every(nonnegative)) return;
  try { return {
    ...cleanDevice(v), at:v.at, processId:v.processId as number, rssBytes:v.rssBytes as number, cpuUserMicros:v.cpuUserMicros as number, cpuSystemMicros:v.cpuSystemMicros as number,
    ...(typeof v.deviceBatteryDeltaPct === 'number' && Number.isFinite(v.deviceBatteryDeltaPct) && Math.abs(v.deviceBatteryDeltaPct) <= 100 ? { deviceBatteryDeltaPct:v.deviceBatteryDeltaPct }:{}),
    ...(typeof v.queueDeltaBytes === 'number' && Number.isSafeInteger(v.queueDeltaBytes) ? {queueDeltaBytes:v.queueDeltaBytes}:{}),
    counters:cleanCounters(v.counters),
  }; } catch { return; }
}

/** Local numeric diagnostics only. No arbitrary metadata field can reach the file or export. */
export class DiagnosticsRecorder {
  private options: Required<DiagnosticsOptions> = { enabled:false, intervalMs:60000, maxSamples:1440 };
  private samples: DiagnosticSample[] = [];
  private counters = initialCounters();
  private fileBytes = 0;
  private error?: string;
  private loaded = false;
  private timer?: NodeJS.Timeout;
  private sampler?: () => Promise<DeviceSnapshot>;
  private pending?: Promise<void>;
  private generation = 0;
  private closed = false;
  private readonly path: string;
  private readonly temporaryPath: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, 'diagnostics.json');
    // Reuse one owned name: even an unlink failure cannot create a new orphan each tick.
    this.temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
  }
  private async removeOrphanedWrites(): Promise<void> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes:true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const match = /^diagnostics\.json\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid)) continue;
      // A reused PID or an inaccessible live process is deliberately retained.
      try { process.kill(pid, 0); continue; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      try { await unlink(join(this.directory, entry.name)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  async configure(options: DiagnosticsOptions, sampler: () => Promise<DeviceSnapshot>): Promise<void> {
    if (this.closed) throw new Error('诊断器已关闭');
    if (typeof options.enabled !== 'boolean' || !Number.isInteger(options.intervalMs) || options.intervalMs < 15000 || options.intervalMs > 3600000 || (options.maxSamples !== undefined && (!Number.isInteger(options.maxSamples) || options.maxSamples < 1 || options.maxSamples > 1440))) throw new Error('诊断配置无效');
    if (this.timer) clearInterval(this.timer);
    this.generation++; await this.pending;
    if (this.closed) return;
    this.options = { ...options, maxSamples: options.maxSamples ?? 1440 }; this.sampler = sampler;
    if (!this.loaded) {
      this.loaded = true;
      try {
        await this.removeOrphanedWrites();
        if ((await stat(this.path)).size > 3 * 1024 * 1024) throw new Error('oversized diagnostics');
        const raw = await readFile(this.path, 'utf8');
        if (raw.length > 3 * 1024 * 1024) throw new Error('oversized diagnostics');
        const v = JSON.parse(raw);
        if (v.version !== 1 || !Array.isArray(v.samples)) throw new Error('invalid diagnostics');
        this.samples = v.samples.map(cleanSample).filter((s: unknown): s is DiagnosticSample => Boolean(s)).slice(-this.options.maxSamples);
        this.counters = cleanCounters(v.counters); this.fileBytes = Buffer.byteLength(raw);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.error = '旧诊断文件不可读，已重新开始数值记录'; }
    }
    this.samples = this.samples.slice(-this.options.maxSamples);
    if (this.options.enabled && !this.closed) {
      await this.sample();
      if (!this.closed) { this.timer = setInterval(() => void this.sample(), this.options.intervalMs); this.timer.unref(); }
    }
  }
  recordCapture(m: CaptureMeasurement): void {
    if (!this.options.enabled || this.closed) return;
    if (!['saved','blocked','failed'].includes(m.outcome)) throw new Error('采集测量类别无效');
    for (const key of ['imageBytes','inferenceMs','ocrMs','durationMs'] as const) if (m[key] !== undefined && !nonnegative(m[key])) throw new Error('采集测量数值无效');
    this.counters[m.outcome]++;
    this.counters.imageBytes += m.imageBytes ?? 0; this.counters.inferenceMs += m.inferenceMs ?? 0;
    this.counters.ocrMs += m.ocrMs ?? 0; this.counters.captureMs += m.durationMs ?? 0;
  }
  recordUpload(bytes: number): void { if (this.options.enabled && !this.closed) { if (!nonnegative(bytes)) throw new Error('上传字节无效'); this.counters.uploadedBytes += bytes; } }
  status(): DiagnosticsStatus {
    return { enabled:this.options.enabled, sampleCount:this.samples.length, fileBytes:this.fileBytes, counters:{...this.counters}, ...(this.samples.length ? {latest:structuredClone(this.samples.at(-1)!)}:{}), ...(this.error ? {error:this.error}:{}) };
  }
  sample(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.options.enabled || !this.sampler || this.closed) return Promise.resolve();
    const generation = this.generation;
    this.pending = this.takeSample(generation).finally(() => {this.pending = undefined;}); return this.pending;
  }
  private async takeSample(generation: number): Promise<void> {
    try {
      const device = cleanDevice(await this.sampler!());
      if (generation !== this.generation || this.closed) return;
      const cpu = process.cpuUsage(), previous = this.samples.at(-1);
      const sample: DiagnosticSample = { ...device, at:new Date().toISOString(), processId:process.pid, rssBytes:process.memoryUsage().rss, cpuUserMicros:cpu.user, cpuSystemMicros:cpu.system, counters:{...this.counters} };
      if (previous) {
        sample.queueDeltaBytes = device.queueBytes - previous.queueBytes;
        if (device.batteryPercent !== undefined && previous.batteryPercent !== undefined && device.onBattery === true && previous.onBattery === true && device.charging === false && previous.charging === false) sample.deviceBatteryDeltaPct = device.batteryPercent - previous.batteryPercent;
      }
      this.samples.push(sample); this.samples = this.samples.slice(-this.options.maxSamples); this.error = undefined;
      await mkdir(this.directory,{recursive:true,mode:0o700});
      const raw = this.serialize();
      const output = await open(this.temporaryPath, 'wx', 0o600);
      try {
        try { await output.writeFile(raw); await output.sync(); }
        finally { await output.close(); }
        await rename(this.temporaryPath, this.path); this.fileBytes = Buffer.byteLength(raw);
      } finally {
        try { await unlink(this.temporaryPath); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    } catch { this.error = '诊断采样或写入失败；采集本身继续按隐私策略执行'; }
  }
  private serialize(): string {
    return JSON.stringify({ version:1, scope:'local-numeric-diagnostics', batteryScope:'whole-device change, not application energy attribution', cpuScope:'collector main process cumulative CPU; inference runtime latency recorded separately', counters:cleanCounters(this.counters), samples:this.samples.map(cleanSample).filter(Boolean) },null,2);
  }
  async exportTo(path: string): Promise<void> { await this.pending; await writeFile(path,this.serialize(),{mode:0o600}); }
  async close(): Promise<void> { this.closed = true; this.options.enabled = false; this.generation++; if (this.timer) clearInterval(this.timer); await this.pending; }
}
