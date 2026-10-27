import { app, BrowserWindow, ipcMain, screen, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getLocale, moteText } from '@mote/shared/i18n';
import type { DragPermissionKind, PermissionHelpState, SettingsWindow } from './permission-types';

const width = 340, height = 340;

// Keep the app-list drop target clear, including when Settings is near a display edge.
export function permissionGuidePosition(bounds: Electron.Rectangle, area: Electron.Rectangle, panelHeight = height): { x: number; y: number } {
  const right = bounds.x + bounds.width + 12;
  const left = bounds.x - width - 12;
  const beside = right + width <= area.x + area.width ? right : left >= area.x ? left : area.x + area.width - width - 12;
  const below = bounds.y + bounds.height + 12;
  const y = right + width <= area.x + area.width || left >= area.x ? bounds.y + 36 : below + panelHeight <= area.y + area.height ? below : area.y + area.height - panelHeight - 12;
  return { x: Math.round(Math.max(area.x, Math.min(beside, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - panelHeight))) };
}

export class PermissionGuide {
  private panel?: BrowserWindow;
  private generation = 0;
  private cleanup?: () => void;
  private disposed = false;

  constructor(private readonly options: {
    appPath?: string;
    owner: () => BrowserWindow | undefined;
    settingsWindow: () => Promise<SettingsWindow>;
    granted: (kind: DragPermissionKind) => boolean;
  }) {}

  async open(kind: DragPermissionKind): Promise<void> {
    this.close();
    const generation = this.generation;
    const appPath = this.options.appPath;
    // Never offer Electron.app or an arbitrary renderer-supplied file as Mote.
    if (this.disposed || !appPath?.endsWith('.app') || this.options.granted(kind)) return;
    const icon = await app.getFileIcon(appPath, { size: 'large' });
    if (generation !== this.generation || this.disposed || icon.isEmpty()) return;
    const panel = new BrowserWindow({
      width, height, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, type: 'panel',
      backgroundColor: '#f8f9fb', title: moteText('权限管理'),
      webPreferences: { preload: join(__dirname, 'permission-help-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.panel = panel;
    const page = pathToFileURL(join(__dirname, 'permission-help.html')).href;
    const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame && event.senderFrame.url === page;
    const state: PermissionHelpState = {
      locale: getLocale(), title: kind === 'screen' ? moteText('屏幕录制') : kind === 'accessibility' ? moteText('辅助功能') : moteText('完整磁盘访问'),
      appName: basename(appPath, '.app'), icon: icon.toDataURL(),
      drag: moteText('将此应用拖入系统设置的权限列表'),
      existing: moteText('列表中已有此应用？直接开启它右侧的开关。'),
      note: kind === 'screen' ? moteText('开启后若仍无法采集，请回到 Mote 重新启动。') : kind === 'files' ? moteText('仅在所选文件夹无法访问时开启；状态请在系统设置中确认。') : moteText('授权状态会自动更新，可随时关闭此浮条。'),
      reveal: moteText('在访达中显示'), close: moteText('关闭浮条'),
    };
    const initial = (event: IpcMainInvokeEvent) => { if (!trusted(event)) throw new Error('Untrusted permission guide'); return state; };
    const action = (event: IpcMainEvent, action: unknown, value: unknown) => {
      if (!trusted(event)) return;
      if (action === 'drag') panel.webContents.startDrag({ file: appPath, icon });
      if (action === 'reveal') shell.showItemInFolder(appPath);
      if (action === 'close') this.close();
      if (action === 'resize' && typeof value === 'number' && Number.isFinite(value)) panel.setSize(width, Math.max(240, Math.min(440, Math.ceil(value))));
    };
    ipcMain.handle('mote:permission-help-state', initial);
    ipcMain.on('mote:permission-help-action', action);
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.webContents.on('will-navigate', event => event.preventDefault());
    panel.webContents.on('will-attach-webview', event => event.preventDefault());
    const owner = this.options.owner();
    const close = () => this.close();
    owner?.on('focus', close);
    owner?.on('closed', close);
    let checking = false, loaded = false, lastPosition = '';
    const refresh = async () => {
      if (checking || generation !== this.generation) return;
      checking = true;
      try {
        if (this.options.granted(kind)) { this.close(); return; }
        const settings = await this.options.settingsWindow();
        if (generation !== this.generation || panel.isDestroyed()) return;
        if (!settings.frontmost || !settings.bounds) { panel.hide(); return; }
        const bounds = settings.bounds;
        if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) { panel.hide(); return; }
        const position = permissionGuidePosition(bounds, screen.getDisplayMatching(bounds).workArea, panel.getSize()[1]);
        const key = `${position.x},${position.y}`;
        if (key !== lastPosition) { panel.setPosition(position.x, position.y, false); lastPosition = key; }
        if (loaded && !panel.isVisible()) panel.showInactive();
      } catch { if (generation === this.generation && !panel.isDestroyed()) panel.hide(); }
      finally { checking = false; }
    };
    const timer = setInterval(() => void refresh(), 1500); timer.unref();
    const expiry = setTimeout(close, 10 * 60_000); expiry.unref();
    this.cleanup = () => {
      clearInterval(timer); clearTimeout(expiry);
      owner?.removeListener('focus', close); owner?.removeListener('closed', close);
      ipcMain.removeHandler('mote:permission-help-state'); ipcMain.removeListener('mote:permission-help-action', action);
    };
    panel.once('closed', () => { if (this.panel === panel) this.close(); });
    try {
      await panel.loadURL(page);
      if (generation !== this.generation || panel.isDestroyed()) return;
      loaded = true; await refresh();
    } catch (error) { if (generation === this.generation) this.close(); throw error; }
  }

  close(): void {
    this.generation++;
    const panel = this.panel; this.panel = undefined;
    this.cleanup?.(); this.cleanup = undefined;
    if (panel && !panel.isDestroyed()) panel.destroy();
  }
  dispose(): void { this.disposed = true; this.close(); }
}
