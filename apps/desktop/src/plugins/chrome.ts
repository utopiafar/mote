/** Mac Chrome capture plugin: owns the private native-messaging bridge, its
 * registration and the restricted permission/setup IPC surface. Stopping the
 * scope unregisters the native host and closes every connected relay. */
import {join} from 'node:path';
import type {ChromePermissionStatus} from '../contracts/chrome';
import {ChromeCaptureBridge} from '../chrome-bridge';
import {CHROME_EXTENSION_ID} from '../chrome-constants';
import {registerChromeNativeHost,unregisterChromeNativeHost} from '../chrome-registration';
import type {BrowserCaptureProvider} from '../browser-capture';
import type {BuiltinDesktopPlugin,BuiltinPluginContext} from './index';

export const chromeReadCapability = 'chrome.read';
export const chromeManageCapability = 'chrome.manage';
export const chromeChannels = {
  permissions: 'mote:chrome-permissions',
  permissionsCancel: 'mote:chrome-permissions-cancel',
  extensions: 'mote:chrome-extensions',
  setup: 'mote:chrome-setup',
} as const;

export interface ChromeSetupReceipt {
  readonly extensionId: string;
  readonly extensionDirectory: string;
  readonly manifestPath: string;
}

export interface ChromePluginOptions {
  readonly profileDirectory: string;
  readonly helperPath: string;
  readonly extensionDirectory: string;
  readonly electronExecutable: string;
  readonly nativeHostScript?: string;
  readonly homeDirectory?: string;
  /** macOS is the only platform that registers this host. */
  readonly platform?: NodeJS.Platform;
  readonly settings: () => readonly string[];
  readonly openPath: (path: string) => Promise<unknown>;
  readonly openExtensions: (url: string) => Promise<void>;
  readonly guard?: () => void;
}

export interface ChromePlugin extends BuiltinDesktopPlugin {
  readonly provider: BrowserCaptureProvider | undefined;
  initialize(): Promise<void>;
  /** Unregisters the native host and closes the relay. Idempotent. */
  close(): Promise<void>;
}

const chromeCheckIdentity = /^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createChromePlugin(options: ChromePluginOptions): ChromePlugin {
  const platform = options.platform ?? process.platform;
  let bridge: ChromeCaptureBridge | undefined;
  let initialization: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let registrationWork: Promise<ChromeSetupReceipt> | undefined;
  let permissionCheck: {id: string; controller: AbortController} | undefined;

  const initialize = (): Promise<void> => {
    initialization ??= (async () => {
      if (platform !== 'darwin' || stopped) return;
      const started = new ChromeCaptureBridge({profileDirectory: options.profileDirectory, helperPath: options.helperPath});
      await started.start();
      // A quit may have won the race while the socket was starting.
      if (stopped) { await started.close(); return; }
      bridge = started;
    })();
    return initialization;
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    stopped = true;
    permissionCheck?.controller.abort();
    permissionCheck = undefined;
    const current = bridge;
    bridge = undefined;
    const task = (async () => {
      const errors: unknown[] = [];
      // Starting the bridge close rejects extension messages synchronously.
      const bridgeClosing = current?.close().catch(error => { errors.push(error); });
      // A registration that was already accepted must finish before its
      // manifest is unregistered, or it could reappear after stop.
      const registration = registrationWork;
      if (registration) {
        try { await registration; }
        catch { /* the caller already observed this registration failure */ }
      }
      try { unregisterChromeNativeHost({profileDirectory: options.profileDirectory, homeDirectory: options.homeDirectory}); }
      catch (error) { errors.push(error); }
      // If stop won the startup race, initialize() closes its late bridge.
      if (initialization) {
        try { await initialization; }
        catch (error) { errors.push(error); }
      }
      if (bridgeClosing) await bridgeClosing;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Chrome plugin cleanup failed');
    })();
    closing = task;
    // A retry may finish cleanup after a transient failure.
    void task.catch(() => { if (closing === task) closing = undefined; });
    return task;
  };

  const checkPermissions = async (rawId: unknown): Promise<ChromePermissionStatus> => {
    if (typeof rawId !== 'string' || !chromeCheckIdentity.test(rawId)) throw Error('Invalid Chrome check identity');
    options.guard?.();
    permissionCheck?.controller.abort();
    const check = {id: rawId, controller: new AbortController()};
    const origins = [...options.settings()];
    permissionCheck = check;
    try {
      const result = await bridge?.permissionStatus(origins, check.controller.signal) ?? {state: 'disconnected' as const, origins: []};
      return JSON.stringify(options.settings()) === JSON.stringify(origins) ? result : {state: 'stale', origins: []};
    } finally {
      if (permissionCheck === check) permissionCheck = undefined;
    }
  };

  const cancelPermissions = (id: unknown): void => {
    const check = permissionCheck;
    if (check && check.id === id) check.controller.abort();
  };

  const setup = async (): Promise<ChromeSetupReceipt> => {
    options.guard?.();
    if (platform !== 'darwin') throw Error('Chrome capture requires macOS');
    const registration = registerChromeNativeHost({
      profileDirectory: options.profileDirectory,
      extensionDirectory: options.extensionDirectory,
      electronExecutable: options.electronExecutable,
      nativeHostScript: options.nativeHostScript ?? join(__dirname, '..', 'chrome-native-host.js'),
      homeDirectory: options.homeDirectory,
    });
    registrationWork = registration;
    const result = await registration.finally(() => {
      if (registrationWork === registration) registrationWork = undefined;
    });
    await options.openPath(result.extensionDirectory);
    return result;
  };

  const openExtensions = async (): Promise<void> => {
    options.guard?.();
    if (platform !== 'darwin') throw Error('Chrome capture requires macOS');
    await options.openExtensions(`chrome://extensions/?id=${CHROME_EXTENSION_ID}`);
  };

  return {
    id: 'mote.chrome',
    get provider() { return bridge; },
    initialize,
    close,
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({
        instanceId: 'mote.chrome',
        capabilities: [chromeReadCapability, chromeManageCapability],
      });
      const outcome = await host.startPlugin(scope, plugin => {
        plugin.defer(() => { void close().catch(() => undefined); });
        plugin.registerJob({id: 'chrome-native-messaging', durable: true, drain: close});
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));
        register(chromeChannels.permissions, chromeReadCapability, args => checkPermissions(args[0]));
        register(chromeChannels.permissionsCancel, chromeReadCapability, args => cancelPermissions(args[0]));
        register(chromeChannels.setup, chromeManageCapability, () => setup());
        register(chromeChannels.extensions, chromeManageCapability, () => openExtensions());
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
