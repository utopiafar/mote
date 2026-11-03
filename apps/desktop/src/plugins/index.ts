/** Build-shipped Mac plugins. The registry is the one startup seam for
 * host-owned registrations; each plugin lives in its own file and receives
 * only the host/window facts it actually needs. */
import type {BrowserWindow, IpcMain, IpcMainInvokeEvent} from 'electron';
import type {DesktopPluginHost} from '../plugin-host/desktop-host';
import {customPageGuardPlugin} from './custom-page-guard';
import {nativeHelperPlugin} from './native-helper';

export interface BuiltinPluginContext {
  readonly host: DesktopPluginHost;
  readonly ipcMain: IpcMain;
  readonly appVersion: string;
  readonly mainWindow: BrowserWindow;
  readonly mainSenderId: number;
  /** The main window's exact trusted() check, reused for custom page IPC. */
  readonly trustedMain: (event: IpcMainInvokeEvent) => void;
}

export interface BuiltinDesktopPlugin {
  readonly id: string;
  register(context: BuiltinPluginContext): void;
}

export const builtinDesktopPlugins: readonly BuiltinDesktopPlugin[] = [
  nativeHelperPlugin,
  customPageGuardPlugin,
];

export function registerBuiltinDesktopPlugins(context: BuiltinPluginContext): void {
  for (const plugin of builtinDesktopPlugins) plugin.register(context);
}
