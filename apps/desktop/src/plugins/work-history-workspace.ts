/** Mac work and sync history workspace plugin: owns the owner-only Central
 * work-activity read, the local receipt/history reads and the bounded receipt
 * content preview. The renderer receives only the declared read services;
 * the durable SyncHistory writer stays with the capture plugin. */
import {moteText} from '@mote/shared/i18n';
import type {Config} from '../contracts';
import type {DurableQueue} from '../queue';
import type {LocalSourceManager} from '../source-manager';
import {syncContent} from '../sync-content';
import type {SyncHistory, SyncHistoryContentQuery, SyncHistoryQuery} from '../sync-history';
import {centralWorkActivity, type WorkActivityQuery} from '../work-activity';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

/** Read-only work, delivery and sync-receipt surfaces. */
export const workHistoryReadCapability = 'work-history.read';

export const workHistoryWorkspaceChannels = {
  workActivity: 'mote:work-activity',
  syncHistory: 'mote:sync-history',
  syncHistoryContents: 'mote:sync-history-contents',
  syncHistoryContent: 'mote:sync-history-content',
  syncHistoryPending: 'mote:sync-history-pending',
} as const;

export interface WorkHistoryWorkspaceOptions {
  readonly settings: () => Config;
  readonly history: SyncHistory;
  readonly queue: DurableQueue;
  readonly sources: () => LocalSourceManager;
  readonly guard?: () => void;
}

export function createWorkHistoryWorkspacePlugin(options: WorkHistoryWorkspaceOptions): BuiltinDesktopPlugin {
  // A Central read that started against an older connection is never projected
  // as the current node's work; callers re-read after the change.
  const withConnection = async <T>(operation: (config: Config) => Promise<T>): Promise<T> => {
    options.guard?.();
    const requested = options.settings();
    const result = await operation(requested);
    if (options.settings() !== requested) throw new Error(moteText('连接已改变，请刷新采集记录'));
    return result;
  };
  const local = <T>(operation: () => T): T => {
    options.guard?.();
    return operation();
  };
  return {
    id: 'mote.work-history-workspace',
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({
        instanceId: 'mote.work-history-workspace',
        capabilities: [workHistoryReadCapability],
      });
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({
            channel, capability: workHistoryReadCapability, windowRoles: ['main'],
            callerCapability: workHistoryReadCapability, roleFrameUrls,
          }, (_view, args) => handler(args));

        register(workHistoryWorkspaceChannels.workActivity, args =>
          withConnection(config => centralWorkActivity(config, args[0] as WorkActivityQuery | undefined)));
        register(workHistoryWorkspaceChannels.syncHistory, args =>
          local(() => options.history.page(options.settings(), args[0] as SyncHistoryQuery)));
        register(workHistoryWorkspaceChannels.syncHistoryContents, args =>
          local(() => options.history.contents(options.settings(), args[0] as SyncHistoryContentQuery)));
        register(workHistoryWorkspaceChannels.syncHistoryContent, args =>
          withConnection(config => {
            const [runId, key, offset, includeImage] = args;
            if (typeof runId !== 'string' || typeof key !== 'string') throw Error('Invalid sync content reference');
            return syncContent(
              options.history, options.queue, options.sources(), config,
              runId, key, offset as number | undefined, includeImage === undefined ? true : includeImage === true,
            );
          }));
        register(workHistoryWorkspaceChannels.syncHistoryPending, () =>
          local(() => {
            const pending = options.queue.historyPending();
            const rows = options.sources().status();
            return [...pending, ...(['file', 'calendar', 'coding'] as const).map(source => {
              const sources = rows.filter(row => source === 'file' ? row.source.kind === 'local-files'
                : source === 'calendar' ? row.source.kind === 'local-calendar' : row.source.kind.startsWith('coding-'));
              return {
                source,
                pending: sources.reduce((sum, row) => sum + row.pending + (row.blocked ?? 0), 0),
                review: 0,
                blocked: sources.reduce((sum, row) => sum + (row.blocked ?? 0), 0),
                retrying: sources.reduce((sum, row) => sum + (row.state === 'error' ? row.pending : 0), 0),
              };
            })];
          }));
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
