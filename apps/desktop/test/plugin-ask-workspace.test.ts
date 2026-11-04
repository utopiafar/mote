import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import type {AskConversation,AskRun} from '../src/ask';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {askCapability,askWorkspaceChannels,createAskWorkspacePlugin} from '../src/plugins/ask-workspace';
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
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it('delivers real query progress and its answer through the one restricted Ask service', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-ask-central-'));
  directories.push(serverDirectory);
  const token = 'generated-plugin-ask-' + randomUUID();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: 'generated-model', modelBaseUrl: 'https://generated.invalid', apiKey: 'generated-key',
    allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    agent: {
      configured: true,
      close: async () => { release(); },
      query: async input => {
        calls++;
        input.onProgress?.({stage: 'tool', tool: 'search_context', phase: 'started'});
        await gate;
        input.onProgress?.({stage: 'tool', tool: 'search_context', phase: 'completed', count: 2});
        return {answer: 'Generated plugin answer', citations: [], trace: [], runId: randomUUID()};
      },
    },
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const config = {...defaultConfig(), serverUrl: origin, token};
  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [askCapability]);
  host.registerWindow(8, 'quick-note', [askCapability]);
  const plugin = createAskWorkspacePlugin({
    settings: () => config,
    installLogin: async () => {},
    endLogin: async () => {},
    browserLogin: async () => {},
  });
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);
  try {
    // The quick-note window holds the same capability but is not an allowed
    // role for Ask; the exact main-frame URL is also enforced.
    expect(await fake.invoke(askWorkspaceChannels.request, view(8, 'quick-note'), ['runs']))
      .toEqual({ok: false, denial: 'wrong-window'});
    expect(await fake.invoke(askWorkspaceChannels.request, {...view(7, 'main'), frameUrl: 'file:///generated/other.html'}, ['runs']))
      .toEqual({ok: false, denial: 'wrong-window'});

    const id = randomUUID();
    const started = await okValue(fake.invoke(askWorkspaceChannels.request, view(7, 'main'), ['start', {id, question: 'Generated plugin question'}])) as AskRun;
    expect(started).toMatchObject({id, status: 'running'});

    // A reopened window recovers the admitted run by identity and never
    // submits the same request to the model a second time.
    host.unregisterWindow(7);
    host.registerWindow(9, 'main', [askCapability]);
    const resumed = await okValue(fake.invoke(askWorkspaceChannels.request, view(9, 'main'), ['runs'])) as {items: AskRun[]};
    expect(resumed.items).toEqual(expect.arrayContaining([expect.objectContaining({id, status: 'running'})]));
    const recovered = await okValue(fake.invoke(askWorkspaceChannels.request, view(9, 'main'), ['start', {id, question: 'Generated plugin question'}])) as AskRun;
    expect(recovered.id).toBe(id);
    expect(calls).toBe(1);

    let running: AskRun | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      running = await okValue(fake.invoke(askWorkspaceChannels.request, view(9, 'main'), ['run', {id}])) as AskRun;
      if (running.events.some(event => event.tool === 'search_context' && event.phase === 'started')) break;
      await wait(5);
    }
    expect(running).toMatchObject({id, status: 'running'});
    expect(running!.events).toEqual(expect.arrayContaining([
      expect.objectContaining({stage: 'tool', tool: 'search_context', phase: 'started'}),
    ]));

    release();
    let finished = running!;
    for (let attempt = 0; attempt < 100 && finished.status === 'running'; attempt++) {
      await wait(10);
      finished = await okValue(fake.invoke(askWorkspaceChannels.request, view(9, 'main'), ['run', {id}])) as AskRun;
    }
    expect(finished.status).toBe('completed');
    expect(finished.events).toEqual(expect.arrayContaining([
      expect.objectContaining({stage: 'tool', tool: 'search_context', phase: 'completed'}),
    ]));
    expect(finished.conversationId).toBeTruthy();
    expect(calls).toBe(1);

    const conversation = await okValue(fake.invoke(askWorkspaceChannels.request, view(9, 'main'), ['conversation', {id: finished.conversationId}])) as AskConversation;
    expect(conversation.id).toBe(finished.conversationId);
    expect(conversation.turns.at(-1)?.result?.answer).toBe('Generated plugin answer');
  } finally {
    release();
    await host.requestQuit();
    await node.app.close();
  }
});
