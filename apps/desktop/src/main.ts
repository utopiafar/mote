import { AskClient } from './ask';
import {storageStatistics} from '@mote/shared/storage-statistics';
import { moteText, statusMessage, configureLocale, getLocale, negotiateLocale, languagePreference, type LanguagePreference } from '@mote/shared/i18n';
import {discoverCodingAgents} from './coding-agents';
import {nativeCalendarActions} from './calendar-actions';
import {previewWork} from './background';
import { collectRecordMetadata } from './record-metadata';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, safeStorage, session, shell, systemPreferences, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { DiagnosticsRecorder } from '@mote/diagnostics';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { readPowerState, recognizeInvitationQr, runHelper, readInstalledApplications } from './native';
import { ConnectionOnboarding, ConnectionError, testConnection, assertConnectionChangeSafe, type ConnectionStatus } from './connection';
import { NoteDraftStore, type NoteDraft } from './note-draft';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCentralBrowser } from './central-browser';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolveProfile, profileDefaults } from './profile';
import { EventJournal, buildSupportBundle, failureCode, type EventStage } from './support';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile, open, mkdir } from 'node:fs/promises';
import { currentPlatform, Collector } from './collector';
import { ConfigStore, updateConfig } from './config';
import { LocalSourceManager } from './source-manager';
import { normalizeSourceOptions } from './source-types';
import { DesktopUpdater } from './updater';
import { createUpdateNetwork } from './update-network';
import { createChromiumUpdateFetch } from './electron-update-fetch';
import { acknowledgeInstalledUpdate } from './update-install';
import { QueueStorage, StorageCommitUncertainError } from './queue-storage';
import { DurableQueue } from './queue';
import { BackgroundJobs } from './background-jobs';
import { LocalContentKeyStore } from './local-content';
import { browseCaptures, captureDetail, captureImage, type BrowseRequest, type CaptureLocation } from './capture-browser';
import { NsfwController } from './nsfw';
import type { Config, ConfigUpdate, Status } from './contracts';

const legacyDataDirectory = app.getPath('userData');
const developmentBuild=Boolean((require('../package.json') as {moteDevelopment?:boolean}).moteDevelopment);
const profile = resolveProfile(process.argv, developmentBuild?{...process.env,MOTE_PROFILE:process.env.MOTE_PROFILE??'dev'}:process.env, legacyDataDirectory);
if (!profile.legacy) {
  mkdirSync(profile.dataDirectory, { recursive: true, mode: 0o700 });
  const sessionDirectory = join(profile.dataDirectory, 'session');
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile.dataDirectory); app.setPath('sessionData', sessionDirectory);
}
const languageFile = join(profile.dataDirectory, 'language.json');
let preferredLanguage: LanguagePreference = 'system';
try { preferredLanguage = languagePreference(JSON.parse(readFileSync(languageFile, 'utf8'))); } catch { /* Missing or invalid preference follows the system. */ }
configureLocale(() => preferredLanguage === 'system' ? negotiateLocale(app.getPreferredSystemLanguages()) : preferredLanguage);
function languageState() { return { preference: preferredLanguage, locale: getLocale() }; }
function refreshApplicationMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Mote', submenu: [
        { role: 'about', label: moteText("关于 Mote") }, { type: 'separator' },
        { label: moteText("设置…"), accelerator: 'CmdOrCtrl+,', click: () => showClientPage('settings') },
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: moteText("退出 Mote") },
      ] },
      { role: 'editMenu', label: moteText("编辑") },
      { label: moteText("前往"), submenu: [
        { label: moteText("概览"), accelerator: 'CmdOrCtrl+1', click: () => showClientPage('overview') },
        { label: moteText("随手记"), accelerator: 'CmdOrCtrl+2', click: () => showClientPage('notes') },
        { label: moteText("来源"), accelerator: 'CmdOrCtrl+3', click: () => showClientPage('sources') },
      ] },
      { label: moteText("显示"), submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(!app.isPackaged || developmentBuild ? [{role:'toggleDevTools' as const}] : [])] },
      { role: 'windowMenu', label: moteText("窗口") },
    ]));
}
const profileLabel = profile.legacy ? moteText("legacy（日常原目录）") : profile.name;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let collector: Collector;
let localSources: LocalSourceManager | undefined;
let updater: DesktopUpdater | undefined;
const onboarding = new ConnectionOnboarding();
let connectionState: ConnectionStatus = { state: 'unchecked', get message() { return moteText("连接尚未检查"); } };
let quitting = false;
let notesSettledForQuit = false;
const noteWork = new Set<Promise<unknown>>();
function trackNote<T>(task: Promise<T>): Promise<T> {
  noteWork.add(task); void task.then(() => noteWork.delete(task), () => noteWork.delete(task)); return task;
}
async function settleNoteWork(): Promise<void> { while (noteWork.size) await Promise.allSettled([...noteWork]); }
let settings: Config;
let recoveryRequired: string | undefined;
const events = new EventJournal(join(profile.dataDirectory, 'diagnostics'), () => Boolean(settings?.diagnosticsEnabled));
let pendingNoteStatus = () => ({ count: 0, unbound: true, baseRecords: undefined as number | undefined });
function includePreparedNote(status: Status): Status { const note = pendingNoteStatus(); return { ...status, sync: { ...status.sync, pendingRecords: (note.baseRecords ?? status.sync.pendingRecords) + note.count, localBacklogUnbound: (note.baseRecords ?? status.sync.pendingRecords) + note.count > 0 && note.unbound } }; }
let storageStatus: () => Status['storage'] = () => undefined;
function clientStatus(): Status { return { ...includePreparedNote(collector.status()), operations: backgroundJobs.snapshot(), storage: storageStatus(), environment: { profile: profile.name, legacy: profile.legacy, dataDirectory: profile.dataDirectory } }; }
const backgroundJobs = new BackgroundJobs();
let controlChain: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlChain.then(() => { if (recoveryRequired) throw new Error(recoveryRequired); return operation(); });
  controlChain = result.catch(() => undefined);
  return result;
}
function encryptedStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
async function showCentral(page?: string): Promise<void> {
  await openCentralBrowser(settings.serverUrl, page, process.platform,
    url => promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', url]), url => shell.openExternal(url));
}
function showWindow(): void { window?.show(); window?.focus(); }
function showClientPage(page: 'overview' | 'notes' | 'sources' | 'settings'): void {
  showWindow(); window?.webContents.send('mote:navigate', page);
}
function trayIcon(): Electron.NativeImage {
  const bitmap = Buffer.alloc(20 * 20 * 4);
  for (let y = 4; y < 16; y++) for (let x = 3; x < 17; x++) {
    if (x < 6 || x > 13 || (y < 10 && (Math.abs(x - (y - 1)) <= 1 || Math.abs(x - (20 - y)) <= 1))) bitmap[(y * 20 + x) * 4 + 3] = 255;
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: 20, height: 20 });
  icon.setTemplateImage(true);
  return icon;
}
function updateUi(status: Status): void {
  status = { ...includePreparedNote(status), operations: backgroundJobs.snapshot(), storage: storageStatus(), environment: { profile: profile.name, legacy: profile.legacy, dataDirectory: profile.dataDirectory } };
  if (window && !window.isDestroyed()) window.webContents.send('mote:status', status);
  tray?.setToolTip(moteText("Mote [{0}] · {1} · 待上传 {2}", profile.name, status.running ? moteText("采集中") : moteText("已停止"), status.queueDepth));
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `Mote [${profile.name}] · ${status.running ? moteText("采集中") : moteText("已停止")}`, enabled: false },
    { label: moteText("待上传 {0} 条", status.queueDepth), enabled: false },
    { type: 'separator' },
    { label: moteText("打开 Mote"), click: () => showClientPage('overview') },
    { label: moteText("随手记"), click: () => showClientPage('notes') },
    { label: moteText("设置…"), click: () => showClientPage('settings') },
    { label: moteText("打开中央仓库"), click: () => { void showCentral().catch(e => dialog.showErrorBox(moteText("中央仓库"), (e as Error).message)); } },
    { label: moteText("开始采集"), enabled: !status.running, click: () => { void serialize(() => collector.start()).catch(error => dialog.showErrorBox(moteText("无法开始采集"), (error as Error).message)); } },
    { label: moteText("停止采集"), enabled: status.running, click: () => { collector.stop(); void serialize(() => collector.settleCapture()); } },
    { type: 'separator' },
    { label: moteText("退出 Mote（停止采集和上传）"), click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => {
    quitting = true; void events.record('APP', 'STOPPED'); collector?.shutdown();
    if (notesSettledForQuit) return;
    event.preventDefault();
    void Promise.allSettled([controlChain, settleNoteWork(), localSources?.close(), updater?.close(), collector?.settleCapture()]).then(() => events.read()).finally(() => { notesSettledForQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray keeps the collector and durable uploader alive. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    await mkdir(profile.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectory = await realpath(profile.dataDirectory);
    const secrets = {
      available: encryptedStorageAvailable,
      encrypt: (value: string) => safeStorage.encryptString(value),
      decrypt: (value: Buffer) => safeStorage.decryptString(value),
    };
    const store = new ConfigStore(dataDirectory, secrets, () => profileDefaults(profile, {}), () => profileDefaults(profile, process.env));
    settings = await store.load();
    const contentKeys = new LocalContentKeyStore(dataDirectory, secrets);
    await contentKeys.initialize(false);
    await store.save(settings); // Persist stable device identity before the first observation.
    void events.record('APP', 'STARTED');
    const noteDrafts = new NoteDraftStore(join(dataDirectory, 'notes')); await noteDrafts.initialize();
    const storage = new QueueStorage(dataDirectory, profile.name, settings.deviceId, [dataDirectory, ...await Promise.all([legacyDataDirectory, `${legacyDataDirectory}-profiles`].map(path => realpath(path).catch(() => resolve(path))))]);
    const queue = new DurableQueue(await storage.open(settings.captureStorageDirectory), settings);
    queue.setStorageGuard(async () => { if (recoveryRequired) throw new Error(recoveryRequired); await storage.assertOwned(queue.directory); });
    await queue.initialize();
    await storage.recover(queue.directory);
    storageStatus = () => ({ directory: queue.directory, defaultDirectory: storage.defaultDirectory, custom: queue.directory !== storage.defaultDirectory, cleanupPending: storage.cleanupPending, recoveryRequired });
    let pendingStorageDirectory: string | undefined;

    pendingNoteStatus = () => ({ count: noteDrafts.hasPrepared() && !queue.contains(noteDrafts.get().id) ? 1 : 0, unbound: queue.binding.unbound() && (!localSources || localSources.nodeBinding.unbound()) && (!noteDrafts.hasPrepared() || noteDrafts.hasUnboundPrepared()), baseRecords: queue.stats().depth + (localSources?.pendingStats().pendingRecords ?? 0) });
    const helperPath = app.isPackaged ? join(process.resourcesPath, 'native', 'mote-helper') : join(__dirname, '..', 'native', 'bin', 'mote-helper');
    const bundlePath = app.isPackaged ? await realpath(resolve(process.resourcesPath, '../..')) : undefined;
    const updateDirectory = join(dataDirectory, 'updates');
    const updateSession = session.fromPartition('mote-public-updates', { cache: false });
    updater = new DesktopUpdater({ directory: updateDirectory, helper: app.isPackaged ? join(process.resourcesPath, 'native', 'mote-updater') : join(__dirname, '..', 'native', 'bin', 'mote-updater'), bundlePath, currentVersion: app.getVersion(), arch: process.arch === 'arm64' ? 'arm64' : 'x64', profile: profile.name }, createUpdateNetwork(createChromiumUpdateFetch(options => net.request({ ...options, session: updateSession }))));
    await updater.initialize();
    localSources = new LocalSourceManager(join(dataDirectory, 'local-sources'), settings, helperPath, true, events);
    await localSources.initialize();
    const nsfw = new NsfwController(join(dataDirectory, 'models'), app.isPackaged ? join(process.resourcesPath, 'native', 'mote-qwen') : join(__dirname, '..', 'native', 'bin', 'mote-qwen'), () => { if (collector) updateUi(clientStatus()); }, { events });
    const diagnostics = new DiagnosticsRecorder(join(dataDirectory, 'diagnostics'));
    const configureDiagnostics = async () => diagnostics.configure({ enabled: settings.diagnosticsEnabled, intervalMs: settings.diagnosticIntervalSeconds * 1000 }, async () => ({
      queueBytes: queue.stats().bytes, modelBytes: nsfw.status().bytes, ...await readPowerState(helperPath).catch(() => ({})),
    }));
    collector = new Collector(settings, queue, helperPath, encryptedStorageAvailable, updateUi, nsfw, diagnostics, events, localSources);
    let calendarDelivery:Promise<void>|undefined;
    const calendarTimer=setInterval(()=>{
      if(calendarDelivery||!settings.token||!settings.serverUrl||settings.syncMode==='manual'||process.platform!=='darwin')return;
      calendarDelivery=nativeCalendarActions({...settings},helperPath,dataDirectory).deliver().catch(()=>{}).finally(()=>{calendarDelivery=undefined;});
    },60000);calendarTimer.unref();
    app.once('before-quit',()=>clearInterval(calendarTimer));

    await nsfw.initialize();
    await configureDiagnostics();
    const pageUrl = pathToFileURL(join(__dirname, 'index.html')).href;
    window = new BrowserWindow({
      width: 1140, height: 840, minWidth: 820, minHeight: 620, title: `Mote [${profileLabel}]`, backgroundColor: '#f7f8f5',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged || developmentBuild },
    });
    refreshApplicationMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    const trusted = (event: IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl || event.senderFrame !== window.webContents.mainFrame) throw new Error(moteText("请求来源不受信任"));
    };
      ipcMain.handle('mote:language', event => { trusted(event); return languageState(); });
    ipcMain.handle('mote:set-language', async (event, raw: unknown) => {
      trusted(event);
      if (!['system', 'zh-CN', 'en'].includes(String(raw))) throw new Error('Invalid language');
      await Promise.all([...noteWork]);
      const next = languagePreference(raw);
      writeFileSync(languageFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(languageFile + '.tmp', languageFile);
      preferredLanguage = next; refreshApplicationMenu(); updateUi(clientStatus());
      // Renderer navigation is blocked; only this trusted IPC may reload its fixed page.
      setTimeout(() => window?.webContents.reload(), 20);
      return languageState();
    });
    const operationLabels: Record<string, string> = {
      'mote:configure': moteText("正在应用设置或迁移存储"), 'mote:import-queue': moteText("正在导入队列"), 'mote:export-queue': moteText("正在导出队列"),
      'mote:model-import': moteText("正在导入并校验模型"), 'mote:model-reload': moteText("正在校验模型"), 'mote:source-sync': moteText("正在扫描并同步来源"),
      'mote:retry': moteText("正在同步待发记录"), 'mote:source-files': moteText("正在连接文件来源"), 'mote:source-update': moteText("正在保存来源设置"),
      'mote:source-calendar': moteText("正在连接日历"), 'mote:calendar-authorize': moteText("正在读取日历授权"), 'mote:installed-applications': moteText("正在读取应用列表"),
      'mote:support-export': moteText("正在导出支持包"), 'mote:diagnostics-export': moteText("正在导出诊断"), 'mote:diagnostics-sample': moteText("正在读取诊断"),
      'mote:connection-confirm': moteText("正在连接中央节点"), 'mote:connection-test': moteText("正在测试连接"),
      'mote:update-download': moteText("正在下载更新"), 'mote:update-install': moteText("正在准备安装更新"), 'mote:update-check': moteText("正在检查更新"),
      'mote:start': moteText("正在准备采集"), 'mote:stop': moteText("正在结束当前采集"), 'mote:note': moteText("正在保存随手记"),
    };
    const handle = (channel: string, operation: (...args: unknown[]) => unknown) => {
      const stage: EventStage | undefined = ({ 'mote:source-sync': 'SOURCE', 'mote:source-files': 'SOURCE', 'mote:source-calendar': 'SOURCE', 'mote:source-update': 'SOURCE', 'mote:connection-confirm': 'CONNECTION', 'mote:connection-test': 'CONNECTION', 'mote:update-check': 'UPDATE', 'mote:update-download': 'UPDATE', 'mote:update-install': 'UPDATE', 'mote:retry': 'UPLOAD', 'mote:configure': 'CONFIG', 'mote:start': 'CAPTURE', 'mote:stop': 'CAPTURE', 'mote:note': 'NOTE', 'mote:note-draft-update': 'NOTE', 'mote:model-download': 'MODEL_DOWNLOAD', 'mote:model-import': 'MODEL_DOWNLOAD', 'mote:model-reload': 'MODEL', 'mote:support-export': 'SUPPORT', 'mote:import-queue': 'QUEUE', 'mote:export-queue': 'QUEUE' } as Record<string, EventStage>)[channel];
    ipcMain.handle(channel, async (event, ...args) => {
        trusted(event);
        if (recoveryRequired && !['mote:get-status', 'mote:storage-restart', 'mote:stop', 'mote:note-draft', 'mote:connection-status', 'mote:update-status', 'mote:sources'].includes(channel)) throw new Error(recoveryRequired);
        const startedAt = Date.now();
        if (stage && channel !== 'mote:note-draft-update') void events.record(stage, 'STARTED');
        try { const label = operationLabels[channel]; const result = await (label ? backgroundJobs.run(channel, label, () => operation(...args)) : operation(...args)); if (stage && channel !== 'mote:note-draft-update' && channel !== 'mote:model-download') void events.record(stage, 'OK', { elapsedMs: Date.now() - startedAt }); return result; }
        catch (error) { if (stage) void events.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt }); throw error; }
      });
    };
    const unboundBacklog = () => queue.binding.unbound() && localSources!.nodeBinding.unbound() && (!noteDrafts.hasPrepared() || noteDrafts.hasUnboundPrepared());
    const pausedSettings = async <T>(operation: () => Promise<T>): Promise<T> => {
      const releaseCollector = await collector.suspendForSettings(); let releaseSources: (() => void) | undefined;
      try { releaseSources = await localSources!.holdConnection(); return await operation(); }
      finally {
        releaseSources?.();
        // changeConnection's forced scan is suppressed while held. Resume it after settings settle;
        // managed sources only stage locally here, leaving uploads to the collector's sync policy.
        if (releaseSources && !quitting && !recoveryRequired) void localSources!.sync(true);
        await releaseCollector();
      }
    };
    const connectionChange = async <T>(operation: () => Promise<T>, sameNodeInvitation = false, confirmedInitial = false): Promise<T> => pausedSettings(async () => {
      const source = localSources!.connectionActivity();
      assertConnectionChangeSafe({ running: clientStatus().running, inFlight: collector.connectionActivity().inFlight, queued: queue.stats().depth, preparedNote: noteDrafts.hasPrepared(), sourcePending: source.pending, sourceInFlight: source.inFlight }, sameNodeInvitation || (confirmedInitial && unboundBacklog()));
      return operation();
    });
    const requireRecovery = (message: string): void => { recoveryRequired = message; collector.requireRecovery(message); void localSources!.close(); };
    const applySettings = async (updated: Config): Promise<void> => {
      const previous = settings;
      const relocating = updated.captureStorageDirectory !== previous.captureStorageDirectory;
      const modelSourceChanged = updated.nsfwSource !== previous.nsfwSource || updated.nsfwCustomUrl !== previous.nsfwCustomUrl;
      const wasDownloading = modelSourceChanged && nsfw.status().downloading;
      let saved = false;
      try {
        await contentKeys.setEnabled(updated.localContentEncryption);
        if (modelSourceChanged) await nsfw.cancelDownload();
        if (profile.legacy && updated.openAtLogin !== previous.openAtLogin) {
          app.setLoginItemSettings({ openAtLogin: updated.openAtLogin });
          if (app.getLoginItemSettings().openAtLogin !== updated.openAtLogin) throw new Error(moteText("系统未允许修改登录启动项，请在系统设置检查"));
        }
        await localSources!.changeConnection(updated);
        settings = updated; collector.updateConfig(updated); await configureDiagnostics();
        if (relocating) await queue.relocate(updated.captureStorageDirectory || storage.defaultDirectory, storage, () => store.save(updated), async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory, value => backgroundJobs.progress('mote:configure', value));
        else await store.save(updated);
        saved = true;
      } catch (error) {
        // A failed directory fsync may follow a successful rename. Preserve both copies and stop all IO.
        const persisted = await store.load().catch(() => undefined);
        if (error instanceof StorageCommitUncertainError || !persisted || JSON.stringify(persisted) === JSON.stringify(updated)) {
          requireRecovery(moteText("设置提交需要恢复；已停止采集与上传并保留数据，请重新打开 Mote。"));
          throw new Error(recoveryRequired);
        }
        try {
          await contentKeys.setEnabled(previous.localContentEncryption);
          await localSources!.changeConnection(previous);
          settings = previous; collector.updateConfig(previous); await configureDiagnostics();
          if (profile.legacy && updated.openAtLogin !== previous.openAtLogin) {
            app.setLoginItemSettings({ openAtLogin: previous.openAtLogin });
            if (app.getLoginItemSettings().openAtLogin !== previous.openAtLogin) throw new Error(moteText("登录项还原失败"));
          }
        } catch {
          requireRecovery(moteText("设置未完成；原持久配置和截图保留，运行状态无法安全还原。请重新打开 Mote 后重试")); throw new Error(recoveryRequired);
        }
        throw error;
      } finally {
        if (wasDownloading && !quitting && !recoveryRequired) nsfw.startDownload(saved ? updated : previous);
      }
      pendingStorageDirectory = undefined;
    };
    const commitConnection = async (updated: Config, sameNodeInvitation = false, confirmedInitial = false): Promise<void> => {
      // Checkpoint before config save so a crash cannot switch credentials without the original source queue.
      const initial = confirmedInitial && unboundBacklog();
      queue.binding.assertChange(updated, queue.stats().depth > 0 || noteDrafts.hasPrepared(), initial, sameNodeInvitation);
      localSources!.nodeBinding.assertChange(updated, localSources!.connectionActivity().pending > 0, initial, sameNodeInvitation);
      if (initial) await localSources!.prepareInitialConnection(updated);
      else if (sameNodeInvitation) await localSources!.prepareReauthorization(updated);
      // Bind before config persistence: after a crash, a mismatched editable config cannot upload old bodies.
      await queue.binding.commit(updated, queue.stats().depth > 0 || noteDrafts.hasPrepared(), initial, sameNodeInvitation);
      await localSources!.nodeBinding.commit(updated, localSources!.connectionActivity().pending > 0, initial, sameNodeInvitation);
      if (initial) await noteDrafts.bindPreparedOrigin(updated.serverUrl);
      if (sameNodeInvitation) await queue.resetRetries();
      await applySettings(updated);
      connectionState = { state: 'unchecked', message: updated.credentialScope === 'collector' ? moteText("已安全保存采集凭据；可测试连接。完整仓库需单独管理员登录。") : moteText("连接已保存，可测试权限与节点版本") };
    };
    const readSelectedInvitation = async (path: string, maximum: number): Promise<Buffer> => {
      const file = await open(path, 'r');
      try { const buffer = Buffer.alloc(maximum + 1); const read = await file.read(buffer, 0, buffer.length, 0); if (read.bytesRead > maximum) throw new Error(moteText("连接邀请文件超过大小限制")); return buffer.subarray(0, read.bytesRead); }
      finally { await file.close(); }
    };
    handle('mote:connection-status', () => ({...connectionState, message: statusMessage(connectionState.message)}));
    handle('mote:connection-preview', input => onboarding.preview(input));
    handle('mote:connection-cancel', () => onboarding.clear());
    handle('mote:connection-import', kind => serialize(async () => {
      if (kind !== 'json' && kind !== 'qr') throw new Error(moteText("邀请导入方式无效"));
      onboarding.clear();
      if (kind === 'qr' && process.platform !== 'darwin') throw new Error(moteText("二维码图片导入暂仅支持 macOS，请使用 JSON 或连接链接"));
      const selected = await dialog.showOpenDialog(window!, { title: kind === 'qr' ? moteText("选择中央连接二维码图片") : moteText("选择中央连接邀请 JSON"), properties: ['openFile'], filters: [{ name: kind === 'qr' ? 'QR image' : 'Mote connection JSON', extensions: kind === 'qr' ? ['png', 'jpg', 'jpeg'] : ['json', 'txt'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      try {
        const bytes = await readSelectedInvitation(selected.filePaths[0], kind === 'qr' ? 8 * 1024 * 1024 : 8192);
        const input = kind === 'qr' ? await recognizeInvitationQr(helperPath, bytes) : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { canceled: false, preview: onboarding.preview(input) };
      } catch { throw new Error(moteText("无法读取有效邀请，请检查 JSON/二维码格式、有效期和文件大小；原连接未变动")); }
    }));
    handle('mote:connection-confirm', (id, origin, deviceName) => serialize(async () => { await connectionChange(async () => {
      if (!encryptedStorageAvailable()) throw new Error(moteText("系统加密存储不可用，不能交换并保存凭据"));
      if (typeof deviceName !== 'string') throw new Error('Invalid device name');
      const named = updateConfig(settings, { ...settings, deviceName });
      const result = await onboarding.redeem(id, origin, named, currentPlatform);
      const updated = { ...updateConfig(settings, { ...named, serverUrl: result.serverUrl, token: result.token }), credentialScope: result.scope };
      const identity = await testConnection(updated);
      if (identity.credential.id !== result.credentialId || identity.credential.scope !== 'collector') throw new Error(moteText("中央凭据身份确认不一致，原连接未修改；请重新生成邀请"));
      await commitConnection(updated, origin === settings.serverUrl, true);
      connectionState = { state: 'connected', message: moteText("采集连接成功；可上传记录与同步自身来源，完整仓库需单独管理员登录"), checkedAt: new Date().toISOString(), identity };
    }, origin === settings.serverUrl, true); return clientStatus(); }));
    handle('mote:connection-test', async () => {
      if (connectionState.state === 'checking') return connectionState;
      const requested = settings; connectionState = { state: 'checking', message: moteText("正在验证已保存连接与权限…") };
      try { const identity = await testConnection(requested); if (settings === requested) connectionState = { state: 'connected', message: identity.credential.scope === 'collector' ? moteText("采集连接正常 · 仅上传与自身来源同步") : moteText("管理员连接正常 · 可访问完整中央仓库"), checkedAt: new Date().toISOString(), identity }; }
      catch (error) { if (settings === requested) connectionState = { state: 'error', message: error instanceof ConnectionError ? error.message : moteText("连接检查失败；已保存配置未改变"), checkedAt: new Date().toISOString() }; }
      return connectionState;
    });
    handle('mote:get-status', () => clientStatus());
    const browseWithConnection = async <T>(operation: (config: Config) => Promise<T>): Promise<T> => {
      const requested = settings; const result = await operation(requested);
      if (settings !== requested) throw new Error(moteText("连接已改变，请刷新采集记录")); return result;
    };
    handle('mote:compression-preview', (quality, maxSide) => previewWork.run({kind:'compression-preview', quality:quality as number,maxSide:maxSide as number}));
    handle('mote:captures-browse', input => browseWithConnection(config => browseCaptures(queue, config, input as BrowseRequest)));
    handle('mote:captures-detail', (location, id) => browseWithConnection(config => captureDetail(queue, config, location as CaptureLocation, id as string)));
    handle('mote:captures-image', (location, id, thumbnail) => browseWithConnection(config => captureImage(queue, config, location as CaptureLocation, id as string, thumbnail as boolean)));
    handle('mote:installed-applications', () => process.platform === 'darwin' ? readInstalledApplications(helperPath).catch(() => []) : []);
    handle('mote:update-status', () => updater!.status());
    handle('mote:update-channel', channel => updater!.setChannel(channel));
    handle('mote:update-check', () => updater!.check());
    handle('mote:update-download', () => updater!.download());
    handle('mote:update-cancel', () => updater!.cancel());
    handle('mote:update-install', () => serialize(() => updater!.install(async () => { collector.stop(); await collector.settleCapture(); await settleNoteWork(); }, () => app.quit())));
    handle('mote:update-reveal', () => { const archive = updater!.archivePath(); if (archive) shell.showItemInFolder(archive); });
    handle('mote:update-notes', async () => { const url = updater!.status().notesUrl; if (url) await shell.openExternal(url); });
    handle('mote:feedback', () => shell.openExternal(githubFeedbackUrl({
      version: app.getVersion(),
      platform: `${process.platform === 'darwin' ? 'macOS' : currentPlatform} ${process.getSystemVersion()} · ${process.arch}`,
      environment: moteText("桌面客户端 · {0}", ['dev', 'test', 'prod', 'legacy'].includes(profile.name) ? profile.name : moteText("自定义环境")),
    })));
    handle('mote:coding-agents', () => discoverCodingAgents());
    handle('mote:source-coding', (provider, options) => serialize(() => { if (provider !== 'claude' && provider !== 'codex' && provider !== 'kimi') throw new Error(moteText("不支持的 Coding Agent")); return localSources!.addCodingAgent(provider, options); }));
    handle('mote:sources', () => localSources!.status());
    handle('mote:source-sync', async () => { await localSources!.sync(true); await collector.retry(); });
    handle('mote:calendar-authorize', () => serialize(() => localSources!.authorizeCalendar()));
    handle('mote:source-calendar', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error(moteText("日历选择无效")); await localSources!.addCalendar(id, options); }));
    handle('mote:source-update', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error(moteText("来源选择无效")); await localSources!.update(id, options); }));
    handle('mote:source-files', (mode, input) => serialize(async () => {
      const options = normalizeSourceOptions(input);
      if (mode !== 'files' && mode !== 'directory') throw new Error(moteText("文件选择方式无效"));
      const result = await dialog.showOpenDialog(window!, { title: moteText("选择持续同步到中央仓库的本地资料"), properties: mode === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'], ...(mode === 'files' ? { filters: [{ name: moteText("UTF-8 文本资料"), extensions: options.extensions.map(e => e.slice(1)) }] } : {}) });
      if (result.canceled) return { canceled: true };
      for (const path of result.filePaths) await localSources!.addFiles(path, options);
      return { canceled: false };
    }));
    handle('mote:calendar-permissions', async () => { if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'); });
    handle('mote:diagnostics-sample', async () => { await diagnostics.sample(); updateUi(clientStatus()); return clientStatus(); });
    handle('mote:storage-statistics',async()=>storageStatistics([dataDirectory,queue.directory]));
    handle('mote:events-raw', async () => events.readRaw());
    handle('mote:events-read', async () => events.read(true));
    handle('mote:diagnostics-export', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: moteText("导出本机数值诊断（不含内容与令牌）"), defaultPath: 'mote-diagnostics.json', filters: [{ name: 'JSON diagnostics', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await diagnostics.sample(); await diagnostics.exportTo(selected.filePath); return { canceled: false };
    });
    handle('mote:support-export', async rawHours => {
      const hours=rawHours===undefined?24:Number(rawHours);if(![1,24,168].includes(hours))throw new Error('Invalid log range');
      const selected = await dialog.showSaveDialog(window!, { title: moteText("导出支持包（数值与固定事件，不含内容和令牌）"), defaultPath: `mote-support-${profile.name}.json`, filters: [{ name: 'JSON support bundle', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await diagnostics.sample();
      const logs=await events.exportRange(Date.now()-hours*3600000);
      await writeFile(selected.filePath, JSON.stringify({...buildSupportBundle(profile, app.getVersion(), clientStatus(), logs.events),...logs}, null, 2), { mode: 0o600 });
      return { canceled: false };
    });
    handle('mote:central', async page => { await showCentral(typeof page === 'string' ? page : undefined); });
    handle('mote:note-draft', () => noteDrafts.get());
    handle('mote:note-draft-update', input => trackNote(noteDrafts.update(input as NoteDraft)));
    handle('mote:note', input => trackNote(serialize(async () => {
      const result = await noteDrafts.submit(input as NoteDraft, settings, currentPlatform, queue, () => collectRecordMetadata(helperPath, dataDirectory, 'manual'));
      updateUi(clientStatus()); if (!quitting) void collector.upload(); return result;
    })));
    handle('mote:storage-restart', () => { app.relaunch(); app.quit(); });
    handle('mote:storage-choose', () => serialize(async () => {
      const selected = await dialog.showOpenDialog(window!, { title: moteText("选择本机截图保存位置"), buttonLabel: moteText("选择位置"), properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      pendingStorageDirectory = await storage.candidate(selected.filePaths[0], queue.directory);
      return { canceled: false, directory: pendingStorageDirectory };
    }));
    handle('mote:storage-open', async () => {
      await storage.assertOwned(queue.directory); const error = await shell.openPath(queue.directory); if (error) throw new Error(moteText("无法打开截图目录，请检查磁盘是否已连接"));
    });
    handle('mote:configure', input => serialize(async () => {
      const confirmedInitial = (input as ConfigUpdate).confirmLocalBacklog === true && unboundBacklog();
      const updated = updateConfig(settings, input as ConfigUpdate, queue.stats().depth + (noteDrafts.hasPrepared() ? 1 : 0), confirmedInitial);
      if (!profile.legacy && updated.openAtLogin) throw new Error(moteText("命名环境请使用带 --profile 的启动命令；系统默认登录项不能保留环境参数"));
      const relocating = updated.captureStorageDirectory !== settings.captureStorageDirectory;
      const changingConnection = updated.serverUrl !== settings.serverUrl || updated.token !== settings.token;
      if (relocating && updated.captureStorageDirectory && updated.captureStorageDirectory !== pendingStorageDirectory) throw new Error(moteText("请通过本机文件夹选择器选择截图位置，再保存设置"));
      if (relocating && changingConnection) throw new Error(moteText("请先保存截图位置，再单独保存节点连接；每次切换均会自动应用"));
      if (changingConnection) await connectionChange(() => commitConnection(updated, false, confirmedInitial), false, confirmedInitial);
      else await pausedSettings(() => applySettings(updated));
      updateUi(clientStatus()); return clientStatus();
    }));
    handle('mote:start', () => serialize(async () => { await collector.start(); return clientStatus(); }));
    handle('mote:stop', () => { collector.stop(); return serialize(async () => { await collector.settleCapture(); return clientStatus(); }); });
    handle('mote:review-pending', () => queue!.reviewPending());
    handle('mote:review-reject', async (id:unknown) => { if(typeof id!=='string')throw Error('Invalid review ID');await queue!.rejectReview(id); });
    handle('mote:review-approve', async (id:unknown) => { if(typeof id!=='string')throw Error('Invalid review ID');await queue!.approveReview(id); });
    handle('mote:retry', async () => { await localSources!.sync(true); await collector.retry(); return clientStatus(); });
    const requireStopped = async () => {
      if (clientStatus().running) throw new Error(moteText("请先停止采集，再修改本地模型"));
      await collector.settleCapture();
    };
    handle('mote:model-download', () => serialize(async () => { await requireStopped(); nsfw.startDownload(settings); return clientStatus(); }));
    handle('mote:model-cancel', async () => { await nsfw.cancelDownload(); return clientStatus(); });
    handle('mote:model-reload', () => serialize(async () => { await requireStopped(); await nsfw.reload(); return clientStatus(); }));
    handle('mote:model-import', () => serialize(async () => {
      await requireStopped();
      const selected = await dialog.showOpenDialog(window!, { title: moteText("导入千问语言模型和视觉投影 GGUF（校验 SHA-256）"), properties: ['openFile', 'multiSelections'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      await nsfw.importFiles(selected.filePaths); return { canceled: false };
    }));
    const askClient = new AskClient();
    handle('mote:ask', (command, input) => askClient.request(settings, command as import('./ask').AskCommand, input as Parameters<AskClient['request']>[2]));
    handle('mote:permission-status', async () => ({
      appPath: bundlePath ?? app.getPath('exe'),
      bundleId: bundlePath ? await promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(bundlePath, 'Contents', 'Info.plist')]).then(result => result.stdout.trim()).catch(() => 'unknown') : 'unpackaged',
      screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unsupported',
      accessibility: process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'unsupported',
      calendar: process.platform === 'darwin' ? await runHelper(helperPath, 'calendar-status').then(value => (value as {status: string}).status).catch(() => 'unknown') : 'unsupported',
    }));
    handle('mote:permission-settings', async kind => {
      const panes: Record<string, string> = { screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', calendar: 'Privacy_Calendars', files: 'Privacy_AllFiles' };
      if (typeof kind !== 'string' || !panes[kind]) throw new Error('Unknown permission');
      if (process.platform === 'darwin') {
        if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + panes[kind]);
      }
    });
    handle('mote:permissions', async () => { if (process.platform === 'darwin') { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); } });
    handle('mote:data-folder', async () => { await shell.openPath(dataDirectory); });
    handle('mote:export-metadata', async () => {
      const selected=await dialog.showSaveDialog(window!,{defaultPath:'mote-local-metadata.json'});
      if(!selected.canceled&&selected.filePath)await writeFile(selected.filePath,JSON.stringify(queue.exportMetadata()),{mode:0o600});
    });
    handle('mote:export-queue', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: moteText("导出已脱敏待上传队列（包含个人资料）"), defaultPath: `mote-queue-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await queue.exportArchiveFile(selected.filePath, value => backgroundJobs.progress('mote:export-queue', value));
      return { canceled: false, path: selected.filePath };
    });
    handle('mote:import-queue', () => serialize(async () => {
      const selected = await dialog.showOpenDialog(window!, { title: moteText("导入 Mote 电脑端队列备份"), properties: ['openFile'], filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      const path = selected.filePaths[0];
      const imported = await queue.importArchiveFile(path, value => backgroundJobs.progress('mote:import-queue', value));
      updateUi(clientStatus()); void collector.upload();
      return { canceled: false, imported };
    }));
    tray = new Tray(trayIcon());
    tray.on('click', showWindow);
    updateUi(clientStatus());
    await window.loadURL(pageUrl);
    await acknowledgeInstalledUpdate({ argv: process.argv, directory: updateDirectory, bundlePath, version: app.getVersion(), profile: profile.name });
    await updater.startupCompleted();
    const receiptTimer = setTimeout(() => { void updater?.startupCompleted(); }, 2500); receiptTimer.unref();
    collector.initialize();
    if (app.getLoginItemSettings().wasOpenedAtLogin) window.hide();
  }).catch(async error => {
    collector?.shutdown();
    const result = await dialog.showMessageBox({ type: 'error', title: moteText("Mote 存储或配置需要恢复"), message: moteText("未开启采集，现有数据已保留"), detail: moteText("{0}\n如使用外接磁盘，请连接原磁盘后重试。应用不会创建空队列替代原目录。", error instanceof Error ? error.message : moteText("无法读取配置或持久队列")), buttons: [moteText("重试"), moteText("退出")], defaultId: 0, cancelId: 1 });
    if (result.response === 0) app.relaunch(); app.quit();
  });
}
