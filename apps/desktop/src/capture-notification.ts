import { moteText } from '@mote/shared/i18n';
import {
  captureStatus,
  type CaptureStatusFacts,
  type CaptureStatusId,
  type CaptureStatusOperation,
  type CaptureStatusRow,
} from '@mote/shared/native-status';
import type { Status } from './contracts';

/** The copy for one native macOS notification, already translated. */
export type CaptureNotification = {
  readonly id: CaptureStatusId;
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly operation: CaptureStatusOperation;
};

export type CaptureNotificationContext = { readonly serverHost?: string };

/** Facts for the shared capture-status table, derived from the desktop status only. */
export function captureStatusFacts(status: Pick<Status, 'config' | 'facts' | 'queueDepth' | 'queueBytes' | 'running' | 'state' | 'sync'>): CaptureStatusFacts {
  const authenticated = Boolean(status.config.serverUrl) && status.config.tokenConfigured;
  const signedOut = status.config.authSignedOut === true || (status.config.authExpiresAt !== undefined && status.config.authExpiresAt <= Date.now());
  const syncState = status.config.syncPaused ? 'paused' : status.facts?.sync.state ?? (status.sync.state === 'manual' ? 'waiting' : status.sync.state);
  return {
    connection: !authenticated ? 'unconfigured' : signedOut ? 'reconnect' : 'connected',
    captureEnabled: status.running || status.state === 'error',
    captureLive: status.running && status.state !== 'error',
    permission: status.state === 'permission_required' ? 'missing' : null,
    storageFull: status.queueBytes >= status.config.maxQueueBytes || status.queueDepth >= status.config.maxQueueEvents,
    interrupted: status.state === 'error',
    syncState,
    pending: status.queueDepth,
    disconnected: false,
  };
}

const notificationBodies: Partial<Record<CaptureStatusId, string>> = {
  storage_full: '采集与同步',
  interrupted: '屏幕 · 应用活动',
  permission: '屏幕录制',
  send_attention: '采集与同步',
};

const operationLabels: Partial<Record<CaptureStatusOperation, string>> = {
  reconnect: '连接',
  restart_capture: '重新开启',
  open_permissions: '打开系统设置',
  open_storage: '处理',
  open_sync: '处理',
};

/** A row sends one notification only when it is a Mac needs-action row. */
export function captureNotification(row: CaptureStatusRow, context: CaptureNotificationContext = {}): CaptureNotification | undefined {
  const notification = row.notification;
  if (row.level !== 'needs_action' || !notification || !notification.platforms.includes('macos')) return undefined;
  return {
    id: row.id,
    title: moteText(notification.titleKey),
    body: row.id === 'reconnect' ? context.serverHost ?? moteText('采集与同步') : moteText(notificationBodies[row.id] ?? '采集与同步'),
    action: moteText(operationLabels[notification.operation] ?? '处理'),
    operation: notification.operation,
  };
}

/** One notification per active issue. Any non-needs-action row is recovery;
 * a later needs-action row starts a new incident. */
export class CaptureNeedsActionNotifier {
  private readonly active = new Set<CaptureStatusId>();

  update(row: CaptureStatusRow, context: CaptureNotificationContext = {}): CaptureNotification | undefined {
    if (row.level !== 'needs_action') {
      this.active.clear();
      return undefined;
    }
    if (this.active.has(row.id)) return undefined;
    this.active.add(row.id);
    return captureNotification(row, context);
  }
}

/** The status row shown by the Mac client. */
export function captureStatusRowFor(status: Pick<Status, 'config' | 'facts' | 'queueDepth' | 'queueBytes' | 'running' | 'state' | 'sync'>): CaptureStatusRow {
  return captureStatus(captureStatusFacts(status));
}
