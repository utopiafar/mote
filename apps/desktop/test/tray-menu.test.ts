import { describe, expect, it } from 'vitest';
import { captureStatusRow } from '@mote/shared/native-status';
import { captureStatusRowFor } from '../src/capture-notification';
import { trayMenuHeadline, trayMenuTemplate, type TrayMenuInput, type TrayMenuItem } from '../src/tray-menu';
import type { Status } from '../src/contracts';

function desktopStatus(overrides: Record<string, unknown> = {}): Status {
  return {
    running: true,
    state: 'capturing',
    queueDepth: 0,
    queueBytes: 0,
    sync: { state: 'idle', pendingRecords: 12 },
    config: {
      serverUrl: 'https://mote.example.net',
      tokenConfigured: true,
      authSignedOut: false,
      syncPaused: false,
      maxQueueBytes: 1024,
      maxQueueEvents: 32,
    },
    ...overrides,
  } as unknown as Status;
}

function menu(input: Partial<TrayMenuInput> = {}): TrayMenuItem[] {
  return trayMenuTemplate({ row: captureStatusRow('capturing'), running: true, pending: 12, canSend: true, ...input });
}

const ids = (items: TrayMenuItem[]) => items.map(item => item.type === 'separator' ? '-' : item.id);
const labels = (items: TrayMenuItem[]) => items.map(item => item.type === 'separator' ? '---' : item.label);

describe('Mac tray menu template', () => {
  it('matches the §5.4 items and order while waiting for capture permission', () => {
    const status = desktopStatus({ state: 'permission_required' });
    const items = menu({ row: captureStatusRowFor(status), running: status.running });
    expect(ids(items)).toEqual([
      'status', 'system-settings', 'pending', '-',
      'note', 'open', 'central', '-',
      'toggle', 'send', '-',
      'settings', 'quit',
    ]);
    expect(labels(items)).toEqual([
      '等待采集权限 · 屏幕录制', '打开系统设置…', '待发送 12 条', '---',
      '记录…', '打开 Mote', '打开中央工作台', '---',
      '停止采集', '立即发送', '---',
      '设置…', '退出 Mote',
    ]);
    const byId = Object.fromEntries(items.flatMap(item => item.type === 'normal' ? [[item.id, item]] : []));
    expect(byId['status'].enabled).toBe(false);
    expect(byId['pending'].enabled).toBe(false);
    expect(byId['system-settings']).toMatchObject({ enabled: true, icon: 'caution' });
  });

  it('keeps the same order without the permission fix while capturing', () => {
    const items = menu({ row: captureStatusRowFor(desktopStatus()) });
    expect(ids(items)).toEqual([
      'status', 'pending', '-',
      'note', 'open', 'central', '-',
      'toggle', 'send', '-',
      'settings', 'quit',
    ]);
    expect(labels(items)).toEqual([
      '采集中', '待发送 12 条', '---',
      '记录…', '打开 Mote', '打开中央工作台', '---',
      '停止采集', '立即发送', '---',
      '设置…', '退出 Mote',
    ]);
  });

  it('shows the stopped canvas state without the pending row', () => {
    const status = desktopStatus({ running: false, state: 'stopped' });
    const items = menu({ row: captureStatusRowFor(status), running: false, pending: 5 });
    expect(ids(items)).toEqual([
      'status', '-',
      'note', 'open', 'central', '-',
      'toggle', 'send', '-',
      'settings', 'quit',
    ]);
    expect(labels(items)).toEqual([
      '采集已停止', '---',
      '记录…', '打开 Mote', '打开中央工作台', '---',
      '开始采集…', '立即发送', '---',
      '设置…', '退出 Mote',
    ]);
  });

  it('omits the pending row when nothing waits to send', () => {
    const items = menu({ pending: 0 });
    expect(ids(items)).toContain('status');
    expect(ids(items)).not.toContain('pending');
  });

  it('only enables sending when the tray send gate allows it', () => {
    const send = (items: TrayMenuItem[]) => items.find(item => item.type === 'normal' && item.id === 'send');
    expect(send(menu({ canSend: true }))).toMatchObject({ enabled: true });
    expect(send(menu({ canSend: false }))).toMatchObject({ enabled: false });
  });
});

describe('Mac tray menu headline', () => {
  it('reads like the matching needs-action notification', () => {
    expect(trayMenuHeadline(captureStatusRow('permission'))).toBe('等待采集权限 · 屏幕录制');
    expect(trayMenuHeadline(captureStatusRow('reconnect'), 'mote.example.net')).toBe('需要重新连接 · mote.example.net');
    expect(trayMenuHeadline(captureStatusRow('storage_full'))).toBe('本机空间已满 · 采集与同步');
    expect(trayMenuHeadline(captureStatusRow('interrupted'))).toBe('采集已中断 · 屏幕 · 应用活动');
    expect(trayMenuHeadline(captureStatusRow('send_attention'))).toBe('发送需要处理 · 采集与同步');
  });

  it('names the capture state for normal and reminder rows', () => {
    expect(trayMenuHeadline(captureStatusRow('capturing'))).toBe('采集中');
    expect(trayMenuHeadline(captureStatusRow('pending_sync'))).toBe('采集中');
    expect(trayMenuHeadline(captureStatusRow('local_only'))).toBe('采集中');
    expect(trayMenuHeadline(captureStatusRow('send_paused'))).toBe('采集中 · 发送已暂停');
    expect(trayMenuHeadline(captureStatusRow('screen_paused'))).toBe('屏幕采集已暂停');
    expect(trayMenuHeadline(captureStatusRow('paused'))).toBe('采集已停止');
  });

  it('follows the shared status row picked from the desktop status', () => {
    expect(trayMenuHeadline(captureStatusRowFor(desktopStatus()))).toBe('采集中');
    expect(trayMenuHeadline(captureStatusRowFor(desktopStatus({ state: 'permission_required' })))).toBe('等待采集权限 · 屏幕录制');
    expect(trayMenuHeadline(captureStatusRowFor(desktopStatus({ running: false, state: 'stopped' })))).toBe('采集已停止');
    expect(trayMenuHeadline(captureStatusRowFor(desktopStatus({ sync: { state: 'error' } })))).toBe('发送需要处理 · 采集与同步');
    const pausedSend = desktopStatus({ config: { ...(desktopStatus().config), syncPaused: true } });
    expect(captureStatusRowFor(pausedSend).id).toBe('send_paused');
    expect(trayMenuHeadline(captureStatusRowFor(pausedSend))).toBe('采集中 · 发送已暂停');
  });
});
