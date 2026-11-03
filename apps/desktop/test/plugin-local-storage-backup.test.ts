import {afterEach, expect, it} from 'vitest';
import {mkdtemp, readdir, realpath, rm} from 'node:fs/promises';
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

it('disabling the plugin during export aborts without a partial file or queue mutation', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-plugin-storage-backup-')));
  directories.push(directory);
  const config = defaultConfig();
  const plugin = createLocalStorageBackupPlugin({
    directory, profileName: 'generated', deviceId: () => config.deviceId,
    queue: () => queue,
    chooseExport: async () => join(directory, 'backup.json'),
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
  expect((await readdir(directory)).filter(name => name.startsWith('backup.json'))).toEqual([]);
  expect(await queue.exportArchive()).toEqual(before);
});
