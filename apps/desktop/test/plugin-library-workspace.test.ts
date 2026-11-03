import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import {DurableQueue} from '../src/queue';
import {uploadCaptureBatch} from '../src/transport';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  createLibraryWorkspacePlugin,libraryReadCapability,libraryWorkspaceChannels,memoryReadCapability,
} from '../src/plugins/library-workspace';
import type {BuiltinPluginContext} from '../src/plugins/index';
import type {LocalSourceManager} from '../src/source-manager';
import type {CentralContentPage,TopicDirectory,TopicPage} from '../src/contracts/content';
import {event} from './fixtures';

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
const view = (senderId: number, windowRole: 'main' | 'quick-note'): IpcCallerView =>
  ({senderId, frameIsMain: true, windowRole, frameUrl: pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it('projects real Central content and topic responses through the restricted desktop services', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-library-workspace-central-'));
  directories.push(serverDirectory);
  const token = 'generated-library-workspace-' + randomUUID();
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated library fixture'); }, close: async () => {}},
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const config = {...defaultConfig(), serverUrl: origin, token};
  const clientDirectory = await mkdtemp(join(tmpdir(), 'mote-library-workspace-client-'));
  directories.push(clientDirectory);
  const queue = new DurableQueue(join(clientDirectory, 'queue'), config);
  await queue.initialize();
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [libraryReadCapability, memoryReadCapability]);
  host.registerWindow(8, 'quick-note', [libraryReadCapability, memoryReadCapability]);
  const plugin = createLibraryWorkspacePlugin({
    settings: () => config,
    queue,
    sources: () => ({
      status: () => [], pendingContentSummaries: () => [], pendingForHistory: () => undefined,
    } as unknown as LocalSourceManager),
    syncHistory: {receivedCapture: () => undefined},
  });
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);
  try {
    const dispose = node.featureServices.contextTrees.register({
      id: 'generated.library', version: '1', label: 'Generated topics',
      nodes: [{id: 'generated.all', label: 'Generated all', select: {}}],
    });
    try {
      const id = randomUUID();
      const capture = {
        ...event(id), deviceId: config.deviceId, deviceName: 'Generated library Mac', platform: 'macos' as const,
        capturedAt: new Date().toISOString(), source: 'note' as const, imageMime: undefined, durationMs: 0,
        appName: 'Generated Library App', windowTitle: 'Generated library title', ocrText: 'Generated library body',
        privacy: {excluded: false, redacted: false, mode: 'none' as const},
      };
      const receipts = await uploadCaptureBatch(config, [{event: capture}]);
      expect(receipts.get(id)).toBe(201);

      const content = await okValue(fake.invoke(libraryWorkspaceChannels.contentCentral, view(7, 'main'))) as CentralContentPage;
      expect(content.items).toEqual(expect.arrayContaining([
        expect.objectContaining({key: `capture:${id}`, source: 'note', preview: 'Generated library body'}),
      ]));

      const directory = await okValue(fake.invoke(libraryWorkspaceChannels.memoryTopics, view(7, 'main'))) as TopicDirectory;
      expect(directory.items).toEqual(expect.arrayContaining([
        expect.objectContaining({id: 'generated.library', label: 'Generated topics'}),
      ]));
      const topicPage = await okValue(fake.invoke(libraryWorkspaceChannels.memoryTopicPage, view(7, 'main'), [{
        treeId: 'generated.library', nodeId: 'generated.all',
      }])) as TopicPage;
      expect(topicPage.items).toEqual([]);

      // The quick-note window holds the same capabilities but is not an allowed
      // role for the reader surface; the exact frame URL is also enforced.
      expect(await fake.invoke(libraryWorkspaceChannels.contentCentral, view(8, 'quick-note')))
        .toEqual({ok: false, denial: 'wrong-window'});
      expect(await fake.invoke(libraryWorkspaceChannels.memoryTopics, {...view(7, 'main'), frameUrl: 'file:///generated/other.html'}))
        .toEqual({ok: false, denial: 'wrong-window'});
    } finally {
      dispose();
    }
  } finally {
    await host.requestQuit();
    await node.app.close();
  }
});
