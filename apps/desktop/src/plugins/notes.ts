/** Mac Notes plugin: owns the durable draft, immutable submission identity,
 * metadata observation and the only note IPC surface. The renderer receives
 * the three declared channels; main never calls the store directly. */
import type {RecordMetadata} from '@mote/shared';
import type {Config, Platform} from '../contracts';
import type {NoteDraft} from '../contracts/note';
import {NoteDraftStore} from '../note-draft';
import type {DurableQueue} from '../queue';
import {failureCode, safeErrorName, type EventCode, type SupportEvent} from '../support';
import {desktopJobIds, notesChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

export const notesReadCapability = 'notes.read';
export const notesWriteCapability = 'notes.write';
export {notesChannels};

export interface NotesPluginOptions {
  readonly directory: string;
  readonly settings: () => Config;
  readonly queue: Pick<DurableQueue, 'enqueue'>;
  readonly platform: Platform;
  /** Serialized with the shell's other control-plane writes. */
  readonly serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly metadata?: () => Promise<RecordMetadata | undefined>;
  readonly guard?: () => void;
  readonly onSubmitted?: () => void;
  readonly event?: (stage: 'NOTE', code: EventCode, details: Pick<SupportEvent, 'elapsedMs' | 'httpStatus' | 'errorName' | 'operation' | 'sourceId' | 'sourceKind'>) => void;
}

export interface NotesPlugin extends BuiltinDesktopPlugin {
  initialize(): Promise<void>;
  get(): NoteDraft;
  hasPrepared(): boolean;
  hasUnboundPrepared(): boolean;
  bindPreparedOrigin(origin: string): Promise<void>;
  /** Drain accepted draft updates and submissions before quit, update or a
   * language change reloads the renderer. */
  settle(): Promise<void>;
}

export function createNotesPlugin(options: NotesPluginOptions): NotesPlugin {
  const store = new NoteDraftStore(options.directory);
  const work = new Set<Promise<unknown>>();
  const track = <T>(task: Promise<T>): Promise<T> => {
    work.add(task);
    void task.then(() => work.delete(task), () => work.delete(task));
    return task;
  };
  const settle = async (): Promise<void> => {
    while (work.size > 0) await Promise.allSettled([...work]);
  };
  const recordFailure = (channel: string, error: unknown, startedAt: number): void => {
    options.event?.('NOTE', failureCode(error, 'NOTE'), {
      elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
    });
  };
  const update = (input: NoteDraft): Promise<NoteDraft> => {
    const startedAt = Date.now();
    options.guard?.();
    return track(store.update(input).catch(error => { recordFailure(notesChannels.update, error, startedAt); throw error; }));
  };
  const submit = (input: NoteDraft): Promise<{id: string; draft: NoteDraft}> => {
    const startedAt = Date.now();
    options.guard?.();
    options.event?.('NOTE', 'STARTED', {operation: notesChannels.save});
    const operation = async () => {
      try {
        const result = await store.submit(input, options.settings(), options.platform, options.queue, options.metadata);
        options.event?.('NOTE', 'OK', {elapsedMs: Date.now() - startedAt, operation: notesChannels.save});
        options.onSubmitted?.();
        return result;
      } catch (error) {
        recordFailure(notesChannels.save, error, startedAt);
        throw error;
      }
    };
    return track(options.serialize ? options.serialize(operation) : operation());
  };
  return {
    id: 'mote.notes',
    initialize: () => store.initialize(),
    get: () => store.get(),
    hasPrepared: () => store.hasPrepared(),
    hasUnboundPrepared: () => store.hasUnboundPrepared(),
    bindPreparedOrigin: origin => store.bindPreparedOrigin(origin),
    settle,
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({instanceId: 'mote.notes', capabilities: [notesReadCapability, notesWriteCapability]});
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl], 'quick-note': [pageUrl + '#quick-note']};
        plugin.registerIpc({
          channel: notesChannels.draft, capability: notesReadCapability,
          windowRoles: ['main', 'quick-note'], callerCapability: notesReadCapability, roleFrameUrls,
        }, () => store.get());
        plugin.registerIpc({
          channel: notesChannels.update, capability: notesWriteCapability,
          windowRoles: ['main', 'quick-note'], callerCapability: notesWriteCapability, roleFrameUrls,
        }, (_view, args) => update(args[0] as NoteDraft));
        plugin.registerIpc({
          channel: notesChannels.save, capability: notesWriteCapability,
          windowRoles: ['main', 'quick-note'], callerCapability: notesWriteCapability, roleFrameUrls,
        }, (_view, args) => submit(args[0] as NoteDraft));
        plugin.registerJob({id: desktopJobIds.notesDraft, durable: true, drain: settle});
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
