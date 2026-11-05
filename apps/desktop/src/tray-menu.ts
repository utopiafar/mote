import { moteText } from '@mote/shared/i18n';
import type { CaptureStatusId, CaptureStatusRow } from '@mote/shared/native-status';
import { captureNotification } from './capture-notification';

/** Stable identities let the host wire clicks and tests assert the template without Electron. */
export type TrayMenuItemId = 'status' | 'system-settings' | 'pending' | 'note' | 'open' | 'central' | 'toggle' | 'send' | 'settings' | 'quit';
export type TrayMenuItem =
  | { type: 'separator' }
  | { type: 'normal'; id: TrayMenuItemId; label: string; enabled: boolean; icon?: 'caution' };

export type TrayMenuInput = {
  /** The single shared capture-status row the icon and notifications already use. */
  row: CaptureStatusRow;
  running: boolean;
  /** Total records waiting to send, captured and source outbox together. */
  pending: number;
  canSend: boolean;
  serverHost?: string;
};

/** Mac menu headlines: needs-action rows read like their notification, the rest name the capture state. */
const reminderHeadlines: Partial<Record<CaptureStatusId, string>> = {
  send_paused: '采集中 · 发送已暂停',
  screen_paused: '屏幕采集已暂停',
  paused: '采集已停止',
};

export function trayMenuHeadline(row: CaptureStatusRow, serverHost?: string): string {
  const notification = captureNotification(row, { serverHost });
  if (notification) return `${notification.title} · ${notification.body}`;
  return moteText(reminderHeadlines[row.id] ?? '采集中');
}

/** The §5.4 Mac tray menu as pure data; `Menu.buildFromTemplate` renders it verbatim. */
export function trayMenuTemplate(input: TrayMenuInput): TrayMenuItem[] {
  const items: TrayMenuItem[] = [
    { type: 'normal', id: 'status', label: trayMenuHeadline(input.row, input.serverHost), enabled: false },
  ];
  if (input.row.id === 'permission') items.push({ type: 'normal', id: 'system-settings', label: moteText('打开系统设置…'), enabled: true, icon: 'caution' });
  if (input.row.id !== 'paused' && input.pending > 0) items.push({ type: 'normal', id: 'pending', label: moteText('待发送 {0} 条', input.pending), enabled: false });
  items.push(
    { type: 'separator' },
    { type: 'normal', id: 'note', label: moteText('记录…'), enabled: true },
    { type: 'normal', id: 'open', label: moteText('打开 Mote'), enabled: true },
    { type: 'normal', id: 'central', label: moteText('打开中央工作台'), enabled: true },
    { type: 'separator' },
    { type: 'normal', id: 'toggle', label: input.running ? moteText('停止采集') : moteText('开始采集…'), enabled: true },
    { type: 'normal', id: 'send', label: moteText('立即发送'), enabled: input.canSend },
    { type: 'separator' },
    { type: 'normal', id: 'settings', label: moteText('设置…'), enabled: true },
    { type: 'normal', id: 'quit', label: moteText('退出 Mote'), enabled: true },
  );
  return items;
}
