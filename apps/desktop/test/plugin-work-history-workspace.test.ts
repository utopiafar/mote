import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {WorkActivityPage} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import type {DurableQueue} from '../src/queue';
import {captureHistoryItem,SyncHistory} from '../src/sync-history';
import type {LocalSourceManager} from '../src/source-manager';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  createWorkHistoryWorkspacePlugin,workHistoryReadCapability,workHistoryWorkspaceChannels,
} from '../src/plugins/work-history-workspace';
import type {BuiltinPluginContext} from '../src/plugins/index';
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
const localDay = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it('projects each real Central operation as its own job, operation identity and time', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-work-history-central-'));
  directories.push(serverDirectory);
  const token = 'generated-work-history-' + randomUUID();
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated work fixture'); }, close: async () => {}},
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const config = {...defaultConfig(), serverUrl: origin, token, deviceId: 'generated-work-device'};
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [workHistoryReadCapability]);
  host.registerWindow(8, 'quick-note', [workHistoryReadCapability]);
  const plugin = createWorkHistoryWorkspacePlugin({
    settings: () => config,
    history: {} as SyncHistory,
    queue: {historyPending: () => []} as unknown as DurableQueue,
    sources: () => ({status: () => []} as unknown as LocalSourceManager),
  });
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);
  try {
    node.executor.register({
      kind: 'work-history.fixture', pool: 'work-history.fixture', concurrency: () => 1,
      validate: () => true, execute: async () => null, commit: () => {},
    });
    const completed = 'workflow:generated-completed-' + randomUUID();
    const failed = 'source:generated-failed-' + randomUUID();
    node.executor.enqueue(completed, 'work-history.fixture', {}, {initial: {state: 'succeeded', attempts: 1, availableAt: 0}});
    node.executor.enqueue(failed, 'work-history.fixture', {}, {initial: {state: 'failed', attempts: 1, availableAt: 0}});
    const completedTimes = {created: Date.parse('2026-10-01T10:00:00.000Z'), updated: Date.parse('2026-10-01T10:05:00.000Z')};
    const failedTimes = {created: Date.parse('2026-10-02T11:00:00.000Z'), updated: Date.parse('2026-10-02T11:07:00.000Z')};
    for (const [id, times] of [[completed, completedTimes], [failed, failedTimes]] as const)
      node.store.db.prepare('UPDATE operation_progress SET created_at=?,updated_at=? WHERE id=?').run(times.created, times.updated, id);

    const completedPage = await okValue(fake.invoke(workHistoryWorkspaceChannels.workActivity, view(7, 'main'), [{state: 'completed'}])) as WorkActivityPage;
    const completedWork = completedPage.items.find(item => item.id === completed);
    expect(completedWork).toMatchObject({
      id: completed, createdAt: new Date(completedTimes.created).toISOString(), updatedAt: new Date(completedTimes.updated).toISOString(),
      technical: {operationIds: [completed]},
    });
    expect(completedPage.items.some(item => item.id === failed)).toBe(false);

    const attentionPage = await okValue(fake.invoke(workHistoryWorkspaceChannels.workActivity, view(7, 'main'), [{state: 'attention'}])) as WorkActivityPage;
    const failedWork = attentionPage.items.find(item => item.id === failed);
    expect(failedWork).toMatchObject({
      id: failed, createdAt: new Date(failedTimes.created).toISOString(), updatedAt: new Date(failedTimes.updated).toISOString(),
      technical: {operationIds: [failed]},
    });
    expect(failedWork!.updatedAt).not.toBe(completedWork!.updatedAt);
    expect(attentionPage.items.some(item => item.id === completed)).toBe(false);

    expect(await fake.invoke(workHistoryWorkspaceChannels.workActivity, view(8, 'quick-note'), [{state: 'completed'}]))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(await fake.invoke(workHistoryWorkspaceChannels.syncHistory, {...view(7, 'main'), frameUrl: 'file:///generated/other.html'}, [{day: localDay()}]))
      .toEqual({ok: false, denial: 'wrong-window'});
  } finally {
    await host.requestQuit();
    await node.app.close();
  }
});

it('keeps sync-history read state across a reopen through the restricted service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-work-history-receipts-'));
  directories.push(directory);
  const path = join(directory, 'history.sqlite');
  const config = {...defaultConfig(), serverUrl: 'http://127.0.0.1:1', token: 'generated-token', deviceId: 'generated-work-device'};
  const item = captureHistoryItem(event(randomUUID()));
  const open = async () => { const history = new SyncHistory(path); await history.initialize(); return history; };
  const register = async (history: SyncHistory) => {
    const fake = makeRouter();
    const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
    host.registerWindow(7, 'main', [workHistoryReadCapability]);
    const plugin = createWorkHistoryWorkspacePlugin({
      settings: () => config, history, queue: {historyPending: () => []} as unknown as DurableQueue,
      sources: () => ({status: () => []} as unknown as LocalSourceManager),
    });
    await plugin.register({
      host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
      mainSenderId: 7, trustedMain: () => undefined,
    } as BuiltinPluginContext);
    return {fake, host};
  };
  const first = await open();
  const run = first.begin(config, 'manual');
  first.attempt(run, [item]);
  first.settle(run, item.key, true, item.captureId, 201);
  first.finish(run);
  const read = async (fake: ReturnType<typeof makeRouter>) => okValue(fake.invoke(workHistoryWorkspaceChannels.syncHistory, view(7, 'main'), [{day: localDay()}])) as Promise<{
    items: {id: string; received: number; outcome: string}[]; received: number;
  }>;
  const firstRegistration = await register(first);
  try {
    const page = await read(firstRegistration.fake);
    expect(page).toMatchObject({received: 1, items: [{id: run, received: 1, outcome: 'received'}]});
    const contents = await okValue(firstRegistration.fake.invoke(workHistoryWorkspaceChannels.syncHistoryContents, view(7, 'main'), [{runId: run}])) as {
      items: {key: string; firstReceipt: boolean}[];
    };
    expect(contents.items).toEqual([expect.objectContaining({key: item.key, firstReceipt: true})]);
  } finally {
    await firstRegistration.host.requestQuit();
    first.close();
  }
  const reopened = await open();
  try {
    const secondRegistration = await register(reopened);
    try {
      const page = await read(secondRegistration.fake);
      expect(page).toMatchObject({received: 1, items: [{id: run, received: 1, outcome: 'received'}]});
      const contents = await okValue(secondRegistration.fake.invoke(workHistoryWorkspaceChannels.syncHistoryContents, view(7, 'main'), [{runId: run}])) as {
        items: {key: string; firstReceipt: boolean}[];
      };
      expect(contents.items).toEqual([expect.objectContaining({key: item.key, firstReceipt: true})]);
    } finally { await secondRegistration.host.requestQuit(); }
  } finally { reopened.close(); }
});
