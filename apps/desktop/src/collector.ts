import { SyncHistory, captureHistoryItem } from './sync-history';
import { connectionToken } from './login-session';
import {collectorStatusView} from './native-status';
import {extractUiPages,uiSnapshotSchema,uiPageText,namedPage,type UiSnapshot,type UiPageV3} from '@mote/shared';
import {runHelper} from './native';
import type {BrowserCaptureProvider} from './browser-capture';
import {extractWechatPages,WECHAT_APP_ID,WECHAT_VERSION} from './wechat-page';
import { reviewUpload, uploadGateConfig } from './upload-gate';
import { uploadMeter } from './upload-meter';
import { moteText, statusMessage } from '@mote/shared/i18n';
import type { DiagnosticsRecorder } from '@mote/diagnostics';
import { randomUUID, createHash } from 'node:crypto';
import { desktopCapturer, nativeImage, powerMonitor, screen, systemPreferences } from 'electron';
import type { NativeImage } from 'electron';
import type { Config, Status, Platform, CaptureEvent } from './contracts';
import { imageFeatures, duplicateImage, type FrameFeatures } from './image-dedupe';
import { decideSync } from './sync-policy';
import type { LocalSourceManager } from './source-manager';
import { MAX_IMAGE_BYTES, publicConfig } from './config';
import { DurableQueue, QueueFullError } from './queue';
import { readVisibleNotifications, activeApplication, foregroundApplication, recognizeText, readPowerState } from './native';
import { imageWork } from './background';

import { collectionForApp, permitsVisibleContent } from './app-collection';
import { collectRecordMetadata } from './record-metadata';
import { heartbeat, uploadCaptureBatch, uploadCapture, DeletedCaptureFailure } from './transport';
import { EventJournal, failureCode, safeErrorName, TransportFailure, type EventStage } from './support';

export const currentPlatform: Platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
export class Collector {
  private notificationSeen=new Set<string>();
  private authorizationGeneration = 0;
  private captureConfigGeneration = 0;
  private notificationSession=randomUUID();
  private running = false;
  private locked = false;
  private sleeping = false;
  private capturing = false;
  private captureOnResume = false;
  private uploading = false;
  private heartbeatInFlight = false;
  private heartbeatAbort?: AbortController;
  private connectionHeld = false;
  private config: Config;
  private captureAbort?: AbortController;
  private uploadAbort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private uploadTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private stopIntent = 0;
  private lastImageFeatures?: FrameFeatures;
  private lastSample?: {at:number;appId:string};
  private lastImageAppId?:string;
  private lastImageAt?:number;
  private lastMediaSample?:{at:number;identity:string};
  private state: Status['state'] = 'stopped';
  private message = moteText("尚未开始采集。请确认隐私设置后手动开始。");
  private lastCaptureAt?: string;
  private lastUploadAt?: string;
  private archiveAcknowledgment?:{at:string;origin:string};
  private lastUploadError?: string;
  constructor(config: Config, private readonly queue: DurableQueue, private readonly helperPath: string, private readonly tokenStorageAvailable: () => boolean, private readonly onChange: (status: Status) => void, private readonly diagnostics?: DiagnosticsRecorder, private readonly events?: EventJournal, private readonly sources?: LocalSourceManager, private readonly history?: SyncHistory, private readonly browserCapture?: BrowserCaptureProvider) {
    this.config = config; this.lastUploadAt = this.queue.stats().lastUploadAt; this.archiveAcknowledgment=this.queue.stats().archiveAcknowledgment;
    powerMonitor.on('lock-screen', () => { this.locked = true; this.pause(moteText("屏幕已锁定，暂停采集")); });
    powerMonitor.on('unlock-screen', () => { this.locked = false; this.resumeCapture(); });
    powerMonitor.on('suspend', () => { this.sleeping = true; this.pause(moteText("电脑休眠，暂停采集")); });
    powerMonitor.on('resume', () => { this.sleeping = false; this.resumeCapture(); });
  }
  initialize(): void {
    this.uploadTimer = setInterval(() => { if (this.uploading) this.publish(); else void this.upload(); }, 1000);
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), 30000);
    void this.upload();
  }
  status(): Status {
    const queue = this.queue.stats(), sync = this.syncStatus();
    return {
      authorizationGeneration: this.authorizationGeneration,
      facts: collectorStatusView({...sync,lastUploadAt:this.archiveAcknowledgment?.origin===this.config.serverUrl?this.archiveAcknowledgment.at:undefined}, queue.blocked),
      running: this.running, state: this.state, message: statusMessage(this.message), sync,
      queueDepth: queue.depth, queueBytes: queue.bytes, nextRetryAt: queue.nextRetryAt,
      lastCaptureAt: this.lastCaptureAt, lastUploadAt: this.lastUploadAt, lastUploadError: this.lastUploadError,
      screenPermission: currentPlatform === 'macos' ? systemPreferences.getMediaAccessStatus('screen') : 'unsupported',
      platform: currentPlatform, encryptedTokenStorage: this.tokenStorageAvailable(), config: publicConfig(this.config), diagnostics: this.diagnostics?.status(),
    };
  }
  private pendingSync() {
    const queue = this.queue.stats(), sources = this.sources?.pendingStats();
    const oldestPendingAt = [queue.oldestPendingAt, (sources?.eligibleRecords === undefined ? sources?.oldestPendingAt : sources.oldestEligibleAt), sources?.oldestUpdateAt].filter((date): date is string => Boolean(date)).sort()[0];
    return { pendingRecords: queue.depth + (sources?.pendingRecords ?? 0), eligibleRecords: queue.eligibleDepth + (sources?.eligibleRecords ?? sources?.pendingRecords ?? 0), heldRecords: queue.depth - queue.eligibleDepth + (sources?.heldRecords ?? 0), heldUpdates: sources?.heldUpdates ?? 0, heldReason: queue.blocked ? moteText("部分记录需要处理：中央记录已删除或节点需升级；请在采集记录中查看，处理后手动重试") : sources?.heldReason, pendingUpdates: sources?.eligibleUpdates ?? sources?.pendingUpdates ?? 0, oldestPendingAt, lastUploadAt: this.lastUploadAt ?? queue.lastUploadAt, nextRetryAt: queue.nextRetryAt };
  }
  private syncStatus(): Status['sync'] {
    const pending = this.pendingSync();
    const { ready: _, ...policy } = decideSync(this.config, { ...pending, pendingRecords: pending.eligibleRecords });
    const decision = { ...policy, pendingRecords: pending.pendingRecords };
    const localBacklogUnbound = decision.pendingRecords > 0 && this.queue.binding.unbound() && (!this.sources || this.sources.nodeBinding.unbound());
    if (decision.state !== 'unconfigured' && !pending.eligibleRecords && !pending.pendingUpdates && (pending.heldRecords || pending.heldUpdates)) return { ...decision, state: 'waiting', message: pending.heldReason ?? moteText("来源待传版本等待恢复"), localBacklogUnbound };
    if (this.uploading) return { ...decision, state: 'uploading', uploadBytesPerSecond: uploadMeter.rate(), message: moteText("正在同步本地记录"), localBacklogUnbound };
    if (!this.config.syncPaused && decision.state !== 'unconfigured' && this.lastUploadError) return { ...decision, state: 'error', message: this.lastUploadError, localBacklogUnbound };
    return { ...decision, localBacklogUnbound };
  }
  private publish(): void { this.onChange(this.status()); }
  private pause(message: string): void {
    this.lastSample = undefined;this.lastMediaSample=undefined;
    this.captureAbort?.abort();
    if (this.running) { this.state = 'paused'; this.message = message; this.publish(); }
  }
  private resumeCapture(): void {
    this.lastSample = undefined; this.lastMediaSample = undefined;
    if (!this.running || this.locked || this.sleeping) return;
    if (this.timer) clearTimeout(this.timer);
    // A cancelled native capture may still be draining. Its finally schedules the retry.
    if (this.capturing) { this.captureOnResume = true; return; }
    void this.capture();
  }
  connectionActivity(): { inFlight: boolean } { return { inFlight: this.capturing || this.uploading || this.heartbeatInFlight }; }
  async holdConnection(): Promise<() => void> {
    if (this.running || this.connectionHeld) throw new Error(moteText("请先停止采集，再更换连接"));
    this.connectionHeld = true;
    this.heartbeatAbort?.abort(); this.captureAbort?.abort(); this.uploadAbort?.abort();
    // Cancel old-credential requests before changing the local binding.
    while (this.connectionActivity().inFlight) await new Promise(resolve => setTimeout(resolve, 25));
    return () => { this.connectionHeld = false; };
  }
  /** Freeze every producer/consumer before applying settings; preserve the user's running intent. */
  async suspendForSettings(): Promise<() => Promise<void>> {
    if (this.connectionHeld || this.closed) throw new Error(moteText("设置正在应用或应用正在退出，请稍后重试"));
    const resume = this.running, intent = this.stopIntent;
    this.connectionHeld = true; this.running = false; this.lastSample = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.heartbeatAbort?.abort(); this.captureAbort?.abort(); this.uploadAbort?.abort();
    this.state = 'paused'; this.message = moteText("正在安全应用设置，已有记录保留"); this.publish();
    while (this.connectionActivity().inFlight) await new Promise(resolve => setTimeout(resolve, 25));
    let released = false;
    return async () => {
      if (released) return; released = true; this.connectionHeld = false;
      if (this.closed) return;
      if (resume && intent === this.stopIntent) {
        try { await this.start(); }
        catch (error) { this.state = 'error'; this.message = moteText("设置已应用，采集暂未恢复：{0}", error instanceof Error ? error.message : moteText("请检查采集条件")); this.publish(); }
      } else { this.state = 'stopped'; this.message = moteText("设置已应用；采集保持停止"); this.publish(); }
      void this.upload();
    };
  }
  async setSyncPaused(paused:boolean):Promise<void> {
    this.config={...this.config,syncPaused:paused};
    if(paused){this.uploadAbort?.abort();this.heartbeatAbort?.abort();while(this.uploading||this.heartbeatInFlight)await new Promise(resolve=>setTimeout(resolve,25));}
    this.publish();if(!paused)void this.upload();
  }
  updateConfig(config: Config): void {
    // Config edits cannot change a privacy policy in the middle of capture.
    if (this.running || this.capturing) throw new Error(moteText("请先停止采集，再修改配置"));
    this.uploadAbort?.abort();

    if (config.token !== this.config.token || config.serverUrl !== this.config.serverUrl || config.deviceId !== this.config.deviceId || config.authSignedOut !== this.config.authSignedOut) this.authorizationGeneration++;
    this.captureConfigGeneration++;this.lastMediaSample=undefined;
    this.config = config;
    this.queue.setLimits(config);
    this.publish();
  }
  async start(): Promise<void> {
    if (this.closed || this.connectionHeld) throw new Error(moteText("正在应用设置或退出，请稍后重试"));
    if (this.running) return;
    if (this.capturing) throw new Error(moteText("正在结束上一轮采集，请稍后再试"));
    if (currentPlatform !== 'macos') throw new Error(moteText("此 MVP 只支持 macOS 采集；Windows/Linux 需要接入可靠前台应用识别后才可启用"));
    if (this.queue.atCapacity()) throw new QueueFullError();
    void this.events?.record('CAPTURE', 'STARTED');
    this.running = true; this.state = 'capturing'; this.message = moteText("已开启；按应用级别记录，完整内容先经过本地隐私过滤");
    this.lastSample = undefined;this.lastMediaSample=undefined;this.lastImageFeatures=undefined;this.lastImageAt=undefined;
    this.publish(); void this.capture(); void this.sendHeartbeat();
  }
  stop(): void {
    this.stopIntent++;
    void this.events?.record('CAPTURE', 'STOPPED');
    this.running = false; this.lastSample = undefined;this.lastMediaSample=undefined; this.captureAbort?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.state = 'stopped'; this.message = moteText("采集已停止；本地记录保留，同步按设置独立运行"); this.publish(); void this.sendHeartbeat();
  }
  async settleCapture(): Promise<void> {
    while (this.capturing) await new Promise(resolve => setTimeout(resolve, 25));
  }
  shutdown(): void {
    this.closed = true; this.heartbeatAbort?.abort();
    this.running = false; this.captureAbort?.abort(); this.uploadAbort?.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.uploadTimer) clearInterval(this.uploadTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    void this.diagnostics?.close();
  }
  requireRecovery(message: string): void { this.shutdown(); this.state = 'error'; this.message = message; this.publish(); }
  async retry(): Promise<void> { if (this.closed || this.connectionHeld) return; await this.queue.resetRetries(); await this.upload(true); await this.sendHeartbeat(true); }
  private async finalImage(image: NativeImage, rectangles: Config['masks']): Promise<NativeImage> {
    const { width, height } = image.getSize();
    return nativeImage.createFromBitmap(Buffer.from(await imageWork.run<Uint8Array>({ kind: 'mask', bytes: image.toBitmap(), width, height, rectangles })), { width, height });
  }
  private async encodeImage(image: NativeImage, quality: number): Promise<Buffer> {
    const { width, height } = image.getSize();
    return Buffer.from(await imageWork.run<Uint8Array>({ kind: 'jpeg', bytes: image.toBitmap(), width, height, quality }));
  }
  /** OCR may read only the verified WeChat message-list rectangle; no region means no OCR. */
  private async readWechatOcr(cfg:Config,snapshot:UiSnapshot,foreground:Awaited<ReturnType<typeof foregroundApplication>>,at:string,signal:AbortSignal,valid:()=>boolean):Promise<UiPageV3|undefined>{
    if(!cfg.structuredOcrEnabled||snapshot.appId!==WECHAT_APP_ID||snapshot.appVersion!==WECHAT_VERSION||!valid())return;
    const lists=snapshot.nodes.filter(node=>node.resourceId==='chat_message_list');if(lists.length!==1)return;
    const scopeIdentity=(value:UiSnapshot)=>JSON.stringify({bounds:value.nodes.filter(node=>node.resourceId==='chat_message_list').map(node=>node.bounds),conversation:value.nodes.filter(node=>node.resourceId==='current_chat_name_label').map(node=>node.text)});
    const verifyRegion=async()=>{
      const raw=await runHelper(this.helperPath,'ui-page',Buffer.from(JSON.stringify({appId:foreground.appId,pid:foreground.pid,masks:cfg.masks,versions:[WECHAT_VERSION],requireUnoccludedRegion:true})),signal) as {status?:string;snapshot?:unknown};
      const parsed=uiSnapshotSchema.safeParse(raw.snapshot);
      return valid()&&raw.status!=='blocked'&&parsed.success&&parsed.data.appId===snapshot.appId&&parsed.data.appVersion===snapshot.appVersion&&scopeIdentity(parsed.data)===scopeIdentity(snapshot);
    };
    if(systemPreferences.getMediaAccessStatus('screen')!=='granted')return;
    const allows=(value:Awaited<ReturnType<typeof activeApplication>>)=>!value.unknownVisibleWindows&&value.appId===foreground.appId&&value.pid===foreground.pid&&value.visibleAppIds.every(id=>{const selected=collectionForApp(id,cfg);return selected.screenshots||selected.structured&&cfg.structuredOcrEnabled;});
    const before=await activeApplication(this.helperPath,signal);if(!valid()||!allows(before)||!await verifyRegion())return;
    const display=screen.getPrimaryDisplay(),bounds=display.bounds,region=lists[0].bounds;
    if(!bounds||region.x<bounds.x||region.y<bounds.y||region.x+region.width>bounds.x+bounds.width||region.y+region.height>bounds.y+bounds.height)return;
    const scale=Math.min(1,cfg.captureMaxSide/Math.max(display.size.width,display.size.height));
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.size.width*scale),height:Math.round(display.size.height*scale)},fetchWindowIcons:false});
    const source=sources.find(item=>item.display_id===String(display.id));if(!source||source.thumbnail.isEmpty())return;
    const after=await activeApplication(this.helperPath,signal);if(!valid()||!allows(after)||before.visibleAppIds.join('\n')!==after.visibleAppIds.join('\n')||!await verifyRegion())return;
    // Masks are applied before both cropping and OCR. Ephemeral pixels are never queued.
    const masked=await this.finalImage(source.thumbnail,cfg.masks),size=masked.getSize();
    const x=Math.ceil((region.x-bounds.x)*size.width/bounds.width),y=Math.ceil((region.y-bounds.y)*size.height/bounds.height);
    const right=Math.floor((region.x+region.width-bounds.x)*size.width/bounds.width),bottom=Math.floor((region.y+region.height-bounds.y)*size.height/bounds.height);
    if(right<=x||bottom<=y||x<0||y<0||right>size.width||bottom>size.height)return;
    const bytes=await this.encodeImage(masked.crop({x,y,width:right-x,height:bottom-y}),cfg.jpegQuality);
    const text=(await recognizeText(this.helperPath,bytes,signal)).trim();
    const final=await foregroundApplication(this.helperPath,signal);
    if(!valid()||final.appId!==foreground.appId||final.pid!==foreground.pid||!text||text.length>32000||!await verifyRegion())return;
    return namedPage(snapshot,{id:'macos.wechat.local-ocr',version:'1',kind:'visible_text'},[{name:'text',values:[{text,source:'ocr'}]}],at,true);
  }
  private async capture(): Promise<void> {
    if (!this.running || this.capturing) return;
    this.capturing = true;
    const startedAt = Date.now();
    const cfg = this.config,captureGeneration=this.captureConfigGeneration;
    let inferenceMs = 0, ocrMs = 0;
    let stage: EventStage = 'CAPTURE';
    const abort = this.captureAbort = new AbortController();
    const valid = () => this.running && this.captureConfigGeneration===captureGeneration && !abort.signal.aborted && !this.locked && !this.sleeping;
    try {
      if (this.locked || this.sleeping || powerMonitor.getSystemIdleState(60) === 'locked') { this.pause(moteText("锁屏或休眠中，暂停采集")); return; }
      if (cfg.idlePauseSeconds > 0 && powerMonitor.getSystemIdleTime() >= cfg.idlePauseSeconds) { this.pause(moteText("已达到空闲阈值，暂停采集；操作电脑后恢复")); return; }
      if (this.queue.atCapacity()) throw new QueueFullError();
      if (cfg.pauseOnBattery || cfg.batteryPauseBelowPct > 0) {
        const power = await readPowerState(this.helperPath, abort.signal);
        if (power.onBattery === undefined || (cfg.batteryPauseBelowPct > 0 && power.batteryPercent === undefined)) { this.pause(moteText("无法确认电量，按你启用的电量策略暂停")); return; }
        if (power.onBattery && (cfg.pauseOnBattery || (power.batteryPercent ?? 100) <= cfg.batteryPauseBelowPct)) { this.pause(moteText("已达到你设置的电量暂停条件")); return; }
      }
      // Notifications have their own opt-in; new channel bits never enable them.
      if(cfg.notificationCollectionEnabled && cfg.defaultCollection.structured && Object.values(cfg.appCollectionRules).every(v=>v.structured)) {
        const visible=await readVisibleNotifications(this.helperPath,abort.signal);
        const observedAt=new Date().toISOString();
        for(const text of visible){
          const key=createHash('sha256').update(text).digest('hex');if(this.notificationSeen.has(key))continue;
          const gate=await reviewUpload(uploadGateConfig(cfg.uploadGate),async()=>text);
          if(gate==='drop')continue;
          if(!valid())return;
          await this.queue.enqueue({id:randomUUID(),deviceId:cfg.deviceId,deviceName:cfg.deviceName,platform:currentPlatform,capturedAt:observedAt,durationMs:0,source:'notification',appId:'com.apple.notificationcenterui',appName:'Notification Center',ocrText:'',privacy:{excluded:false,redacted:false,mode:'none',collection:'content',reason:gate==='hold'?'upload review pending':'explicit notification text rules'},metadata:{version:1,observedAt,collector:{method:'accessibility'},observation:{sessionId:this.notificationSession,elapsedRealtimeMs:Math.floor(process.uptime()*1000)},notification:{action:'posted',notificationKey:key,postedAt:observedAt,ongoing:false,groupSummary:false,text}}},undefined,gate==='hold');
          this.notificationSeen.add(key);
        }
        if(this.notificationSeen.size>1000)this.notificationSeen=new Set([...this.notificationSeen].slice(-500));
      }
      const foreground = await foregroundApplication(this.helperPath, abort.signal);
      if (!valid()) return;
      const selected = collectionForApp(foreground.appId, cfg);
      if (!selected.duration&&!selected.screenshots&&!selected.structured) { this.pause(moteText("当前应用设置为不记录，已跳过本次采样")); return; }
      this.state = 'capturing'; this.message = moteText("已开启；按应用级别记录，完整内容先经过本地隐私过滤"); this.publish();
      const observationId=randomUUID(),at=new Date(startedAt).toISOString();
      const observation={id:observationId,selected:{...selected}};
      const base={deviceId:cfg.deviceId,deviceName:cfg.deviceName,platform:currentPlatform,capturedAt:at,appId:foreground.appId,appName:foreground.appName};
      const sameForeground=async()=>{const after=await foregroundApplication(this.helperPath,abort.signal),current=valid()&&after.appId===foreground.appId&&after.pid===foreground.pid;if(!current)this.lastMediaSample=undefined;return current;};
      // Duration is the sole usage accumulator. It does not require window or content access.
      if(selected.duration){
        const metadata=cfg.metadataEnabled?await collectRecordMetadata(this.helperPath,this.queue.directory,undefined,abort.signal):undefined;
        if(!await sameForeground()||metadata?.state?.screenLocked){this.lastSample=undefined;return;}
        const durationMs=this.lastSample?.appId===foreground.appId?Math.max(0,Math.min(cfg.intervalMs,startedAt-this.lastSample.at)):0;
        await this.queue.enqueue({...base,id:randomUUID(),durationMs,source:'activity',privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'},metadata:{...metadata,version:1,observedAt:at,capture:{intervalMs:cfg.intervalMs},captureObservation:observation}});
        this.lastSample={at:startedAt,appId:foreground.appId};this.lastCaptureAt=at;
      }else this.lastSample=undefined;
      if(!valid())return;
      if(!selected.structured||!selected.duration||foreground.appId!=='com.google.Chrome')this.lastMediaSample=undefined;
      let browserIdentity:string|undefined,chromeReady=true,browserScreenshotSafe=false;
      if(foreground.appId==='com.google.Chrome'&&(selected.screenshots||selected.structured)){
        const result=await this.browserCapture?.sample({appId:foreground.appId,pid:foreground.pid,origins:cfg.chromeOrigins,observedAt:at,observationId,masks:cfg.masks,structured:selected.structured},abort.signal).catch(()=>undefined);
        if(!valid()||!await sameForeground())return;
        browserIdentity=result?.identity;chromeReady=result?.status==='ok'&&Boolean(browserIdentity);browserScreenshotSafe=result?.screenshotSafe===true;if(!chromeReady||!result?.media)this.lastMediaSample=undefined;
        if (selected.structured && !chromeReady) this.message = !cfg.chromeOrigins.length
          ? moteText('结构化内容未采集：请先配置允许的 Chrome 站点；应用时长按所选设置记录')
          : result?.status === 'disconnected' || !this.browserCapture
            ? moteText('结构化内容未采集：Mote Chrome 扩展尚未连接；应用时长按所选设置记录')
            : moteText('结构化内容未采集：Chrome 窗口、站点授权或遮挡校验未通过；应用时长按所选设置记录');
        if(chromeReady&&result){
          const browserValid=async()=>{const current=Boolean(browserIdentity&&await this.browserCapture?.validate(browserIdentity,abort.signal))&&await sameForeground();if(!current)this.lastMediaSample=undefined;return current;};
          if(selected.structured){
            for(const [objectIndex,page] of result.pages.entries()){
              if(!await browserValid())return;
              const text=uiPageText(page),gate=await reviewUpload(uploadGateConfig(cfg.uploadGate),async()=>text);
              if(!valid()||!await browserValid())return;
              if(gate==='drop')continue;
              await this.queue.enqueue({...base,id:randomUUID(),durationMs:0,source:'ui_page',ocrText:text,privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'browser_dom'},captureObservation:{...observation,objectIndex},uiPage:page}},undefined,gate==='hold');
              this.lastCaptureAt=at;
            }
            if(result.media&&await browserValid()){
              const gate=await reviewUpload(uploadGateConfig(cfg.uploadGate),async()=>JSON.stringify(result.media));
              if(!valid()||!await browserValid())return;
              const sessions=result.media.sessions,session=result.media.status==='available'&&sessions.length===1?sessions[0]:undefined;
              const identity=selected.duration&&session?.playbackState==='playing'&&session.appId===foreground.appId&&session.appName===foreground.appName?JSON.stringify([foreground.appId,session.sessionId,session.mediaId??'']):undefined;
              const elapsed=this.lastMediaSample?startedAt-this.lastMediaSample.at:0;
              const durationMs=identity&&this.lastMediaSample?.identity===identity&&elapsed>0&&elapsed<=cfg.intervalMs*2?Math.min(cfg.intervalMs,60000,elapsed):0;
              if(gate!=='drop'){
                await this.queue.enqueue({...base,id:randomUUID(),durationMs,source:'media',ocrText:'',privacy:{excluded:false,redacted:false,mode:'none',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'browser_dom'},captureObservation:observation,media:result.media}},undefined,gate==='hold');
                this.lastMediaSample=identity?{at:startedAt,identity}:undefined;this.lastCaptureAt=at;
              }else this.lastMediaSample=undefined;
            }
          }
        }
      }else if(selected.structured){
        // Only selected applications reach AX. Unsupported/failed structure never enables pixels.
        const candidates=(cfg.uiPageRules??[]).filter(r=>r.platform==='macos'&&r.appId===foreground.appId&&!r.activity);
        const versions=foreground.appId===WECHAT_APP_ID?[WECHAT_VERSION]:candidates.some(r=>!r.appVersion)?[]:candidates.map(r=>r.appVersion);
        if(foreground.appId===WECHAT_APP_ID||candidates.length){
          const raw=await runHelper(this.helperPath,'ui-page',Buffer.from(JSON.stringify({appId:foreground.appId,pid:foreground.pid,masks:cfg.masks,versions})),abort.signal).catch(()=>({status:'failed'})) as {snapshot?:unknown;status?:string};
          if(!valid()||!await sameForeground())return;
          if(raw.status!=='blocked'&&raw.snapshot){
            const parsed=uiSnapshotSchema.safeParse(raw.snapshot);
            if(parsed.success&&parsed.data.appId===foreground.appId){
              const snapshot=parsed.data;
              let pages:UiPageV3[]=[];
              try{pages=foreground.appId===WECHAT_APP_ID?extractWechatPages(snapshot,at):extractUiPages(snapshot,candidates,'macos',at).filter((page):page is UiPageV3=>page.version===3);}catch{/* Unsupported evidence cannot authorize another reader. */}
              if(!pages.length&&foreground.appId===WECHAT_APP_ID){
                const ocrPage=await this.readWechatOcr(cfg,snapshot,foreground,at,abort.signal,valid).catch(()=>undefined);
                if(ocrPage)pages=[ocrPage];
              }
              // Review all sanitized evidence before projection, including descriptions and state.
              const gate=await reviewUpload(uploadGateConfig(cfg.uploadGate),async()=>[...snapshot.nodes.flatMap(n=>[n.text,n.description??'',n.state??'']),...pages.map(uiPageText)].join('\n'));
              if(!valid()||!await sameForeground())return;
              if(gate!=='drop')for(const [objectIndex,page] of pages.slice(0,64).entries()){
                if(!valid()||!await sameForeground())return;
                await this.queue.enqueue({...base,id:randomUUID(),durationMs:0,source:'ui_page',ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},captureObservation:{...observation,objectIndex},uiPage:page}},undefined,gate==='hold');
                this.lastCaptureAt=at;
              }
            }
          }
        }
      }
      if(!selected.screenshots||!chromeReady){this.state='capturing';this.publish();void this.upload();return;}
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        this.state = 'permission_required'; this.message = moteText("完整内容需要屏幕录制授权；仅活动应用仍可采样。请打开系统权限设置");
        void this.events?.record('CAPTURE', 'PERMISSION'); this.publish(); return;
      }
      if (!valid()||!await sameForeground()) return;
      const before = await activeApplication(this.helperPath, abort.signal);
      if (!valid()||before.appId !== foreground.appId || before.pid !== foreground.pid || !collectionForApp(before.appId,cfg).screenshots || !permitsVisibleContent(before.visibleAppIds, before.unknownVisibleWindows, cfg)) return;
      if(before.visibleAppIds.includes('com.google.Chrome')&&(foreground.appId!=='com.google.Chrome'||!browserScreenshotSafe||!browserIdentity||!await this.browserCapture?.validate(browserIdentity,abort.signal)))return;
      const display = screen.getPrimaryDisplay();
      const scale = Math.min(1, cfg.captureMaxSide / Math.max(display.size.width, display.size.height));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }, fetchWindowIcons: false });
      const source = sources.find(s => s.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error(moteText("无法获取主屏截图，本次采集已跳过"));
      const after = await activeApplication(this.helperPath, abort.signal);
      if (!valid()||before.appId!==after.appId||before.pid!==after.pid||!permitsVisibleContent(after.visibleAppIds,after.unknownVisibleWindows,cfg)||before.visibleAppIds.join('\n')!==after.visibleAppIds.join('\n')||before.unknownVisibleWindows!==after.unknownVisibleWindows) return;
      if(browserIdentity&&!await this.browserCapture?.validate(browserIdentity,abort.signal))return;
      const sanitized = await this.finalImage(source.thumbnail, cfg.masks);
      const jpeg = await this.encodeImage(sanitized, cfg.jpegQuality);
      if (jpeg.length > MAX_IMAGE_BYTES) throw new Error(moteText("截图超出单张大小限制，本次采集已跳过"));
      const mode = cfg.imageDedupeMode ?? 'off',size=sanitized.getSize();
      const dedupeScale=mode!=='off'&&mode!=='exact'&&Math.max(size.width,size.height)>96?96/Math.max(size.width,size.height):1;
      const sample=dedupeScale<1?sanitized.resize({width:Math.max(1,Math.floor(size.width*dedupeScale)),height:Math.max(1,Math.floor(size.height*dedupeScale))}):sanitized;
      const features=mode==='off'?undefined:imageFeatures(sample.toBitmap(),sample.getSize().width,sample.getSize().height);
      if(features&&duplicateImage(this.lastImageFeatures,features,mode)&&this.lastImageAppId===foreground.appId&&this.lastImageAt!==undefined&&startedAt-this.lastImageAt<=cfg.intervalMs*2){this.lastImageAt=startedAt;this.publish();void this.upload();return;}
      const gate=await reviewUpload(uploadGateConfig(cfg.uploadGate),()=>recognizeText(this.helperPath,jpeg,abort.signal));
      const metadata=cfg.metadataEnabled?await collectRecordMetadata(this.helperPath,this.queue.directory,'screen_capture',abort.signal):undefined;
      if(!valid()||metadata?.state?.screenLocked||!await sameForeground()||browserIdentity&&!await this.browserCapture?.validate(browserIdentity,abort.signal))return;
      if(gate==='drop'){this.publish();return;}
      const event:CaptureEvent={...base,id:randomUUID(),durationMs:0,source:'screen',imageMime:'image/jpeg',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:cfg.masks.length>0,mode:'local',collection:'content',reason:gate==='hold'?'upload review pending':'explicit screenshot channel and mask rules'},metadata:{...metadata,version:1,observedAt:at,captureObservation:observation,capture:{intervalMs:cfg.intervalMs,...sanitized.getSize(),displayScale:display.scaleFactor,ocrEnabled:false,maskCount:cfg.masks.length}}};
      stage='QUEUE';await this.queue.enqueue(event,jpeg,gate==='hold');
      this.lastImageFeatures=features;this.lastImageAppId=foreground.appId;this.lastImageAt=startedAt;this.lastCaptureAt=at;
      this.diagnostics?.recordCapture({outcome:'saved',imageBytes:jpeg.length,inferenceMs,ocrMs,durationMs:Date.now()-startedAt});
      this.state='capturing';this.publish();void this.upload();
    } catch (error) {
      void this.events?.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt, errorName:safeErrorName(error) });
      this.lastSample = undefined;this.lastMediaSample=undefined;
      this.diagnostics?.recordCapture({ outcome: 'failed', inferenceMs, ocrMs, durationMs: Date.now() - startedAt });
      if (!this.running || abort.signal.aborted) return;
      if (error instanceof QueueFullError) { this.stop(); this.state = 'error'; this.message = error.message; }
      else { this.state = 'paused'; this.message = error instanceof Error ? error.message : moteText("采集失败，已跳过本次记录"); }
      this.publish();
    } finally {
      this.capturing = false;
      const resume = this.captureOnResume && !this.locked && !this.sleeping;
      this.captureOnResume = false;
      if (this.running) this.timer = setTimeout(() => void this.capture(), resume ? 0 : Math.max(1000, cfg.intervalMs - (Date.now() - startedAt)));
    }
  }
  async upload(explicit = false): Promise<void> {
    if (this.closed || this.uploading || this.connectionHeld) return;
    const pending = this.pendingSync();
    const policy = decideSync(this.config, { ...pending, pendingRecords: pending.eligibleRecords }, Date.now(), explicit);
    if (!pending.eligibleRecords && !pending.pendingUpdates && (pending.heldRecords || pending.heldUpdates)) { this.publish(); return; }
    if (!policy.ready) { this.publish(); return; }
    if (!this.queue.binding.matches(this.config)) { this.lastUploadError = moteText("本地队列仍绑定原节点，请恢复已确认的连接"); this.publish(); return; }
    const historyRun = this.history?.begin(this.config, explicit ? 'manual' : 'automatic');
    const onBytes = historyRun ? (bytes: number) => this.history!.addBytes(historyRun, bytes) : undefined;
    this.uploading = true; this.lastUploadError = undefined;
    const abort = this.uploadAbort = new AbortController();
    this.publish();
    try {
      const captureRounds=this.queue.stats().depth,liveSince=Date.now();let liveBytes=0;
      const flushCaptures=async()=>{
      let sliceBytes=0,completed=0;const sliceStarted=performance.now(),preferSince=liveBytes<16*1024*1024?liveSince:undefined;
      // Bound each flush so the UI and new capture policy changes stay responsive.
      for (let count = 0, limit = Math.min(25,this.queue.stats().depth); count < limit && sliceBytes<4*1024*1024 && (count===0||performance.now()-sliceStarted<15000) && !abort.signal.aborted; count++) {
        let entry: Awaited<ReturnType<DurableQueue['next']>>;
        let attempted: NonNullable<typeof entry>[] = [];
        let uploadStarted = 0;
        const startAttempt = (first: NonNullable<typeof entry>) => {
          entry = first; attempted = [first]; uploadStarted = Date.now();
          void this.events?.record('UPLOAD', 'STARTED');
        };
        if (!this.config.packedUpload) {
          const first = await this.queue.next(Date.now(),preferSince);
          if (!first) break;
          startAttempt(first);
        }
        try {
          if (this.config.packedUpload) {
            const batch = await this.queue.nextBatch(25, Date.now(), preferSince, startAttempt);
            if (!entry) break;
            sliceBytes+=batch.reduce((sum,item)=>sum+Buffer.byteLength(JSON.stringify(item.record.event))+Math.ceil((item.image?.length??0)/3)*4+64,0);
            attempted = batch;
            if (historyRun) this.history!.attempt(historyRun, batch.map(item => captureHistoryItem(item.record.event)));
            const receipts = await uploadCaptureBatch(this.config, batch.map(item => ({ event: item.record.event, image: item.image })), abort.signal, onBytes,
              historyRun ? (id, code) => this.history!.settle(historyRun, id, code === 200 || code === 201, id, code) : undefined);
            let incomplete = false;
            for (const item of batch) {
              const code = receipts.get(item.record.event.id);
              if (historyRun) this.history!.settle(historyRun, item.record.event.id, code === 200 || code === 201, item.record.event.id, code);
              if (code === 200 || code === 201) {
                await this.queue.acknowledge(item.record.event.id, item.record.event.stateSeries?.samples.length ?? 0);
                if (this.diagnostics?.status().enabled) this.diagnostics.recordUpload(Buffer.byteLength(JSON.stringify({ ...item.record.event, ...(item.image ? {imageBase64: item.image.toString('base64')} : {}) })));
                this.lastUploadAt = new Date().toISOString(); this.archiveAcknowledgment={at:this.lastUploadAt,origin:this.config.serverUrl};
              }
              else if (code === 409 || code === 410) await this.queue.blockSync(item.record.event.id, moteText("中央记录冲突或已删除，本机副本保留待处理。"));
              else { await this.queue.failed(item.record.event.id); incomplete = true; }
            }
            if (incomplete) { this.lastUploadError = moteText("部分记录未确认，已保留等待重试"); break; }
            count += batch.length - 1;
          } else {
            if (!entry) break;
            sliceBytes+=Buffer.byteLength(JSON.stringify(entry.record.event))+Math.ceil((entry.image?.length??0)/3)*4+64;
            if (historyRun) this.history!.attempt(historyRun, [captureHistoryItem(entry.record.event)]);
            await uploadCapture(this.config, entry.record.event, entry.image, abort.signal, onBytes);
            if (historyRun) this.history!.settle(historyRun, entry.record.event.id, true, entry.record.event.id);
            await this.queue.acknowledge(entry.record.event.id, entry.record.event.stateSeries?.samples.length??0);
          }
          void this.events?.record('UPLOAD', 'OK', { elapsedMs: Date.now() - uploadStarted });
          if (!this.config.packedUpload && this.diagnostics?.status().enabled) this.diagnostics.recordUpload(Buffer.byteLength(JSON.stringify({ ...entry.record.event, ...(entry.image ? { imageBase64: entry.image.toString('base64') } : {}) })));
          this.lastUploadAt = new Date().toISOString(); if(!this.config.packedUpload)this.archiveAcknowledgment={at:this.lastUploadAt,origin:this.config.serverUrl}; this.lastUploadError = undefined;completed++;
        } catch (error) {
          // Reading/validating the first item has never been an upload attempt.
          if (!entry) throw error;
          if (historyRun) for (const item of attempted) this.history!.settle(historyRun, item.record.event.id, false, undefined, error instanceof TransportFailure ? error.httpStatus : undefined, abort.signal.aborted);
          if (abort.signal.aborted) break;
          const stage: EventStage = error instanceof TransportFailure ? 'UPLOAD' : 'QUEUE';
          void this.events?.record(stage, failureCode(error, stage), {errorName:safeErrorName(error),...(error instanceof TransportFailure ? { httpStatus: error.httpStatus } : {})});
          if (error instanceof DeletedCaptureFailure || (error instanceof TransportFailure && (error.httpStatus === 410 || error.httpStatus === 409))) {
            await this.queue.blockSync(entry.record.event.id, error.httpStatus === 409 ? moteText("中央记录冲突或已删除，本机副本保留待处理。") : moteText("中央已删除此记录，不会重新创建；本机副本保留待处理。"));
            this.lastUploadError = error.message;
            continue; // A permanent conflict on one item must not hold up unrelated records.
          } else await this.queue.failed(entry.record.event.id);
          this.lastUploadError = error instanceof Error ? error.message : moteText("上传失败，队列已保留");
          break;
        }
      }
      liveBytes=preferSince===undefined?0:liveBytes+sliceBytes;
      return completed;
      };
      await flushCaptures();
      if (!abort.signal.aborted && !this.lastUploadError) {
        await this.sources?.flushPending(abort.signal,async()=>{await flushCaptures();if(this.lastUploadError)throw new Error(this.lastUploadError);}, historyRun ? {observer:this.history!.observer(historyRun),onBytes:onBytes!} : undefined);
        for(let round=1;round<captureRounds&&!abort.signal.aborted&&!this.lastUploadError;round++){
          if(!await flushCaptures())break;
        }
        if (pending.pendingRecords > this.pendingSync().pendingRecords || pending.pendingUpdates > this.pendingSync().pendingUpdates) this.lastUploadAt = new Date().toISOString();
        if(pending.pendingRecords>this.pendingSync().pendingRecords)this.archiveAcknowledgment={at:this.lastUploadAt!,origin:this.config.serverUrl};
        await this.queue.syncCheckpoint(this.lastUploadAt,undefined,this.archiveAcknowledgment);
      }
    } catch (error) {
      if (!abort.signal.aborted) { this.lastUploadError = error instanceof Error ? error.message : moteText("同步失败，本地记录已保留"); await this.queue.syncCheckpoint(this.lastUploadAt, new Date(Date.now() + 30000).toISOString(),this.archiveAcknowledgment).catch(() => undefined); }
      void this.events?.record('QUEUE', 'STORAGE', {errorName:safeErrorName(error)}); }
    finally { try { if (historyRun) this.history!.finish(historyRun, abort.signal.aborted); } finally { this.uploading = false; this.publish(); } }
  }
  private async sendHeartbeat(explicit = false): Promise<void> {
    if (this.config.syncPaused || this.closed || this.connectionHeld || this.heartbeatInFlight || !this.config.serverUrl || !connectionToken(this.config) || (this.config.syncMode === 'manual' && !explicit) || !this.queue.binding.matches(this.config)) return;
    this.heartbeatInFlight = true;
    const abort=this.heartbeatAbort=new AbortController();
    const state = this.state === 'stopped' ? 'paused' : this.state;
    try {
      const metadata = this.config.metadataEnabled ? await collectRecordMetadata(this.helperPath, this.queue.directory, undefined, abort.signal) : undefined;
      const sync = this.syncStatus();
      await heartbeat(this.config, {
        metadata, deviceId: this.config.deviceId, deviceName: this.config.deviceName, platform: currentPlatform,
        status: state, queueDepth: this.queue.stats().depth, lastCaptureAt: this.lastCaptureAt, error: this.lastUploadError,
        sync: {
          mode: sync.mode, state: explicit && !sync.pendingRecords && !this.pendingSync().pendingUpdates && !this.pendingSync().heldUpdates && !this.lastUploadError ? 'idle' : sync.state,
          intervalMinutes: this.config.syncIntervalMinutes, batchSize: this.config.syncBatchSize,
          pendingRecords: Math.min(1_000_000, sync.pendingRecords), lastUploadAt: sync.lastUploadAt, nextUploadAt: sync.nextUploadAt,
        },
      }, this.events, abort.signal);
    } catch (error) { void this.events?.record('HEARTBEAT', failureCode(error, 'HEARTBEAT'), {errorName:safeErrorName(error)}); }
    finally { this.heartbeatInFlight = false; }
  }
}
