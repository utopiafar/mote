import type { DiagnosticsRecorder } from '@mote/diagnostics';
import { randomUUID } from 'node:crypto';
import { desktopCapturer, powerMonitor, screen, systemPreferences } from 'electron';
import type { Config, Status, Platform, CaptureEvent, NsfwGate } from './contracts';
import { decideSync } from './sync-policy';
import type { LocalSourceManager } from './source-manager';
import { MAX_IMAGE_BYTES, publicConfig } from './config';
import { DurableQueue, QueueFullError } from './queue';
import { activeApplication, foregroundApplication, recognizeText, readPowerState } from './native';
import { reviewLocally } from './privacy';
import { collectionForApp, permitsVisibleContent } from './app-collection';
import { collectRecordMetadata } from './record-metadata';
import { prepareScreenshot, maskScreenshot } from './capture-frame';
import { heartbeat, uploadCapture, uploadDeferredOcr, DeletedCaptureFailure } from './transport';
import { EventJournal, failureCode, TransportFailure, type EventStage } from './support';

export const currentPlatform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
export class Collector {
  private running = false;
  private locked = false;
  private sleeping = false;
  private capturing = false;
  private uploading = false;
  private heartbeatInFlight = false;
  private connectionHeld = false;
  private config: Config;
  private captureAbort?: AbortController;
  private uploadAbort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private uploadTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private ocrTimer?: ReturnType<typeof setInterval>;
  private ocrBusy = false;
  private ocrAbort?: AbortController;
  private captureOcrAbort?: AbortController;
  private closed = false;
  private stopIntent = 0;
  private lastSample?: { at: number; appId: string; collection: 'content' | 'activity' };
  private state: Status['state'] = 'stopped';
  private message = '尚未开始采集。请确认隐私设置后手动开始。';
  private lastCaptureAt?: string;
  private lastUploadAt?: string;
  private lastUploadError?: string;
  constructor(config: Config, private readonly queue: DurableQueue, private readonly helperPath: string, private readonly tokenStorageAvailable: () => boolean, private readonly onChange: (status: Status) => void, private readonly nsfw?: NsfwGate, private readonly diagnostics?: DiagnosticsRecorder, private readonly events?: EventJournal, private readonly sources?: LocalSourceManager) {
    this.config = config; this.lastUploadAt = this.queue.stats().lastUploadAt;
    powerMonitor.on('lock-screen', () => { this.locked = true; this.pause('屏幕已锁定，暂停采集'); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.lastSample = undefined; });
    powerMonitor.on('suspend', () => { this.sleeping = true; this.pause('电脑休眠，暂停采集'); });
    powerMonitor.on('resume', () => { this.sleeping = false; this.lastSample = undefined; });
    powerMonitor.on('on-ac', () => { void this.processPendingOcr(); });
    powerMonitor.on('on-battery', () => { if (this.config.ocrOnlyWhileCharging) { this.ocrAbort?.abort(); this.captureOcrAbort?.abort(); } });
  }
  initialize(): void {
    this.uploadTimer = setInterval(() => void this.upload(), 2000);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 30000);
    this.ocrTimer = setInterval(() => void this.processPendingOcr(), 10000);
    void this.processPendingOcr();
    void this.upload();
  }
  status(): Status {
    const queue = this.queue.stats();
    return {
      running: this.running, state: this.state, message: this.message, sync: this.syncStatus(),
      queueDepth: queue.depth, queueBytes: queue.bytes, nextRetryAt: queue.nextRetryAt,
      lastCaptureAt: this.lastCaptureAt, lastUploadAt: this.lastUploadAt, lastUploadError: this.lastUploadError,
      screenPermission: currentPlatform === 'macos' ? systemPreferences.getMediaAccessStatus('screen') : 'unsupported',
      platform: currentPlatform, encryptedTokenStorage: this.tokenStorageAvailable(), config: publicConfig(this.config), nsfw: this.nsfw?.status(), diagnostics: this.diagnostics?.status(),
    };
  }
  private pendingSync() {
    const queue = this.queue.stats(), sources = this.sources?.pendingStats();
    const oldestPendingAt = [queue.oldestPendingAt, (sources?.eligibleRecords === undefined ? sources?.oldestPendingAt : sources.oldestEligibleAt), sources?.oldestUpdateAt].filter((date): date is string => Boolean(date)).sort()[0];
    return { pendingRecords: queue.depth + (sources?.pendingRecords ?? 0), eligibleRecords: queue.eligibleDepth + (sources?.eligibleRecords ?? sources?.pendingRecords ?? 0), heldRecords: queue.depth - queue.eligibleDepth + (sources?.heldRecords ?? 0), heldUpdates: sources?.heldUpdates ?? 0, heldReason: queue.blocked ? '部分记录需要处理：中央记录已删除或节点需升级；请在采集记录中查看，处理后手动重试' : queue.waitingOcr ? '图片已同步；本机保留图片，等待 OCR 完成后同步文字' : sources?.heldReason, pendingUpdates: sources?.eligibleUpdates ?? sources?.pendingUpdates ?? 0, oldestPendingAt, lastUploadAt: this.lastUploadAt ?? queue.lastUploadAt, nextRetryAt: queue.nextRetryAt };
  }
  private syncStatus(): Status['sync'] {
    const pending = this.pendingSync();
    const { ready: _, ...policy } = decideSync(this.config, { ...pending, pendingRecords: pending.eligibleRecords });
    const decision = { ...policy, pendingRecords: pending.pendingRecords };
    const localBacklogUnbound = decision.pendingRecords > 0 && this.queue.binding.unbound() && (!this.sources || this.sources.nodeBinding.unbound());
    if (decision.state !== 'unconfigured' && !pending.eligibleRecords && !pending.pendingUpdates && (pending.heldRecords || pending.heldUpdates)) return { ...decision, state: 'waiting', message: pending.heldReason ?? '来源待传版本等待恢复', localBacklogUnbound };
    if (this.uploading) return { ...decision, state: 'uploading', message: '正在同步本地记录', localBacklogUnbound };
    if (decision.state !== 'unconfigured' && this.lastUploadError) return { ...decision, state: 'error', message: this.lastUploadError, localBacklogUnbound };
    return { ...decision, localBacklogUnbound };
  }
  private publish(): void { this.onChange(this.status()); }
  private pause(message: string): void {
    this.lastSample = undefined;
    this.captureAbort?.abort();
    if (this.running) { this.state = 'paused'; this.message = message; this.publish(); }
  }
  connectionActivity(): { inFlight: boolean } { return { inFlight: this.capturing || this.uploading || this.heartbeatInFlight || this.ocrBusy }; }
  async holdConnection(): Promise<() => void> {
    if (this.running || this.connectionHeld) throw new Error('请先停止采集，再更换连接');
    this.connectionHeld = true;
    this.captureAbort?.abort(); this.uploadAbort?.abort(); this.ocrAbort?.abort();
    // Heartbeats already have a bounded timeout. Wait until no old-credential request can race a save.
    while (this.connectionActivity().inFlight) await new Promise(resolve => setTimeout(resolve, 25));
    return () => { this.connectionHeld = false; };
  }
  /** Freeze every producer/consumer before applying settings; preserve the user's running intent. */
  async suspendForSettings(): Promise<() => Promise<void>> {
    if (this.connectionHeld || this.closed) throw new Error('设置正在应用或应用正在退出，请稍后重试');
    const resume = this.running, intent = this.stopIntent;
    this.connectionHeld = true; this.running = false; this.lastSample = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.captureAbort?.abort(); this.captureOcrAbort?.abort(); this.uploadAbort?.abort(); this.ocrAbort?.abort();
    this.state = 'paused'; this.message = '正在安全应用设置，已有记录保留'; this.publish();
    while (this.connectionActivity().inFlight) await new Promise(resolve => setTimeout(resolve, 25));
    let released = false;
    return async () => {
      if (released) return; released = true; this.connectionHeld = false;
      if (this.closed) return;
      if (resume && intent === this.stopIntent) {
        try { await this.start(); }
        catch (error) { this.state = 'error'; this.message = `设置已应用，采集暂未恢复：${error instanceof Error ? error.message : '请检查采集条件'}`; this.publish(); }
      } else { this.state = 'stopped'; this.message = '设置已应用；采集保持停止'; this.publish(); }
      void this.upload(); void this.processPendingOcr();
    };
  }
  updateConfig(config: Config): void {
    // Config edits cannot change a privacy policy in the middle of capture.
    if (this.running || this.capturing) throw new Error('请先停止采集，再修改配置');
    this.uploadAbort?.abort();
    this.ocrAbort?.abort();
    this.nsfw?.reset();
    this.config = config;
    this.queue.setLimits(config);
    this.publish();
  }
  async start(): Promise<void> {
    if (this.closed || this.connectionHeld) throw new Error('正在应用设置或退出，请稍后重试');
    if (this.running) return;
    if (this.capturing) throw new Error('正在结束上一轮采集，请稍后再试');
    if (currentPlatform !== 'macos') throw new Error('此 MVP 只支持 macOS 采集；Windows/Linux 需要接入可靠前台应用识别后才可启用');
    if (this.queue.atCapacity()) throw new QueueFullError();
    void this.events?.record('CAPTURE', 'STARTED');
    this.running = true; this.state = 'capturing'; this.message = '已开启；按应用级别记录，完整内容先经过本地隐私过滤';
    this.lastSample = undefined;
    this.publish(); void this.capture(); void this.sendHeartbeat();
  }
  stop(): void {
    this.stopIntent++;
    void this.events?.record('CAPTURE', 'STOPPED');
    this.running = false; this.lastSample = undefined; this.captureAbort?.abort(); this.nsfw?.reset();
    if (this.timer) clearTimeout(this.timer);
    this.state = 'stopped'; this.message = '采集已停止；本地记录保留，同步按设置独立运行'; this.publish(); void this.sendHeartbeat();
  }
  async settleCapture(): Promise<void> {
    while (this.capturing) await new Promise(resolve => setTimeout(resolve, 25));
  }
  shutdown(): void {
    this.closed = true;
    this.running = false; this.captureAbort?.abort(); this.uploadAbort?.abort(); this.ocrAbort?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ocrTimer) clearInterval(this.ocrTimer);
    this.nsfw?.close(); void this.diagnostics?.close();
  }
  requireRecovery(message: string): void { this.shutdown(); this.state = 'error'; this.message = message; this.publish(); }
  async retry(): Promise<void> { if (this.closed || this.connectionHeld) return; await this.queue.resetRetries(); await this.upload(true); await this.sendHeartbeat(true); }
  /** Only reads already sanitized queued JPEGs; independent of whether new capture is running. */
  async processPendingOcr(): Promise<void> {
    if (this.closed || this.ocrBusy || this.connectionHeld || this.sleeping || !this.config.ocrEnabled) return;
    this.ocrBusy = true;
    const cfg = this.config, abort = this.ocrAbort = new AbortController();
    let id: string | undefined;
    try {
      const next = await this.queue.nextOcr(); if (!next) return;
      id = next.record.event.id;
      if (cfg.ocrOnlyWhileCharging && (await readPowerState(this.helperPath, abort.signal)).onBattery !== false) return;
      const text = await recognizeText(this.helperPath, next.image, abort.signal);
      if (abort.signal.aborted || cfg !== this.config) return;
      await this.queue.saveOcr(id, text); this.publish();
      void this.upload();
    } catch { if (id && !abort.signal.aborted) await this.queue.deferOcr(id).catch(() => undefined); }
    finally { this.ocrBusy = false; }
  }
  private async capture(): Promise<void> {
    if (!this.running || this.capturing) return;
    this.capturing = true;
    const startedAt = Date.now();
    const cfg = this.config;
    let inferenceMs = 0, ocrMs = 0;
    let stage: EventStage = 'CAPTURE';
    const abort = this.captureAbort = new AbortController();
    const valid = () => this.running && !abort.signal.aborted && !this.locked && !this.sleeping;
    try {
      if (this.locked || this.sleeping || powerMonitor.getSystemIdleState(60) === 'locked') { this.pause('锁屏或休眠中，暂停采集'); return; }
      if (cfg.idlePauseSeconds > 0 && powerMonitor.getSystemIdleTime() >= cfg.idlePauseSeconds) { this.pause('已达到空闲阈值，暂停采集；操作电脑后恢复'); return; }
      if (this.queue.atCapacity()) throw new QueueFullError();
      if (cfg.pauseOnBattery || cfg.batteryPauseBelowPct > 0) {
        const power = await readPowerState(this.helperPath, abort.signal);
        if (power.onBattery === undefined || (cfg.batteryPauseBelowPct > 0 && power.batteryPercent === undefined)) { this.pause('无法确认电量，按你启用的电量策略暂停'); return; }
        if (power.onBattery && (cfg.pauseOnBattery || (power.batteryPercent ?? 100) <= cfg.batteryPauseBelowPct)) { this.pause('已达到你设置的电量暂停条件'); return; }
      }
      const foreground = await foregroundApplication(this.helperPath, abort.signal);
      if (!valid()) return;
      const collection = collectionForApp(foreground.appId, cfg);
      if (collection === 'off') { this.pause('当前应用设置为不记录，已跳过本次采样'); return; }
      if (collection === 'activity') {
        // This branch never requests screen permission, window enumeration, pixels, OCR or a model.
        const metadata = cfg.metadataEnabled ? await collectRecordMetadata(this.helperPath, this.queue.directory, undefined, abort.signal) : undefined;
        const after = await foregroundApplication(this.helperPath, abort.signal);
        if (!valid()) return;
        if (after.appId !== foreground.appId || after.pid !== foreground.pid) { this.pause('活动采样期间前台应用变化，已跳过'); return; }
        if (metadata?.state?.screenLocked) { this.pause('屏幕已锁定，暂停记录'); return; }
        const durationMs = this.lastSample?.appId === foreground.appId && this.lastSample.collection === 'activity' ? Math.max(0, Math.min(cfg.intervalMs, startedAt - this.lastSample.at)) : 0;
        const event: CaptureEvent = {
          id: randomUUID(), deviceId: cfg.deviceId, deviceName: cfg.deviceName, platform: currentPlatform,
          capturedAt: new Date(startedAt).toISOString(), durationMs, appId: foreground.appId, appName: foreground.appName,
          source: 'activity', privacy: { excluded: false, redacted: false, mode: 'none', collection: 'activity' },
          ...(metadata ? { metadata: { ...metadata, capture: { intervalMs: cfg.intervalMs } } } : {}),
        };
        stage = 'QUEUE'; await this.queue.enqueue(event);
        this.lastSample = { at: startedAt, appId: foreground.appId, collection }; this.lastCaptureAt = event.capturedAt;
        void this.events?.record('QUEUE', 'OK', { elapsedMs: Date.now() - startedAt });
        this.state = 'capturing'; this.message = '仅记录应用活动；未采集屏幕、窗口标题或正文'; this.publish(); void this.upload(); return;
      }
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        this.lastSample = undefined; this.state = 'permission_required'; this.message = '完整内容需要屏幕录制授权；仅活动应用仍可采样。请打开系统权限设置';
        void this.events?.record('CAPTURE', 'PERMISSION'); this.publish(); return;
      }
      if (cfg.nsfwEnabled) { if (!this.nsfw) throw new Error('本地千问视觉审查不可用，完整内容已跳过'); await this.nsfw.ensureReady(); }
      if (!valid()) return;
      const readyForeground = await foregroundApplication(this.helperPath, abort.signal);
      if (readyForeground.appId !== foreground.appId || readyForeground.pid !== foreground.pid || collectionForApp(readyForeground.appId, cfg) !== 'content') { this.pause('准备期间前台应用变化，已跳过本次内容采样'); return; }
      const before = await activeApplication(this.helperPath, abort.signal);
      if (before.appId !== foreground.appId || before.pid !== foreground.pid || collectionForApp(before.appId, cfg) !== 'content' || !permitsVisibleContent(before.visibleAppIds, before.unknownVisibleWindows, cfg)) { this.pause('屏幕含仅活动、不记录或身份未知的窗口，整张截图已跳过'); return; }
      const display = screen.getPrimaryDisplay();
      const scale = Math.min(1, cfg.captureMaxSide / Math.max(display.size.width, display.size.height));
      this.message = '正在读取屏幕画面…'; this.publish();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }, fetchWindowIcons: false });
      const source = sources.find(s => s.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取主屏截图，本次采集已跳过');
      const after = await activeApplication(this.helperPath, abort.signal);
      if (!valid()) return;
      if (before.appId !== after.appId || before.pid !== after.pid || collectionForApp(after.appId, cfg) !== 'content' || !permitsVisibleContent(after.visibleAppIds, after.unknownVisibleWindows, cfg) || before.visibleAppIds.join('\n') !== after.visibleAppIds.join('\n') || before.unknownVisibleWindows !== after.unknownVisibleWindows) { this.pause('采样期间屏幕应用发生变化或存在排除窗口，已跳过本次采集'); return; }
      // All unredacted pixels remain only in process memory. Never write a raw image.
      let sanitized = maskScreenshot(prepareScreenshot(source.thumbnail, display.size, cfg.captureMaxSide), cfg.masks);
      let appliedMasks = cfg.masks.length;
      if (cfg.nsfwEnabled) {
        stage = 'MODEL';
        this.message = '正在加载模型并进行本机隐私检查…'; this.publish();
        if (!this.nsfw) throw new Error('本地千问视觉模型不可用，本次截图已跳过');
        const { width, height } = sanitized.getSize();
        const inferenceStarted = Date.now();
        const decision = await this.nsfw.classify({ bitmap: sanitized.toBitmap(), width, height }, cfg, abort.signal);
        if (!valid()) return;
        inferenceMs = Date.now() - inferenceStarted;
        if (decision.blocked) { void this.events?.record('MODEL', 'FILTERED', { elapsedMs: inferenceMs }); this.diagnostics?.recordCapture({ outcome: 'blocked', inferenceMs, durationMs: Date.now() - startedAt }); this.pause('本地千问视觉策略拒绝，整张截图已跳过'); return; }
      }
      if (cfg.privacyModelUrl) {
        stage = 'PRIVACY';
        this.message = '正在进行本机附加隐私检查…'; this.publish();
        const decision = await reviewLocally(cfg.privacyModelUrl, sanitized.toJPEG(cfg.jpegQuality), abort.signal);
        if (!valid()) return;
        if (!decision.allow) { void this.events?.record('PRIVACY', 'FILTERED'); this.pause('本地隐私模型拒绝本次采集'); return; }
        sanitized = maskScreenshot(sanitized, decision.rectangles);
        appliedMasks += decision.rectangles.length;
      }
      const jpeg = sanitized.toJPEG(cfg.jpegQuality);
      if (jpeg.length > MAX_IMAGE_BYTES) throw new Error('截图超出单张大小限制，本次采集已跳过');
      // OCR must run after BOTH user masks and optional model masks.
      stage = 'OCR';
      const ocrStarted = Date.now();
      const deferredForPower = cfg.ocrEnabled && cfg.ocrOnlyWhileCharging && (await readPowerState(this.helperPath, abort.signal).catch(() => ({} as import('./native').PowerState))).onBattery !== false;
      let ocrText: string | undefined;
      let ocr: NonNullable<CaptureEvent['ocr']> = { status: cfg.ocrEnabled ? 'pending' : 'disabled', ...(deferredForPower ? { reason: 'charging' as const } : {}) };
      if (cfg.ocrEnabled && !deferredForPower) {
        this.message = '正在识别文字…'; this.publish();
        const ocrAbort = this.captureOcrAbort = new AbortController();
        try { ocrText = await recognizeText(this.helperPath, jpeg, AbortSignal.any([abort.signal, ocrAbort.signal])); if (!ocrAbort.signal.aborted) ocr = { status: 'completed' }; else ocrText = undefined; }
        catch { /* Preserve the sanitized image and retry OCR from the durable queue. */ }
        ocrMs = Date.now() - ocrStarted;
      }
      if (!valid()) return;
      const metadata = cfg.metadataEnabled ? await collectRecordMetadata(this.helperPath, this.queue.directory, 'screen_capture', abort.signal) : undefined;
      if (!valid()) return;
      const durationMs = this.lastSample?.appId === before.appId && this.lastSample.collection === 'content' ? Math.max(0, Math.min(cfg.intervalMs, startedAt - this.lastSample.at)) : 0;
      const event: CaptureEvent = {
        id: randomUUID(), deviceId: cfg.deviceId, deviceName: cfg.deviceName, platform: currentPlatform,
        capturedAt: new Date(startedAt).toISOString(), durationMs, appId: before.appId, appName: before.appName,
        imageMime: 'image/jpeg', ocrText, ocr, source: 'screen',
        ...(metadata ? { metadata: { ...metadata, capture: { intervalMs: cfg.intervalMs, ...sanitized.getSize(), displayScale: display.scaleFactor, ocrEnabled: cfg.ocrEnabled, maskCount: appliedMasks } } } : {}),
        privacy: { excluded: false, redacted: appliedMasks > 0, mode: 'local', collection: 'content', reason: `${cfg.nsfwEnabled ? 'offline Qwen visual policy passed; ' : ''}${appliedMasks > 0 ? 'configured or local-model masks applied before OCR and persistence' : cfg.privacyModelUrl ? 'local privacy model approved; no masks returned' : 'user-configured app filters checked; no masks configured'}` },
      };
      stage = 'QUEUE';
      this.message = '正在保存采集记录…'; this.publish();
      await this.queue.enqueue(event, jpeg);
      void this.events?.record('QUEUE', 'OK', { elapsedMs: Date.now() - startedAt });
      this.diagnostics?.recordCapture({ outcome: 'saved', imageBytes: jpeg.length, inferenceMs, ocrMs, durationMs: Date.now() - startedAt });
      this.lastSample = { at: startedAt, appId: before.appId, collection: 'content' }; this.lastCaptureAt = event.capturedAt;
      this.state = 'capturing'; this.message = ocr.status === 'pending' ? `截图已安全保存；${deferredForPower ? '接通电源后自动补做 OCR' : 'OCR 等待重试'}` : '正在采集主屏；本地过滤与脱敏已完成'; this.publish(); void this.upload();
    } catch (error) {
      void this.events?.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt });
      this.lastSample = undefined;
      this.diagnostics?.recordCapture({ outcome: 'failed', inferenceMs, ocrMs, durationMs: Date.now() - startedAt });
      if (!this.running || abort.signal.aborted) return;
      if (error instanceof QueueFullError) { this.stop(); this.state = 'error'; this.message = error.message; }
      else { this.state = 'paused'; this.message = error instanceof Error ? error.message : '采集失败，已跳过本次记录'; }
      this.publish();
    } finally {
      this.capturing = false;
      if (this.running) this.timer = setTimeout(() => void this.capture(), Math.max(1000, cfg.intervalMs - (Date.now() - startedAt)));
    }
  }
  async upload(explicit = false): Promise<void> {
    if (this.closed || this.uploading || this.connectionHeld) return;
    const pending = this.pendingSync();
    const policy = decideSync(this.config, { ...pending, pendingRecords: pending.eligibleRecords }, Date.now(), explicit);
    if (!pending.eligibleRecords && !pending.pendingUpdates && (pending.heldRecords || pending.heldUpdates)) { this.publish(); return; }
    if (!policy.ready) { this.publish(); return; }
    if (!this.queue.binding.matches(this.config)) { this.lastUploadError = '本地队列仍绑定原节点，请恢复已确认的连接'; this.publish(); return; }
    this.uploading = true; this.lastUploadError = undefined;
    const abort = this.uploadAbort = new AbortController();
    this.publish();
    try {
      // Bound each flush so the UI and new capture policy changes stay responsive.
      for (let count = 0, limit = this.queue.stats().depth; count < limit && !abort.signal.aborted; count++) {
        const entry = await this.queue.next();
        if (!entry) break;
        try {
          if (entry.record.uploaded) {
            await uploadDeferredOcr(this.config, entry.record.event.id, entry.record.ocrResult!, abort.signal);
            await this.queue.acknowledge(entry.record.event.id, true);
          } else {
            await uploadCapture(this.config, entry.record.event, entry.image, abort.signal);
            await this.queue.acknowledge(entry.record.event.id);
          }
          void this.events?.record('UPLOAD', 'OK');
          this.diagnostics?.recordUpload(entry.record.uploaded
            ? Buffer.byteLength(JSON.stringify({ ocrText: entry.record.ocrResult, status: 'completed' }))
            : Buffer.byteLength(JSON.stringify({ ...entry.record.event, ...(entry.image ? { imageBase64: entry.image.toString('base64') } : {}) })));
          this.lastUploadAt = new Date().toISOString(); this.lastUploadError = undefined;
        } catch (error) {
          if (abort.signal.aborted) break;
          const stage: EventStage = error instanceof TransportFailure ? 'UPLOAD' : 'QUEUE';
          void this.events?.record(stage, failureCode(error, stage), error instanceof TransportFailure ? { httpStatus: error.httpStatus } : {});
          if (error instanceof DeletedCaptureFailure || (error instanceof TransportFailure && (error.httpStatus === 410 || (entry.record.uploaded && error.httpStatus === 409)))) {
            await this.queue.blockSync(entry.record.event.id, error.httpStatus === 409 ? '中央 OCR 文字与本机结果冲突，已停止补写并保留中央原文字；本机副本保留待处理。' : '中央已删除此记录，不会重新创建；本机副本保留待处理。');
            this.lastUploadError = error.message;
            continue; // A permanent conflict on one item must not hold up unrelated records.
          } else await this.queue.failed(entry.record.event.id);
          this.lastUploadError = error instanceof Error ? error.message : '上传失败，队列已保留';
          break;
        }
      }
      if (!abort.signal.aborted && !this.lastUploadError) {
        await this.sources?.flushPending(abort.signal);
        if (pending.pendingRecords > this.pendingSync().pendingRecords || pending.pendingUpdates > this.pendingSync().pendingUpdates) this.lastUploadAt = new Date().toISOString();
        await this.queue.syncCheckpoint(this.lastUploadAt);
      }
    } catch (error) {
      if (!abort.signal.aborted) { this.lastUploadError = error instanceof Error ? error.message : '同步失败，本地记录已保留'; await this.queue.syncCheckpoint(this.lastUploadAt, new Date(Date.now() + 30000).toISOString()).catch(() => undefined); }
      void this.events?.record('QUEUE', 'STORAGE'); }
    finally { this.uploading = false; this.publish(); }
  }
  private async sendHeartbeat(explicit = false): Promise<void> {
    if (this.closed || this.connectionHeld || this.heartbeatInFlight || !this.config.serverUrl || !this.config.token || (this.config.syncMode === 'manual' && !explicit) || !this.queue.binding.matches(this.config)) return;
    this.heartbeatInFlight = true;
    const state = this.state === 'stopped' ? 'paused' : this.state;
    try {
      const metadata = this.config.metadataEnabled ? await collectRecordMetadata(this.helperPath, this.queue.directory, undefined) : undefined;
      const sync = this.syncStatus();
      await heartbeat(this.config, {
        metadata, deviceId: this.config.deviceId, deviceName: this.config.deviceName, platform: currentPlatform,
        status: state, queueDepth: this.queue.stats().depth, lastCaptureAt: this.lastCaptureAt, error: this.lastUploadError,
        sync: {
          mode: sync.mode, state: explicit && !sync.pendingRecords && !this.pendingSync().pendingUpdates && !this.pendingSync().heldUpdates && !this.lastUploadError ? 'idle' : sync.state,
          intervalMinutes: this.config.syncIntervalMinutes, batchSize: this.config.syncBatchSize,
          pendingRecords: Math.min(1_000_000, sync.pendingRecords), lastUploadAt: sync.lastUploadAt, nextUploadAt: sync.nextUploadAt,
        },
      }, this.events);
    } catch (error) { void this.events?.record('HEARTBEAT', failureCode(error, 'HEARTBEAT')); }
    finally { this.heartbeatInFlight = false; }
  }
}
