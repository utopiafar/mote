/** Mac system-tools plugin: owns update transport/installation, the privacy
 * bounded support bundle and tray sending. The updater controller, event
 * journal and tray response live inside this scope, so disabling the plugin
 * revokes its IPC and aborts an in-flight update download without touching the
 * durable queue or the owner's profile. The renderer-side install dialog and
 * diagnostic disclosure helpers are the presentation consumers of these
 * fixed services. */
import {moteText} from '@mote/shared/i18n';
import {writeFile} from 'node:fs/promises';
import {net, session} from 'electron';
import type {MessageBoxOptions} from 'electron';
import type {Status} from '../contracts';
import type {UpdateStatus} from '../contracts/settings';
import type {DesktopProfile} from '../profile';
import {EventJournal, buildSupportBundle, failureCode, safeErrorName, type EventStage} from '../support';
import {RuntimeLogSettings} from '../runtime-log-settings';
import {canSendFromTray, showTraySendFailure} from '../tray-send';
import {DesktopUpdater, type UpdateDependencies} from '../updater';
import {createUpdateNetwork} from '../update-network';
import {createChromiumUpdateFetch} from '../electron-update-fetch';
import {acknowledgeInstalledUpdate} from '../update-install';
import {desktopJobIds, systemToolsChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

export const systemToolsReadCapability = 'system-tools.read';
export const systemToolsManageCapability = 'system-tools.manage';

export {systemToolsChannels};

export interface SystemToolsOptions {
  /** The profile data directory; the diagnostics journal lives below it. */
  readonly directory: string;
  readonly currentVersion: string;
  readonly arch: 'arm64' | 'x64';
  readonly profile: DesktopProfile;
  readonly developmentBuild: boolean;
  readonly devDownloadsUrl: string;
  readonly status: () => Status;
  readonly chooseSupportPath: () => Promise<string | undefined>;
  readonly chooseLogPath?: () => Promise<string | undefined>;
  readonly sampleDiagnostics?: () => Promise<unknown>;
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly reveal: (path: string) => void;
  readonly openLogDirectory?: (path: string) => Promise<unknown>;
  readonly sendPending: () => Promise<unknown>;
  readonly showMessage: (options: MessageBoxOptions) => Promise<{response: number}>;
  readonly beforeInstall: () => Promise<void>;
  readonly quit: () => void;
  /** Serialized with the shell's other control-plane writes. */
  readonly serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly background?: <T>(channel: string, label: string, operation: () => T | Promise<T>) => Promise<T>;
  readonly guard?: () => void;
  readonly changed?: () => void;
}

export interface SystemToolsInitializeOptions {
  readonly updatesDirectory: string;
  readonly helperPath: string;
  readonly bundlePath?: string;
  /** Generated fixtures inject the checked release transport. */
  readonly updaterDependencies?: Partial<UpdateDependencies>;
}

export interface SystemToolsPlugin extends BuiltinDesktopPlugin {
  /** Shared configurable event journal; its records are fixed safe fields only. */
  readonly events: EventJournal;
  initialize(options: SystemToolsInitializeOptions): Promise<void>;
  acknowledgeStartup(argv?: readonly string[]): Promise<void>;
  updateStatus(): UpdateStatus;
  canSend(status: Pick<Status, 'config' | 'sync'>): boolean;
  sendNow(): Promise<void>;
  close(): Promise<void>;
}

export function createSystemToolsPlugin(options: SystemToolsOptions): SystemToolsPlugin {
  const logSettings = new RuntimeLogSettings(options.directory, options.developmentBuild || options.profile.name === 'dev');
  const events = new EventJournal(logSettings.directory, () => true, 500, level => logSettings.allows(level));
  let updater: DesktopUpdater | undefined;
  let updatesDirectory: string | undefined;
  let bundlePath: string | undefined;
  let updateSession: ReturnType<typeof session.fromPartition> | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> =>
    options.serialize ? options.serialize(operation) : operation();
  const requireUpdater = (): DesktopUpdater => {
    if (!updater) throw new Error('更新功能尚未初始化');
    return updater;
  };
  const developmentStatus = (): UpdateStatus => ({
    ...requireUpdater().status(), manualDownload: true, state: 'idle', canInstall: false,
    availableVersion: undefined, notesUrl: options.devDownloadsUrl,
    message: moteText('查看版本说明与安装包'), installReason: '',
  });
  const currentStatus = (): UpdateStatus => options.developmentBuild ? developmentStatus() : requireUpdater().status();

  async function close(): Promise<void> {
    if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = undefined; }
    await updater?.close();
  }

  const execute = async <T>(
    channel: string, stage: EventStage | undefined, label: string | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    // Recovery still permits reading the update status.
    if (channel !== systemToolsChannels.updateStatus) options.guard?.();
    const startedAt = Date.now();
    if (stage) void events.record(stage, 'STARTED', {operation: channel});
    try {
      const result = await (label && options.background ? options.background(channel, label, operation) : operation());
      if (stage) void events.record(stage, 'OK', {elapsedMs: Date.now() - startedAt, operation: channel});
      return result;
    } catch (error) {
      if (stage) void events.record(stage, failureCode(error, stage), {
        elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
      });
      throw error;
    } finally { if (label) options.changed?.(); }
  };

  return {
    id: 'mote.system-tools',
    events,
    async initialize({updatesDirectory: directory, helperPath, bundlePath: bundle, updaterDependencies}: SystemToolsInitializeOptions): Promise<void> {
      if (updater) throw new Error('更新功能已初始化');
      updatesDirectory = directory;
      bundlePath = bundle;
      // The shared verifier owns hosts, redirects and integrity. Only the
      // generated transport fixture may replace the Chromium fetch.
      const network = updaterDependencies?.check && updaterDependencies?.download ? undefined
        : createUpdateNetwork(createChromiumUpdateFetch(request => net.request({
          ...request, session: updateSession ??= session.fromPartition('mote-public-updates', {cache: false}),
        })));
      updater = new DesktopUpdater({
        directory, helper: helperPath, bundlePath: bundle, currentVersion: options.currentVersion,
        arch: options.arch, profile: options.profile.name,
      }, {...(network ?? {}), ...updaterDependencies});
      await updater.initialize();
    },
    async acknowledgeStartup(argv = process.argv): Promise<void> {
      if (!updater || !updatesDirectory) return;
      await acknowledgeInstalledUpdate({
        argv: [...argv], directory: updatesDirectory, bundlePath,
        version: options.currentVersion, profile: options.profile.name,
      });
      await updater.startupCompleted();
      receiptTimer ??= setTimeout(() => { void updater?.startupCompleted(); }, 2500);
      receiptTimer.unref();
    },
    updateStatus: currentStatus,
    canSend: status => canSendFromTray(status),
    async sendNow(): Promise<void> {
      try { await serialize(options.sendPending); }
      catch (error) { await showTraySendFailure(error, options.showMessage); }
    },
    close,
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({
        instanceId: 'mote.system-tools',
        capabilities: [systemToolsReadCapability, systemToolsManageCapability],
      });
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));

        register(systemToolsChannels.updateStatus, systemToolsReadCapability, () =>
          execute(systemToolsChannels.updateStatus, undefined, undefined, currentStatus));
        register(systemToolsChannels.updateChannel, systemToolsManageCapability, args =>
          execute(systemToolsChannels.updateChannel, undefined, undefined, () => requireUpdater().setChannel(args[0])));
        register(systemToolsChannels.updateCheck, systemToolsReadCapability, () =>
          execute(systemToolsChannels.updateCheck, 'UPDATE', '正在检查更新', () => options.developmentBuild ? developmentStatus() : requireUpdater().check()));
        register(systemToolsChannels.updateDownload, systemToolsManageCapability, () =>
          execute(systemToolsChannels.updateDownload, 'UPDATE', '正在下载更新', () => requireUpdater().download()));
        register(systemToolsChannels.updateCancel, systemToolsManageCapability, () =>
          execute(systemToolsChannels.updateCancel, undefined, undefined, () => requireUpdater().cancel()));
        register(systemToolsChannels.updateInstall, systemToolsManageCapability, () =>
          execute(systemToolsChannels.updateInstall, 'UPDATE', '正在准备安装更新', () =>
            serialize(() => requireUpdater().install(options.beforeInstall, options.quit))));
        register(systemToolsChannels.updateReveal, systemToolsManageCapability, () =>
          execute(systemToolsChannels.updateReveal, undefined, undefined, () => {
            const archive = requireUpdater().archivePath();
            if (archive) options.reveal(archive);
          }));
        register(systemToolsChannels.updateNotes, systemToolsManageCapability, () =>
          execute(systemToolsChannels.updateNotes, undefined, undefined, async () => {
            const url = options.developmentBuild ? options.devDownloadsUrl : requireUpdater().status().notesUrl;
            if (url) await options.openExternal(url);
          }));
        register(systemToolsChannels.supportExport, systemToolsManageCapability, args =>
          execute(systemToolsChannels.supportExport, 'SUPPORT', '正在导出支持包', async () => {
            const hours = args[0] === undefined ? 24 : Number(args[0]);
            if (![1, 24, 168].includes(hours)) throw new Error('Invalid log range');
            const path = await options.chooseSupportPath();
            if (!path) return {canceled: true};
            await options.sampleDiagnostics?.();
            const logs = await events.exportRange(Date.now() - hours * 3600000);
            await writeFile(path, JSON.stringify({
              ...buildSupportBundle(options.profile, options.currentVersion, options.status(), logs.events), ...logs,
            }, null, 2), {mode: 0o600});
            return {canceled: false};
          }));
        register(systemToolsChannels.eventsRead, systemToolsReadCapability, () =>
          execute(systemToolsChannels.eventsRead, undefined, undefined, () => events.read(true)));
        register(systemToolsChannels.eventsRaw, systemToolsReadCapability, () =>
          execute(systemToolsChannels.eventsRaw, undefined, undefined, () => events.readRaw()));
        register(systemToolsChannels.logSettings, systemToolsReadCapability, () => logSettings.read());
        register(systemToolsChannels.logSettingsSave, systemToolsManageCapability, args => logSettings.save(args[0]));
        register(systemToolsChannels.logDirectoryOpen, systemToolsManageCapability, () => options.openLogDirectory?.(logSettings.directory));
        register(systemToolsChannels.logExport, systemToolsManageCapability, async () => {
          const path = await options.chooseLogPath?.();
          if (!path) return {canceled:true};
          const result = await events.exportRange(0, Date.now() + 1);
          await writeFile(path, result.events.map(event => JSON.stringify(event)).join('\n') + (result.events.length ? '\n' : ''), {mode:0o600});
          return {canceled:false};
        });

        // An explicit quit waits for the updater to finish aborting; disabling
        // the scope aborts immediately and leaves the durable queue untouched.
        plugin.registerJob({id: desktopJobIds.systemToolsUpdater, durable: true, drain: close});
        plugin.defer(() => { void close(); });
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
