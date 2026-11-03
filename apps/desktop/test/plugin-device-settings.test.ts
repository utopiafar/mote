import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import type {Config, Status} from '../src/contracts';
import type {ConnectionBindingStore} from '../src/connection-binding';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  createDeviceSettingsPlugin,deviceSettingsChannels,deviceSettingsReadCapability,deviceSettingsWriteCapability,
  type DeviceSettingsRuntime,
} from '../src/plugins/device-settings';
import type {BuiltinPluginContext} from '../src/plugins/index';

// The permission guide imports Electron; its native window is not part of this
// generated IPC/connection fixture.
vi.mock('electron', () => ({
  app: {getFileIcon: async () => ({isEmpty: () => true})},
  BrowserWindow: class {},
  ipcMain: {handle() {}, on() {}, removeHandler() {}, removeListener() {}},
  screen: {getDisplayMatching: () => ({workArea: {x: 0, y: 0, width: 1200, height: 900}})},
  shell: {showItemInFolder() {}},
}));

const makeRouter = () => {
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const router: IpcRouter = {
    handle: (channel, listener) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); },
  };
  return {
    router,
    invoke: (channel: string, view: IpcCallerView, args: readonly unknown[] = []) =>
      handlers.get(channel)?.(view, args) as Promise<IpcInvokeResult> | undefined,
  };
};

const pageUrl = 'file:///generated/index.html';
const view = (): IpcCallerView => ({senderId: 7, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

function generatedStatus(config: Config): Status {
  return {
    running: false, state: 'stopped', message: 'Generated', queueDepth: 0, queueBytes: 0,
    sync: {state: 'manual', mode: 'manual', message: 'Generated', pendingRecords: 0},
    screenPermission: 'granted', platform: 'macos', encryptedTokenStorage: true, config: config as Status['config'],
  };
}

it('keeps the saved connection until an explicit confirmation and consumes the real Central pairing response', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-device-settings-central-'));
  const clientDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-device-settings-client-'));
  directories.push(serverDirectory, clientDirectory);
  const ownerToken = 'generated-device-settings-owner-' + randomUUID();
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token: ownerToken, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated device settings fixture'); }, close: async () => {}},
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  try {
    const invitation = (await fetch(origin + '/api/connections/invitations', {
      method: 'POST', headers: {Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json'},
      body: JSON.stringify({serverUrl: origin, label: 'Generated Mac'}),
    }).then(response => response.json())) as {uri: string};

    let settings: Config = {...defaultConfig(), serverUrl: 'http://127.0.0.1:47832'};
    const binding = (): ConnectionBindingStore & {writes: number} => {
      let writes = 0;
      return {
        get writes() { return writes; },
        unbound: () => true, matches: () => false,
        snapshot: () => ({kind: 'unbound'} as ReturnType<ConnectionBindingStore['snapshot']>),
        assertChange: () => {}, commit: async () => { writes++; },
      } as unknown as ConnectionBindingStore & {writes: number};
    };
    const queueBinding = binding(), sourceBinding = binding();
    const runtime = {
      collector: {
        suspendForSettings: async () => () => {}, connectionActivity: () => ({inFlight: false}),
        updateConfig: () => {}, setSyncPaused: async () => {},
      },
      sources: {
        holdConnection: async () => () => {}, sync: async () => {},
        connectionActivity: () => ({pending: 0, inFlight: false}),
        changeConnection: async () => {}, nodeBinding: sourceBinding,
        prepareInitialConnection: async () => {}, prepareReauthorization: async () => {},
        setSyncPaused: async () => {},
        captureContext: async () => ({snapshot: {sourceId: 'generated', version: 0, description: ''}}),
        saveCaptureContext: async () => ({snapshot: {sourceId: 'generated', version: 1, description: 'Generated'}}),
      },
      queue: {binding: queueBinding, stats: () => ({depth: 0}), resetRetries: async () => {}},
      notes: {
        hasPrepared: () => false, hasUnboundPrepared: () => false, bindPreparedOrigin: async () => {}, settle: async () => {},
      },
      loginItems: {set: () => {}, get: () => false},
      running: () => false, quitting: () => false,
      recoveryRequired: () => undefined, requireRecovery: () => {},
      configureDiagnostics: async () => {},
      relocate: async () => {},
      clearStorageSelection: () => {}, pendingStorageDirectory: () => undefined,
      status: () => generatedStatus(settings),
      serialize: <T>(operation: () => Promise<T>) => operation(),
      background: <T>(_channel: string, _label: string, operation: () => T | Promise<T>) => Promise.resolve(operation()),
      guard: () => {}, changed: () => {},
      applicationPath: '/Generated/Mote Dev.app', canDrag: true,
      bundleId: async () => 'dev.generated.mote', mediaAccessStatus: () => 'granted',
      accessibilityGranted: () => true, calendarStatus: async () => 'granted',
      openExternal: async () => {}, restart: () => {},
      owner: () => undefined, settingsWindow: async () => ({frontmost: false}),
      granted: () => true, chooseInvitation: async () => undefined,
      recognizeQr: async () => '', settleNotes: async () => {},
      onLanguageChanged: () => {}, reloadWindows: () => {},
    } as unknown as DeviceSettingsRuntime;

    const plugin = createDeviceSettingsPlugin({
      directory: clientDirectory,
      secrets: {available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString()},
      defaults: () => ({...defaultConfig(), serverUrl: 'http://127.0.0.1:47832'}),
      bootstrap: () => ({...defaultConfig(), serverUrl: 'http://127.0.0.1:47832'}),
      defaultProfile: true, platform: 'macos', systemLanguages: () => ['en-US'],
    });
    await plugin.initialize();
    settings = plugin.settings();
    plugin.attach({...runtime, status: () => generatedStatus(plugin.settings()), onSettings: value => { settings = value; }});

    const fake = makeRouter();
    const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
    host.registerWindow(7, 'main', [deviceSettingsReadCapability, deviceSettingsWriteCapability]);
    await plugin.register({
      host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
      mainSenderId: 7, trustedMain: () => undefined,
    } as BuiltinPluginContext);

    const configPath = join(clientDirectory, 'config.json');
    const configBefore = await readFile(configPath, 'utf8');
    const original = plugin.settings();
    const preview = await okValue(fake.invoke(deviceSettingsChannels.connectionPreview, view(), [invitation.uri])) as {id: string; serverUrl: string};
    expect(preview.serverUrl).toBe(origin);
    expect(plugin.settings()).toBe(original);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await fake.invoke(deviceSettingsChannels.connectionCancel, view())).toMatchObject({ok: true});
    expect(plugin.settings()).toBe(original);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(queueBinding.writes).toBe(0);

    // A second preview after cancel still needs the exact reviewed origin and
    // then consumes the real invitation/redeem and connection self responses.
    const reviewed = await okValue(fake.invoke(deviceSettingsChannels.connectionPreview, view(), [invitation.uri])) as {id: string; serverUrl: string};
    const confirmed = await okValue(fake.invoke(deviceSettingsChannels.connectionConfirm, view(), [reviewed.id, reviewed.serverUrl, 'Generated renamed Mac'])) as Status;
    expect(confirmed.running).toBe(false);
    expect(plugin.settings().serverUrl).toBe(origin);
    expect(plugin.settings().deviceName).toBe('Generated renamed Mac');
    expect(plugin.settings().token).toBeTruthy();
    expect(plugin.settings().credentialScope).toBe('owner');
    expect((await plugin.store.load()).deviceName).toBe('Generated renamed Mac');
    expect(queueBinding.writes).toBe(1);
    expect(sourceBinding.writes).toBe(1);

    const status = await okValue(fake.invoke(deviceSettingsChannels.connectionStatus, view())) as {
      state: string; identity?: {credential: {id: string; deviceId?: string}};
    };
    expect(status.state).toBe('connected');
    expect(status.identity?.credential.deviceId).toBe(plugin.settings().deviceId);
    const self = await fetch(origin + '/api/connections/self', {
      headers: {Authorization: 'Bearer ' + plugin.settings().token},
    });
    expect(self.status).toBe(200);
    expect((await self.json() as {credential: {id: string}}).credential.id).toBe(status.identity?.credential.id);

    // The same plugin scope owns language, capture-context declarations and
    // permission status; the renderer never receives the underlying manager.
    expect(await okValue(fake.invoke(deviceSettingsChannels.language, view()))).toMatchObject({preference: 'system'});
    expect(await okValue(fake.invoke(deviceSettingsChannels.setLanguage, view(), ['en']))).toMatchObject({preference: 'en', locale: 'en'});
    expect(await okValue(fake.invoke(deviceSettingsChannels.captureContext, view(), ['activity'])))
      .toMatchObject({snapshot: {sourceId: 'generated'}});
    expect(await okValue(fake.invoke(deviceSettingsChannels.permissionStatus, view()))).toMatchObject({
      appPath: '/Generated/Mote Dev.app', canDrag: true, bundleId: 'dev.generated.mote',
      screen: 'granted', accessibility: 'granted', calendar: 'granted',
    });

    await host.requestQuit();
  } finally {
    await node.app.close();
  }
});
