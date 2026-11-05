import { describe, expect, it } from 'vitest';
import { captureStatus, captureStatusRow } from '@mote/shared/native-status';
import { CaptureNeedsActionNotifier, captureStatusFacts, captureStatusRowFor } from '../src/capture-notification';
import type { Status } from '../src/contracts';

const normal = captureStatus({ connection: 'connected', captureEnabled: true, captureLive: true, syncState: 'idle', pending: 0 });
const reconnect = captureStatusRow('reconnect');
const storageFull = captureStatusRow('storage_full');

function desktopStatus(overrides: Record<string, unknown> = {}): Status {
  return {
    running: true,
    state: 'capturing',
    queueDepth: 0,
    queueBytes: 0,
    sync: { state: 'idle' },
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

describe('Mac needs-action notifications', () => {
  it('sends each active issue once while it remains unresolved', () => {
    const notifier = new CaptureNeedsActionNotifier();
    const context = { serverHost: 'mote.example.net' };
    expect(notifier.update(reconnect, context)).toEqual({
      id: 'reconnect',
      title: '需要重新连接',
      body: 'mote.example.net',
      action: '连接',
      operation: 'reconnect',
    });
    expect(notifier.update(reconnect, context)).toBeUndefined();
    expect(notifier.update(reconnect, context)).toBeUndefined();

    // A different active issue is a different thing; returning to the first
    // unresolved issue does not repeat it.
    expect(notifier.update(storageFull, context)).toMatchObject({ id: 'storage_full', title: '本机空间已满' });
    expect(notifier.update(reconnect, context)).toBeUndefined();
    expect(notifier.update(storageFull, context)).toBeUndefined();
  });

  it('sends again after a normal or reminder row, and only for needs-action rows', () => {
    const notifier = new CaptureNeedsActionNotifier();
    const context = { serverHost: 'mote.example.net' };
    expect(notifier.update(reconnect, context)).toMatchObject({ id: 'reconnect' });
    expect(notifier.update(normal, context)).toBeUndefined();
    expect(notifier.update(reconnect, context)).toMatchObject({ id: 'reconnect' });

    const paused = captureStatus({ connection: 'connected', captureEnabled: false, captureLive: false, syncState: 'idle', pending: 0 });
    expect(notifier.update(paused, context)).toBeUndefined();
    expect(notifier.update(reconnect, context)).toMatchObject({ id: 'reconnect' });
    expect(notifier.update(captureStatusRow('capturing'), context)).toBeUndefined();
    expect(notifier.update(captureStatusRow('disconnected'), context)).toBeUndefined();
  });

  it('matches the Mac canvas notification copy', () => {
    const notifier = new CaptureNeedsActionNotifier();
    expect(notifier.update(captureStatusRow('permission'))).toMatchObject({
      title: '等待采集权限',
      body: '屏幕录制',
      action: '打开系统设置',
    });
    expect(notifier.update(captureStatusRow('interrupted'))).toMatchObject({
      title: '采集已中断',
      body: '屏幕 · 应用活动',
      action: '重新开启',
    });
    expect(notifier.update(captureStatusRow('send_attention'))).toMatchObject({
      title: '发送需要处理',
      body: '采集与同步',
      action: '处理',
    });
  });

  it('derives the shared status row from the desktop status', () => {
    expect(captureStatusRowFor(desktopStatus()).id).toBe('capturing');
    expect(captureStatusRowFor(desktopStatus({ running: false, state: 'stopped' })).id).toBe('paused');
    expect(captureStatusRowFor(desktopStatus({ state: 'permission_required' })).id).toBe('permission');
    expect(captureStatusRowFor(desktopStatus({ sync: { state: 'error' } })).id).toBe('send_attention');
    expect(captureStatusRowFor(desktopStatus({ facts: { sync: { state: 'blocked' } } })).id).toBe('send_attention');
    expect(captureStatusRowFor(desktopStatus({ queueBytes: 1024 })).id).toBe('storage_full');
    expect(captureStatusRowFor(desktopStatus({ state: 'error' })).id).toBe('interrupted');
    expect(captureStatusRowFor(desktopStatus({ running: false, state: 'error' })).id).toBe('interrupted');
    expect(captureStatusRowFor(desktopStatus({
      sync: { state: 'manual' },
      config: { ...(desktopStatus().config), tokenConfigured: true, syncPaused: true },
    })).id).toBe('send_paused');
    expect(captureStatusRowFor(desktopStatus({
      config: { ...(desktopStatus().config), authSignedOut: true },
    })).id).toBe('reconnect');
    expect(captureStatusFacts(desktopStatus({ queueDepth: 32 }))).toMatchObject({ storageFull: true });
  });
});
