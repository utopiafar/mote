import {ChromeCaptureBridge} from './chrome-bridge';
import {registerChromeNativeHost} from './chrome-registration';
import {appearancePreference,resolveColorScheme,linearUiTheme,type AppearancePreference} from '@mote/shared';
import { connectionToken, loginRequest, loginVerifier } from './login-session';
import { SyncHistory, type SyncHistoryQuery, type SyncHistoryContentQuery } from './sync-history';
import { localContentPage, localContentDetail, centralContentPage } from './content-library';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { syncContent, readCentralContent } from './sync-content';
import { AskClient } from './ask';
import {storageStatistics} from '@mote/shared/storage-statistics';
import { moteText, statusMessage, configureLocale, getLocale, negotiateLocale, languagePreference, type LanguagePreference } from '@mote/shared/i18n';
import {discoverCodingAgents} from './coding-agents';
import {nativeCalendarActions} from './calendar-actions';
import {previewWork} from './background';
import { collectRecordMetadata } from './record-metadata';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, session, shell, systemPreferences, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { DiagnosticsRecorder } from '@mote/diagnostics';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { readPowerState, recognizeInvitationQr, runHelper, readInstalledApplications } from './native';
import { ConnectionOnboarding, ConnectionError, testConnection, assertConnectionChangeSafe, type ConnectionStatus } from './connection';
import { NoteDraftStore, type NoteDraft } from './note-draft';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCentralBrowser,validateCentralWorkId } from './central-browser';
import {centralWorkActivity} from './work-activity';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolveProfile, profileDefaults, isDevelopmentProfile } from './profile';
import { desktopSecretStorage } from './secret-storage';
import { EventJournal, buildSupportBundle, failureCode, safeErrorName, type EventStage } from './support';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile, open, mkdir } from 'node:fs/promises';
import { currentPlatform, Collector } from './collector';
import { ConfigStore, updateConfig, signedOutConfig } from './config';
import { LocalSourceManager } from './source-manager';
import { normalizeSourceOptions } from './source-types';
import { DesktopUpdater } from './updater';
import { createUpdateNetwork } from './update-network';
import { createChromiumUpdateFetch } from './electron-update-fetch';
import { acknowledgeInstalledUpdate } from './update-install';
import { QueueStorage, StorageCommitUncertainError } from './queue-storage';
import { DurableQueue } from './queue';
import { BackgroundJobs } from './background-jobs';
import {ensureStorageFormat} from './storage-format';
import { browseCaptures, captureDetail, captureImage, type BrowseRequest, type CaptureLocation } from './capture-browser';
import type { Config, ConfigUpdate, Status } from './contracts';

const defaultDataDirectory = app.getPath('userData');
const developmentBuild=Boolean((require('../package.json') as {moteDevelopment?:boolean}).moteDevelopment);
const desktopDevDownloadsUrl='https://github.com/utopiafar/mote/releases?q=desktop-dev-+prerelease%3Atrue+draft%3Afalse&expanded=true';
const profile = resolveProfile(process.argv, developmentBuild?{...process.env,MOTE_PROFILE:process.env.MOTE_PROFILE??'dev'}:process.env, defaultDataDirectory);
const developmentProfile = isDevelopmentProfile(profile, developmentBuild);
if (!profile.defaultProfile) {
  mkdirSync(profile.dataDirectory, { recursive: true, mode: 0o700 });
  const sessionDirectory = join(profile.dataDirectory, 'session');
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile.dataDirectory); app.setPath('sessionData', sessionDirectory);
}
const appearanceFile=join(profile.dataDirectory,'appearance.json');
let preferredAppearance:AppearancePreference='auto';
try { preferredAppearance=appearancePreference(JSON.parse(readFileSync(appearanceFile,'utf8'))); } catch { /* New/invalid preferences follow the OS. */ }
nativeTheme.themeSource=preferredAppearance==='auto'?'system':preferredAppearance;
function appearanceState(){return {preference:preferredAppearance,scheme:resolveColorScheme(preferredAppearance,nativeTheme.shouldUseDarkColors)};}
function appearanceBackground(){return linearUiTheme.schemes![appearanceState().scheme].background;}
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
        { label: moteText("工作台"), accelerator: 'CmdOrCtrl+1', click: () => showClientPage('overview') },
        { label: moteText("随手记"), accelerator: 'CmdOrCtrl+2', click: () => showClientPage('notes') },
        { label: moteText("来源"), accelerator: 'CmdOrCtrl+3', click: () => showClientPage('sources') },
      ] },
      { label: moteText("显示"), submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(developmentProfile ? [{role:'toggleDevTools' as const}] : [])] },
      { role: 'windowMenu', label: moteText("窗口") },
    ]));
}
const profileLabel = profile.name;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quickNoteWindow: BrowserWindow | undefined;
let openQuickNote: (()=>Promise<void>) | undefined;
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
function clientStatus(): Status { return { ...includePreparedNote(collector.status()), operations: backgroundJobs.snapshot(), storage: storageStatus(), credentialStorage: developmentProfile ? 'json' : 'system', environment: { profile: profile.name, defaultProfile: profile.defaultProfile, dataDirectory: profile.dataDirectory } }; }
const backgroundJobs = new BackgroundJobs();
let controlChain: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlChain.then(() => { if (recoveryRequired) throw new Error(recoveryRequired); return operation(); });
  controlChain = result.catch(() => undefined);
  return result;
}
function encryptedStorageAvailable(): boolean {
  if (developmentProfile) return false;
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
let browserLogin: ((page?:string,evidenceId?:string,durationMs?:number,workId?:string)=>Promise<void>)|undefined;
let ensureBrowserLogin: (()=>Promise<void>)|undefined;
async function showCentral(page?: string, evidenceId?: string,workId?:string): Promise<void> {
  if(!connectionToken(settings)){if(browserLogin)return browserLogin(page,evidenceId,undefined,workId);throw Error(moteText('请先登录中央节点，各页面会共用这次登录。'));}
  await ensureBrowserLogin?.();
  const {code}=await loginRequest(settings,'/api/login/ticket',{expiresAt:settings.authExpiresAt},connectionToken(settings));
  await openCentralBrowser(settings.serverUrl, page, process.platform,
    url => promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', url]), url => shell.openExternal(url), evidenceId, code,undefined,workId);
}
function showWindow(): void { window?.show(); window?.focus(); }
function showClientPage(page: 'overview' | 'notes' | 'sources' | 'settings' | 'central'): void {
  if (page === 'notes') { void openQuickNote?.(); return; }
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
  status = { ...includePreparedNote(status), operations: backgroundJobs.snapshot(), storage: storageStatus(), credentialStorage: developmentProfile ? 'json' : 'system', environment: { profile: profile.name, defaultProfile: profile.defaultProfile, dataDirectory: profile.dataDirectory } };
  if (window && !window.isDestroyed()) window.webContents.send('mote:status', status);
  if (quickNoteWindow && !quickNoteWindow.isDestroyed()) quickNoteWindow.webContents.send('mote:status', status);
  tray?.setToolTip(moteText("Mote [{0}] · {1} · 待上传 {2}", profile.name, status.running ? moteText("采集中") : moteText("已停止"), status.queueDepth));
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `Mote [${profile.name}] · ${status.running ? moteText("采集中") : moteText("已停止")}`, enabled: false },
    { label: moteText("待上传 {0} 条", status.queueDepth), enabled: false },
    { type: 'separator' },
    { label: moteText("打开 Mote"), click: () => showClientPage('overview') },
    { label: moteText("随手记"), click: () => showClientPage('notes') },
    { label: moteText("打开中央仓库"), click: () => showClientPage('central') },
    { label: moteText("设置…"), click: () => showClientPage('settings') },
    { label: status.running ? moteText("停止采集") : moteText("开始采集"), click: () => { if(status.running){collector.stop();void serialize(()=>collector.settleCapture());}else void serialize(()=>collector.start()).catch(error=>dialog.showErrorBox(moteText("无法开始采集"),(error as Error).message)); } },
    { label: moteText("立即发送"), enabled: !status.config.syncPaused, click: () => { void serialize(async()=>{await localSources?.sync(true);await collector.retry();}).catch(error=>dialog.showErrorBox(moteText("立即发送"),(error as Error).message)); } },
    { type: 'separator' },
    { label: moteText("退出 Mote（停止采集和上传）"), click: () => app.quit() },
  ]));
}

let chromeCaptureBridge:ChromeCaptureBridge|undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => {
    quitting = true; void events.record('APP', 'STOPPED'); collector?.shutdown();
    if (notesSettledForQuit) return;
    event.preventDefault();
    void Promise.allSettled([controlChain, settleNoteWork(), localSources?.close(), updater?.close(), chromeCaptureBridge?.close(), collector?.settleCapture()]).then(() => events.read()).finally(() => { notesSettledForQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray keeps the collector and durable uploader alive. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    await mkdir(profile.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectory = await realpath(profile.dataDirectory);
    await ensureStorageFormat(dataDirectory,['config.json','queue','notes','local-sources','content-key.json']);
    const secrets = desktopSecretStorage(profile, developmentBuild, () => safeStorage);
    const store = new ConfigStore(dataDirectory, secrets, () => profileDefaults(profile, {}, developmentBuild), () => profileDefaults(profile, process.env, developmentBuild));
    settings = await store.load();
    await store.save(settings); // Persist stable device identity before the first observation.
    void events.record('APP', 'STARTED');
    const noteDrafts = new NoteDraftStore(join(dataDirectory, 'notes')); await noteDrafts.initialize();
    const storage = new QueueStorage(dataDirectory, profile.name, settings.deviceId, [dataDirectory, ...await Promise.all([defaultDataDirectory, `${defaultDataDirectory}-profiles`].map(path => realpath(path).catch(() => resolve(path))))]);
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
    const diagnostics = new DiagnosticsRecorder(join(dataDirectory, 'diagnostics'));
    const configureDiagnostics = async () => diagnostics.configure({ enabled: settings.diagnosticsEnabled, intervalMs: settings.diagnosticIntervalSeconds * 1000 }, async () => ({
      queueBytes: queue.stats().bytes, modelBytes: 0, ...await readPowerState(helperPath).catch(() => ({})),
    }));
    const syncHistory = new SyncHistory(join(dataDirectory,'sync-history.sqlite')); await syncHistory.initialize();
    if(process.platform==='darwin'){chromeCaptureBridge=new ChromeCaptureBridge({profileDirectory:dataDirectory,helperPath});await chromeCaptureBridge.start();}
    collector = new Collector(settings, queue, helperPath, encryptedStorageAvailable, updateUi, diagnostics, events, localSources,syncHistory,chromeCaptureBridge);
    let calendarDelivery:Promise<void>|undefined;
    const calendarTimer=setInterval(()=>{
      if(calendarDelivery||settings.syncPaused||!connectionToken(settings)||!settings.serverUrl||settings.syncMode==='manual'||process.platform!=='darwin')return;
      calendarDelivery=nativeCalendarActions({...settings},helperPath,dataDirectory).deliver().catch(()=>{}).finally(()=>{calendarDelivery=undefined;});
    },60000);calendarTimer.unref();
    app.once('before-quit',()=>clearInterval(calendarTimer));

    await configureDiagnostics();
    const pageUrl = pathToFileURL(join(__dirname, 'index.html')).href;
    window = new BrowserWindow({
      width: 1140, height: 840, minWidth: 820, minHeight: 620, title: `Mote [${profileLabel}]`, backgroundColor: appearanceBackground(),
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: developmentProfile },
    });
    const broadcastAppearance=()=>{window?.setBackgroundColor(appearanceBackground());window?.webContents.send('mote:appearance',appearanceState());};
    nativeTheme.on('updated',broadcastAppearance);
    window.once('closed',()=>nativeTheme.removeListener('updated',broadcastAppearance));
    refreshApplicationMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    const trusted = (event: IpcMainInvokeEvent) => {
      if (!([window,quickNoteWindow].some(owned=>owned && !owned.isDestroyed() && event.sender===owned.webContents && event.senderFrame===owned.webContents.mainFrame && event.senderFrame?.url===(owned===quickNoteWindow?pageUrl+'#quick-note':pageUrl)))) throw new Error(moteText("请求来源不受信任"));
    };
    openQuickNote=async()=>{
      if(quickNoteWindow&&!quickNoteWindow.isDestroyed()){quickNoteWindow.show();quickNoteWindow.focus();return;}
      const noteWindow=new BrowserWindow({width:480,height:560,minWidth:380,minHeight:420,title:moteText('随手记'),backgroundColor:appearanceBackground(),webPreferences:{preload:join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:developmentProfile}});
      quickNoteWindow=noteWindow;
      noteWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      noteWindow.webContents.on('will-navigate',event=>event.preventDefault());
      noteWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
      const appearance=()=>{noteWindow.setBackgroundColor(appearanceBackground());noteWindow.webContents.send('mote:appearance',appearanceState());};nativeTheme.on('updated',appearance);
      noteWindow.once('closed',()=>{nativeTheme.removeListener('updated',appearance);if(quickNoteWindow===noteWindow)quickNoteWindow=undefined;});
      await noteWindow.loadURL(pageUrl+'#quick-note');
    };
    ipcMain.on('mote:appearance-initial' ,(event)=>{trusted(event);event.returnValue=appearanceState();});
    ipcMain.handle('mote:set-appearance',(event,raw:unknown)=>{
      trusted(event);
      if(raw!=='auto'&&raw!=='light'&&raw!=='dark')throw Error('Invalid appearance');
      writeFileSync(appearanceFile+'.tmp',JSON.stringify(raw),{mode:0o600});
      renameSync(appearanceFile+'.tmp',appearanceFile);
      preferredAppearance=raw;nativeTheme.themeSource=raw==='auto'?'system':raw;
      broadcastAppearance();return appearanceState();
    });
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
    // Retain authored keys: a renderer locale change does not restart the main process.
    const operationLabels: Record<string, string> = {
      'mote:configure': "正在应用设置或迁移存储", 'mote:import-queue': "正在导入队列", 'mote:export-queue': "正在导出队列",
      'mote:source-sync': "正在扫描并同步来源",
      'mote:retry': "正在同步待发记录", 'mote:source-files': "正在连接文件来源", 'mote:source-update': "正在保存来源设置",
      'mote:source-calendar': "正在连接日历", 'mote:calendar-authorize': "正在读取日历授权", 'mote:installed-applications': "正在读取应用列表",
      'mote:support-export': "正在导出支持包", 'mote:diagnostics-export': "正在导出诊断", 'mote:diagnostics-sample': "正在读取诊断",
      'mote:connection-confirm': "正在连接中央节点", 'mote:connection-test': "正在测试连接",
      'mote:update-download': "正在下载更新", 'mote:update-install': "正在准备安装更新", 'mote:update-check': "正在检查更新",
      'mote:start': "正在准备采集", 'mote:stop': "正在结束当前采集", 'mote:note': "正在保存随手记",
    };
    const handle = (channel: string, operation: (...args: unknown[]) => unknown) => {
      const stage: EventStage | undefined = ({ 'mote:source-sync': 'SOURCE', 'mote:source-files': 'SOURCE', 'mote:source-calendar': 'SOURCE', 'mote:source-update': 'SOURCE', 'mote:connection-confirm': 'CONNECTION', 'mote:connection-test': 'CONNECTION', 'mote:update-check': 'UPDATE', 'mote:update-download': 'UPDATE', 'mote:update-install': 'UPDATE', 'mote:retry': 'UPLOAD', 'mote:configure': 'CONFIG', 'mote:start': 'CAPTURE', 'mote:stop': 'CAPTURE', 'mote:note': 'NOTE', 'mote:note-draft-update': 'NOTE', 'mote:support-export': 'SUPPORT', 'mote:import-queue': 'QUEUE', 'mote:export-queue': 'QUEUE' } as Record<string, EventStage>)[channel];
    ipcMain.handle(channel, async (event, ...args) => {
        trusted(event);
        if (recoveryRequired && !['mote:get-status', 'mote:storage-restart', 'mote:stop', 'mote:note-draft', 'mote:connection-status', 'mote:update-status', 'mote:sources'].includes(channel)) throw new Error(recoveryRequired);
        const startedAt = Date.now();
        if (stage && channel !== 'mote:note-draft-update') void events.record(stage, 'STARTED', {operation:channel});
        try { const label = operationLabels[channel]; const result = await (label ? backgroundJobs.run(channel, label, () => operation(...args)) : operation(...args)); if (stage && channel !== 'mote:note-draft-update') void events.record(stage, 'OK', { elapsedMs: Date.now() - startedAt,operation:channel }); return result; }
        catch (error) { if (stage) void events.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt,operation:channel,errorName:safeErrorName(error) }); throw error; }
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
      try {
        if (profile.defaultProfile && updated.openAtLogin !== previous.openAtLogin) {
          app.setLoginItemSettings({ openAtLogin: updated.openAtLogin });
          if (app.getLoginItemSettings().openAtLogin !== updated.openAtLogin) throw new Error(moteText("系统未允许修改登录启动项，请在系统设置检查"));
        }
        await localSources!.changeConnection(updated);
        settings = updated; collector.updateConfig(updated); await configureDiagnostics();
        if (relocating) await queue.relocate(updated.captureStorageDirectory || storage.defaultDirectory, storage, () => store.save(updated), async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory, value => backgroundJobs.progress('mote:configure', value));
        else await store.save(updated);
      } catch (error) {
        // A failed directory fsync may follow a successful rename. Preserve both copies and stop all IO.
        const persisted = await store.load().catch(() => undefined);
        if (error instanceof StorageCommitUncertainError || !persisted || JSON.stringify(persisted) === JSON.stringify(updated)) {
          requireRecovery(moteText("设置提交需要恢复；已停止采集与上传并保留数据，请重新打开 Mote。"));
          throw new Error(recoveryRequired);
        }
        try {
          await localSources!.changeConnection(previous);
          settings = previous; collector.updateConfig(previous); await configureDiagnostics();
          if (profile.defaultProfile && updated.openAtLogin !== previous.openAtLogin) {
            app.setLoginItemSettings({ openAtLogin: previous.openAtLogin });
            if (app.getLoginItemSettings().openAtLogin !== previous.openAtLogin) throw new Error(moteText("登录项还原失败"));
          }
        } catch {
          requireRecovery(moteText("设置未完成；原持久配置和截图保留，运行状态无法安全还原。请重新打开 Mote 后重试")); throw new Error(recoveryRequired);
        }
        throw error;
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
      connectionState = { state: 'unchecked', message: moteText("连接已保存，可测试权限与节点版本") };
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
      if (!secrets.available()) throw new Error(moteText("系统加密存储不可用，不能交换并保存凭据"));
      if (typeof deviceName !== 'string') throw new Error('Invalid device name');
      const named = updateConfig(settings, { ...settings, deviceName });
      const result = await onboarding.redeem(id, origin, named, currentPlatform);
      const updated = { ...updateConfig(settings, { ...named, serverUrl: result.serverUrl, token: result.token }), credentialScope: result.scope, authSignedOut:false, authExpiresAt:undefined, authSessionOnly:false };
      const identity = await testConnection(updated);
      if (identity.credential.id !== result.credentialId || identity.credential.scope !== 'owner') throw new Error(moteText("中央凭据身份确认不一致，原连接未修改；请重新生成邀请"));
      await commitConnection(updated, origin === settings.serverUrl, true);
      connectionState = { state: 'connected', message: moteText("登录成功，可使用所有中央功能。"), checkedAt: new Date().toISOString(), identity };
    }, origin === settings.serverUrl, true); return clientStatus(); }));
    handle('mote:connection-test', async () => {
      if (connectionState.state === 'checking') return connectionState;
      const requested = settings; connectionState = { state: 'checking', message: moteText("正在验证已保存连接与权限…") };
      try { const identity = await testConnection(requested); if (settings === requested) connectionState = { state: 'connected', message: moteText("管理员连接正常 · 可访问完整中央仓库"), checkedAt: new Date().toISOString(), identity }; }
      catch (error) { if (settings === requested) connectionState = { state: 'error', message: error instanceof ConnectionError ? error.message : moteText("连接检查失败；已保存配置未改变"), checkedAt: new Date().toISOString() }; }
      return connectionState;
    });
    handle('mote:sync-paused', paused => serialize(async () => {
      if(typeof paused!=='boolean')throw new Error('Invalid paused sync setting');
      const previous=settings,updated=updateConfig(settings,{...settings,syncPaused:paused});
      if(paused){await collector.setSyncPaused(true);await localSources!.setSyncPaused(true);}
      try {
        await store.save(updated);settings=updated;
        // A resume takes effect only after it is durable; scans and sampling never stop.
        await localSources!.setSyncPaused(paused);await collector.setSyncPaused(paused);
      }catch(error){
        const persisted=await store.load().catch(()=>undefined);
        if(!persisted||JSON.stringify(persisted)===JSON.stringify(updated)){requireRecovery(moteText("设置提交需要恢复；已停止采集与上传并保留数据，请重新打开 Mote。"));throw error;}
        await collector.setSyncPaused(Boolean(previous.syncPaused));await localSources!.setSyncPaused(Boolean(previous.syncPaused));throw error;
      }
      return clientStatus();
    }));
    handle('mote:get-status', () => clientStatus());
    const browseWithConnection = async <T>(operation: (config: Config) => Promise<T>): Promise<T> => {
      const requested = settings; const result = await operation(requested);
      if (settings !== requested) throw new Error(moteText("连接已改变，请刷新采集记录")); return result;
    };
    handle('mote:work-activity',input=>browseWithConnection(config=>centralWorkActivity(config,input as import('./work-activity').WorkActivityQuery|undefined)));
    handle('mote:sync-history', input => syncHistory.page(settings,input as SyncHistoryQuery));
    handle('mote:sync-history-contents', input => syncHistory.contents(settings,input as SyncHistoryContentQuery));
    handle('mote:sync-history-content', (runId,key,offset,includeImage) => browseWithConnection(config => { if(typeof runId!=='string'||typeof key!=='string')throw Error('Invalid sync content reference'); return syncContent(syncHistory,queue,localSources!,config,runId,key,offset as number|undefined,includeImage===undefined?true:includeImage===true); }));
    handle('mote:sync-history-pending', () => {
      const pending=queue.historyPending();
      const rows=localSources!.status();
      return [...pending,...(['file','calendar','coding'] as const).map(source=>{const sources=rows.filter(r=>source==='file'?r.source.kind==='local-files':source==='calendar'?r.source.kind==='local-calendar':r.source.kind.startsWith('coding-'));return {source,pending:sources.reduce((sum,r)=>sum+r.pending+(r.blocked??0),0),review:0,blocked:sources.reduce((sum,r)=>sum+(r.blocked??0),0),retrying:sources.reduce((sum,r)=>sum+(r.state==='error'?r.pending:0),0)};})];
    });
    handle('mote:compression-preview', (quality, maxSide) => previewWork.run({kind:'compression-preview', quality:quality as number,maxSide:maxSide as number}));
    handle('mote:captures-browse', input => browseWithConnection(config => browseCaptures(queue, config, input as BrowseRequest)));
    handle('mote:captures-detail', (location, id) => browseWithConnection(config => captureDetail(queue, config, location as CaptureLocation, id as string)));
    handle('mote:captures-image', (location, id, thumbnail) => browseWithConnection(config => captureImage(queue, config, location as CaptureLocation, id as string, thumbnail as boolean)));
    handle('mote:chrome-setup',async()=>{
      if(process.platform!=='darwin')throw Error('Chrome capture requires macOS');
      const extensionDirectory=app.isPackaged?join(process.resourcesPath,'chrome-extension'):join(__dirname,'..','chrome-extension');
      const result=await registerChromeNativeHost({profileDirectory:dataDirectory,extensionDirectory,electronExecutable:process.execPath,nativeHostScript:join(__dirname,'chrome-native-host.js')});
      await shell.openPath(extensionDirectory);return result;
    });
    handle('mote:installed-applications', () => process.platform === 'darwin' ? readInstalledApplications(helperPath).catch(() => []) : []);
    const devUpdateStatus = () => ({...updater!.status(), manualDownload:true, state:'idle' as const, canInstall:false, availableVersion:undefined, notesUrl:desktopDevDownloadsUrl, message:moteText('查看版本说明与安装包'), installReason:''});
    handle('mote:update-status', () => developmentBuild ? devUpdateStatus() : updater!.status());
    handle('mote:update-channel', channel => updater!.setChannel(channel));
    handle('mote:update-check', () => developmentBuild ? devUpdateStatus() : updater!.check());
    handle('mote:update-download', () => updater!.download());
    handle('mote:update-cancel', () => updater!.cancel());
    handle('mote:update-install', () => serialize(() => updater!.install(async () => { collector.stop(); await collector.settleCapture(); await settleNoteWork(); }, () => app.quit())));
    handle('mote:update-reveal', () => { const archive = updater!.archivePath(); if (archive) shell.showItemInFolder(archive); });
    handle('mote:update-notes', async () => { const url = developmentBuild ? desktopDevDownloadsUrl : updater!.status().notesUrl; if (url) await shell.openExternal(url); });
    handle('mote:feedback', () => shell.openExternal(githubFeedbackUrl({
      version: app.getVersion(),
      platform: `${process.platform === 'darwin' ? 'macOS' : currentPlatform} ${process.getSystemVersion()} · ${process.arch}`,
      environment: moteText("桌面客户端 · {0}", ['dev', 'test', 'prod', 'default'].includes(profile.name) ? profile.name : moteText("自定义环境")),
    })));
    handle('mote:coding-agents', () => discoverCodingAgents());
    handle('mote:source-coding', (provider, options) => serialize(() => { if (provider !== 'claude' && provider !== 'codex' && provider !== 'kimi') throw new Error(moteText("不支持的 Coding Agent")); return localSources!.addCodingAgent(provider, options); }));
    handle('mote:sources', () => localSources!.status());
    handle('mote:source-sync', async () => { const scan = localSources!.sync(true); await collector.retry(); await scan; await collector.retry(); });
    handle('mote:action-calendar-connect', () => serialize(() => nativeCalendarActions({...settings},helperPath,dataDirectory).connect()));
    handle('mote:calendar-authorize', () => serialize(() => localSources!.authorizeCalendar()));
    handle('mote:source-calendar', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error(moteText("日历选择无效")); await localSources!.addCalendar(id, options); }));
    handle('mote:source-update', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error(moteText("来源选择无效")); await localSources!.update(id, options); }));
    const sourceSelections = new Map<string,string[]>();
    handle('mote:source-select', mode => serialize(async () => {
      if (mode !== 'files' && mode !== 'directory') throw new Error(moteText("文件选择方式无效"));
      const result = await dialog.showOpenDialog(window!, {title:mode==='directory'?moteText("同步文件夹"):moteText("导入文件"),properties:mode==='directory'?['openDirectory']:['openFile','multiSelections']});
      if (result.canceled || !result.filePaths.length) return {canceled:true};
      // Paths remain in the privileged process; the renderer can confirm only this native selection.
      sourceSelections.clear(); const selectionId=randomUUID(); sourceSelections.set(selectionId,result.filePaths);
      return {canceled:false,selectionId,names:result.filePaths.map(path=>basename(path))};
    }));
    handle('mote:source-cancel', id => { if (typeof id === 'string') sourceSelections.delete(id); });
    handle('mote:source-confirm', (id,input) => serialize(async () => {
      const paths=typeof id==='string'?sourceSelections.get(id):undefined;
      if (!paths) throw new Error(moteText("文件选择已失效，请重新选择"));
      const options=normalizeSourceOptions(input);
      // Remove successful members individually: a retry after a partial failure never duplicates them.
      while(paths.length) { await localSources!.addFiles(paths[0],options); paths.shift(); }
      sourceSelections.delete(id as string);
    }));
    handle('mote:content-central', cursor => browseWithConnection(config=>centralContentPage(config,cursor as string|undefined)));
    handle('mote:content-central-detail',(id,offset,image)=>browseWithConnection(config=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id)||offset!==undefined&&(!Number.isSafeInteger(offset)||Number(offset)<0))throw Error('Invalid content reference');return readCentralContent(config,{key:id,captureId:id,source:'file',title:'',observedAt:'',outcome:'received',firstReceipt:false},Number(offset??0),image===true);}));
    handle('mote:content-local', offset => localContentPage(queue,localSources!,offset as number|undefined));
    handle('mote:content-local-detail', (key,image) => browseWithConnection(() => localContentDetail(queue,localSources!,key as string,image as boolean|undefined).catch(async error=>{
      if(typeof key!=='string')throw error;const parts=key.split(':');const receiptKey=parts[0]==='queue'?parts[1]:parts[0]==='source'?require('node:crypto').createHash('sha256').update(`${parts[1]}\0${parts[2]}`).digest('hex'):undefined;
      const id=receiptKey?syncHistory.receivedCapture(settings,receiptKey):undefined;if(!id)throw error;return readCentralContent(settings,{key:receiptKey!,captureId:id,source:'file',title:'',observedAt:'',outcome:'received',firstReceipt:false,...(parts[0]==='source'?{sourceId:parts[1]}:{})},0,image===true);
    })));
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
    handle('mote:central', async (page, evidenceId) => {
      if (evidenceId !== undefined && typeof evidenceId !== 'string') throw new Error('Invalid evidence reference');
      await showCentral(typeof page === 'string' ? page : undefined, evidenceId);
    });
    handle('mote:central-work',async workId=>showCentral('activity',undefined,validateCentralWorkId(workId)));
    handle('mote:quick-note', () => openQuickNote?.());
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
      let updated = updateConfig(settings, input as ConfigUpdate, queue.stats().depth + (noteDrafts.hasPrepared() ? 1 : 0), confirmedInitial);
      if (!profile.defaultProfile && updated.openAtLogin) throw new Error(moteText("命名环境请使用带 --profile 的启动命令；系统默认登录项不能保留环境参数"));
      const relocating = updated.captureStorageDirectory !== settings.captureStorageDirectory;
      const changingConnection = updated.serverUrl !== settings.serverUrl || updated.token !== settings.token;
      if (relocating && updated.captureStorageDirectory && updated.captureStorageDirectory !== pendingStorageDirectory) throw new Error(moteText("请通过本机文件夹选择器选择截图位置，再保存设置"));
      if (relocating && changingConnection) throw new Error(moteText("请先保存截图位置，再单独保存节点连接；每次切换均会自动应用"));
      if(changingConnection&&updated.token){
        const identity=await testConnection(updated,fetch,false);
        if(!identity.capabilities.archiveRead)throw Error(moteText('请升级中央节点后再登录。'));
        if(identity.credential.id==='owner'||identity.credential.deviceId!==updated.deviceId){const grant=await loginRequest(updated,'/api/login/session',{serverUrl:updated.serverUrl,deviceId:updated.deviceId,deviceName:updated.deviceName,platform:currentPlatform,durationMs:30*86400000},updated.token);updated={...updated,token:grant.token,authExpiresAt:grant.expiresAt};}
        updated={...updated,credentialScope:'owner',authSignedOut:false,authSessionOnly:false};
      }
      if (changingConnection) await connectionChange(() => commitConnection(updated, false, confirmedInitial), false, confirmedInitial);
      else await pausedSettings(() => applySettings(updated));
      updateUi(clientStatus()); return clientStatus();
    }));
    handle('mote:start', () => serialize(async () => { await collector.start(); return clientStatus(); }));
    handle('mote:stop', () => { collector.stop(); return serialize(async () => { await collector.settleCapture(); return clientStatus(); }); });
    handle('mote:review-pending', () => queue!.reviewPending());
    handle('mote:review-reject', async (id:unknown) => { if(typeof id!=='string')throw Error('Invalid review ID');await queue!.rejectReview(id); });
    handle('mote:review-approve', async (id:unknown) => { if(typeof id!=='string')throw Error('Invalid review ID');await queue!.approveReview(id); });
    handle('mote:retry', async () => { const scan = localSources!.sync(true); await collector.retry(); await scan; await collector.retry(); return clientStatus(); });
    const askClient = new AskClient(config=>config.serverUrl===settings.serverUrl&&config.token===settings.token&&config.authSignedOut===settings.authSignedOut&&config.authExpiresAt===settings.authExpiresAt);
    let loginGeneration=0;
    const endLogin=()=>serialize(async()=>{
      loginGeneration++;
      const previous=settings, token=connectionToken(previous);
      // Locally sign out even when the node is offline; never fall back to another credential.
      await pausedSettings(()=>applySettings(signedOutConfig(previous)));
      if(token)await loginRequest(previous,'/api/login/logout',{},token).catch(()=>{});
      updateUi(clientStatus());
    });
    const installLogin=async(token:string,durationMs=30*86400000,expectedGeneration=loginGeneration)=>{
      if(![0,86400000,604800000,2592000000].includes(durationMs))throw Error('Invalid lifetime');
      const requested=settings;
      const identity=await testConnection({...requested,token},fetch,false);
      if(!identity.capabilities.archiveRead)throw Error(moteText('请升级中央节点后再登录。'));
      let credential=token,expiresAt=durationMs?Date.now()+durationMs:undefined;
      let minted=false;
      if(identity.credential.id==='owner'||identity.credential.deviceId!==requested.deviceId){
        const grant=await loginRequest(requested,'/api/login/session',{serverUrl:requested.serverUrl,deviceId:requested.deviceId,deviceName:requested.deviceName,platform:currentPlatform,durationMs},token);credential=grant.token;expiresAt=grant.expiresAt;minted=true;
      }
      try {
        await serialize(()=>{
          // Check after waiting for other settings/logout operations as well as network I/O.
          if(settings!==requested||expectedGeneration!==loginGeneration)throw Error(moteText('登录会话已变更，请重新打开中央页面。'));
          return connectionChange(()=>commitConnection({...requested,token:credential,credentialScope:'owner',authSignedOut:false,authSessionOnly:durationMs===0,authExpiresAt:expiresAt},true,true),true,true);
        });
      } catch(error) {
        if(minted)await loginRequest(requested,'/api/login/logout',{},credential).catch(()=>{});
        throw error;
      }
      loginGeneration++;updateUi(clientStatus());
      if(requested.token&&requested.token!==credential)await loginRequest(requested,'/api/login/logout',{},requested.token).catch(()=>{});
    };
    ensureBrowserLogin=async()=>{const current=settings;if(connectionToken(current)&&(await testConnection(current)).credential.id==='owner')await installLogin(current.token!,current.authSessionOnly?0:2592000000);};
    browserLogin=async(page,evidenceId,durationMs=2592000000,workId)=>{
      if(![0,86400000,604800000,2592000000].includes(durationMs))throw Error('Invalid lifetime');
      const requested=settings,generation=++loginGeneration,{verifier,challenge}=loginVerifier();
      const {id}=await loginRequest(requested,'/api/login/requests',{serverUrl:requested.serverUrl,deviceId:requested.deviceId,deviceName:requested.deviceName,platform:currentPlatform,challenge,durationMs});
      await openCentralBrowser(requested.serverUrl,page,process.platform,url=>promisify(execFile)('/usr/bin/open',['-a','Google Chrome',url]),url=>shell.openExternal(url),evidenceId,undefined,id,workId);
      const deadline=Date.now()+10*60000;
      while(Date.now()<deadline&&generation===loginGeneration&&settings===requested&&!quitting){
        const grant=await loginRequest(requested,'/api/login/poll',{id,verifier});
        if(grant.ready){await installLogin(grant.token,durationMs,generation);await loginRequest(requested,'/api/login/ack',{id,verifier}).catch(()=>{});return;}
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      throw Error(moteText('登录会话已变更，请重新打开中央页面。'));
    };
    let authCheck:Promise<unknown>|undefined;let nextAuthCheck=0;
    const authTimer=setInterval(()=>{
      if(connectionToken(settings)&&Date.now()>=nextAuthCheck&&!authCheck){const selected=settings;nextAuthCheck=Date.now()+15000;authCheck=testConnection(selected).catch(error=>{if(settings===selected&&error instanceof ConnectionError&&error.code==='AUTH')return endLogin();}).finally(()=>{authCheck=undefined;});}
      if(settings.token&&!settings.authSignedOut&&settings.authExpiresAt&&settings.authExpiresAt<=Date.now())void endLogin().catch(()=>{});
    },1000);authTimer.unref();app.once('before-quit',()=>clearInterval(authTimer));
    handle('mote:ask', async (command,input) => {
      if(command==='login'){const value=input as {token?:string;durationMs?:number};if(typeof value?.token!=='string'||value.token.length<32||value.token.length>8192||/[\r\n]/.test(value.token))throw Error(moteText('请输入有效的中央所有者令牌'));await installLogin(value.token.trim(),value.durationMs);return {};}
      if(command==='logout'){await endLogin();return {};}
      if(command==='login-browser'){await browserLogin!(undefined,undefined,(input as {durationMs?:number})?.durationMs);return {};}
      try{return await askClient.request(settings,command as import('./ask').AskCommand,input as Parameters<AskClient['request']>[2]);}
      catch(error){if(error instanceof Error&&error.message===moteText('令牌无效或已失效，请检查后重新登录。'))await endLogin();throw error;}
    });
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
