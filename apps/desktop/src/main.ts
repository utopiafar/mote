import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { DiagnosticsRecorder } from '@mote/diagnostics';
import { readPowerState } from './native';
import { NoteDraftStore, type NoteDraft } from './note-draft';
import { openCentralWindow } from './central-window';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveProfile, profileDefaults } from './profile';
import { EventJournal, buildSupportBundle, failureCode, type EventStage } from './support';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { currentPlatform, Collector } from './collector';
import { ConfigStore, updateConfig } from './config';
import { LocalSourceManager } from './source-manager';
import { normalizeSourceOptions } from './source-types';
import { DesktopUpdater } from './updater';
import { acknowledgeInstalledUpdate } from './update-install';
import { DurableQueue } from './queue';
import { NsfwController } from './nsfw';
import type { Config, ConfigUpdate, Status } from './contracts';

const profile = resolveProfile(process.argv, process.env, app.getPath('userData'));
if (!profile.legacy) {
  mkdirSync(profile.dataDirectory, { recursive: true, mode: 0o700 });
  const sessionDirectory = join(profile.dataDirectory, 'session');
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile.dataDirectory); app.setPath('sessionData', sessionDirectory);
}
const profileLabel = profile.legacy ? 'legacy（日常原目录）' : profile.name;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let centralWindow: BrowserWindow | undefined;
let centralOpening: Promise<void> | undefined;
let collector: Collector;
let localSources: LocalSourceManager | undefined;
let updater: DesktopUpdater | undefined;
let quitting = false;
let notesSettledForQuit = false;
const noteWork = new Set<Promise<unknown>>();
function trackNote<T>(task: Promise<T>): Promise<T> {
  noteWork.add(task); void task.then(() => noteWork.delete(task), () => noteWork.delete(task)); return task;
}
async function settleNoteWork(): Promise<void> { while (noteWork.size) await Promise.allSettled([...noteWork]); }
let settings: Config;
const events = new EventJournal(join(profile.dataDirectory, 'diagnostics'), () => Boolean(settings?.diagnosticsEnabled));
function clientStatus(): Status { return { ...collector.status(), environment: { profile: profile.name, legacy: profile.legacy, dataDirectory: profile.dataDirectory } }; }
let controlChain: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlChain.then(operation);
  controlChain = result.catch(() => undefined);
  return result;
}
function encryptedStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
async function showCentral(): Promise<void> {
  if (centralWindow && !centralWindow.isDestroyed()) { centralWindow.show(); centralWindow.focus(); return; }
  if (centralOpening) return centralOpening;
  const requested = settings;
  centralOpening = (async () => {
    const opened = await openCentralWindow(requested);
    if (settings.serverUrl !== requested.serverUrl || settings.token !== requested.token) { opened.close(); return; }
    centralWindow = opened;
  })().finally(() => { centralOpening = undefined; });
  return centralOpening;
}
function showWindow(): void { window?.show(); window?.focus(); }
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
  status = { ...status, environment: { profile: profile.name, legacy: profile.legacy, dataDirectory: profile.dataDirectory } };
  if (window && !window.isDestroyed()) window.webContents.send('mote:status', status);
  tray?.setToolTip(`Mote [${profile.name}] · ${status.running ? '采集中' : '已停止'} · 待上传 ${status.queueDepth}`);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `Mote [${profile.name}] · ${status.running ? '采集中' : '已停止'}`, enabled: false },
    { label: `待上传 ${status.queueDepth} 条`, enabled: false },
    { type: 'separator' },
    { label: '打开采集与随手记', click: showWindow },
    { label: '打开中央仓库', click: () => { void showCentral().catch(e => dialog.showErrorBox('中央仓库', (e as Error).message)); } },
    { label: '开始采集', enabled: !status.running, click: () => { void serialize(() => collector.start()).catch(error => dialog.showErrorBox('无法开始采集', (error as Error).message)); } },
    { label: '停止采集', enabled: status.running, click: () => { void serialize(async () => { collector.stop(); await collector.settleCapture(); }); } },
    { type: 'separator' },
    { label: '退出 Mote（停止采集和上传）', click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => {
    quitting = true; void events.record('APP', 'STOPPED'); collector?.shutdown();
    if (notesSettledForQuit) return;
    event.preventDefault();
    void Promise.allSettled([settleNoteWork(), localSources?.close(), updater?.close(), collector?.settleCapture()]).then(() => events.read()).finally(() => { notesSettledForQuit = true; app.quit(); });
  });
  app.on('window-all-closed', () => { /* Tray keeps the collector and durable uploader alive. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    const dataDirectory = profile.dataDirectory;
    const store = new ConfigStore(dataDirectory, {
      available: encryptedStorageAvailable,
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    }, () => profileDefaults(profile, {}), () => profileDefaults(profile, process.env));
    settings = await store.load();
    await store.save(settings); // Persist stable device identity before the first observation.
    void events.record('APP', 'STARTED');
    const noteDrafts = new NoteDraftStore(join(dataDirectory, 'notes')); await noteDrafts.initialize();
    const queue = new DurableQueue(join(dataDirectory, 'queue'), settings);
    await queue.initialize();
    const helperPath = app.isPackaged ? join(process.resourcesPath, 'native', 'mote-helper') : join(__dirname, '..', 'native', 'bin', 'mote-helper');
    const bundlePath = app.isPackaged ? await realpath(resolve(process.resourcesPath, '../..')) : undefined;
    const updateDirectory = join(dataDirectory, 'updates');
    updater = new DesktopUpdater({ directory: updateDirectory, helper: app.isPackaged ? join(process.resourcesPath, 'native', 'mote-updater') : join(__dirname, '..', 'native', 'bin', 'mote-updater'), bundlePath, currentVersion: app.getVersion(), arch: process.arch === 'arm64' ? 'arm64' : 'x64', profile: profile.name });
    await updater.initialize();
    localSources = new LocalSourceManager(join(dataDirectory, 'local-sources'), settings, helperPath);
    await localSources.initialize();
    const nsfw = new NsfwController(join(dataDirectory, 'models'), app.isPackaged ? join(process.resourcesPath, 'native', 'mote-qwen') : join(__dirname, '..', 'native', 'bin', 'mote-qwen'), () => { if (collector) updateUi(clientStatus()); }, { events });
    const diagnostics = new DiagnosticsRecorder(join(dataDirectory, 'diagnostics'));
    const configureDiagnostics = async () => diagnostics.configure({ enabled: settings.diagnosticsEnabled, intervalMs: settings.diagnosticIntervalSeconds * 1000 }, async () => ({
      queueBytes: queue.stats().bytes, modelBytes: nsfw.status().bytes, ...await readPowerState(helperPath).catch(() => ({})),
    }));
    collector = new Collector(settings, queue, helperPath, encryptedStorageAvailable, updateUi, nsfw, diagnostics, events);
    await nsfw.initialize();
    await configureDiagnostics();
    const pageUrl = pathToFileURL(join(__dirname, 'index.html')).href;
    window = new BrowserWindow({
      width: 1140, height: 840, minWidth: 820, minHeight: 620, title: `Mote [${profileLabel}] · 电脑采集器`, backgroundColor: '#f3f5f1',
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    const trusted = (event: IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl || event.senderFrame !== window.webContents.mainFrame) throw new Error('请求来源不受信任');
    };
    const handle = (channel: string, operation: (...args: unknown[]) => unknown) => {
      const stage: EventStage | undefined = ({ 'mote:configure': 'CONFIG', 'mote:start': 'CAPTURE', 'mote:stop': 'CAPTURE', 'mote:note': 'NOTE', 'mote:note-draft-update': 'NOTE', 'mote:model-download': 'MODEL_DOWNLOAD', 'mote:model-import': 'MODEL_DOWNLOAD', 'mote:model-reload': 'MODEL', 'mote:support-export': 'SUPPORT', 'mote:import-queue': 'QUEUE', 'mote:export-queue': 'QUEUE' } as Record<string, EventStage>)[channel];
      ipcMain.handle(channel, async (event, ...args) => {
        trusted(event);
        try { const result = await operation(...args); if (stage && channel !== 'mote:note-draft-update' && channel !== 'mote:model-download') void events.record(stage, 'OK'); return result; }
        catch (error) { if (stage) void events.record(stage, failureCode(error, stage)); throw error; }
      });
    };
    handle('mote:get-status', () => clientStatus());
    handle('mote:update-status', () => updater!.status());
    handle('mote:update-channel', channel => updater!.setChannel(channel));
    handle('mote:update-check', () => updater!.check());
    handle('mote:update-download', () => updater!.download());
    handle('mote:update-cancel', () => updater!.cancel());
    handle('mote:update-install', () => serialize(() => updater!.install(async () => { collector.stop(); await collector.settleCapture(); await settleNoteWork(); }, () => app.quit())));
    handle('mote:update-reveal', () => { const archive = updater!.archivePath(); if (archive) shell.showItemInFolder(archive); });
    handle('mote:update-notes', async () => { const url = updater!.status().notesUrl; if (url) await shell.openExternal(url); });
    handle('mote:sources', () => localSources!.status());
    handle('mote:source-sync', () => { void localSources!.sync(true); });
    handle('mote:calendar-authorize', () => serialize(() => localSources!.authorizeCalendar()));
    handle('mote:source-calendar', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error('日历选择无效'); await localSources!.addCalendar(id, options); }));
    handle('mote:source-update', (id, options) => serialize(async () => { if (typeof id !== 'string') throw new Error('来源选择无效'); await localSources!.update(id, options); }));
    handle('mote:source-files', (mode, input) => serialize(async () => {
      const options = normalizeSourceOptions(input);
      if (mode !== 'files' && mode !== 'directory') throw new Error('文件选择方式无效');
      const result = await dialog.showOpenDialog(window!, { title: '选择持续同步到中央仓库的本地资料', properties: mode === 'directory' ? ['openDirectory'] : ['openFile', 'multiSelections'], ...(mode === 'files' ? { filters: [{ name: 'UTF-8 文本资料', extensions: options.extensions.map(e => e.slice(1)) }] } : {}) });
      if (result.canceled) return { canceled: true };
      for (const path of result.filePaths) await localSources!.addFiles(path, options);
      return { canceled: false };
    }));
    handle('mote:calendar-permissions', async () => { if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'); });
    handle('mote:diagnostics-sample', async () => { await diagnostics.sample(); updateUi(clientStatus()); return clientStatus(); });
    handle('mote:diagnostics-export', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: '导出本机数值诊断（不含内容与令牌）', defaultPath: 'mote-diagnostics.json', filters: [{ name: 'JSON diagnostics', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await diagnostics.sample(); await diagnostics.exportTo(selected.filePath); return { canceled: false };
    });
    handle('mote:support-export', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: '导出支持包（数值与固定事件，不含内容和令牌）', defaultPath: `mote-support-${profile.name}.json`, filters: [{ name: 'JSON support bundle', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await diagnostics.sample();
      await writeFile(selected.filePath, JSON.stringify(buildSupportBundle(profile, app.getVersion(), clientStatus(), await events.read()), null, 2), { mode: 0o600 });
      return { canceled: false };
    });
    handle('mote:central', showCentral);
    handle('mote:note-draft', () => noteDrafts.get());
    handle('mote:note-draft-update', input => trackNote(noteDrafts.update(input as NoteDraft)));
    handle('mote:note', input => trackNote(serialize(async () => {
      const result = await noteDrafts.submit(input as NoteDraft, settings, currentPlatform, queue);
      updateUi(clientStatus()); if (!quitting) void collector.upload(); return result;
    })));
    handle('mote:configure', input => serialize(async () => {
      if (clientStatus().running) throw new Error('请先停止采集，再修改配置');
      await collector.settleCapture();
      const updated = updateConfig(settings, input as ConfigUpdate, queue.stats().depth + (noteDrafts.hasPrepared() ? 1 : 0));
      if (!profile.legacy && updated.openAtLogin) throw new Error('命名环境请使用带 --profile 的启动命令；系统默认登录项不能保留环境参数');
      if (profile.legacy && updated.openAtLogin !== settings.openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: updated.openAtLogin });
        if (app.getLoginItemSettings().openAtLogin !== updated.openAtLogin) throw new Error('系统未允许修改登录启动项，请在系统设置检查；开发模式建议先使用打包应用');
      }
      await store.save(updated);
      if (updated.serverUrl !== settings.serverUrl || updated.token !== settings.token) { centralWindow?.close(); centralWindow = undefined; }
      settings = updated;
      collector.updateConfig(updated);
      await localSources!.changeConnection(updated);
      await configureDiagnostics();
      return clientStatus();
    }));
    handle('mote:start', () => serialize(async () => { await collector.start(); return clientStatus(); }));
    handle('mote:stop', () => serialize(async () => { collector.stop(); await collector.settleCapture(); return clientStatus(); }));
    handle('mote:retry', async () => { await collector.retry(); return clientStatus(); });
    const requireStopped = async () => {
      if (clientStatus().running) throw new Error('请先停止采集，再修改本地模型');
      await collector.settleCapture();
    };
    handle('mote:model-download', () => serialize(async () => { await requireStopped(); nsfw.startDownload(settings); return clientStatus(); }));
    handle('mote:model-cancel', async () => { await nsfw.cancelDownload(); return clientStatus(); });
    handle('mote:model-reload', () => serialize(async () => { await requireStopped(); await nsfw.reload(); return clientStatus(); }));
    handle('mote:model-import', () => serialize(async () => {
      await requireStopped();
      const selected = await dialog.showOpenDialog(window!, { title: '导入千问语言模型和视觉投影 GGUF（校验 SHA-256）', properties: ['openFile', 'multiSelections'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      await nsfw.importFiles(selected.filePaths); return { canceled: false };
    }));
    handle('mote:permissions', async () => { if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); });
    handle('mote:data-folder', async () => { await shell.openPath(dataDirectory); });
    handle('mote:export-queue', async () => {
      const selected = await dialog.showSaveDialog(window!, { title: '导出已脱敏待上传队列（包含个人资料）', defaultPath: `mote-queue-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      const archive = await queue.exportArchive();
      await writeFile(selected.filePath, JSON.stringify(archive), { mode: 0o600 });
      return { canceled: false, path: selected.filePath };
    });
    handle('mote:import-queue', async () => {
      const selected = await dialog.showOpenDialog(window!, { title: '导入 Mote 电脑端队列备份', properties: ['openFile'], filters: [{ name: 'Mote queue archive', extensions: ['json'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
      const path = selected.filePaths[0];
      if ((await stat(path)).size > 360 * 1024 * 1024) throw new Error('备份超过 360 MiB，请使用完整 queue 文件夹迁移');
      const imported = await queue.importArchive(JSON.parse(await readFile(path, 'utf8')));
      updateUi(clientStatus()); void collector.upload();
      return { canceled: false, imported };
    });
    tray = new Tray(trayIcon());
    tray.on('click', showWindow);
    updateUi(clientStatus());
    await window.loadURL(pageUrl);
    await acknowledgeInstalledUpdate({ argv: process.argv, directory: updateDirectory, bundlePath, version: app.getVersion(), profile: profile.name });
    await updater.startupCompleted();
    const receiptTimer = setTimeout(() => { void updater?.startupCompleted(); }, 2500); receiptTimer.unref();
    collector.initialize();
    if (app.getLoginItemSettings().wasOpenedAtLogin) window.hide();
  }).catch(() => {
    dialog.showErrorBox('Mote 启动失败', '配置、系统密钥存储或持久队列无法读取。请保留现有数据，参照 docs/desktop.md 备份和修复；应用未开启采集。');
    app.quit();
  });
}
