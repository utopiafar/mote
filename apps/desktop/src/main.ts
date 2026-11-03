import '@mote/shared/i18n-all';
import {canSendFromTray,showTraySendFailure} from './tray-send';
import {describeBackupFile} from './queue-backup-identity';
import {appearancePreference,resolveColorScheme,linearUiTheme,type AppearancePreference} from '@mote/shared';
import { connectionToken, loginRequest, loginVerifier } from './login-session';
import { SyncHistory, type SyncHistoryQuery, type SyncHistoryContentQuery } from './sync-history';
import { randomUUID } from 'node:crypto';
import { syncContent } from './sync-content';
import {storageStatistics} from '@mote/shared/storage-statistics';
import { moteText } from '@mote/shared/i18n';
import {discoverCodingAgents} from './coding-agents';
import {nativeCalendarActions} from './calendar-actions';
import { type SettingsWindow } from './permission-types';
import {previewWork} from './background';
import { collectRecordMetadata } from './record-metadata';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, session, shell, systemPreferences, Tray } from 'electron';
import { DesktopPluginHost, electronIpcRouter } from './plugin-host/desktop-host';
import { NativeProviderRegistry } from './plugin-host/native-registry';
import { registerBuiltinDesktopPlugins } from './plugins';
import { createNotesPlugin, notesReadCapability, notesWriteCapability } from './plugins/notes';
import { createLibraryWorkspacePlugin, libraryReadCapability, memoryReadCapability } from './plugins/library-workspace';
import { createChromePlugin, chromeManageCapability, chromeReadCapability, type ChromePlugin } from './plugins/chrome';
import { createSourcesPlugin, sourcesReadCapability, sourcesWriteCapability, type SourcesPlugin } from './plugins/sources';
import { createCapturePlugin, createCaptureStages, captureReadCapability, captureWriteCapability, type CapturePlugin } from './plugins/capture';
import { askCapability, createAskWorkspacePlugin } from './plugins/ask-workspace';
import { createDeviceSettingsPlugin, deviceSettingsReadCapability, deviceSettingsWriteCapability } from './plugins/device-settings';
import type { IpcMainInvokeEvent } from 'electron';
import { DiagnosticsRecorder } from '@mote/diagnostics';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { readPowerState, recognizeInvitationQr, runHelper, readInstalledApplications } from './native';
import { ConnectionError, testConnection } from './connection';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCentralBrowser,validateCentralWorkId } from './central-browser';
import { showCentral as navigateCentral, prepareBrowserSession, pollBrowserLogin, type BrowserLogin } from './central-navigation';
import {centralWorkActivity} from './work-activity';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolveProfile, profileDefaults, isDevelopmentProfile } from './profile';
import { desktopSecretStorage } from './secret-storage';
import { EventJournal, buildSupportBundle, failureCode, safeErrorName, type EventStage } from './support';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { currentPlatform, type Collector } from './collector';
import { signedOutConfig } from './config';
import { DesktopUpdater } from './updater';
import { createUpdateNetwork } from './update-network';
import { createChromiumUpdateFetch } from './electron-update-fetch';
import { acknowledgeInstalledUpdate } from './update-install';
import { QueueStorage } from './queue-storage';
import { QueueImportFailure, DurableQueue } from './queue';
import { BackgroundJobs } from './background-jobs';
import {ensureStorageFormat} from './storage-format';
import type { Config, Status } from './contracts';

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
const secrets = desktopSecretStorage(profile, developmentBuild, () => safeStorage);
const deviceSettings = createDeviceSettingsPlugin({
  directory: profile.dataDirectory,
  secrets,
  defaults: () => profileDefaults(profile, {}, developmentBuild),
  bootstrap: () => profileDefaults(profile, process.env, developmentBuild),
  defaultProfile: profile.defaultProfile,
  platform: currentPlatform,
  systemLanguages: () => app.getPreferredSystemLanguages(),
});
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
        { label: moteText("首页"), accelerator: 'CmdOrCtrl+1', click: () => showClientPage('overview') },
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
let capturePlugin: CapturePlugin | undefined;
let sourcesPlugin: SourcesPlugin | undefined;
let localSources: SourcesPlugin['manager'] | undefined;
let updater: DesktopUpdater | undefined;
let quitting = false;
let notesSettledForQuit = false;
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
let browserLogin: BrowserLogin | undefined;
let ensureBrowserLogin: (()=>Promise<void>)|undefined;
async function showCentral(page?: string, evidenceId?: string,workId?:string,conversationId?:string): Promise<void> {
  return navigateCentral({
    settings: () => settings,
    authorizationGeneration: () => collector.status().authorizationGeneration ?? 0,
    browserLogin: () => browserLogin,
    ensureBrowserLogin: async () => { await ensureBrowserLogin?.(); },
    platform: process.platform,
    launchChrome: url => promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', url]),
    openDefault: url => shell.openExternal(url),
  }, page, evidenceId, workId,conversationId);
}
function showWindow(): void { window?.show(); window?.focus(); }
function showClientPage(page: 'overview' | 'notes' | 'sources' | 'settings' | 'central' | 'capture-start'): void {
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
    { label: status.running ? moteText("停止采集") : moteText("开始采集"), click: () => { if(status.running){collector.stop();void serialize(()=>collector.settleCapture());}else showClientPage('capture-start'); } },
    { label: moteText("立即发送"), enabled: canSendFromTray(status), click: () => { void serialize(async()=>{await localSources?.sync(true);await collector.retry();}).catch(error=>showTraySendFailure(error,options=>dialog.showMessageBox(options))); } },
    { type: 'separator' },
    { label: moteText("退出 Mote（停止采集和上传）"), click: () => app.quit() },
  ]));
}

let chromePlugin:ChromePlugin|undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  let pluginHost: DesktopPluginHost | undefined;
  app.on('before-quit', event => {
    quitting = true; void events.record('APP', 'STOPPED'); capturePlugin?.shutdown();
    if (notesSettledForQuit) return;
    event.preventDefault();
    void Promise.allSettled([controlChain, localSources?.close(), updater?.close(), chromePlugin?.close(), collector?.settleCapture(), pluginHost?.requestQuit()]).then(() => events.read()).finally(() => { notesSettledForQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray keeps the collector and durable uploader alive. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    await mkdir(profile.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectory = await realpath(profile.dataDirectory);
    await ensureStorageFormat(dataDirectory,['config.json','queue','notes','local-sources','content-key.json']);
    await deviceSettings.initialize(dataDirectory);
    settings = deviceSettings.settings();
    const store = deviceSettings.store;
    void events.record('APP', 'STARTED');
    const storage = new QueueStorage(dataDirectory, profile.name, settings.deviceId, [dataDirectory, ...await Promise.all([defaultDataDirectory, `${defaultDataDirectory}-profiles`].map(path => realpath(path).catch(() => resolve(path))))]);
    const queue = new DurableQueue(await storage.open(settings.captureStorageDirectory), settings, createCaptureStages());
    queue.setStorageGuard(async () => { if (recoveryRequired) throw new Error(recoveryRequired); await storage.assertOwned(queue.directory); });
    await queue.initialize();
    await storage.recover(queue.directory);
    storageStatus = () => ({ directory: queue.directory, defaultDirectory: storage.defaultDirectory, custom: queue.directory !== storage.defaultDirectory, cleanupPending: storage.cleanupPending, recoveryRequired });
    let pendingStorageDirectory: string | undefined;

    const helperPath = app.isPackaged ? join(process.resourcesPath, 'native', 'mote-helper') : join(__dirname, '..', 'native', 'bin', 'mote-helper');
    const bundlePath = app.isPackaged ? await realpath(resolve(process.resourcesPath, '../..')) : undefined;
    const updateDirectory = join(dataDirectory, 'updates');
    const updateSession = session.fromPartition('mote-public-updates', { cache: false });
    updater = new DesktopUpdater({ directory: updateDirectory, helper: app.isPackaged ? join(process.resourcesPath, 'native', 'mote-updater') : join(__dirname, '..', 'native', 'bin', 'mote-updater'), bundlePath, currentVersion: app.getVersion(), arch: process.arch === 'arm64' ? 'arm64' : 'x64', profile: profile.name }, createUpdateNetwork(createChromiumUpdateFetch(options => net.request({ ...options, session: updateSession }))));
    await updater.initialize();
    sourcesPlugin = createSourcesPlugin({
      directory: join(dataDirectory, 'local-sources'),
      settings: () => settings,
      helperPath,
      events,
      serialize,
      background: (channel, label, operation) => backgroundJobs.run(channel, label, operation),
      retry: () => collector.retry(),
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
      changed: () => { if (!quitting) updateUi(clientStatus()); },
      choosePaths: async ({mode, purpose, extensions}) => {
        const title = purpose === 'select'
          ? mode === 'directory' ? moteText("同步文件夹") : moteText("导入文件")
          : moteText("选择持续同步到中央仓库的本地资料");
        const result = await dialog.showOpenDialog(window!, {
          title,
          properties: mode === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'],
          ...(purpose === 'import' && mode === 'files' ? {filters: [{name: moteText("UTF-8 文本资料"), extensions: (extensions ?? []).map(extension => extension.slice(1))}]} : {}),
        });
        return {canceled: result.canceled, filePaths: result.filePaths};
      },
      openCalendarPermissions: async () => {
        if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
      },
    });
    localSources = sourcesPlugin.manager;
    await sourcesPlugin.initialize();
    const diagnostics = new DiagnosticsRecorder(join(dataDirectory, 'diagnostics'));
    const configureDiagnostics = async () => diagnostics.configure({ enabled: settings.diagnosticsEnabled, intervalMs: settings.diagnosticIntervalSeconds * 1000 }, async () => ({
      queueBytes: queue.stats().bytes, modelBytes: 0, ...await readPowerState(helperPath).catch(() => ({})),
    }));
    const syncHistory = new SyncHistory(join(dataDirectory,'sync-history.sqlite')); await syncHistory.initialize();
    chromePlugin=createChromePlugin({profileDirectory:dataDirectory,helperPath,extensionDirectory:app.isPackaged?join(process.resourcesPath,'chrome-extension'):join(__dirname,'..','chrome-extension'),electronExecutable:process.execPath,platform:process.platform,settings:()=>settings.chromeOrigins,guard:()=>{if(recoveryRequired)throw new Error(recoveryRequired);},openPath:path=>shell.openPath(path),openExtensions:async url=>{await promisify(execFile)('/usr/bin/open',['-a','Google Chrome',url]);}});await chromePlugin.initialize();
    capturePlugin = createCapturePlugin({
      queue, settings: () => settings, helperPath, encryptedStorageAvailable,
      onChange: updateUi, status: clientStatus, diagnostics, events, sources: localSources,
      history: syncHistory, browserCapture: chromePlugin?.provider, serialize,
      background: (channel, label, operation) => backgroundJobs.run(channel, label, operation),
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
      changed: () => { if (!quitting) updateUi(clientStatus()); },
    });
    collector = capturePlugin.collector;
    let calendarDelivery:Promise<void>|undefined;
    const calendarTimer=setInterval(()=>{
      if(calendarDelivery||settings.syncPaused||!connectionToken(settings)||!settings.serverUrl||settings.syncMode==='manual'||process.platform!=='darwin')return;
      calendarDelivery=nativeCalendarActions({...settings},helperPath,dataDirectory).deliver().catch(()=>{}).finally(()=>{calendarDelivery=undefined;});
    },60000);calendarTimer.unref();
    app.once('before-quit',()=>clearInterval(calendarTimer));

    await configureDiagnostics();
    const pageUrl = pathToFileURL(join(__dirname, 'index.html')).href;
    const notes = createNotesPlugin({
      directory: join(dataDirectory, 'notes'),
      settings: () => settings,
      queue,
      platform: currentPlatform,
      serialize,
      metadata: () => collectRecordMetadata(helperPath, dataDirectory, 'manual'),
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
      onSubmitted: () => { updateUi(clientStatus()); if (!quitting) void collector.upload(); },
      event: (stage, code, details) => void events.record(stage, code, details),
    });
    await notes.initialize();
    deviceSettings.attach({
      collector, sources: localSources!, queue, notes,
      authorizeCalendar: () => sourcesPlugin!.authorizeCalendar(),
      isCalendarPermissionError: error => sourcesPlugin!.isCalendarPermissionError(error),
      loginItems: {set: openAtLogin => app.setLoginItemSettings({openAtLogin}), get: () => app.getLoginItemSettings().openAtLogin},
      running: () => clientStatus().running, quitting: () => quitting,
      recoveryRequired: () => recoveryRequired, requireRecovery: message => requireRecovery(message),
      configureDiagnostics,
      relocate: updated => queue.relocate(updated.captureStorageDirectory || storage.defaultDirectory, storage, () => store.save(updated), async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory, value => backgroundJobs.progress('mote:configure', value)),
      clearStorageSelection: () => { pendingStorageDirectory = undefined; },
      pendingStorageDirectory: () => pendingStorageDirectory,
      status: clientStatus, serialize,
      background: (channel, label, operation) => backgroundJobs.run(channel, label, operation),
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
      changed: () => { if (!quitting) updateUi(clientStatus()); },
      events, onSettings: value => { settings = value; },
      applicationPath: bundlePath ?? app.getPath('exe'),
      canDrag: process.platform === 'darwin' && Boolean(bundlePath),
      bundleId: () => bundlePath ? promisify(execFile)('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(bundlePath, 'Contents', 'Info.plist')]).then(result => result.stdout.trim()).catch(() => 'unknown') : Promise.resolve('unpackaged'),
      mediaAccessStatus: () => systemPreferences.getMediaAccessStatus('screen'),
      accessibilityGranted: () => systemPreferences.isTrustedAccessibilityClient(false),
      calendarStatus: () => runHelper(helperPath, 'calendar-status').then(value => (value as {status: string}).status).catch(() => 'unknown'),
      openExternal: url => shell.openExternal(url),
      restart: () => { app.relaunch(); app.quit(); },
      owner: () => window,
      guideAppPath: bundlePath,
      settingsWindow: () => runHelper(helperPath, 'permission-settings-window') as Promise<SettingsWindow>,
      granted: kind => process.platform === 'darwin' && (kind === 'screen' ? systemPreferences.getMediaAccessStatus('screen') === 'granted' : kind === 'accessibility' ? systemPreferences.isTrustedAccessibilityClient(false) : false),
      chooseInvitation: async kind => {
        const selected = await dialog.showOpenDialog(window!, { title: kind === 'qr' ? moteText("选择中央连接二维码图片") : moteText("选择中央连接邀请 JSON"), properties: ['openFile'], filters: [{ name: kind === 'qr' ? 'QR image' : 'Mote connection JSON', extensions: kind === 'qr' ? ['png', 'jpg', 'jpeg'] : ['json', 'txt'] }] });
        return selected.canceled ? undefined : selected.filePaths[0];
      },
      recognizeQr: bytes => recognizeInvitationQr(helperPath, bytes),
      settleNotes: () => notes.settle(),
      onLanguageChanged: () => { refreshApplicationMenu(); updateUi(clientStatus()); },
      reloadWindows: () => { window?.webContents.reload(); if (quickNoteWindow && !quickNoteWindow.isDestroyed()) quickNoteWindow.webContents.reload(); },
    });
    pendingNoteStatus = () => ({ count: notes.hasPrepared() && !queue.contains(notes.get().id) ? 1 : 0, unbound: queue.binding.unbound() && (!localSources || localSources.nodeBinding.unbound()) && (!notes.hasPrepared() || notes.hasUnboundPrepared()), baseRecords: queue.stats().depth + (localSources?.pendingStats().pendingRecords ?? 0) });
    const library = createLibraryWorkspacePlugin({
      settings: () => settings,
      queue,
      sources: () => localSources!,
      syncHistory,
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
    });
    pluginHost = new DesktopPluginHost({ router: electronIpcRouter(ipcMain, () => pluginHost!.windowFacts), native: new NativeProviderRegistry('mac') });
    const host: DesktopPluginHost = pluginHost;
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
    const mainSenderId = window.webContents.id;
    host.registerWindow(mainSenderId, 'main', [notesReadCapability, notesWriteCapability, libraryReadCapability, memoryReadCapability, sourcesReadCapability, sourcesWriteCapability, askCapability, chromeReadCapability, chromeManageCapability, captureReadCapability, captureWriteCapability, deviceSettingsReadCapability, deviceSettingsWriteCapability]);
    window.once('closed', () => host.unregisterWindow(mainSenderId));
    window.on('close', event => { if (!quitting) { event.preventDefault(); host.onMainWindowClosed(); window?.hide(); } });
    const trusted = (event: IpcMainInvokeEvent) => {
      if (!([window,quickNoteWindow].some(owned=>owned && !owned.isDestroyed() && event.sender===owned.webContents && event.senderFrame===owned.webContents.mainFrame && event.senderFrame?.url===(owned===quickNoteWindow?pageUrl+'#quick-note':pageUrl)))) throw new Error(moteText("请求来源不受信任"));
    };
    const trustedMain = (event: IpcMainInvokeEvent) => {
      if (!(window && !window.isDestroyed() && event.sender===window.webContents && event.senderFrame===window.webContents.mainFrame && event.senderFrame?.url===pageUrl)) throw new Error(moteText("请求来源不受信任"));
    };
    await registerBuiltinDesktopPlugins({ host, ipcMain, appVersion: app.getVersion(), mainWindow: window, mainSenderId, pageUrl, trustedMain }, [notes, library, deviceSettings, sourcesPlugin!, chromePlugin!, capturePlugin!]);
    openQuickNote=async()=>{
      if(quickNoteWindow&&!quickNoteWindow.isDestroyed()){quickNoteWindow.show();quickNoteWindow.focus();return;}
      const noteWindow=new BrowserWindow({width:580,height:466,useContentSize:true,minWidth:380,minHeight:420,title:moteText('随手记'),backgroundColor:appearanceBackground(),webPreferences:{preload:join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:developmentProfile}});
      quickNoteWindow=noteWindow;
      const noteSenderId = noteWindow.webContents.id;
      host.registerWindow(noteSenderId, 'quick-note', [notesReadCapability, notesWriteCapability, deviceSettingsReadCapability, deviceSettingsWriteCapability]);
      noteWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      noteWindow.webContents.on('will-navigate',event=>event.preventDefault());
      noteWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
      const appearance=()=>{noteWindow.setBackgroundColor(appearanceBackground());noteWindow.webContents.send('mote:appearance',appearanceState());};nativeTheme.on('updated',appearance);
      noteWindow.once('closed',()=>{host.unregisterWindow(noteSenderId);nativeTheme.removeListener('updated',appearance);if(quickNoteWindow===noteWindow)quickNoteWindow=undefined;});
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
    // Retain authored keys: a renderer locale change does not restart the main process.
    const operationLabels: Record<string, string> = {
      'mote:installed-applications': "正在读取应用列表",
      'mote:support-export': "正在导出支持包", 'mote:diagnostics-export': "正在导出诊断", 'mote:diagnostics-sample': "正在读取诊断",
      'mote:update-download': "正在下载更新", 'mote:update-install': "正在准备安装更新", 'mote:update-check': "正在检查更新",
    };
    const handle = (channel: string, operation: (...args: unknown[]) => unknown) => {
      const stage: EventStage | undefined = ({ 'mote:update-check': 'UPDATE', 'mote:update-download': 'UPDATE', 'mote:update-install': 'UPDATE', 'mote:support-export': 'SUPPORT' } as Record<string, EventStage>)[channel];
    ipcMain.handle(channel, async (event, ...args) => {
        trusted(event);
        if (recoveryRequired && !['mote:get-status', 'mote:storage-restart', 'mote:connection-status', 'mote:update-status'].includes(channel)) throw new Error(recoveryRequired);
        const startedAt = Date.now();
        if (stage) void events.record(stage, 'STARTED', {operation:channel});
        try { const label = operationLabels[channel]; const result = await (label ? backgroundJobs.run(channel, label, () => operation(...args)) : operation(...args)); if (stage) void events.record(stage, 'OK', { elapsedMs: Date.now() - startedAt,operation:channel }); return result; }
        catch (error) { if (stage) void events.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt,operation:channel,errorName:safeErrorName(error) }); throw error; }
        finally { if (operationLabels[channel] && !quitting) updateUi(clientStatus()); }
      });
    };
    const requireRecovery = (message: string): void => { recoveryRequired = message; collector.requireRecovery(message); void localSources!.close(); };
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
    handle('mote:installed-applications', () => process.platform === 'darwin' ? readInstalledApplications(helperPath).catch(() => []) : []);
    const devUpdateStatus = () => ({...updater!.status(), manualDownload:true, state:'idle' as const, canInstall:false, availableVersion:undefined, notesUrl:desktopDevDownloadsUrl, message:moteText('查看版本说明与安装包'), installReason:''});
    handle('mote:update-status', () => developmentBuild ? devUpdateStatus() : updater!.status());
    handle('mote:update-channel', channel => updater!.setChannel(channel));
    handle('mote:update-check', () => developmentBuild ? devUpdateStatus() : updater!.check());
    handle('mote:update-download', () => updater!.download());
    handle('mote:update-cancel', () => updater!.cancel());
    handle('mote:update-install', () => serialize(() => updater!.install(async () => { collector.stop(); await collector.settleCapture(); await notes.settle(); }, () => app.quit())));
    handle('mote:update-reveal', () => { const archive = updater!.archivePath(); if (archive) shell.showItemInFolder(archive); });
    handle('mote:update-notes', async () => { const url = developmentBuild ? desktopDevDownloadsUrl : updater!.status().notesUrl; if (url) await shell.openExternal(url); });
    handle('mote:feedback', () => shell.openExternal(githubFeedbackUrl({
      version: app.getVersion(),
      platform: `${process.platform === 'darwin' ? 'macOS' : currentPlatform} ${process.getSystemVersion()} · ${process.arch}`,
      environment: moteText("桌面客户端 · {0}", ['dev', 'test', 'prod', 'default'].includes(profile.name) ? profile.name : moteText("自定义环境")),
    })));
    handle('mote:coding-agents', () => discoverCodingAgents());
    handle('mote:action-calendar-connect', () => serialize(() => nativeCalendarActions({...settings},helperPath,dataDirectory).connectAndDeliver(()=>settings.syncPaused===true)));
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
    handle('mote:central', async (page, evidenceId,conversationId) => {
      if (evidenceId !== undefined && typeof evidenceId !== 'string') throw new Error('Invalid evidence reference');
      if(conversationId!==undefined&&(typeof conversationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)))throw Error('Invalid conversation identity');
      await showCentral(typeof page === 'string' ? page : undefined, evidenceId,undefined,conversationId);
    });
    handle('mote:central-work',async workId=>showCentral('activity',undefined,validateCentralWorkId(workId)));
    handle('mote:quick-note', () => openQuickNote?.());
    handle('mote:quick-note-size', expanded => {
      if (typeof expanded !== 'boolean') throw new Error('Invalid quick-note size');
      if (quickNoteWindow && !quickNoteWindow.isDestroyed()) quickNoteWindow.setContentSize(quickNoteWindow.getContentSize()[0], expanded ? 594 : 466);
    });
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
    let loginGeneration=0;
    const endLogin=()=>serialize(async()=>{
      loginGeneration++;
      const previous=settings, token=connectionToken(previous);
      // Locally sign out even when the node is offline; never fall back to another credential.
      await deviceSettings.paused(()=>deviceSettings.apply(signedOutConfig(previous)));
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
          return deviceSettings.connectionChange(()=>deviceSettings.commitConnection({...requested,token:credential,credentialScope:'owner',authSignedOut:false,authSessionOnly:durationMs===0,authExpiresAt:expiresAt},true,true),true,true);
        });
      } catch(error) {
        if(minted)await loginRequest(requested,'/api/login/logout',{},credential).catch(()=>{});
        throw error;
      }
      loginGeneration++;updateUi(clientStatus());
      const installed=settings, installedGeneration=collector.status().authorizationGeneration;
      if(requested.token&&requested.token!==credential)await loginRequest(requested,'/api/login/logout',{},requested.token).catch(()=>{});
      if(settings!==installed||collector.status().authorizationGeneration!==installedGeneration)throw Error(moteText('登录会话已变更，请重新打开中央页面。'));
    };
    ensureBrowserLogin=()=>prepareBrowserSession({settings:()=>settings,authorizationGeneration:()=>collector.status().authorizationGeneration??0,inspect:current=>testConnection(current),install:installLogin});
    browserLogin=async(page,evidenceId,durationMs=2592000000,workId,conversationId)=>{
      if(![0,86400000,604800000,2592000000].includes(durationMs))throw Error('Invalid lifetime');
      const requested=settings,generation=++loginGeneration,{verifier,challenge}=loginVerifier();
      const {id}=await loginRequest(requested,'/api/login/requests',{serverUrl:requested.serverUrl,deviceId:requested.deviceId,deviceName:requested.deviceName,platform:currentPlatform,challenge,durationMs});
      const ensureCurrent=()=>{if(settings!==requested||generation!==loginGeneration||quitting)throw Error(moteText('登录会话已变更，请重新打开中央页面。'));};
      ensureCurrent();
      await openCentralBrowser(requested.serverUrl,page,process.platform,url=>{ensureCurrent();return promisify(execFile)('/usr/bin/open',['-a','Google Chrome',url]);},url=>{ensureCurrent();return shell.openExternal(url);},evidenceId,undefined,id,workId,conversationId);
      await pollBrowserLogin({
        current:()=>generation===loginGeneration&&settings===requested&&!quitting,
        poll:()=>loginRequest(requested,'/api/login/poll',{id,verifier}),
        install:token=>installLogin(token,durationMs,generation),
        acknowledge:()=>loginRequest(requested,'/api/login/ack',{id,verifier}).catch(()=>{}),
        wait:()=>new Promise(resolve=>setTimeout(resolve,1500)),
      });
    };
    let authCheck:Promise<unknown>|undefined;let nextAuthCheck=0;
    const authTimer=setInterval(()=>{
      if(connectionToken(settings)&&Date.now()>=nextAuthCheck&&!authCheck){const selected=settings;nextAuthCheck=Date.now()+15000;authCheck=testConnection(selected).catch(error=>{if(settings===selected&&error instanceof ConnectionError&&error.code==='AUTH')return endLogin();}).finally(()=>{authCheck=undefined;});}
      if(settings.token&&!settings.authSignedOut&&settings.authExpiresAt&&settings.authExpiresAt<=Date.now())void endLogin().catch(()=>{});
    },1000);authTimer.unref();app.once('before-quit',()=>clearInterval(authTimer));
    const askPlugin = createAskWorkspacePlugin({
      settings: () => settings,
      installLogin,
      endLogin,
      browserLogin,
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
    });
    await askPlugin.register({host, ipcMain, appVersion: app.getVersion(), mainWindow: window, mainSenderId, pageUrl, trustedMain});
    handle('mote:data-folder', async () => { await shell.openPath(dataDirectory); });
    handle('mote:export-metadata', async () => {
      const selected=await dialog.showSaveDialog(window!,{defaultPath:'mote-local-metadata.json'});
      if(!selected.canceled&&selected.filePath)await writeFile(selected.filePath,JSON.stringify(queue.exportMetadata()),{mode:0o600});
    });
    handle('mote:export-queue', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: moteText("导出已脱敏待上传队列（包含个人资料）"), defaultPath: `mote-queue-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      const selectedFile=await describeBackupFile(selected.filePath);
      backgroundJobs.progress('mote:export-queue',{message:moteText('正在导出队列'),file:{name:selectedFile.name,path:selectedFile.path}});updateUi(clientStatus());
      await queue.exportArchiveFile(selected.filePath, value => backgroundJobs.progress('mote:export-queue', value));
      return { canceled: false, path: selected.filePath, file:await describeBackupFile(selected.filePath) };
    });
    handle('mote:import-queue', () => serialize(async () => {
      const selected = await dialog.showOpenDialog(window!, { title: moteText("导入 Mote 电脑端队列备份"), properties: ['openFile'], filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      const path = selected.filePaths[0];
      const file=await describeBackupFile(path);
      backgroundJobs.progress('mote:import-queue',{message:moteText('正在校验备份'),file});updateUi(clientStatus());
      try {
        const imported = await queue.importArchiveFile(path, value => backgroundJobs.progress('mote:import-queue', value));
        updateUi(clientStatus()); void collector.upload();
        return { canceled: false, state:'imported', imported, file };
      } catch(error) {
        updateUi(clientStatus());
        if(error instanceof QueueImportFailure)return {canceled:false,state:'incomplete',...error.report,error:error.message,file};
        throw error;
      }
    }));
    tray = new Tray(trayIcon());
    tray.on('click', showWindow);
    updateUi(clientStatus());
    await window.loadURL(pageUrl);
    await acknowledgeInstalledUpdate({ argv: process.argv, directory: updateDirectory, bundlePath, version: app.getVersion(), profile: profile.name });
    await updater.startupCompleted();
    const receiptTimer = setTimeout(() => { void updater?.startupCompleted(); }, 2500); receiptTimer.unref();
    capturePlugin!.initialize();
    if (app.getLoginItemSettings().wasOpenedAtLogin) window.hide();
  }).catch(async error => {
    capturePlugin?.shutdown();
    const result = await dialog.showMessageBox({ type: 'error', title: moteText("Mote 存储或配置需要恢复"), message: moteText("未开启采集，现有数据已保留"), detail: moteText("{0}\n如使用外接磁盘，请连接原磁盘后重试。应用不会创建空队列替代原目录。", error instanceof Error ? error.message : moteText("无法读取配置或持久队列")), buttons: [moteText("重试"), moteText("退出")], defaultId: 0, cancelId: 1 });
    if (result.response === 0) app.relaunch(); app.quit();
  });
}
