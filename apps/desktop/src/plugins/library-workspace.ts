/** Mac library workspace plugin: owns local and Central content reading, the
 * capture browser and Memory topics. The renderer receives only the declared
 * read services; every response stays a bounded, validated projection. */
import {createHash} from 'node:crypto';
import {moteText} from '@mote/shared/i18n';
import type {Config} from '../contracts';
import {centralContentPage, centralSourceContentPage, localContentDetail, localContentPage} from '../content-library';
import {browseCaptures, captureDetail, captureImage, type BrowseRequest, type CaptureLocation} from '../capture-browser';
import {centralMemoryTopicDetail, centralMemoryTopicEvidence, centralMemoryTopicPage, centralMemoryTopics, type TopicQuery} from '../memory-topics';
import {readCentralContent} from '../sync-content';
import type {DurableQueue} from '../queue';
import type {LocalSourceManager} from '../source-manager';
import type {SyncHistory} from '../sync-history';
import {libraryWorkspaceChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

/** Read-only surfaces split by primary evidence domain. */
export const libraryReadCapability = 'library.read';
export const memoryReadCapability = 'memory.read';

export {libraryWorkspaceChannels};

export interface LibraryWorkspaceOptions {
  readonly settings: () => Config;
  readonly queue: DurableQueue;
  readonly sources: () => LocalSourceManager;
  readonly syncHistory: Pick<SyncHistory, 'receivedCapture'>;
  readonly guard?: () => void;
}

export function createLibraryWorkspacePlugin(options: LibraryWorkspaceOptions): BuiltinDesktopPlugin {
  // A read that started against an older connection is never projected as the
  // current node's evidence. Callers re-read after the change.
  const withConnection = async <T>(operation: (config: Config) => Promise<T>): Promise<T> => {
    options.guard?.();
    const requested = options.settings();
    const result = await operation(requested);
    if (options.settings() !== requested) throw new Error(moteText('连接已改变，请刷新采集记录'));
    return result;
  };
  const sources = () => options.sources();
  const local = <T>(operation: () => T): T => {
    options.guard?.();
    return operation();
  };
  return {
    id: 'mote.library-workspace',
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({
        instanceId: 'mote.library-workspace',
        capabilities: [libraryReadCapability, memoryReadCapability],
      });
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));

        register(libraryWorkspaceChannels.contentCentral, libraryReadCapability, args =>
          withConnection(config => centralContentPage(config, args[0] as string | undefined, args[1] as string | undefined)));
        register(libraryWorkspaceChannels.contentCentralDetail, libraryReadCapability, args =>
          withConnection(config => {
            const [id, offset, image] = args;
            if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)
              || offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0)) throw Error('Invalid content reference');
            return readCentralContent(config, {
              key: id, captureId: id, source: 'file', title: '', observedAt: '', outcome: 'received', firstReceipt: false,
            }, Number(offset ?? 0), image === true);
          }));
        register(libraryWorkspaceChannels.contentLocal, libraryReadCapability, args => local(() =>
          localContentPage(options.queue, sources(), args[0] as number | undefined, args[1] as string | undefined)));
        register(libraryWorkspaceChannels.contentLocalDetail, libraryReadCapability, args =>
          withConnection(config => {
            const key = args[0], image = args[1];
            return localContentDetail(options.queue, sources(), key as string, image as boolean | undefined).catch(async error => {
              if (typeof key !== 'string') throw error;
              const parts = key.split(':');
              const receiptKey = parts[0] === 'queue' ? parts[1]
                : parts[0] === 'source' ? createHash('sha256').update(`${parts[1]}\0${parts[2]}`).digest('hex') : undefined;
              const id = receiptKey ? options.syncHistory.receivedCapture(config, receiptKey) : undefined;
              if (!id) throw error;
              return readCentralContent(config, {
                key: receiptKey!, captureId: id, source: 'file', title: '', observedAt: '', outcome: 'received', firstReceipt: false,
                ...(parts[0] === 'source' ? {sourceId: parts[1]} : {}),
              }, 0, image === true);
            });
          }));

        register(libraryWorkspaceChannels.capturesBrowse, libraryReadCapability, args =>
          withConnection(config => browseCaptures(options.queue, config, args[0] as BrowseRequest)));
        register(libraryWorkspaceChannels.capturesDetail, libraryReadCapability, args =>
          withConnection(config => captureDetail(options.queue, config, args[0] as CaptureLocation, args[1] as string)));
        register(libraryWorkspaceChannels.capturesImage, libraryReadCapability, args =>
          withConnection(config => captureImage(options.queue, config, args[0] as CaptureLocation, args[1] as string, args[2] as boolean)));

        register(libraryWorkspaceChannels.sourceArchivedContent, libraryReadCapability, args =>
          withConnection(config => {
            const [id, cursor] = args, source = sources().status().find(row => row.source.id === id)?.source;
            if (!source || typeof id !== 'string') throw Error('Invalid source');
            return centralSourceContentPage(config, source, cursor as string | undefined);
          }));
        register(libraryWorkspaceChannels.sourcePendingContent, libraryReadCapability, args =>
          local(() => {
            const id = args[0];
            if (typeof id !== 'string' || !sources().status().some(row => row.source.id === id)) throw Error('Invalid source');
            return localContentPage(options.queue, sources(), 0, undefined, id);
          }));

        register(libraryWorkspaceChannels.memoryTopics, memoryReadCapability, () => withConnection(config => centralMemoryTopics(config)));
        register(libraryWorkspaceChannels.memoryTopicPage, memoryReadCapability, args =>
          withConnection(config => centralMemoryTopicPage(config, args[0] as TopicQuery)));
        register(libraryWorkspaceChannels.memoryTopicDetail, memoryReadCapability, args =>
          withConnection(config => centralMemoryTopicDetail(config, args[0] as string)));
        register(libraryWorkspaceChannels.memoryTopicEvidence, memoryReadCapability, args =>
          withConnection(config => centralMemoryTopicEvidence(config, args[0] as string, args[1] as string, () => {
            if (options.settings() !== config) throw Error(moteText('连接已改变，请刷新采集记录'));
          })));
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
