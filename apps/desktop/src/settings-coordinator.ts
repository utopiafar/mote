import { moteText } from '@mote/shared/i18n';
import { assertConnectionChangeSafe } from './connection';
import { StorageCommitUncertainError } from './queue-storage';
import type { Config } from './contracts';
import type { ConfigStore } from './config';
import type { Collector } from './collector';
import type { LocalSourceManager } from './source-manager';
import type { DurableQueue } from './queue';
import type { NoteDraftStore } from './note-draft';
import type { ConnectionStatus } from './contracts/connection';

export interface SettingsDependencies {
  settings(): Config;
  installSettings(config: Config): void;
  store: Pick<ConfigStore, 'load' | 'save'>;
  collector: Pick<Collector, 'suspendForSettings' | 'connectionActivity' | 'updateConfig'>;
  sources: Pick<LocalSourceManager, 'holdConnection' | 'sync' | 'connectionActivity' | 'changeConnection' | 'nodeBinding' | 'prepareInitialConnection' | 'prepareReauthorization'>;
  queue: Pick<DurableQueue, 'binding' | 'stats' | 'resetRetries'>;
  notes: Pick<NoteDraftStore, 'hasPrepared' | 'hasUnboundPrepared' | 'bindPreparedOrigin'>;
  defaultProfile: boolean;
  loginItems: { set(openAtLogin: boolean): void; get(): boolean };
  running(): boolean;
  quitting(): boolean;
  recoveryRequired(): string | undefined;
  requireRecovery(message: string): void;
  configureDiagnostics(): Promise<void>;
  relocate(config: Config): Promise<void>;
  clearStorageSelection(): void;
  connectionStatus(status: ConnectionStatus): void;
}

/** Coordinates the existing settings transaction; IPC trust and serialization belong to the platform entry. */
export class SettingsCoordinator {
  constructor(private readonly dependencies: SettingsDependencies) {}

  unboundBacklog(): boolean {
    const { queue, sources, notes } = this.dependencies;
    return queue.binding.unbound() && sources.nodeBinding.unbound() && (!notes.hasPrepared() || notes.hasUnboundPrepared());
  }

  async paused<T>(operation: () => Promise<T>): Promise<T> {
    const d = this.dependencies;
    const releaseCollector = await d.collector.suspendForSettings();
    let releaseSources: (() => void) | undefined;
    try { releaseSources = await d.sources.holdConnection(); return await operation(); }
    finally {
      releaseSources?.();
      // A held changeConnection scan resumes only after settings settle; uploads remain policy-owned.
      if (releaseSources && !d.quitting() && !d.recoveryRequired()) void d.sources.sync(true);
      await releaseCollector();
    }
  }

  async connectionChange<T>(operation: () => Promise<T>, sameNodeInvitation = false, confirmedInitial = false): Promise<T> {
    return this.paused(async () => {
      const d = this.dependencies, source = d.sources.connectionActivity();
      assertConnectionChangeSafe({ running: d.running(), inFlight: d.collector.connectionActivity().inFlight, queued: d.queue.stats().depth, preparedNote: d.notes.hasPrepared(), sourcePending: source.pending, sourceInFlight: source.inFlight }, sameNodeInvitation || (confirmedInitial && this.unboundBacklog()));
      return operation();
    });
  }

  async apply(updated: Config): Promise<void> {
    const d = this.dependencies, previous = d.settings();
    const relocating = updated.captureStorageDirectory !== previous.captureStorageDirectory;
    try {
      if (d.defaultProfile && updated.openAtLogin !== previous.openAtLogin) {
        d.loginItems.set(updated.openAtLogin);
        if (d.loginItems.get() !== updated.openAtLogin) throw new Error(moteText('系统未允许修改登录启动项，在系统设置检查'));
      }
      await d.sources.changeConnection(updated);
      d.installSettings(updated); d.collector.updateConfig(updated); await d.configureDiagnostics();
      if (relocating) await d.relocate(updated);
      else await d.store.save(updated);
    } catch (error) {
      // A failed directory fsync may follow a successful rename. Preserve both copies and stop all IO.
      const persisted = await d.store.load().catch(() => undefined);
      if (error instanceof StorageCommitUncertainError || !persisted || JSON.stringify(persisted) === JSON.stringify(updated)) {
        d.requireRecovery(error instanceof StorageCommitUncertainError?error.message:moteText('设置提交需要恢复；已停止采集与上传并保留数据，请重新打开 Mote。'));
        throw new Error(d.recoveryRequired());
      }
      try {
        await d.sources.changeConnection(previous);
        d.installSettings(previous); d.collector.updateConfig(previous); await d.configureDiagnostics();
        if (d.defaultProfile && updated.openAtLogin !== previous.openAtLogin) {
          d.loginItems.set(previous.openAtLogin);
          if (d.loginItems.get() !== previous.openAtLogin) throw new Error(moteText('登录项还原失败'));
        }
      } catch {
        d.requireRecovery(moteText('设置未完成；原持久配置和截图保留，运行状态无法安全还原。请重新打开 Mote 后重试'));
        throw new Error(d.recoveryRequired());
      }
      throw error;
    }
    d.clearStorageSelection();
  }

  async commitConnection(updated: Config, sameNodeInvitation = false, confirmedInitial = false): Promise<void> {
    const d = this.dependencies, initial = confirmedInitial && this.unboundBacklog();
    // Checkpoint before config save: a crash cannot switch credentials without the original source queue.
    d.queue.binding.assertChange(updated, d.queue.stats().depth > 0 || d.notes.hasPrepared(), initial, sameNodeInvitation);
    d.sources.nodeBinding.assertChange(updated, d.sources.connectionActivity().pending > 0, initial, sameNodeInvitation);
    if (initial) await d.sources.prepareInitialConnection(updated);
    else if (sameNodeInvitation) await d.sources.prepareReauthorization(updated);
    // Bind before persistence: a mismatched editable config cannot upload old bodies after a crash.
    await d.queue.binding.commit(updated, d.queue.stats().depth > 0 || d.notes.hasPrepared(), initial, sameNodeInvitation);
    await d.sources.nodeBinding.commit(updated, d.sources.connectionActivity().pending > 0, initial, sameNodeInvitation);
    if (initial) await d.notes.bindPreparedOrigin(updated.serverUrl);
    if (sameNodeInvitation) await d.queue.resetRetries();
    await this.apply(updated);
    d.connectionStatus({ state: 'unchecked', message: moteText('连接已保存，可测试权限与节点版本') });
  }
}
