/** Custom page frames are bound by the main-owned registry; any navigation
 * of a bound frame is cancelled before the replacement document can run. */
import type {CustomPageFrameClaim, CustomPageFrameTarget} from '../contracts/custom-page';
import type {BuiltinDesktopPlugin} from './index';

export const customPageGuardPlugin: BuiltinDesktopPlugin = {
  id: 'mote.custom-pages',
  register({host, ipcMain, mainWindow, mainSenderId, trustedMain}) {
    const webContents = mainWindow.webContents;
    webContents.on('will-frame-navigate', details => { if (host.customPageWillNavigate(mainSenderId, details)) details.preventDefault(); });
    webContents.on('will-redirect', details => { if (host.customPageWillNavigate(mainSenderId, details)) details.preventDefault(); });
    webContents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) host.revokeCustomPages(mainSenderId); });
    webContents.on('did-frame-navigate', () => { if (!mainWindow.isDestroyed()) host.pruneCustomPages(mainSenderId, webContents.mainFrame); });
    webContents.on('destroyed', () => host.forgetCustomPages(mainSenderId));
    // Push the exact granted epoch to the trusted host so its channel can end
    // instead of relying on the guard's private counter.
    host.onCustomPageRevoked((webContentsId, revocation) => {
      if (webContentsId !== mainSenderId || mainWindow.isDestroyed()) return;
      webContents.send('mote:custom-page-revoked', revocation);
    });
    ipcMain.handle('mote:custom-page-prepare', (event, target: CustomPageFrameTarget) => {
      trustedMain(event);
      if (!target || typeof target !== 'object') throw new TypeError('Invalid custom page target');
      return host.prepareCustomPageFrame(mainSenderId, target);
    });
    ipcMain.handle('mote:custom-page-claim', (event, claim: CustomPageFrameClaim) => {
      trustedMain(event);
      if (!claim || typeof claim !== 'object') throw new TypeError('Invalid custom page claim');
      return host.claimCustomPageFrame(mainSenderId, claim, event.sender.mainFrame);
    });
  },
};
