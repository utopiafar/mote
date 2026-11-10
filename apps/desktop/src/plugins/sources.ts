/** Mac sources plugin: owns LocalSourceManager, the source adapters, native
 * watchers, durable source jobs and the only source IPC surface. The renderer
 * receives only the declared read/write services; source paths and native
 * selections stay inside the privileged process. */
import { moteText } from '@mote/shared/i18n';
import type {Config} from '../contracts';
import type {CalendarChoice, SourceOptions} from '../contracts/sources';
import { normalizeSourceOptions } from '../source-types';
import { SourceSelectionController } from '../source-selection';
import { CalendarPermissionError } from '../source-calendar';
import { LocalSourceManager } from '../source-manager';
import { failureCode, safeErrorName, type EventJournal, type EventStage } from '../support';
import {desktopJobIds, sourcesChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

/** A renderer may read source state/context without being able to mutate it. */
export const sourcesReadCapability = 'sources.read';
export const sourcesWriteCapability = 'sources.write';

export {sourcesChannels};

export interface SourcePathChoiceRequest {
  readonly mode: 'files' | 'directory';
  readonly purpose: 'select' | 'import';
  readonly extensions?: readonly string[];
}

export interface SourcePathChoice {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

export interface SourcesPluginOptions {
  readonly directory: string;
  readonly settings: () => Config;
  readonly helperPath: string;
  readonly events?: Pick<EventJournal, 'record'>;
  /** Serialized with the shell's other control-plane writes. */
  readonly serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Shared background-operation projection owned by the shell. */
  readonly background?: <T>(channel: string, label: string, operation: () => T | Promise<T>) => Promise<T>;
  /** Managed uploads belong to the collector; scans still run in this plugin. */
  readonly retry?: () => Promise<void>;
  readonly guard?: () => void;
  readonly changed?: () => void;
  readonly choosePaths?: (request: SourcePathChoiceRequest) => Promise<SourcePathChoice>;
  readonly openCalendarPermissions?: () => Promise<void>;
}

export interface SourcesPlugin extends BuiltinDesktopPlugin {
  readonly manager: LocalSourceManager;
  initialize(): Promise<void>;
  close(): Promise<void>;
  authorizeCalendar(): Promise<CalendarChoice[]>;
  isCalendarPermissionError(error: unknown): boolean;
}

const stageFor = (channel: string): EventStage | undefined =>
  channel === sourcesChannels.sync || channel === sourcesChannels.files
    || channel === sourcesChannels.update || channel === sourcesChannels.calendar ? 'SOURCE' : undefined;

const labelFor = (channel: string): string | undefined => {
  if (channel === sourcesChannels.sync) return moteText("正在扫描并同步来源");
  if (channel === sourcesChannels.files) return moteText("正在连接文件来源");
  if (channel === sourcesChannels.update) return moteText("正在保存来源设置");
  if (channel === sourcesChannels.calendar) return moteText("正在连接日历");
  if (channel === sourcesChannels.calendarAuthorize) return moteText("正在读取日历授权");
  return undefined;
};

export function createSourcesPlugin(options: SourcesPluginOptions): SourcesPlugin {
  const manager = new LocalSourceManager(
    options.directory, options.settings(), options.helperPath, true,
    options.events as EventJournal | undefined,
  );
  const selections = new SourceSelectionController((path: string, input: unknown) => manager.addFiles(path, input));
  const serialize = <T>(operation: () => Promise<T>): Promise<T> =>
    options.serialize ? options.serialize(operation) : operation();
  const execute = async <T>(channel: string, operation: () => T | Promise<T>): Promise<T> => {
    // The source list stays readable while a storage recovery blocks writes.
    if (channel !== sourcesChannels.list) options.guard?.();
    const stage = stageFor(channel), startedAt = Date.now();
    if (stage) void options.events?.record(stage, 'STARTED', {operation: channel});
    try {
      const label = labelFor(channel);
      const result = await (label && options.background ? options.background(channel, label, operation) : operation());
      if (stage) void options.events?.record(stage, 'OK', {elapsedMs: Date.now() - startedAt, operation: channel});
      return result;
    } catch (error) {
      if (stage) void options.events?.record(stage, failureCode(error, stage), {
        elapsedMs: Date.now() - startedAt, operation: channel, errorName: safeErrorName(error),
      });
      throw error;
    } finally { if (labelFor(channel)) options.changed?.(); }
  };
  const choosePaths = async (request: SourcePathChoiceRequest): Promise<SourcePathChoice> => {
    if (!options.choosePaths) throw new Error('Source picker unavailable');
    return options.choosePaths(request);
  };
  return {
    id: 'mote.sources',
    manager,
    initialize: () => manager.initialize(),
    close: () => manager.close(),
    authorizeCalendar: () => manager.authorizeCalendar(),
    isCalendarPermissionError: (error: unknown) => error instanceof CalendarPermissionError,
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({instanceId: 'mote.sources', capabilities: [sourcesReadCapability, sourcesWriteCapability]});
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));

        register(sourcesChannels.coding, sourcesWriteCapability, args => execute(sourcesChannels.coding, () => serialize(async () => {
          const provider = args[0];
          if (provider !== 'claude' && provider !== 'codex' && provider !== 'kimi' && provider !== 'opencode') throw new Error(moteText("不支持的 Coding Agent"));
          return manager.addCodingAgent(provider, args[1]);
        })));
        register(sourcesChannels.list, sourcesReadCapability, () => execute(sourcesChannels.list, () => manager.status()));
        register(sourcesChannels.context, sourcesReadCapability, args => execute(sourcesChannels.context, () => serialize(() => {
          const id = args[0];
          if (typeof id !== 'string') throw Error('Invalid source');
          return manager.sourceContext(id);
        })));
        register(sourcesChannels.contextSave, sourcesWriteCapability, args => execute(sourcesChannels.contextSave, () => serialize(() => {
          const id = args[0];
          if (typeof id !== 'string') throw Error('Invalid source');
          return manager.saveSourceContext(id, args[1]);
        })));
        register(sourcesChannels.sync, sourcesWriteCapability, () => execute(sourcesChannels.sync, async () => {
          const scan = manager.sync(true);
          await options.retry?.();
          await scan;
          await options.retry?.();
        }));
        register(sourcesChannels.calendarAuthorize, sourcesWriteCapability, () =>
          execute(sourcesChannels.calendarAuthorize, () => serialize(() => manager.authorizeCalendar())));
        register(sourcesChannels.calendar, sourcesWriteCapability, args => execute(sourcesChannels.calendar, () => serialize(async () => {
          const id = args[0];
          if (typeof id !== 'string') throw new Error(moteText("日历选择无效"));
          return manager.addCalendar(id, args[1]);
        })));
        register(sourcesChannels.update, sourcesWriteCapability, args => execute(sourcesChannels.update, () => serialize(async () => {
          const id = args[0];
          if (typeof id !== 'string') throw new Error(moteText("来源选择无效"));
          await manager.update(id, args[1] as SourceOptions & {enabled: boolean});
        })));
        register(sourcesChannels.select, sourcesWriteCapability, args => execute(sourcesChannels.select, () => serialize(async () => {
          const mode = args[0];
          if (mode !== 'files' && mode !== 'directory') throw new Error(moteText("文件选择方式无效"));
          const result = await choosePaths({mode, purpose: 'select'});
          if (result.canceled || !result.filePaths.length) return {canceled: true};
          // Paths remain in the privileged process; the renderer can confirm only this native selection.
          return selections.select([...result.filePaths]);
        })));
        register(sourcesChannels.cancel, sourcesWriteCapability, args => execute(sourcesChannels.cancel, () => selections.cancel(args[0])));
        register(sourcesChannels.confirm, sourcesWriteCapability, args =>
          execute(sourcesChannels.confirm, () => serialize(() => selections.confirm(args[0], args[1]))));
        register(sourcesChannels.files, sourcesWriteCapability, args => execute(sourcesChannels.files, () => serialize(async () => {
          const mode = args[0];
          const sourceOptions = normalizeSourceOptions(args[1]);
          if (mode !== 'files' && mode !== 'directory') throw new Error(moteText("文件选择方式无效"));
          const result = await choosePaths({mode, purpose: 'import', extensions: sourceOptions.extensions});
          if (result.canceled) return {canceled: true};
          for (const path of result.filePaths) await manager.addFiles(path, sourceOptions);
          return {canceled: false};
        })));
        register(sourcesChannels.calendarPermissions, sourcesWriteCapability, () =>
          execute(sourcesChannels.calendarPermissions, () => options.openCalendarPermissions?.()));

        plugin.registerJob({id: desktopJobIds.sourcesManager, durable: true, drain: () => manager.close()});
        plugin.defer(() => { void manager.close(); });
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
