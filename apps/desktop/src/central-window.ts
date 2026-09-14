import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './contracts';
import { validateServerUrl } from './config';
const guardOwners = new Map<string, symbol>();
export function centralRequestAllowed(url: string, origin: string): boolean {
  try { return new URL(url).origin === origin; } catch { return false; }
}
export function centralApiRequest(url: string, origin: string): boolean {
  try { const u = new URL(url); return u.origin === origin && u.pathname.startsWith('/api/'); } catch { return false; }
}
export function centralPartition(origin: string): string { return 'persist:mote-central-' + createHash('sha256').update(validateServerUrl(origin)).digest('hex'); }
export async function openCentralWindow(config: Config): Promise<BrowserWindow> {
  const origin = validateServerUrl(config.serverUrl);
  if (!config.token) throw new Error('请先保存中央节点访问令牌');
  const partition = centralPartition(origin), owner = Symbol(partition);
  guardOwners.set(partition, owner);
  const isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !centralRequestAllowed(details.url, origin) }));
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
    if (!central.isDestroyed() && !central.webContents.isDestroyed() && details.webContentsId === central.webContents.id && details.frame === central.webContents.mainFrame && centralApiRequest(details.url, origin)) headers.Authorization = `Bearer ${config.token}`;
    callback({ requestHeaders: headers });
  });
  const downloadListener = (_event: Electron.Event, item: Electron.DownloadItem) => {
    // Native save dialog remains available for the central export feature.
    item.setSaveDialogOptions({ title: '保存中央仓库导出（包含个人资料）' });
  };
  isolated.on('will-download', downloadListener);
  const central = new BrowserWindow({ width: 1280, height: 850, minWidth: 820, minHeight: 600, title: 'Mote · 中央仓库',
    webPreferences: { session: isolated, preload: join(__dirname, 'central-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
  const closeSession = (event: Electron.IpcMainEvent) => {
    if (!central.isDestroyed() && event.sender === central.webContents && event.senderFrame === central.webContents.mainFrame) central.close();
  };
  ipcMain.on('mote:central-close', closeSession);
  central.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === 'https://github.com' && target.pathname === '/utopiafar/mote/issues/new' && target.searchParams.get('template') === 'bug_report.yml') {
        // Discard renderer-controlled query data. The private central page must not
        // send content or credentials out through an otherwise allowed feedback link.
        void shell.openExternal(githubFeedbackUrl({ version: app.getVersion(),
          platform: `${process.platform === 'darwin' ? 'macOS' : process.platform} ${process.getSystemVersion()} · ${process.arch}（中央窗口宿主客户端）`,
          environment: '桌面内嵌中央界面',
        })).catch(() => { if (!central.isDestroyed()) void dialog.showMessageBox(central, { type: 'error', message: '无法打开 GitHub，请检查默认浏览器后重试。' }); });
      }
    } catch { /* All other external targets remain blocked. */ }
    return { action: 'deny' };
  });
  central.webContents.on('will-attach-webview', event => event.preventDefault());
  central.webContents.on('will-navigate', (event, url) => { if (!centralRequestAllowed(url, origin)) event.preventDefault(); });
  central.webContents.on('will-redirect', (event, url) => { if (!centralRequestAllowed(url, origin)) event.preventDefault(); });
  central.on('closed', () => {
    ipcMain.removeListener('mote:central-close', closeSession);
    isolated.removeListener('will-download', downloadListener);
    if (guardOwners.get(partition) !== owner) return;
    // Persistent drafts survive, but service workers / keepalive requests get no network after close.
    isolated.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    isolated.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key];
      callback({ cancel: true, requestHeaders: headers });
    });
    guardOwners.delete(partition);
  });
  try { await central.loadURL(origin); } catch { central.close(); throw new Error('中央界面加载失败，请确认中央节点正在运行且提供前端页面'); }
  return central;
}
