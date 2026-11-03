import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import {DurableQueue} from '../src/queue';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import type {Status} from '../src/contracts';
import {
  captureChannels,captureReadCapability,captureWriteCapability,createCapturePlugin,createCaptureStages,type CapturePlugin,
} from '../src/plugins/capture';
import type {BuiltinPluginContext} from '../src/plugins/index';
import {event} from './fixtures';

const mocks = vi.hoisted(() => ({
  idle: vi.fn(() => 0), idleState: vi.fn(() => 'active'), capture: vi.fn(async () => [] as unknown[]),
}));
vi.mock('electron', async () => {
  const {EventEmitter: Emitter} = await import('node:events');
  class GeneratedImage {
    constructor(readonly pixels: Buffer, readonly width = 4, readonly height = 4) {}
    getSize() { return {width: this.width, height: this.height}; }
    isEmpty() { return false; }
    toBitmap() { return Buffer.from(this.pixels); }
  }
  return {
    desktopCapturer: {getSources: mocks.capture},
    nativeImage: {createFromBitmap: (buffer: Buffer, options: {width: number; height: number}) => new GeneratedImage(buffer, options.width, options.height)},
    powerMonitor: Object.assign(new Emitter(), {getSystemIdleTime: mocks.idle, getSystemIdleState: mocks.idleState}),
    screen: {getPrimaryDisplay: () => ({id: 1, size: {width: 4, height: 4}, bounds: {x: 0, y: 0, width: 4, height: 4}, scaleFactor: 2})},
    systemPreferences: {getMediaAccessStatus: () => 'granted'},
  };
});
vi.mock('../src/native', () => ({
  readVisibleNotifications: vi.fn(async () => []),
  runHelper: vi.fn(async () => ({status: 'blocked'})),
  activeApplication: vi.fn(async () => ({appId: 'dev.mote.fixture', appName: 'Generated Fixture', pid: 1, visibleAppIds: ['dev.mote.fixture'], unknownVisibleWindows: false})),
  foregroundApplication: vi.fn(async () => ({appId: 'dev.mote.fixture', appName: 'Generated Fixture', pid: 1})),
  recognizeText: vi.fn(async () => 'Generated text'),
  readPowerState: vi.fn(async () => ({onBattery: false, charging: true, batteryPercent: 100})),
}));
vi.mock('../src/record-metadata', () => ({collectRecordMetadata: vi.fn(async () => undefined)}));

import {powerMonitor} from 'electron';

const makeRouter = () => {
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const removed: string[] = [];
  const router: IpcRouter = {
    handle: (channel, listener) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); removed.push(channel); },
  };
  return {
    router, removed,
    invoke: (channel: string, view: IpcCallerView, args: readonly unknown[] = []) =>
      handlers.get(channel)?.(view, args) as Promise<IpcInvokeResult> | undefined,
    has: (channel: string) => handlers.has(channel),
  };
};

const pageUrl = 'file:///generated/index.html';
const view = (senderId = 7): IpcCallerView => ({senderId, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

let directories: string[] = [];
let plugin: CapturePlugin | undefined;
beforeEach(() => { directories = []; });
afterEach(async () => {
  plugin?.shutdown();
  plugin = undefined;
  (powerMonitor as unknown as EventEmitter).removeAllListeners();
  await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

const createPlugin = (queue: DurableQueue, settings: ReturnType<typeof defaultConfig>) => {
  plugin = createCapturePlugin({
    queue, settings: () => settings, helperPath: '/fixture/no-real-helper',
    encryptedStorageAvailable: () => true, onChange: () => undefined,
    status: () => plugin!.collector.status(),
  });
  return plugin;
};

const register = async (current: CapturePlugin, host: DesktopPluginHost, mainSenderId = 7) => {
  await current.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId, trustedMain: () => undefined,
  } as BuiltinPluginContext);
};

describe('capture plugin lifecycle', () => {
  it('unregisters capture timers, power watchers and IPC handlers when the plugin is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mote-plugin-capture-lifecycle-'));
    directories.push(directory);
    const settings = defaultConfig();
    const queue = new DurableQueue(join(directory, 'queue'), settings);
    await queue.initialize();
    const current = createPlugin(queue, settings);
    current.initialize();
    const collector = current.collector as unknown as {uploadTimer?: unknown; heartbeatTimer?: unknown};
    expect(collector.uploadTimer).toBeDefined();
    expect(collector.heartbeatTimer).toBeDefined();
    const power = powerMonitor as unknown as EventEmitter;
    expect(power.listenerCount('lock-screen')).toBe(1);
    expect(power.listenerCount('unlock-screen')).toBe(1);
    expect(power.listenerCount('suspend')).toBe(1);
    expect(power.listenerCount('resume')).toBe(1);

    const fake = makeRouter();
    const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
    host.registerWindow(7, 'main', [captureReadCapability, captureWriteCapability]);
    await register(current, host);
    expect(fake.has(captureChannels.reviewPending)).toBe(true);
    expect(await okValue(fake.invoke(captureChannels.reviewPending, view()))).toEqual([]);
    const started = await okValue(fake.invoke(captureChannels.start, view())) as Status;
    expect(started.running).toBe(true);
    const stopped = await okValue(fake.invoke(captureChannels.stop, view())) as Status;
    expect(stopped.running).toBe(false);

    expect(host.stopScope('mote.capture')).toEqual([]);
    expect(collector.uploadTimer).toBeUndefined();
    expect(collector.heartbeatTimer).toBeUndefined();
    expect(power.listenerCount('lock-screen')).toBe(0);
    expect(power.listenerCount('unlock-screen')).toBe(0);
    expect(power.listenerCount('suspend')).toBe(0);
    expect(power.listenerCount('resume')).toBe(0);
    expect(fake.has(captureChannels.reviewPending)).toBe(false);
    expect(await fake.invoke(captureChannels.reviewPending, view())).toBeUndefined();
    // Shutdown is idempotent after the scope already disposed the plugin.
    current.shutdown();
  });

  it('resumes the durable capture stage series after a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mote-plugin-capture-stages-'));
    directories.push(directory);
    const settings = defaultConfig();
    const {ocrText: _text, imageMime: _mime, ...base} = event();
    const first = {
      ...base, deviceId: settings.deviceId, source: 'activity' as const, durationMs: 0,
      capturedAt: '2026-09-24T00:00:00.000Z',
      privacy: {excluded: false as const, redacted: false as const, mode: 'none' as const, collection: 'activity' as const},
    };
    const before = new DurableQueue(join(directory, 'queue'), settings, createCaptureStages());
    await before.initialize();
    await before.enqueue(first);

    const restarted = new DurableQueue(join(directory, 'queue'), settings, createCaptureStages());
    await restarted.initialize();
    await restarted.enqueue({...first, id: randomUUID(), capturedAt: '2026-09-24T00:00:05.000Z'});
    const record = (await restarted.next())?.record.event;
    expect(record?.id).toBe(first.id);
    expect(record?.stateSeries?.samples).toHaveLength(2);
  });
});

describe('capture plugin Central consumer', () => {
  it('acknowledges the real Central ingest receipt in the queue state', async () => {
    const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-capture-central-'));
    directories.push(serverDirectory);
    const token = 'generated-plugin-capture-' + randomUUID();
    const node = await buildApp({
      dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
      maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
      allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
      embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
    }, {
      backgroundWorker: false,
      agent: {configured: false, query: async () => { throw Error('No model in generated capture fixture'); }, close: async () => {}},
    });
    const origin = await node.app.listen({host: '127.0.0.1', port: 0});
    const settings = {...defaultConfig(), serverUrl: origin, token, packedUpload: false};
    const clientDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-capture-client-'));
    directories.push(clientDirectory);
    const queue = new DurableQueue(join(clientDirectory, 'queue'), settings, createCaptureStages());
    await queue.initialize();
    const fake = makeRouter();
    const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
    host.registerWindow(7, 'main', [captureReadCapability, captureWriteCapability]);
    const current = createPlugin(queue, settings);
    await register(current, host);
    try {
      const id = randomUUID();
      const capture = {
        ...event(id), deviceId: settings.deviceId, deviceName: settings.deviceName, platform: 'macos' as const,
        capturedAt: new Date().toISOString(), source: 'note' as const, imageMime: undefined, durationMs: 0,
        ocrText: 'Generated capture receipt body', privacy: {excluded: false as const, redacted: false as const, mode: 'none' as const},
      };
      await queue.enqueue(capture);
      const status = await okValue(fake.invoke(captureChannels.retry, view())) as Status;
      expect(queue.stats().depth).toBe(0);
      expect(status.queueDepth).toBe(0);
      expect(status.lastUploadAt).toBeDefined();
      expect(queue.stats().archiveAcknowledgment).toMatchObject({origin, at: status.lastUploadAt});

      const response = await fetch(origin + '/api/captures/' + id, {headers: {Authorization: 'Bearer ' + token}});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({id, source: 'note'});
    } finally {
      await host.requestQuit();
      await node.app.close();
    }
  });
});
