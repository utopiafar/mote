/** Mac local storage and backup plugin: owns queue storage selection, native
 * backup operations and compression previews. Disabling its scope aborts an
 * active archive export before the temporary file can become a partial backup. */
import {moteText} from '@mote/shared/i18n';
import {previewWork} from '../background';
import type {WorkProgress} from '../contracts/operations';
import {QueueImportFailure, type DurableQueue} from '../queue';
import {describeBackupFile} from '../queue-backup-identity';
import {QueueStorage} from '../queue-storage';
import {ensureStorageFormat} from '../storage-format';
import {failureCode, safeErrorName, type EventJournal} from '../support';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

export const localStorageBackupCapability = 'local-storage-backup.manage';
export const localStorageBackupChannels = {
  compressionPreview: 'mote:compression-preview',
  storageChoose: 'mote:storage-choose',
  storageOpen: 'mote:storage-open',
  exportQueue: 'mote:export-queue',
  importQueue: 'mote:import-queue',
} as const;

export interface LocalStorageBackupOptions {
  readonly directory: string;
  readonly profileName: string;
  readonly deviceId: () => string;
  readonly protectedRoots?: readonly string[];
  readonly queue: () => DurableQueue;
  readonly chooseExport: () => Promise<string | undefined>;
  readonly chooseImport: () => Promise<string | undefined>;
  readonly chooseStorage: () => Promise<string | undefined>;
  readonly storageSelected?: (directory: string) => void;
  readonly openPath: (path: string) => Promise<string>;
  readonly upload?: () => void | Promise<void>;
  readonly serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly background?: <T>(channel: string, label: string, operation: () => T | Promise<T>) => Promise<T>;
  readonly progress?: (channel: string, value: WorkProgress) => void;
  readonly guard?: () => void;
  readonly changed?: () => void;
  readonly events?: Pick<EventJournal, 'record'>;
}

export interface LocalStorageBackupPlugin extends BuiltinDesktopPlugin {
  readonly storage: QueueStorage;
  initialize(): Promise<void>;
}

export function createLocalStorageBackupPlugin(options: LocalStorageBackupOptions): LocalStorageBackupPlugin {
  let storage: QueueStorage | undefined;
  const getStorage = (): QueueStorage => storage ??= new QueueStorage(
    options.directory, options.profileName, options.deviceId(), options.protectedRoots ? [...options.protectedRoots] : undefined,
  );
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => options.serialize ? options.serialize(operation) : operation();
  const execute = async <T>(channel: string, operation: () => T | Promise<T>): Promise<T> => {
    options.guard?.();
    const backup = channel === localStorageBackupChannels.exportQueue || channel === localStorageBackupChannels.importQueue;
    const startedAt = Date.now();
    if (backup) void options.events?.record('QUEUE', 'STARTED', {operation: channel});
    try {
      const label = channel === localStorageBackupChannels.exportQueue ? moteText('正在导出队列')
        : channel === localStorageBackupChannels.importQueue ? moteText('正在导入队列') : undefined;
      const result = await (label && options.background ? options.background(channel, label, operation) : operation());
      if (backup) void options.events?.record('QUEUE', 'OK', {elapsedMs: Date.now() - startedAt, operation: channel});
      return result;
    } catch (error) {
      if (backup) void options.events?.record('QUEUE', failureCode(error, 'QUEUE'), {
        elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
      });
      throw error;
    } finally {
      if (backup) options.changed?.();
    }
  };
  return {
    id: 'mote.local-storage-backup',
    get storage() { return getStorage(); },
    initialize: () => ensureStorageFormat(options.directory, ['config.json', 'queue', 'notes', 'local-sources', 'content-key.json']),
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({instanceId: 'mote.local-storage-backup', capabilities: [localStorageBackupCapability]});
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({
            channel, capability: localStorageBackupCapability, windowRoles: ['main'],
            callerCapability: localStorageBackupCapability, roleFrameUrls,
          }, (_view, args) => handler(args));

        register(localStorageBackupChannels.compressionPreview, args => execute(localStorageBackupChannels.compressionPreview, () =>
          previewWork.run({kind: 'compression-preview', quality: args[0] as number, maxSide: args[1] as number})));
        register(localStorageBackupChannels.storageChoose, () => execute(localStorageBackupChannels.storageChoose, () => serialize(async () => {
          const parent = await options.chooseStorage();
          if (!parent) return {canceled: true};
          const directory = await getStorage().candidate(parent, options.queue().directory);
          options.storageSelected?.(directory);
          return {canceled: false, directory};
        })));
        register(localStorageBackupChannels.storageOpen, () => execute(localStorageBackupChannels.storageOpen, async () => {
          const directory = options.queue().directory;
          await getStorage().assertOwned(directory);
          const error = await options.openPath(directory);
          if (error) throw new Error(moteText('无法打开截图目录，请检查磁盘是否已连接'));
        }));
        register(localStorageBackupChannels.exportQueue, () => execute(localStorageBackupChannels.exportQueue, async () => {
          const path = await options.chooseExport();
          if (!path) return {canceled: true};
          const selectedFile = await describeBackupFile(path);
          options.progress?.(localStorageBackupChannels.exportQueue, {
            message: moteText('正在导出队列'), file: {name: selectedFile.name, path: selectedFile.path},
          });
          options.changed?.();
          await options.queue().exportArchiveFile(path, value => options.progress?.(localStorageBackupChannels.exportQueue, value), plugin.signal);
          return {canceled: false, path, file: await describeBackupFile(path)};
        }));
        register(localStorageBackupChannels.importQueue, () => execute(localStorageBackupChannels.importQueue, () => serialize(async () => {
          const path = await options.chooseImport();
          if (!path) return {canceled: true};
          const file = await describeBackupFile(path);
          options.progress?.(localStorageBackupChannels.importQueue, {message: moteText('正在校验备份'), file});
          options.changed?.();
          try {
            const imported = await options.queue().importArchiveFile(path, value => options.progress?.(localStorageBackupChannels.importQueue, value));
            options.changed?.();
            void options.upload?.();
            return {canceled: false, state: 'imported', imported, file};
          } catch (error) {
            options.changed?.();
            if (error instanceof QueueImportFailure) return {canceled: false, state: 'incomplete', ...error.report, error: error.message, file};
            throw error;
          }
        })));
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
