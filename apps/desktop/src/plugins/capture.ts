/** Mac capture plugin: owns the Collector, its durable capture stage registry
 * and the only capture-control IPC surface. Capture timers, power watchers and
 * handlers live inside this scope, so disabling the plugin leaves no timer,
 * watcher or handler behind while the durable queue checkpoint stays reusable
 * after a process restart. */
import { moteText } from '@mote/shared/i18n';
import type { DiagnosticsRecorder } from '@mote/diagnostics';
import type { BrowserCaptureProvider } from '../browser-capture';
import { builtInCaptureStages, type CaptureStageRegistry } from '../capture-stages';
import { Collector } from '../collector';
import type { Config, Status } from '../contracts';
import type { DurableQueue } from '../queue';
import type { LocalSourceManager } from '../source-manager';
import type { SyncHistory } from '../sync-history';
import { failureCode, safeErrorName, type EventJournal, type EventStage } from '../support';
import type { BuiltinDesktopPlugin, BuiltinPluginContext } from './index';

export const captureReadCapability = 'capture.read';
export const captureWriteCapability = 'capture.write';

export const captureChannels = {
  start: 'mote:start',
  stop: 'mote:stop',
  retry: 'mote:retry',
  reviewPending: 'mote:review-pending',
  reviewReject: 'mote:review-reject',
  reviewApprove: 'mote:review-approve',
} as const;

/** The capture stage pipeline is versioned durable state, not a per-process
 * cache; both the first launch and every reopen construct the same registry. */
export function createCaptureStages(): CaptureStageRegistry {
  return builtInCaptureStages();
}

export interface CapturePluginOptions {
  readonly queue: DurableQueue;
  readonly settings: () => Config;
  readonly helperPath: string;
  readonly encryptedStorageAvailable: () => boolean;
  readonly onChange: (status: Status) => void;
  /** The shell's full status projection returned by capture services. */
  readonly status: () => Status;
  readonly diagnostics?: DiagnosticsRecorder;
  readonly events?: EventJournal;
  readonly sources?: LocalSourceManager;
  readonly history?: SyncHistory;
  readonly browserCapture?: BrowserCaptureProvider;
  /** Serialized with the shell's other control-plane writes. */
  readonly serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Shared background-operation projection owned by the shell. */
  readonly background?: <T>(channel: string, label: string, operation: () => T | Promise<T>) => Promise<T>;
  readonly guard?: () => void;
  readonly changed?: () => void;
}

export interface CapturePlugin extends BuiltinDesktopPlugin {
  readonly collector: Collector;
  initialize(): void;
  shutdown(): void;
}

export function createCapturePlugin(options: CapturePluginOptions): CapturePlugin {
  const collector = new Collector(
    options.settings(), options.queue, options.helperPath, options.encryptedStorageAvailable,
    options.onChange, options.diagnostics, options.events, options.sources, options.history, options.browserCapture,
  );
  const serialize = <T>(operation: () => Promise<T>): Promise<T> =>
    options.serialize ? options.serialize(operation) : operation();
  const execute = async <T>(
    channel: string, stage: EventStage | undefined, label: string | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    // Recovery still permits stopping the current capture.
    if (channel !== captureChannels.stop) options.guard?.();
    const startedAt = Date.now();
    if (stage) void options.events?.record(stage, 'STARTED', { operation: channel });
    try {
      const result = await (label && options.background ? options.background(channel, label, operation) : operation());
      if (stage) void options.events?.record(stage, 'OK', { elapsedMs: Date.now() - startedAt, operation: channel });
      return result;
    } catch (error) {
      if (stage) void options.events?.record(stage, failureCode(error, stage), {
        elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
      });
      throw error;
    } finally { if (label) options.changed?.(); }
  };
  return {
    id: 'mote.capture',
    collector,
    initialize: () => collector.initialize(),
    shutdown: () => collector.shutdown(),
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({instanceId: 'mote.capture', capabilities: [captureReadCapability, captureWriteCapability]});
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));

        register(captureChannels.start, captureWriteCapability, () =>
          execute(captureChannels.start, 'CAPTURE', moteText('正在准备采集'), () =>
            serialize(async () => { await collector.start(); return options.status(); })));
        register(captureChannels.stop, captureWriteCapability, () => {
          collector.stop();
          return execute(captureChannels.stop, 'CAPTURE', moteText('正在结束当前采集'), () =>
            serialize(async () => { await collector.settleCapture(); return options.status(); }));
        });
        register(captureChannels.retry, captureWriteCapability, () =>
          execute(captureChannels.retry, 'UPLOAD', moteText('正在同步待发记录'), async () => {
            const scan = options.sources?.sync(true);
            await collector.retry();
            await scan;
            await collector.retry();
            return options.status();
          }));
        register(captureChannels.reviewPending, captureReadCapability, () =>
          execute(captureChannels.reviewPending, undefined, undefined, () => options.queue.reviewPending()));
        register(captureChannels.reviewReject, captureWriteCapability, args =>
          execute(captureChannels.reviewReject, undefined, undefined, () => {
            const id = args[0];
            if (typeof id !== 'string') throw Error('Invalid review ID');
            return options.queue.rejectReview(id);
          }));
        register(captureChannels.reviewApprove, captureWriteCapability, args =>
          execute(captureChannels.reviewApprove, undefined, undefined, () => {
            const id = args[0];
            if (typeof id !== 'string') throw Error('Invalid review ID');
            return options.queue.approveReview(id);
          }));

        // Closing the window keeps capture alive; an explicit quit drains the
        // current capture before the collector stops its timers and watchers.
        plugin.registerJob({id: 'capture-runtime', durable: true, drain: async () => {
          collector.stop();
          await collector.settleCapture();
        }});
        plugin.defer(() => collector.shutdown());
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
