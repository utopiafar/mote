import { join } from 'node:path';
import { VisionModelStore, QWEN_MODEL, REVIEW_SYSTEM, REVIEW_GRAMMAR, parseVisionDecision, type VisionPaths, type VisionDecision } from '@mote/local-inference';
import type { Config, NsfwGate, NsfwStatus } from './contracts';
import { InferenceProcess, type InferenceChild } from './inference-process';
import { nativeInferenceChild } from './native-inference-child';
import { prepareVisionImage } from './vision-image';
type VisionFiles = Pick<VisionModelStore, 'inspect' | 'verifiedPaths' | 'download' | 'importFiles'>;
interface NativeVisionResult { text: string; status: string; backend: string; durationMs: number; loadMs: number; visionMs: number; tokens: number }

export class NsfwController implements NsfwGate {
  private readonly modelStore: VisionFiles;
  private readonly worker: InferenceProcess;
  private downloadAbort?: AbortController;
  private downloadTask?: Promise<void>;
  private verifiedPaths?: VisionPaths;
  private closed = false;
  private value: NsfwStatus = {
    modelState: 'missing', modelId: QWEN_MODEL.id, modelRevision: QWEN_MODEL.revision,
    bytes: 0, totalBytes: QWEN_MODEL.totalBytes, downloading: false, inferenceState: 'stopped', blockedCount: 0,
  };
  constructor(directory: string, executable: string, private readonly onChange: () => void, options: { store?: VisionFiles; spawn?: () => InferenceChild } = {}) {
    this.modelStore = options.store ?? new VisionModelStore(join(directory, 'qwen'));
    this.worker = new InferenceProcess(options.spawn ?? (() => nativeInferenceChild(executable)), (state, error) => {
      this.value.inferenceState = state;
      if (state === 'error' || state === 'stopped') this.verifiedPaths = undefined;
      if (error) this.value.error = error;
      this.publish();
    });
  }
  status(): NsfwStatus { return { ...this.value }; }
  private publish(): void { if (!this.closed) this.onChange(); }
  async initialize(): Promise<void> { await this.inspect(); }
  private async inspect(): Promise<void> {
    const result = await this.modelStore.inspect();
    this.value.modelState = result.state; this.value.bytes = result.bytes; this.value.totalBytes = result.totalBytes;
    this.publish();
  }
  async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('本地模型客户端已关闭');
    if (this.value.downloading) throw new Error('本地千问视觉模型正在下载或校验，请完成后再开始采集');
    if (this.verifiedPaths) return;
    this.value.modelState = 'verifying'; this.publish();
    try {
      this.verifiedPaths = await this.modelStore.verifiedPaths();
      this.value.modelState = 'ready'; this.value.bytes = this.value.totalBytes; this.value.error = undefined;
    } catch {
      await this.inspect();
      this.value.error = '本地千问视觉模型缺失或校验失败；请先下载、续传或导入模型';
      throw new Error(this.value.error);
    } finally { this.publish(); }
  }
  async classify(image: { bitmap: Buffer; width: number; height: number }, config: Config, signal?: AbortSignal): Promise<{ allow: boolean; blocked: boolean }> {
    if (signal?.aborted) throw new Error('本地视觉推理已取消');
    await this.ensureReady();
    const started = Date.now();
    const result = await this.worker.request<NativeVisionResult>({ ...this.verifiedPaths, threads: config.nsfwThreads,
      system: REVIEW_SYSTEM, grammar: REVIEW_GRAMMAR,
      prompt: config.reviewPolicy, maxTokens: config.reviewMaxTokens,
      ...prepareVisionImage(image.bitmap, image.width, image.height, config.reviewMaxSide),
    }, config.nsfwTimeoutMs, signal);
    let decision: VisionDecision;
    try {
      if (!result || result.status !== 'eos' || result.backend !== 'cpu' || !Number.isFinite(result.durationMs) || result.durationMs < 0) throw new Error('无效结果');
      decision = parseVisionDecision(result.text);
    } catch {
      this.reset(); this.value.error = '千问未返回完整有效的审查 JSON，本次截图已跳过'; this.publish(); throw new Error(this.value.error);
    }
    this.value.lastAllowed = decision.allow; this.value.lastDurationMs = Date.now() - started;
    this.value.lastLoadMs = Number.isFinite(result.loadMs) ? result.loadMs : undefined;
    this.value.lastVisionMs = Number.isFinite(result.visionMs) ? result.visionMs : undefined;
    this.value.lastTokens = Number.isFinite(result.tokens) ? result.tokens : undefined;
    this.value.error = undefined;
    if (!decision.allow) this.value.blockedCount++;
    // Deliberately omit model reason/labels from UI telemetry and captures: they can contain private content.
    this.publish();
    return { allow: decision.allow, blocked: !decision.allow };
  }
  startDownload(config: Config): void {
    if (this.closed || this.downloadTask || this.value.downloading) throw new Error('模型下载正在进行或客户端已关闭');
    this.reset();
    const abort = this.downloadAbort = new AbortController();
    this.value.downloading = true; this.value.error = undefined; this.publish();
    let lastUpdate = 0;
    this.downloadTask = this.modelStore.download({
      source: config.nsfwSource, customUrl: config.nsfwCustomUrl || undefined, signal: abort.signal,
      onProgress: progress => {
        this.value.bytes = progress.bytes; this.value.totalBytes = progress.totalBytes;
        this.value.downloadSource = progress.source; this.value.modelState = 'partial';
        if (Date.now() - lastUpdate >= 150 || progress.bytes === progress.totalBytes) { lastUpdate = Date.now(); this.publish(); }
      },
    }).then(async () => { this.value.error = undefined; await this.inspect(); }).catch(async () => {
      this.value.error = abort.signal.aborted ? '下载已取消，断点已保留；点击下载可继续' : '模型下载或校验失败，已保留可续传部分；请重试、更换来源或导入';
      await this.inspect().catch(() => undefined);
    }).finally(() => { this.value.downloading = false; this.downloadTask = undefined; this.publish(); });
  }
  async cancelDownload(): Promise<void> { this.downloadAbort?.abort(); await this.downloadTask; }
  async importFiles(paths: string[]): Promise<void> {
    if (this.downloadTask || this.closed || this.value.downloading) throw new Error('请先取消模型下载或等待导入完成');
    this.reset(); this.value.downloading = true; this.value.modelState = 'verifying'; this.value.error = undefined; this.publish();
    try { await this.modelStore.importFiles(paths); await this.inspect(); }
    catch { await this.inspect(); this.value.error = '导入模型与固定版本大小或 SHA-256 不一致；原模型未被替换'; throw new Error(this.value.error); }
    finally { this.value.downloading = false; this.publish(); }
  }
  async reload(): Promise<void> { if (this.value.downloading) throw new Error('模型操作进行中，请稍后重载'); this.reset(); await this.ensureReady(); }
  reset(): void { this.verifiedPaths = undefined; this.worker.reset(); }
  close(): void { this.closed = true; this.downloadAbort?.abort(); this.worker.close(); }
}
