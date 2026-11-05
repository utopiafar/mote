import '@mote/shared/i18n-all';
import {appearancePreference,resolveColorScheme,linearUiTheme,type AppearancePreference} from '@mote/shared';
import { connectionToken, loginRequest, loginVerifier } from './login-session';
import { SyncHistory } from './sync-history';
import { randomUUID } from 'node:crypto';
import {storageStatistics} from '@mote/shared/storage-statistics';
import { moteText } from '@mote/shared/i18n';
import {discoverCodingAgents} from './coding-agents';
import {nativeCalendarActions} from './calendar-actions';
import { type SettingsWindow } from './permission-types';
import { collectRecordMetadata } from './record-metadata';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, systemPreferences, Tray } from 'electron';
import { DesktopPluginHost, electronIpcRouter } from './plugin-host/desktop-host';
import { NativeProviderRegistry } from './plugin-host/native-registry';
import { deviceSettingsChannels, hostChannels, pushChannels } from './desktop-ipc-channels';
import { registerBuiltinDesktopPlugins } from './plugins';
import { createNotesPlugin, notesReadCapability, notesWriteCapability } from './plugins/notes';
import { createLibraryWorkspacePlugin, libraryReadCapability, memoryReadCapability } from './plugins/library-workspace';
import { createChromePlugin, chromeManageCapability, chromeReadCapability, type ChromePlugin } from './plugins/chrome';
import { createSourcesPlugin, sourcesReadCapability, sourcesWriteCapability, type SourcesPlugin } from './plugins/sources';
import { createCapturePlugin, createCaptureStages, captureReadCapability, captureWriteCapability, type CapturePlugin } from './plugins/capture';
import { askCapability, createAskWorkspacePlugin } from './plugins/ask-workspace';
import { createDeviceSettingsPlugin, deviceSettingsReadCapability, deviceSettingsWriteCapability } from './plugins/device-settings';
import { createWorkHistoryWorkspacePlugin, workHistoryReadCapability } from './plugins/work-history-workspace';
import { createLocalStorageBackupPlugin, localStorageBackupCapability } from './plugins/local-storage-backup';
import { createSystemToolsPlugin, systemToolsManageCapability, systemToolsReadCapability } from './plugins/system-tools';
import { capabilityPublisherCapability, createCapabilityPublisherPlugin } from './plugins/capability-publisher';
import type { IpcMainInvokeEvent } from 'electron';
import { DiagnosticsRecorder } from '@mote/diagnostics';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { readPowerState, recognizeInvitationQr, runHelper, readInstalledApplications } from './native';
import { ConnectionError, testConnection } from './connection';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openCentralBrowser,validateCentralWorkId } from './central-browser';
import { showCentral as navigateCentral, prepareBrowserSession, pollBrowserLogin, type BrowserLogin } from './central-navigation';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolveProfile, profileDefaults, isDevelopmentProfile } from './profile';
import { desktopSecretStorage } from './secret-storage';
import { failureCode, safeErrorName, type EventStage } from './support';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { currentPlatform, type Collector } from './collector';
import { CaptureNeedsActionNotifier, captureStatusRowFor, type CaptureNotification } from './capture-notification';
import { signedOutConfig } from './config';
import { DurableQueue } from './queue';
import { BackgroundJobs } from './background-jobs';
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
        { label: moteText("记录"), accelerator: 'CmdOrCtrl+2', click: () => showClientPage('notes') },
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
let quitting = false;
let notesSettledForQuit = false;
let settings: Config;
let recoveryRequired: string | undefined;
let prepareForUpdateInstall: (() => Promise<void>) | undefined;
let diagnosticsRecorder: DiagnosticsRecorder | undefined;
const systemTools = createSystemToolsPlugin({
  directory: profile.dataDirectory,
  currentVersion: app.getVersion(),
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  profile,
  developmentBuild,
  devDownloadsUrl: desktopDevDownloadsUrl,
  diagnosticsEnabled: () => Boolean(settings?.diagnosticsEnabled),
  status: () => clientStatus(),
  chooseSupportPath: async () => {
    const selected = await dialog.showSaveDialog(window!, { title: moteText("导出支持包（数值与固定事件，不含内容和令牌）"), defaultPath: `mote-support-${profile.name}.json`, filters: [{ name: 'JSON support bundle', extensions: ['json'] }] });
    return selected.canceled ? undefined : selected.filePath;
  },
  sampleDiagnostics: async () => { await diagnosticsRecorder?.sample(); },
  openExternal: url => shell.openExternal(url),
  reveal: path => shell.showItemInFolder(path),
  sendPending: async () => { await localSources?.sync(true); await collector.retry(); },
  showMessage: options => dialog.showMessageBox(options),
  beforeInstall: async () => { await prepareForUpdateInstall?.(); },
  quit: () => app.quit(),
  serialize,
  background: (channel, label, operation) => backgroundJobs.run(channel, label, operation),
  guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
  changed: () => { if (!quitting) updateUi(clientStatus()); },
});
const events = systemTools.events;
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
function showClientPage(page: 'overview' | 'notes' | 'sources' | 'settings' | 'central' | 'capture-start' | 'permissions' | 'storage' | 'sync' | 'connection'): void {
  if (page === 'notes') { void openQuickNote?.(); return; }
  showWindow(); window?.webContents.send(pushChannels.navigate, page);
}
const captureNotifications = new CaptureNeedsActionNotifier();
function showCaptureNotification(notice: CaptureNotification): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) return;
  const notification = new Notification({
    title: notice.title, body: notice.body,
    actions: notice.action ? [{ type: 'button' as const, text: notice.action }] : undefined,
  });
  const open = () => {
    if (notice.operation === 'restart_capture') showClientPage('capture-start');
    else if (notice.operation === 'open_permissions') showClientPage('permissions');
    else if (notice.operation === 'open_storage') showClientPage('storage');
    else if (notice.operation === 'open_sync') showClientPage('sync');
    else if (notice.operation === 'reconnect') showClientPage('connection');
    else showClientPage('overview');
  };
  notification.on('click', open);
  notification.on('action', open);
  notification.show();
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
  if (window && !window.isDestroyed()) window.webContents.send(pushChannels.status, status);
  if (quickNoteWindow && !quickNoteWindow.isDestroyed()) quickNoteWindow.webContents.send(pushChannels.status, status);
  let serverHost: string | undefined;
  try { serverHost = status.config.serverUrl ? new URL(status.config.serverUrl).host : undefined; } catch { /* An invalid URL is already surfaced by connection settings. */ }
  const notice = captureNotifications.update(captureStatusRowFor(status), { serverHost });
  if (notice) showCaptureNotification(notice);
  tray?.setToolTip(moteText("Mote [{0}] · {1} · 待上传 {2}", profile.name, status.running ? moteText("采集中") : moteText("已停止"), status.queueDepth));
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `Mote [${profile.name}] · ${status.running ? moteText("采集中") : moteText("已停止")}`, enabled: false },
    { label: moteText("待上传 {0} 条", status.queueDepth), enabled: false },
    { type: 'separator' },
    { label: moteText("打开 Mote"), click: () => showClientPage('overview') },
    { label: moteText("记录"), click: () => showClientPage('notes') },
    { label: moteText("打开中央仓库"), click: () => showClientPage('central') },
    { label: moteText("设置…"), click: () => showClientPage('settings') },
    { label: status.running ? moteText("停止采集") : moteText("开始采集"), click: () => { if(status.running){collector.stop();void serialize(()=>collector.settleCapture());}else showClientPage('capture-start'); } },
    { label: moteText("立即发送"), enabled: systemTools.canSend(status), click: () => { void systemTools.sendNow(); } },
    { type: 'separator' },
    { label: moteText("退出 Mote（停止采集和上传）"), click: () => app.quit() },
  ]));
}

/** Shell/window/status transport is an explicit host primitive, but it still
 * passes through the same plugin IPC authorization as business packages. */
const hostCapability = 'host.shell';
let registerHostIpc: (channel: string, operation: (...args: unknown[]) => unknown) => void = () => {
  throw new Error('Host IPC is not ready');
};

let chromePlugin:ChromePlugin|undefined;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  let pluginHost: DesktopPluginHost | undefined;
  app.on('before-quit', event => {
    quitting = true; void events.record('APP', 'STOPPED'); capturePlugin?.shutdown();
    if (notesSettledForQuit) return;
    event.preventDefault();
    void Promise.allSettled([controlChain, localSources?.close(), systemTools.close(), chromePlugin?.close(), collector?.settleCapture(), pluginHost?.requestQuit()]).then(() => events.read()).finally(() => { notesSettledForQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray keeps the collector and durable uploader alive. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    await mkdir(profile.dataDirectory, { recursive: true, mode: 0o700 });
    const dataDirectory = await realpath(profile.dataDirectory);
    const localStorageBackup = createLocalStorageBackupPlugin({
      directory: dataDirectory, profileName: profile.name, deviceId: () => settings.deviceId,
      protectedRoots: [dataDirectory, ...await Promise.all([defaultDataDirectory, `${defaultDataDirectory}-profiles`].map(path => realpath(path).catch(() => resolve(path))))],
      queue: () => queue,
      chooseExport: async () => {
        const selected = await dialog.showSaveDialog(window!, { title: moteText("导出已脱敏待上传队列（包含个人资料）"), defaultPath: `mote-queue-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
        return selected.canceled ? undefined : selected.filePath || undefined;
      },
      chooseImport: async () => {
        const selected = await dialog.showOpenDialog(window!, { title: moteText("导入 Mote 电脑端队列备份"), properties: ['openFile'], filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
        return selected.canceled ? undefined : selected.filePaths[0];
      },
      chooseStorage: async () => {
        const selected = await dialog.showOpenDialog(window!, { title: moteText("选择本机截图保存位置"), buttonLabel: moteText("选择位置"), properties: ['openDirectory', 'createDirectory'] });
        return selected.canceled ? undefined : selected.filePaths[0];
      },
      storageSelected: directory => { pendingStorageDirectory = directory; },
      openPath: path => shell.openPath(path), upload: () => collector.upload(), serialize, events,
      background: (channel, label, operation) => backgroundJobs.run(channel, label, operation),
      progress: (channel, value) => backgroundJobs.progress(channel, value),
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
      changed: () => { if (!quitting) updateUi(clientStatus()); },
    });
    await localStorageBackup.initialize();
    await deviceSettings.initialize(dataDirectory);
    settings = deviceSettings.settings();
    const store = deviceSettings.store;
    void events.record('APP', 'STARTED');
    const storage = localStorageBackup.storage;
    const queue = new DurableQueue(await storage.open(settings.captureStorageDirectory), settings, createCaptureStages());
    queue.setStorageGuard(async () => { if (recoveryRequired) throw new Error(recoveryRequired); await storage.assertOwned(queue.directory); });
    await queue.initialize();
    await storage.recover(queue.directory);
    storageStatus = () => ({ directory: queue.directory, defaultDirectory: storage.defaultDirectory, custom: queue.directory !== storage.defaultDirectory, cleanupPending: storage.cleanupPending, recoveryRequired });
    let pendingStorageDirectory: string | undefined;

    const helperPath = app.isPackaged ? join(process.resourcesPath, 'native', 'mote-helper') : join(__dirname, '..', 'native', 'bin', 'mote-helper');
    const bundlePath = app.isPackaged ? await realpath(resolve(process.resourcesPath, '../..')) : undefined;
    await systemTools.initialize({
      updatesDirectory: join(dataDirectory, 'updates'),
      helperPath: app.isPackaged ? join(process.resourcesPath, 'native', 'mote-updater') : join(__dirname, '..', 'native', 'bin', 'mote-updater'),
      bundlePath,
    });
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
    diagnosticsRecorder = diagnostics;
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
    const capabilityPublisher = createCapabilityPublisherPlugin({
      settings: () => settings,
      calendar: () => nativeCalendarActions({...settings}, helperPath, dataDirectory),
    });

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
      relocate: updated => queue.relocate(updated.captureStorageDirectory || storage.defaultDirectory, storage, () => store.save(updated), async () => (await store.load()).captureStorageDirectory || storage.defaultDirectory, value => backgroundJobs.progress(deviceSettingsChannels.configure, value)),
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
    prepareForUpdateInstall = async () => { collector.stop(); await collector.settleCapture(); await notes.settle(); };
    pendingNoteStatus = () => ({ count: notes.hasPrepared() && !queue.contains(notes.get().id) ? 1 : 0, unbound: queue.binding.unbound() && (!localSources || localSources.nodeBinding.unbound()) && (!notes.hasPrepared() || notes.hasUnboundPrepared()), baseRecords: queue.stats().depth + (localSources?.pendingStats().pendingRecords ?? 0) });
    const library = createLibraryWorkspacePlugin({
      settings: () => settings,
      queue,
      sources: () => localSources!,
      syncHistory,
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
    });
    const workHistory = createWorkHistoryWorkspacePlugin({
      settings: () => settings,
      history: syncHistory,
      queue,
      sources: () => localSources!,
      guard: () => { if (recoveryRequired) throw new Error(recoveryRequired); },
    });
    pluginHost = new DesktopPluginHost({ router: electronIpcRouter(ipcMain, () => pluginHost!.windowFacts), native: new NativeProviderRegistry('mac') });
    const host: DesktopPluginHost = pluginHost;
    window = new BrowserWindow({
      width: 1140, height: 840, minWidth: 820, minHeight: 620, title: `Mote [${profileLabel}]`, backgroundColor: appearanceBackground(),
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: developmentProfile },
    });
    const broadcastAppearance=()=>{window?.setBackgroundColor(appearanceBackground());window?.webContents.send(pushChannels.appearance,appearanceState());};
    nativeTheme.on('updated',broadcastAppearance);
    window.once('closed',()=>nativeTheme.removeListener('updated',broadcastAppearance));
    refreshApplicationMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const mainSenderId = window.webContents.id;
    host.registerWindow(mainSenderId, 'main', [hostCapability, notesReadCapability, notesWriteCapability, libraryReadCapability, memoryReadCapability, sourcesReadCapability, sourcesWriteCapability, askCapability, chromeReadCapability, chromeManageCapability, captureReadCapability, captureWriteCapability, deviceSettingsReadCapability, deviceSettingsWriteCapability, workHistoryReadCapability, localStorageBackupCapability, systemToolsReadCapability, systemToolsManageCapability, capabilityPublisherCapability]);
    window.once('closed', () => host.unregisterWindow(mainSenderId));
    window.on('close', event => { if (!quitting) { event.preventDefault(); host.onMainWindowClosed(); window?.hide(); } });
    const trusted = (event: IpcMainInvokeEvent) => {
      if (!([window,quickNoteWindow].some(owned=>owned && !owned.isDestroyed() && event.sender===owned.webContents && event.senderFrame===owned.webContents.mainFrame && event.senderFrame?.url===(owned===quickNoteWindow?pageUrl+'#quick-note':pageUrl)))) throw new Error(moteText("请求来源不受信任"));
    };
    const trustedMain = (event: IpcMainInvokeEvent) => {
      if (!(window && !window.isDestroyed() && event.sender===window.webContents && event.senderFrame===window.webContents.mainFrame && event.senderFrame?.url===pageUrl)) throw new Error(moteText("请求来源不受信任"));
    };
    await registerBuiltinDesktopPlugins({ host, ipcMain, appVersion: app.getVersion(), mainWindow: window, mainSenderId, pageUrl, trustedMain }, [notes, library, deviceSettings, workHistory, sourcesPlugin!, chromePlugin!, capturePlugin!, localStorageBackup, systemTools, capabilityPublisher]);
    openQuickNote=async()=>{
      if(quickNoteWindow&&!quickNoteWindow.isDestroyed()){quickNoteWindow.show();quickNoteWindow.focus();return;}
      const noteWindow=new BrowserWindow({width:580,height:466,useContentSize:true,minWidth:380,minHeight:420,title:moteText('记录'),backgroundColor:appearanceBackground(),webPreferences:{preload:join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,devTools:developmentProfile}});
      quickNoteWindow=noteWindow;
      const noteSenderId = noteWindow.webContents.id;
      host.registerWindow(noteSenderId, 'quick-note', [hostCapability, notesReadCapability, notesWriteCapability, deviceSettingsReadCapability, deviceSettingsWriteCapability]);
      noteWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      noteWindow.webContents.on('will-navigate',event=>event.preventDefault());
      noteWindow.webContents.on('will-attach-webview',event=>event.preventDefault());
      const appearance=()=>{noteWindow.setBackgroundColor(appearanceBackground());noteWindow.webContents.send(pushChannels.appearance,appearanceState());};nativeTheme.on('updated',appearance);
      noteWindow.once('closed',()=>{host.unregisterWindow(noteSenderId);nativeTheme.removeListener('updated',appearance);if(quickNoteWindow===noteWindow)quickNoteWindow=undefined;});
      await noteWindow.loadURL(pageUrl+'#quick-note');
    };
    ipcMain.on(hostChannels.appearanceInitial ,(event)=>{trusted(event);event.returnValue=appearanceState();});
    // Retain authored keys: a renderer locale change does not restart the main process.
    const operationLabels: Record<string, string> = {
      [hostChannels.installedApplications]: "正在读取应用列表",
      [hostChannels.diagnosticsExport]: "正在导出诊断", [hostChannels.diagnosticsSample]: "正在读取诊断",
    };
    const hostScope = host.createScope({instanceId: 'mote.host', capabilities: [hostCapability]});
    const hostStarted = await host.startPlugin(hostScope, plugin => {
      const roleFrameUrls = {main: [pageUrl], 'quick-note': [pageUrl + '#quick-note']};
      registerHostIpc = (channel, operation) => {
        const stage: EventStage | undefined = ({} as Record<string, EventStage>)[channel];
        plugin.registerIpc({channel, capability: hostCapability, windowRoles: ['main', 'quick-note'], roleFrameUrls}, async (_view, args) => {
          if (recoveryRequired && !([hostChannels.getStatus, hostChannels.storageRestart, deviceSettingsChannels.connectionStatus] as readonly string[]).includes(channel)) throw new Error(recoveryRequired);
          const startedAt = Date.now();
          if (stage) void events.record(stage, 'STARTED', {operation:channel});
          try {
            const label = operationLabels[channel];
            const result = await (label ? backgroundJobs.run(channel, label, () => operation(...args)) : operation(...args));
            if (stage) void events.record(stage, 'OK', { elapsedMs: Date.now() - startedAt,operation:channel });
            return result;
          } catch (error) {
            if (stage) void events.record(stage, failureCode(error, stage), { elapsedMs: Date.now() - startedAt,operation:channel,errorName:safeErrorName(error) });
            throw error;
          } finally { if (operationLabels[channel] && !quitting) updateUi(clientStatus()); }
        });
      };
      registerHostIpc(hostChannels.setAppearance, (raw: unknown) => {
        if(raw!=='auto'&&raw!=='light'&&raw!=='dark')throw Error('Invalid appearance');
        writeFileSync(appearanceFile+'.tmp',JSON.stringify(raw),{mode:0o600});
        renameSync(appearanceFile+'.tmp',appearanceFile);
        preferredAppearance=raw;nativeTheme.themeSource=raw==='auto'?'system':raw;
        broadcastAppearance();return appearanceState();
      });
      registerHostIpc(hostChannels.getStatus, () => clientStatus());
      registerHostIpc(hostChannels.installedApplications, () => process.platform === 'darwin' ? readInstalledApplications(helperPath).catch(() => []) : []);
      registerHostIpc(hostChannels.feedback, () => shell.openExternal(githubFeedbackUrl({
        version: app.getVersion(),
        platform: `${process.platform === 'darwin' ? 'macOS' : currentPlatform} ${process.getSystemVersion()} · ${process.arch}`,
        environment: moteText("桌面客户端 · {0}", ['dev', 'test', 'prod', 'default'].includes(profile.name) ? profile.name : moteText("自定义环境")),
      })));
      registerHostIpc(hostChannels.codingAgents, () => discoverCodingAgents());
      registerHostIpc(hostChannels.diagnosticsSample, async () => { await diagnostics.sample(); updateUi(clientStatus()); return clientStatus(); });
      registerHostIpc(hostChannels.storageStatistics,async()=>storageStatistics([dataDirectory,queue.directory]));
      registerHostIpc(hostChannels.diagnosticsExport, async () => {
        const selected = await dialog.showSaveDialog(window!, { title: moteText("导出本机数值诊断（不含内容与令牌）"), defaultPath: 'mote-diagnostics.json', filters: [{ name: 'JSON diagnostics', extensions: ['json'] }] });
        if (selected.canceled || !selected.filePath) return { canceled: true };
        await diagnostics.sample(); await diagnostics.exportTo(selected.filePath); return { canceled: false };
      });
      registerHostIpc(hostChannels.central, async (page: unknown, evidenceId: unknown,conversationId: unknown) => {
        if (evidenceId !== undefined && typeof evidenceId !== 'string') throw new Error('Invalid evidence reference');
        if(conversationId!==undefined&&(typeof conversationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationId)))throw Error('Invalid conversation identity');
        await showCentral(typeof page === 'string' ? page : undefined, evidenceId,undefined,conversationId);
      });
      registerHostIpc(hostChannels.centralWork,async (workId: unknown)=>showCentral('activity',undefined,validateCentralWorkId(workId)));
      registerHostIpc(hostChannels.quickNote, () => openQuickNote?.());
      registerHostIpc(hostChannels.quickNoteSize, (expanded: unknown) => {
        if (typeof expanded !== 'boolean') throw new Error('Invalid quick-note size');
        if (quickNoteWindow && !quickNoteWindow.isDestroyed()) quickNoteWindow.setContentSize(quickNoteWindow.getContentSize()[0], expanded ? 594 : 466);
      });
      registerHostIpc(hostChannels.storageRestart, () => { app.relaunch(); app.quit(); });
    });
    if (!hostStarted.started) throw hostStarted.error;
    const requireRecovery = (message: string): void => { recoveryRequired = message; collector.requireRecovery(message); void localSources!.close(); };
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
    registerHostIpc(hostChannels.dataFolder, async () => { await shell.openPath(dataDirectory); });
    registerHostIpc(hostChannels.exportMetadata, async () => {
      const selected=await dialog.showSaveDialog(window!,{defaultPath:'mote-local-metadata.json'});
      if(!selected.canceled&&selected.filePath)await writeFile(selected.filePath,JSON.stringify(queue.exportMetadata()),{mode:0o600});
    });
    tray = new Tray(trayIcon());
    tray.on('click', showWindow);
    updateUi(clientStatus());
    await window.loadURL(pageUrl);
    await systemTools.acknowledgeStartup();
    capturePlugin!.initialize();
    if (app.getLoginItemSettings().wasOpenedAtLogin) window.hide();
  }).catch(async error => {
    capturePlugin?.shutdown();
    const result = await dialog.showMessageBox({ type: 'error', title: moteText("Mote 存储或配置需要恢复"), message: moteText("未开启采集，现有数据已保留"), detail: moteText("{0}\n如使用外接磁盘，请连接原磁盘后重试。应用不会创建空队列替代原目录。", error instanceof Error ? error.message : moteText("无法读取配置或持久队列")), buttons: [moteText("重试"), moteText("退出")], defaultId: 0, cancelId: 1 });
    if (result.response === 0) app.relaunch(); app.quit();
  });
}
