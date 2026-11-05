/** Mac device settings plugin: owns the configuration store, the settings
 * transaction, connection invitation handoff/checks, permission help, the
 * language preference and capture-context declarations. It backs the renderer
 * settings workspace, permissions UI, capture-context dialog and language
 * draft through declared read/write services; credential exchange, OS
 * permission panes and the private config file stay in the privileged process. */
import {open} from 'node:fs/promises';
import {readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  configureLocale, getLocale, languagePreference, locales, moteText, negotiateLocale, statusMessage,
  type LanguagePreference,
} from '@mote/shared/i18n';
import type {BrowserWindow} from 'electron';
import type {Config, ConfigUpdate, Platform, Status} from '../contracts';
import type {ConnectionStatus} from '../contracts/connection';
import type {CaptureContextChannel} from '../contracts/sources';
import {ConfigStore, updateConfig, type SecretStorage} from '../config';
import {ConnectionOnboarding, testConnection} from '../connection';
import {ConnectionController} from '../connection-controller';
import {loginRequest} from '../login-session';
import {PermissionGuide} from '../permission-guide';
import {permissionKind, type DragPermissionKind, type PermissionStatus, type SettingsWindow} from '../permission-types';
import {SettingsCoordinator, type SettingsDependencies} from '../settings-coordinator';
import {failureCode, safeErrorName, type EventJournal, type EventStage} from '../support';
import {deviceSettingsChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

/** Configuration and connection state are read broadly; every effect asks for
 * the write service explicitly. */
export const deviceSettingsReadCapability = 'device-settings.read';
export const deviceSettingsWriteCapability = 'device-settings.write';

export {deviceSettingsChannels};

type SettingsCollector = SettingsDependencies['collector'];
type SettingsSources = SettingsDependencies['sources'];
type SettingsQueue = SettingsDependencies['queue'];
type SettingsNotes = SettingsDependencies['notes'];

export interface DeviceSettingsRuntime {
  readonly collector: SettingsCollector & {setSyncPaused(paused: boolean): Promise<void>};
  readonly sources: SettingsSources & {
    setSyncPaused(paused: boolean): Promise<void>;
    captureContext(channel: CaptureContextChannel): Promise<unknown>;
    saveCaptureContext(channel: CaptureContextChannel, input: unknown): Promise<unknown>;
  };
  readonly authorizeCalendar: () => Promise<unknown>;
  readonly isCalendarPermissionError: (error: unknown) => boolean;
  readonly queue: SettingsQueue;
  readonly notes: SettingsNotes & {settle(): Promise<void>};
  readonly loginItems: {set(openAtLogin: boolean): void; get(): boolean};
  readonly running: () => boolean;
  readonly quitting: () => boolean;
  readonly recoveryRequired: () => string | undefined;
  readonly requireRecovery: (message: string) => void;
  readonly configureDiagnostics: () => Promise<void>;
  readonly relocate: (config: Config) => Promise<void>;
  readonly clearStorageSelection: () => void;
  readonly pendingStorageDirectory: () => string | undefined;
  readonly status: () => Status;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly background: <T>(channel: string, label: string, operation: () => T | Promise<T>) => Promise<T>;
  readonly guard: () => void;
  readonly changed: () => void;
  readonly events?: Pick<EventJournal, 'record'>;
  readonly onSettings?: (config: Config) => void;
  readonly applicationPath: string;
  readonly canDrag: boolean;
  readonly bundleId: () => Promise<string>;
  readonly mediaAccessStatus: () => string;
  readonly accessibilityGranted: () => boolean;
  readonly calendarStatus: () => Promise<string>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly restart: () => void;
  readonly owner: () => BrowserWindow | undefined;
  readonly guideAppPath?: string;
  readonly settingsWindow: () => Promise<SettingsWindow>;
  readonly granted: (kind: DragPermissionKind) => boolean;
  readonly chooseInvitation: (kind: 'json' | 'qr') => Promise<string | undefined>;
  readonly recognizeQr: (bytes: Buffer) => Promise<string>;
  readonly settleNotes: () => Promise<void>;
  readonly onLanguageChanged: () => void;
  readonly reloadWindows: () => void;
}

export interface DeviceSettingsPluginOptions {
  readonly directory: string;
  readonly secrets: SecretStorage;
  readonly defaults: () => Config;
  readonly bootstrap: () => Config;
  readonly defaultProfile: boolean;
  readonly platform: Platform;
  readonly systemLanguages: () => readonly string[];
}

export interface DeviceSettingsPlugin extends BuiltinDesktopPlugin {
  /** Load the durable configuration; the stable device identity is persisted
   * before any observation can depend on it. */
  initialize(directory?: string): Promise<void>;
  attach(runtime: DeviceSettingsRuntime): void;
  readonly store: ConfigStore;
  settings(): Config;
  languageState(): {preference: LanguagePreference; locale: ReturnType<typeof getLocale>};
  unboundBacklog(): boolean;
  paused<T>(operation: () => Promise<T>): Promise<T>;
  apply(config: Config): Promise<void>;
  connectionChange<T>(operation: () => Promise<T>, sameNodeInvitation?: boolean, confirmedInitial?: boolean): Promise<T>;
  commitConnection(config: Config, sameNodeInvitation?: boolean, confirmedInitial?: boolean): Promise<void>;
}

const connectionStage = (channel: string): EventStage | undefined =>
  channel === deviceSettingsChannels.connectionConfirm || channel === deviceSettingsChannels.connectionTest ? 'CONNECTION'
    : channel === deviceSettingsChannels.configure ? 'CONFIG' : undefined;

const operationLabel = (channel: string): string | undefined => {
  if (channel === deviceSettingsChannels.configure) return moteText('正在应用设置或迁移存储');
  if (channel === deviceSettingsChannels.connectionConfirm) return moteText('正在连接中央');
  if (channel === deviceSettingsChannels.connectionTest) return moteText('正在测试连接');
  return undefined;
};

async function readSelectedInvitation(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maximum + 1);
    const read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead > maximum) throw new Error(moteText('连接邀请文件超过大小限制'));
    return buffer.subarray(0, read.bytesRead);
  } finally { await file.close(); }
}

export function createDeviceSettingsPlugin(options: DeviceSettingsPluginOptions): DeviceSettingsPlugin {
  const languageFile = join(options.directory, 'language.json');
  let preferredLanguage: LanguagePreference = 'system';
  try { preferredLanguage = languagePreference(JSON.parse(readFileSync(languageFile, 'utf8'))); } catch { /* Missing or invalid preference follows the system. */ }
  configureLocale(() => preferredLanguage === 'system' ? negotiateLocale(options.systemLanguages()) : preferredLanguage);

  let directory = options.directory;
  let store: ConfigStore | undefined;
  let settings: Config | undefined;
  let coordinator: SettingsCoordinator | undefined;
  let runtime: DeviceSettingsRuntime | undefined;
  let connectionState: ConnectionStatus = {state: 'unchecked', get message() { return moteText('连接尚未检查'); }};
  let permissionSettingsGeneration = 0;
  const onboarding = new ConnectionOnboarding();

  const requireStore = (): ConfigStore => {
    if (!store) throw new Error('Device settings are not initialized');
    return store;
  };
  const requireSettings = (): Config => {
    if (!settings) throw new Error('Device settings are not initialized');
    return settings;
  };
  const requireCoordinator = (): SettingsCoordinator => {
    if (!coordinator) throw new Error('Device settings are not attached');
    return coordinator;
  };
  const requireRuntime = (): DeviceSettingsRuntime => {
    if (!runtime) throw new Error('Device settings are not attached');
    return runtime;
  };
  const installSettings = (value: Config): void => { settings = value; runtime?.onSettings?.(value); };
  const languageState = () => ({preference: preferredLanguage, locale: getLocale()});

  return {
    id: 'mote.device-settings',
    get store() { return requireStore(); },
    settings: requireSettings,
    languageState,
    async initialize(target = options.directory): Promise<void> {
      if (store) throw new Error('Device settings are already initialized');
      directory = target;
      store = new ConfigStore(directory, options.secrets, options.defaults, options.bootstrap);
      settings = await store.load();
      await store.save(settings); // Persist stable device identity before the first observation.
    },
    attach(value: DeviceSettingsRuntime): void {
      if (runtime) throw new Error('Device settings are already attached');
      runtime = value;
      coordinator = new SettingsCoordinator({
        settings: requireSettings, installSettings, store: requireStore(),
        collector: value.collector, sources: value.sources, queue: value.queue, notes: value.notes,
        defaultProfile: options.defaultProfile, loginItems: value.loginItems,
        running: value.running, quitting: value.quitting,
        recoveryRequired: value.recoveryRequired, requireRecovery: value.requireRecovery,
        configureDiagnostics: value.configureDiagnostics, relocate: value.relocate,
        clearStorageSelection: value.clearStorageSelection,
        connectionStatus: next => { connectionState = next; },
      });
    },
    unboundBacklog: () => requireCoordinator().unboundBacklog(),
    paused: operation => requireCoordinator().paused(operation),
    apply: config => requireCoordinator().apply(config),
    connectionChange: (operation, sameNodeInvitation = false, confirmedInitial = false) =>
      requireCoordinator().connectionChange(operation, sameNodeInvitation, confirmedInitial),
    commitConnection: (config, sameNodeInvitation = false, confirmedInitial = false) =>
      requireCoordinator().commitConnection(config, sameNodeInvitation, confirmedInitial),
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const d = requireRuntime();
      const coordinator = requireCoordinator();
      const connection = new ConnectionController({
        settings: requireSettings, status: () => connectionState,
        installStatus: value => { connectionState = value; },
        secretStorageAvailable: () => options.secrets.available(),
        platform: options.platform, coordinator, onboarding,
      });
      const permissionGuide = new PermissionGuide({
        appPath: d.guideAppPath, owner: d.owner,
        settingsWindow: d.settingsWindow, granted: d.granted,
      });
      const execute = async <T>(channel: string, operation: () => T | Promise<T>): Promise<T> => {
        if (channel !== deviceSettingsChannels.connectionStatus) d.guard();
        const stage = connectionStage(channel), startedAt = Date.now();
        if (stage) void d.events?.record(stage, 'STARTED', {operation: channel});
        try {
          const label = operationLabel(channel);
          const result = await (label ? d.background(channel, label, operation) : operation());
          if (stage) void d.events?.record(stage, 'OK', {elapsedMs: Date.now() - startedAt, operation: channel});
          return result;
        } catch (error) {
          if (stage) void d.events?.record(stage, failureCode(error, stage), {
            elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
          });
          throw error;
        } finally {
          if (operationLabel(channel) && !d.quitting()) d.changed();
        }
      };
      const openPermissionSettings = async (raw: unknown): Promise<void> => {
        const kind = permissionKind(raw);
        const generation = ++permissionSettingsGeneration;
        const panes = {screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', calendar: 'Privacy_Calendars', files: 'Privacy_AllFiles'};
        permissionGuide.close();
        if (options.platform !== 'macos') return;
        await d.openExternal('x-apple.systempreferences:com.apple.preference.security?' + panes[kind]);
        if (kind !== 'calendar' && generation === permissionSettingsGeneration) await permissionGuide.open(kind);
      };
      const permissionStatus = async (): Promise<PermissionStatus> => ({
        appPath: d.applicationPath,
        canDrag: d.canDrag,
        bundleId: await d.bundleId(),
        screen: options.platform === 'macos' ? d.mediaAccessStatus() : 'unsupported',
        accessibility: options.platform === 'macos' ? (d.accessibilityGranted() ? 'granted' : 'denied') : 'unsupported',
        calendar: options.platform === 'macos' ? await d.calendarStatus() : 'unsupported',
      });

      const scope = host.createScope({
        instanceId: 'mote.device-settings',
        capabilities: [deviceSettingsReadCapability, deviceSettingsWriteCapability],
      });
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl], 'quick-note': [pageUrl + '#quick-note']};
        const register = (
          channel: string, capability: string,
          handler: (args: readonly unknown[]) => unknown,
          roles: readonly ('main' | 'quick-note')[] = ['main'],
        ) => plugin.registerIpc({
          channel, capability, windowRoles: roles, callerCapability: capability, roleFrameUrls,
        }, (_view, args) => handler(args));

        register(deviceSettingsChannels.connectionStatus, deviceSettingsReadCapability, () =>
          execute(deviceSettingsChannels.connectionStatus, () => ({...connectionState, message: statusMessage(connectionState.message)})));
        register(deviceSettingsChannels.connectionPreview, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.connectionPreview, () => onboarding.preview(args[0])));
        register(deviceSettingsChannels.connectionCancel, deviceSettingsWriteCapability, () =>
          execute(deviceSettingsChannels.connectionCancel, () => onboarding.clear()));
        register(deviceSettingsChannels.connectionImport, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.connectionImport, () => d.serialize(async () => {
            const kind = args[0];
            if (kind !== 'json' && kind !== 'qr') throw new Error(moteText('邀请导入方式无效'));
            onboarding.clear();
            if (kind === 'qr' && options.platform !== 'macos') throw new Error(moteText('二维码图片导入暂仅支持 macOS，请使用 JSON 或连接链接'));
            const path = await d.chooseInvitation(kind);
            if (!path) return {canceled: true};
            try {
              const bytes = await readSelectedInvitation(path, kind === 'qr' ? 8 * 1024 * 1024 : 8192);
              const input = kind === 'qr' ? await d.recognizeQr(bytes) : new TextDecoder('utf-8', {fatal: true}).decode(bytes);
              return {canceled: false, preview: onboarding.preview(input)};
            } catch {
              throw new Error(moteText('无法读取有效邀请，请检查 JSON/二维码格式、有效期和文件大小；原连接未变动'));
            }
          })));
        register(deviceSettingsChannels.connectionConfirm, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.connectionConfirm, () => d.serialize(async () => {
            await connection.confirm(args[0], args[1], args[2]);
            return d.status();
          })));
        register(deviceSettingsChannels.connectionTest, deviceSettingsWriteCapability, () =>
          execute(deviceSettingsChannels.connectionTest, () => connection.test()));
        register(deviceSettingsChannels.configure, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.configure, () => d.serialize(async () => {
            const current = requireSettings();
            const confirmedInitial = (args[0] as ConfigUpdate).confirmLocalBacklog === true && coordinator.unboundBacklog();
            let updated = updateConfig(current, args[0] as ConfigUpdate, d.queue.stats().depth + (d.notes.hasPrepared() ? 1 : 0), confirmedInitial);
            if (!options.defaultProfile && updated.openAtLogin) throw new Error(moteText('命名环境请使用带 --profile 的启动命令；系统默认登录项不能保留环境参数'));
            const relocating = updated.captureStorageDirectory !== current.captureStorageDirectory;
            const changingConnection = updated.serverUrl !== current.serverUrl || updated.token !== current.token;
            if (relocating && updated.captureStorageDirectory && updated.captureStorageDirectory !== d.pendingStorageDirectory()) throw new Error(moteText('请通过本机文件夹选择器选择截图位置，再保存设置'));
            if (relocating && changingConnection) throw new Error(moteText('请先保存截图位置，再单独保存节点连接；每次切换均会自动应用'));
            if (changingConnection && updated.token) {
              const identity = await testConnection(updated, fetch, false);
              if (!identity.capabilities.archiveRead) throw new Error(moteText('升级中央后再登录'));
              if (identity.credential.id === 'owner' || identity.credential.deviceId !== updated.deviceId) {
                const grant = await loginRequest(updated, '/api/login/session', {
                  serverUrl: updated.serverUrl, deviceId: updated.deviceId, deviceName: updated.deviceName,
                  platform: options.platform, durationMs: 30 * 86400000,
                }, updated.token);
                updated = {...updated, token: grant.token, authExpiresAt: grant.expiresAt};
              }
              updated = {...updated, credentialScope: 'owner', authSignedOut: false, authSessionOnly: false};
            }
            if (changingConnection) await coordinator.connectionChange(() => coordinator.commitConnection(updated, false, confirmedInitial), false, confirmedInitial);
            else await coordinator.paused(() => coordinator.apply(updated));
            d.changed();
            return d.status();
          })));
        register(deviceSettingsChannels.syncPaused, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.syncPaused, () => d.serialize(async () => {
            const paused = args[0];
            if (typeof paused !== 'boolean') throw new Error('Invalid paused sync setting');
            const current = requireSettings(), updated = updateConfig(current, {...current, syncPaused: paused});
            if (paused) { await d.collector.setSyncPaused(true); await d.sources.setSyncPaused(true); }
            try {
              await requireStore().save(updated); installSettings(updated);
              // A resume takes effect only after it is durable; scans and sampling never stop.
              await d.sources.setSyncPaused(paused); await d.collector.setSyncPaused(paused);
            } catch (error) {
              const persisted = await requireStore().load().catch(() => undefined);
              if (!persisted || JSON.stringify(persisted) === JSON.stringify(updated)) {
                d.requireRecovery(moteText('设置提交需要恢复；已停止采集与上传并保留数据，请重新打开 Mote。')); throw error;
              }
              await d.collector.setSyncPaused(Boolean(current.syncPaused));
              await d.sources.setSyncPaused(Boolean(current.syncPaused));
              throw error;
            }
            return d.status();
          })));
        register(deviceSettingsChannels.permissionStatus, deviceSettingsReadCapability, () =>
          execute(deviceSettingsChannels.permissionStatus, permissionStatus));
        register(deviceSettingsChannels.permissionSettings, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.permissionSettings, () => openPermissionSettings(args[0])));
        register(deviceSettingsChannels.permissionRequest, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.permissionRequest, async () => {
            const kind = permissionKind(args[0]);
            if (kind === 'calendar' && options.platform === 'macos') {
              const generation = ++permissionSettingsGeneration;
              permissionGuide.close();
              try { await d.authorizeCalendar(); }
              catch (error) {
                if (!d.isCalendarPermissionError(error)) throw error;
                if (generation === permissionSettingsGeneration) await openPermissionSettings(kind);
              }
            } else await openPermissionSettings(kind);
          }));
        register(deviceSettingsChannels.permissionRestart, deviceSettingsWriteCapability, () =>
          execute(deviceSettingsChannels.permissionRestart, () => d.restart()));
        register(deviceSettingsChannels.permissions, deviceSettingsWriteCapability, () =>
          execute(deviceSettingsChannels.permissions, async () => {
            if (options.platform === 'macos') await d.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          }));
        register(deviceSettingsChannels.captureContext, deviceSettingsReadCapability, args =>
          execute(deviceSettingsChannels.captureContext, () => d.sources.captureContext(args[0] as CaptureContextChannel)));
        register(deviceSettingsChannels.captureContextSave, deviceSettingsWriteCapability, args =>
          execute(deviceSettingsChannels.captureContextSave, () => d.serialize(() =>
            d.sources.saveCaptureContext(args[0] as CaptureContextChannel, args[1]))));
        register(deviceSettingsChannels.language, deviceSettingsReadCapability, () => languageState(), ['main', 'quick-note']);
        register(deviceSettingsChannels.setLanguage, deviceSettingsWriteCapability, async args => {
          const raw = args[0];
          if (raw !== 'system' && !(locales as readonly string[]).includes(String(raw))) throw new Error('Invalid language');
          await d.settleNotes();
          const next = languagePreference(raw);
          writeFileSync(languageFile + '.tmp', JSON.stringify(next), {mode: 0o600});
          renameSync(languageFile + '.tmp', languageFile);
          preferredLanguage = next;
          d.onLanguageChanged();
          // Renderer navigation is blocked; only this trusted IPC may reload its fixed page.
          setTimeout(() => d.reloadWindows(), 20);
          return languageState();
        }, ['main', 'quick-note']);

        plugin.defer(() => permissionGuide.dispose());
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
