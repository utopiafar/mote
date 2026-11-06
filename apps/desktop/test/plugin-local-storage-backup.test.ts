import {afterEach, expect, it} from 'vitest';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {defaultConfig} from '../src/config';
import {DurableQueue} from '../src/queue';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry';
import type {IpcCallerView, IpcInvokeResult, IpcRouter} from '../src/plugin-host/ipc-registry';
import {
  createLocalStorageBackupPlugin, localStorageBackupCapability, localStorageBackupChannels,
} from '../src/plugins/local-storage-backup';
import type {BuiltinPluginContext} from '../src/plugins/index';
import {event} from './fixtures';

const pageUrl = 'file:///generated/index.html';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, {recursive: true, force: true}))); });

it.each([false, true])('disabling during export aborts without a partial file or queue mutation (existing destination: %s)', async existing => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-plugin-storage-backup-')));
  directories.push(directory);
  const destination = join(directory, 'backup.json');
  if (existing) await writeFile(destination, 'generated previous backup');
  const config = defaultConfig();
  const plugin = createLocalStorageBackupPlugin({
    directory, profileName: 'generated', deviceId: () => config.deviceId,
    queue: () => queue,
    chooseExport: async () => destination,
    chooseImport: async () => undefined,
    chooseStorage: async () => undefined,
    openPath: async () => '',
    progress: (channel, value) => {
      if (channel === localStorageBackupChannels.exportQueue && value.completed === 1) {
        expect(host.stopScope('mote.local-storage-backup')).toEqual([]);
      }
    },
  });
  await plugin.initialize();
  const queue = new DurableQueue(await plugin.storage.open(''), config);
  await queue.initialize();
  for (let index = 0; index < 3; index++) await queue.enqueue({
    ...event(randomUUID()), source: 'note', durationMs: 0, imageMime: undefined,
    ocrText: `Generated immutable note ${index}`, privacy: {excluded: false, redacted: false, mode: 'none'},
  });
  const before = await queue.exportArchive();

  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const router: IpcRouter = {
    handle: (channel, listener) => { handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); },
  };
  const host = new DesktopPluginHost({router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [localStorageBackupCapability]);
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);
  const invoke = handlers.get(localStorageBackupChannels.exportQueue)!;
  const pending = invoke({senderId: 7, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl}, []) as Promise<IpcInvokeResult>;

  await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  expect(handlers.has(localStorageBackupChannels.exportQueue)).toBe(false);
  expect((await readdir(directory)).filter(name => name.startsWith('backup.json'))).toEqual(existing ? ['backup.json'] : []);
  if (existing) expect(await readFile(destination, 'utf8')).toBe('generated previous backup');
  expect(await queue.exportArchive()).toEqual(before);
});

it.each([
  {stopAt:'committing', failRename:false},
  {stopAt:'committed', failRename:false},
  {stopAt:'committing', failRename:true},
] as const)('reports the actual result when commit wins before revocation: %j', async ({stopAt, failRename}) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-plugin-storage-commit-')));
  directories.push(directory);
  const destination = join(directory, 'backup.json');
  if (failRename) await mkdir(destination);
  const config = defaultConfig();
  let stopped = false;
  const plugin = createLocalStorageBackupPlugin({
    directory, profileName: 'generated', deviceId: () => config.deviceId,
    queue: () => queue,
    chooseExport: async () => destination,
    chooseImport: async () => undefined,
    chooseStorage: async () => undefined,
    openPath: async () => '',
    progress: (channel, value) => {
      if (channel === localStorageBackupChannels.exportQueue && value.phase === stopAt) {
        stopped = true;
        expect(host.stopScope('mote.local-storage-backup')).toEqual([]);
      }
    },
  });
  await plugin.initialize();
  const queue = new DurableQueue(await plugin.storage.open(''), config);
  await queue.initialize();
  for (let index = 0; index < 3; index++) await queue.enqueue({
    ...event(randomUUID()), source: 'note', durationMs: 0, imageMime: undefined,
    ocrText: `Generated immutable note ${index}`, privacy: {excluded: false, redacted: false, mode: 'none'},
  });
  const before = await queue.exportArchive();
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const router: IpcRouter = {handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); }};
  const host = new DesktopPluginHost({router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [localStorageBackupCapability]);
  await plugin.register({host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined} as BuiltinPluginContext);
  const pending = handlers.get(localStorageBackupChannels.exportQueue)!(
    {senderId: 7, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl}, [],
  ) as Promise<IpcInvokeResult>;

  if (failRename) {
    const error = await pending.then(() => undefined, reason => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).not.toBe('AbortError');
    expect(await readdir(destination)).toEqual([]);
  } else {
    const result = await pending;
    expect(result).toMatchObject({ok: true, value: {canceled: false, path: destination}});
    const written = JSON.parse(await readFile(destination, 'utf8'));
    expect(written.records).toHaveLength(before.records.length);
    expect(written.records).toEqual(expect.arrayContaining(before.records));
    expect(written.blobs).toEqual(before.blobs);
  }
  expect(stopped).toBe(true);
  expect(handlers.has(localStorageBackupChannels.exportQueue)).toBe(false);
  expect((await readdir(directory)).filter(name => name.startsWith('backup.json'))).toEqual(['backup.json']);
  expect(await queue.exportArchive()).toEqual(before);
});
