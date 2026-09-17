import { moteText } from '@mote/shared/i18n';
import type { Config, SyncStatus } from './contracts';
export type SyncSettings = Pick<Config, 'serverUrl' | 'token' | 'syncMode' | 'syncIntervalMinutes' | 'syncBatchSize'>;
export interface PendingSync { pendingRecords: number; pendingUpdates?: number; oldestPendingAt?: string; lastUploadAt?: string; nextRetryAt?: string }
/** Pure scheduling policy. Deadlines derive from persisted records/checkpoints, never process uptime. */
export function decideSync(config: SyncSettings, pending: PendingSync, now = Date.now(), explicit = false): SyncStatus & { ready: boolean } {
  const base = { mode: config.syncMode ?? 'realtime', pendingRecords: pending.pendingRecords, lastUploadAt: pending.lastUploadAt };
  if (!config.serverUrl || !config.token) return { ...base, state: 'unconfigured', message: moteText("仅保存在本机；连接中央节点后可同步"), ready: false };
  if (explicit) return { ...base, state: 'idle', message: moteText("准备同步本地记录"), ready: true };
  if (base.mode === 'manual') return { ...base, state: 'manual', message: pending.pendingRecords ? moteText("记录已保存在本机，等待手动同步") : moteText("手动同步已启用"), ready: false };
  if (!pending.pendingRecords && !pending.pendingUpdates) return { ...base, state: 'idle', message: moteText("已同步，等待新记录"), ready: false };
  const oldest = Date.parse(pending.oldestPendingAt ?? '') || now;
  const last = Date.parse(pending.lastUploadAt ?? '') || oldest;
  const interval = (config.syncIntervalMinutes ?? 15) * 60000;
  let due = now;
  if (base.mode === 'interval') due = last + interval;
  if (base.mode === 'batch' && pending.pendingRecords < (config.syncBatchSize ?? 20)) due = oldest + interval;
  const retry = Date.parse(pending.nextRetryAt ?? '');
  if (Number.isFinite(retry)) due = retry;
  if (due <= now) return { ...base, state: 'idle', message: moteText("本地记录已就绪，准备同步"), ready: true };
  return { ...base, state: 'waiting', message: base.mode === 'batch' ? moteText("等待累计 {0} 条，或到达最长等待时间", config.syncBatchSize) : moteText("记录已保存在本机，等待下次同步"), nextUploadAt: new Date(due).toISOString(), ready: false };
}
