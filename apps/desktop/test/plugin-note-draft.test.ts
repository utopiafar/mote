import {afterEach, beforeEach, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import {readCentralContent} from '../src/sync-content';
import {captureHistoryItem} from '../src/sync-history';
import {DurableQueue} from '../src/queue';
import {uploadCaptureBatch} from '../src/transport';
import type {Config} from '../src/contracts';
import type {CaptureEvent} from '../src/contracts';
import type {SyncHistoryItem} from '../src/contracts/sync-history';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView, IpcInvokeResult, IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {createNotesPlugin, notesChannels, notesReadCapability, notesWriteCapability} from '../src/plugins/notes';
import type {BuiltinPluginContext} from '../src/plugins/index';

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
const view = (senderId: number, windowRole: 'main' | 'quick-note', frameUrl = windowRole === 'main' ? pageUrl : pageUrl + '#quick-note'): IpcCallerView =>
  ({senderId, frameIsMain: true, windowRole, frameUrl});

async function pluginFixture(config: Config, queue: {enqueue(event: CaptureEvent): Promise<unknown>}) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-plugin-note-draft-'));
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [notesReadCapability, notesWriteCapability]);
  host.registerWindow(8, 'quick-note', [notesReadCapability, notesWriteCapability]);
  const plugin = createNotesPlugin({directory, settings: () => config, queue, platform: 'macos'});
  await plugin.initialize();
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);
  return {directory, host, plugin, invoke: fake.invoke};
}

const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it('owns the draft and submission through the host-restricted note service', async () => {
  const config = {...defaultConfig(), token: 'generated-note-token'};
  const queued: CaptureEvent[] = [];
  const fixture = await pluginFixture(config, {enqueue: async event => { queued.push(event); }});
  directories.push(fixture.directory);
  try {
    const initial = await okValue(fixture.invoke(notesChannels.draft, view(8, 'quick-note'))) as {id: string; revision: number};
    const updated = await okValue(fixture.invoke(notesChannels.update, view(8, 'quick-note'), [{...initial, text: 'Generated note body', description: 'Generated description', revision: 1}])) as {text: string; revision: number};
    expect(updated).toMatchObject({text: 'Generated note body', revision: 1});
    const saved = await okValue(fixture.invoke(notesChannels.save, view(8, 'quick-note'), [updated])) as {id: string; draft: {text: string}};
    expect(saved.id).toBe(initial.id);
    expect(saved.draft.text).toBe('');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({id: initial.id, source: 'note', ocrText: 'Generated note body'});
    expect(queued[0].metadata?.ownerDescription).toBe('Generated description');

    // The quick-note window may use the declared service; other roles and
    // frames never reach the store.
    expect(await fixture.invoke(notesChannels.draft, {...view(8, 'quick-note'), frameUrl: pageUrl}))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(await fixture.invoke(notesChannels.save, {...view(8, 'quick-note'), frameUrl: 'file:///evil.html'}))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(queued).toHaveLength(1);
  } finally {
    await fixture.host.requestQuit();
  }
});

it('consumes a real Central save receipt and reads the saved note through the desktop consumer', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-note-central-'));
  directories.push(serverDirectory);
  const token = 'generated-plugin-note-' + randomUUID();
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated note plugin fixture'); }, close: async () => {}},
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const config = {...defaultConfig(), serverUrl: origin, token};
  const clientDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-note-receipt-'));
  directories.push(clientDirectory);
  const queue = new DurableQueue(join(clientDirectory, 'queue'), config);
  await queue.initialize();
  const fixture = await pluginFixture(config, queue);
  directories.push(fixture.directory);
  try {
    const initial = await okValue(fixture.invoke(notesChannels.draft, view(8, 'quick-note'))) as {id: string; revision: number};
    const updated = await okValue(fixture.invoke(notesChannels.update, view(8, 'quick-note'), [{...initial, text: 'Generated note kept by the real Central node', mood: '', description: '', revision: 1}])) as {text: string; revision: number};
    const saved = await okValue(fixture.invoke(notesChannels.save, view(8, 'quick-note'), [updated])) as {id: string};
    expect(saved.id).toBe(initial.id);

    const batch = await queue.nextBatch(25, Date.now());
    expect(batch).toHaveLength(1);
    const notes = batch.filter(item => item.record.event.source === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0].record.event.id).toBe(initial.id);

    // The desktop transport validates the Central v2 receipt before the
    // queue acknowledges the exact event.
    const receipts = await uploadCaptureBatch(config, notes.map(item => ({event: item.record.event, image: item.image})));
    expect(receipts.get(initial.id)).toBe(201);
    await queue.acknowledge(initial.id, 0);

    const item = {...captureHistoryItem(notes[0].record.event), outcome: 'received', firstReceipt: true} as SyncHistoryItem;
    const content = await readCentralContent(config, item);
    expect(content.location).toBe('central');
    expect(content.text).toContain('Generated note kept by the real Central node');
    expect(content.captureId).toBe(initial.id);
  } finally {
    await fixture.host.requestQuit();
    await node.app.close();
  }
});
