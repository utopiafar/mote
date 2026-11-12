import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {copyFile,mkdir,mkdtemp,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../server/src/app.js';
import {defaultConfig} from '../src/config';
import {DEFAULT_SOURCE_OPTIONS, type SourceStatus} from '../src/source-types';
import {sourceConnectionBinding} from '../src/login-session';
import {sourceHash} from '../src/source-sync';
import {sourceState} from '../src/source-state-store';
import * as localVolume from '../src/local-volume';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  createSourcesPlugin,sourcesChannels,sourcesReadCapability,sourcesWriteCapability,
} from '../src/plugins/sources';
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
const view = (senderId: number): IpcCallerView => ({senderId, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

let directories: string[] = [];
beforeEach(() => { directories = []; });
afterEach(async () => { vi.restoreAllMocks();await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it('keeps source checkpoints and revision cursors continuous against real Central responses', async () => {
  const serverDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-sources-central-'));
  directories.push(serverDirectory);
  const token = 'generated-plugin-sources-' + randomUUID();
  const node = await buildApp({
    dataDir: join(serverDirectory, 'data'), token, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated source fixture'); }, close: async () => {}},
  });
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const config = {...defaultConfig(), serverUrl: origin, token};
  const clientDirectory = await mkdtemp(join(tmpdir(), 'mote-plugin-sources-client-'));
  directories.push(clientDirectory);
  const sourceRoot = join(clientDirectory, 'generated-source');
  const file = join(sourceRoot, 'generated.md');
  await mkdir(sourceRoot);
  await writeFile(file, 'Generated first source body');
  if(!await localVolume.localVolumeIdentity(sourceRoot))vi.spyOn(localVolume,'localVolumeIdentity').mockResolvedValue('apfs:generated-volume');

  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [sourcesReadCapability, sourcesWriteCapability]);
  const plugin = createSourcesPlugin({
    directory: join(clientDirectory, 'local-sources'),
    settings: () => config,
    helperPath: '/must-not-be-invoked-calendar-helper',
    serialize: operation => operation(),
    choosePaths: async request => ({canceled: false, filePaths: [request.mode === 'directory' ? sourceRoot : file]}),
  });
  // The native watcher contract is covered by its own test; this case controls scans.
  vi.spyOn((plugin.manager as any).watcher, 'setTargets').mockResolvedValue(undefined);
  try {
    await plugin.initialize();
    await plugin.register({
      host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
      mainSenderId: 7, trustedMain: () => undefined,
    } as BuiltinPluginContext);

    const selection = await okValue(fake.invoke(sourcesChannels.select, view(7), ['directory'])) as {canceled: boolean; selectionId?: string};
    expect(selection.canceled).toBe(false);
    const confirmation = await okValue(fake.invoke(sourcesChannels.confirm, view(7), [
      selection.selectionId, {...DEFAULT_SOURCE_OPTIONS, name: 'Generated source'},
    ])) as {sourceIds: string[]};
    const sourceId = confirmation.sourceIds[0]!;
    expect((await okValue(fake.invoke(sourcesChannels.list, view(7))) as SourceStatus[])[0]!.source.id).toBe(sourceId);

    await okValue(fake.invoke(sourcesChannels.sync, view(7)));
    await plugin.manager.flushPending(new AbortController().signal);
    const binding = sourceConnectionBinding(config);
    const statePath = join(clientDirectory, 'local-sources', 'nodes', binding, sourceId + '.json');
    const firstState = sourceState(statePath) as any;
    expect(firstState.checkpoint).toMatchObject({
      version: 1, root: await realpath(sourceRoot), nextFile: 'generated.md', initialized: true,
    });
    expect(firstState.checkpoint.catalog['generated.md']).toMatchObject({syncState: 'synced'});
    const firstExternalId = Object.values(firstState.known as Record<string, {item: {externalId: string}}>)[0]!.item.externalId;
    const firstDelivered = firstState.delivered[sourceHash(firstExternalId)];
    expect(typeof firstDelivered).toBe('string');

    const headers = {Authorization: 'Bearer ' + token};
    const firstItems = await fetch(origin + '/api/sources/' + sourceId + '/items', {headers}).then(response => response.json()) as {
      items: {externalId: string; revision: string}[];
    };
    expect(firstItems.items).toHaveLength(1);
    expect(firstItems.items[0]!.revision).toBe(firstDelivered);

    await writeFile(file, 'Generated second source body with a different length');
    await okValue(fake.invoke(sourcesChannels.sync, view(7)));
    await plugin.manager.flushPending(new AbortController().signal);
    const secondState = sourceState(statePath) as any;
    expect(secondState.checkpoint).toMatchObject({
      version: 1, root: await realpath(sourceRoot), nextFile: 'generated.md', initialized: true,
    });
    expect(secondState.checkpoint.scanNumber).toBeGreaterThan(firstState.checkpoint.scanNumber);
    expect(secondState.checkpoint.catalog['generated.md'].lastSeenScan).toBe(secondState.checkpoint.scanNumber);
    const secondDelivered = secondState.delivered[sourceHash(firstExternalId)];
    expect(typeof secondDelivered).toBe('string');
    expect(secondDelivered).not.toBe(firstDelivered);

    const history = await fetch(origin + '/api/sources/' + sourceId + '/history?externalId=' + encodeURIComponent(firstExternalId), {headers})
      .then(response => response.json()) as {items: {revision: string}[]};
    expect(history.items.map(item => item.revision)).toEqual(expect.arrayContaining([firstDelivered, secondDelivered]));
    expect(history.items).toHaveLength(2);

    // The real scanner's source-local identity is the Central externalId.
    // Renaming on the verified local volume updates that entry, while a copy
    // with the same bytes becomes a separate source item.
    const renamed=join(sourceRoot,'renamed.md'),copy=join(sourceRoot,'copy.md');
    await rename(file,renamed);await copyFile(renamed,copy);
    await okValue(fake.invoke(sourcesChannels.sync, view(7)));
    await plugin.manager.flushPending(new AbortController().signal);
    const thirdState=sourceState(statePath) as any;
    expect(thirdState.checkpoint.volumeIdentity).toMatch(/^apfs:/);
    expect(thirdState.checkpoint.catalog['renamed.md'].entryId).toBe(firstExternalId);
    expect(thirdState.checkpoint.catalog['copy.md'].entryId).not.toBe(firstExternalId);
    const finalItems=await fetch(origin+'/api/sources/'+sourceId+'/items',{headers}).then(response=>response.json()) as {items:{externalId:string;title:string}[]};
    expect(finalItems.items).toHaveLength(2);
    expect(finalItems.items).toEqual(expect.arrayContaining([
      expect.objectContaining({externalId:firstExternalId,title:'renamed.md'}),
      expect.objectContaining({externalId:thirdState.checkpoint.catalog['copy.md'].entryId,title:'copy.md'}),
    ]));
    const finalHistory=await fetch(origin+'/api/sources/'+sourceId+'/history?externalId='+encodeURIComponent(firstExternalId),{headers}).then(response=>response.json()) as {items:{revision:string}[]};
    expect(finalHistory.items).toHaveLength(3);
  } finally {
    await host.requestQuit();
    await node.app.close();
  }
});
