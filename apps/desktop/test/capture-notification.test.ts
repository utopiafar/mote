import { describe, expect, it } from 'vitest';
import { moteText } from '@mote/shared/i18n';
import { captureStatus, captureStatusRow, captureStatusTable } from '@mote/shared/native-status';
import { CaptureNeedsActionNotifier, captureNotification, captureStatusFacts, captureStatusRowFor } from '../src/capture-notification';
import type { Status } from '../src/contracts';
import { defaultConfig } from '../src/config';
import { AssistantNoticePresenter, AssistantNotificationReader, type AssistantNotice, type AssistantNoticeCursor } from '../src/assistant-notification';

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

  it('renders every shared system-notification cell tagged for Mac', () => {
    const cells = captureStatusTable.filter(row => row.notification?.platforms.includes('macos'));
    expect(cells).toHaveLength(5);
    for (const row of cells) {
      expect(captureNotification(row)).toMatchObject({
        id: row.id,
        title: moteText(row.notification!.titleKey),
        operation: row.notification!.operation,
      });
    }
    expect(captureNotification(captureStatusRow('disconnected'))).toBeUndefined();
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

const noticeOrigin = 'https://generated.invalid';
const notice: AssistantNotice = { id: '10000000-0000-4000-8000-000000000001', revision: 1, title: 'Generated useful card', reason: 'Generated reminder reason',
  eligibleAt: '2026-11-13T10:00:00.000Z', expiresAt: '2026-11-13T11:00:00.000Z' };
const snapshot = (event = notice) => ({ items: [event] });
function noticeFixture() {
  let cursor: AssistantNoticeCursor | undefined, now = Date.parse(notice.eligibleAt);
  const displayed: { event: AssistantNotice; shown(): void; failed(): void; closed: boolean }[] = [];
  const create = () => new AssistantNoticePresenter({ cursor: () => cursor, save: value => { cursor = value; }, now: () => now,
    show: (event, shown, failed) => { const delivery = { event, shown, failed, closed: false }; displayed.push(delivery); return { close: () => { delivery.closed = true; } }; } });
  return { create, displayed, get cursor() { return cursor; }, time: (value: string) => { now = Date.parse(value); } };
}

describe('online assistant notifications', () => {
  it('shows one occurrence once across duplicate polls, a reconnect and process recreation', () => {
    const f = noticeFixture(), first = f.create();
    first.update(noticeOrigin, snapshot(), true); first.update(noticeOrigin, snapshot(), true);
    expect(f.displayed).toHaveLength(1); expect(f.cursor).toBeUndefined();
    f.displayed[0].shown(); first.clear();
    const restored = f.create(); restored.update(noticeOrigin, snapshot(), true);
    expect(f.displayed).toHaveLength(1);
    expect(f.cursor).toEqual({ origin: noticeOrigin, id: notice.id, eligibleAt: notice.eligibleAt, shownAt: notice.eligibleAt });
    // Snooze is a new server occurrence over the same card, not a content update.
    f.time('2026-11-13T10:30:00.000Z');
    restored.update(noticeOrigin, snapshot({ ...notice, eligibleAt: '2026-11-13T10:30:00.000Z' }), true);
    expect(f.displayed).toHaveLength(2);
    f.displayed[1].shown(); restored.update(noticeOrigin, snapshot(), true);
    expect(f.displayed).toHaveLength(2); // A preference change cannot replay an older slot.
  });

  it('denial and failed OS adaptation never consume the event; an offline unseen event can recover', () => {
    const f = noticeFixture(), presenter = f.create();
    presenter.update(noticeOrigin, snapshot(), false);
    expect(f.displayed).toHaveLength(0); expect(f.cursor).toBeUndefined();
    presenter.update(noticeOrigin, snapshot(), true); f.displayed[0].failed();
    expect(f.cursor).toBeUndefined(); expect(f.displayed[0].closed).toBe(true);
    presenter.update(noticeOrigin, snapshot(), true); f.displayed[1].shown();
    expect(f.displayed).toHaveLength(2);
    const unseen = { ...notice, id: '10000000-0000-4000-8000-000000000002', eligibleAt: '2026-11-13T11:00:00.000Z', expiresAt: '2026-11-13T12:00:00.000Z' };
    f.time(unseen.eligibleAt);
    presenter.clear(); presenter.update(noticeOrigin, snapshot(unseen), true);
    expect(f.displayed.at(-1)?.event.id).toBe(unseen.id);
  });

  it('revisions, suppression and expiry remove old summaries without another alert', () => {
    const f = noticeFixture(), presenter = f.create();
    presenter.update(noticeOrigin, snapshot(), true); f.displayed[0].shown();
    presenter.update(noticeOrigin, snapshot({ ...notice, revision: 2, reason: 'Generated current correction' }), true);
    expect(f.displayed[0].closed).toBe(true); expect(f.displayed).toHaveLength(1);
    presenter.update(noticeOrigin, { items: [] }, true); // card read/withdrawal, quiet time or frequency suppression.
    presenter.update(noticeOrigin, snapshot(), true); expect(f.displayed).toHaveLength(1);
    const next = { ...notice, id: '10000000-0000-4000-8000-000000000002', eligibleAt: '2026-11-13T11:00:00.000Z', expiresAt: '2026-11-13T12:00:00.000Z' };
    f.time(next.eligibleAt);
    presenter.update(noticeOrigin, snapshot(next), true); f.displayed[1].shown();
    f.time(next.expiresAt); presenter.expire(); expect(f.displayed[1].closed).toBe(true);
    presenter.update(noticeOrigin, snapshot(), true); expect(f.displayed).toHaveLength(2);
  });

  it('keeps the configured interval between actual local displays when polling is delayed', () => {
    const f = noticeFixture(), presenter = f.create();
    presenter.update(noticeOrigin, snapshot(), true); f.displayed[0].shown();
    const later = { ...notice, id: '10000000-0000-4000-8000-000000000002',
      eligibleAt: '2026-11-13T10:30:00.000Z', expiresAt: '2026-11-13T11:30:00.000Z' };
    f.time(later.eligibleAt); presenter.update(noticeOrigin, snapshot(later), true);
    expect(f.displayed).toHaveLength(1); // 30 minutes after the last actual display; the server interval is 60.
    f.time('2026-11-13T11:00:00.000Z'); presenter.update(noticeOrigin, snapshot(later), true);
    expect(f.displayed).toHaveLength(2); // A delayed poll cannot compress the configured gap.
  });

  it('ignores a late shown callback after withdrawal and keeps origins separate', () => {
    const f = noticeFixture(), presenter = f.create();
    presenter.update(noticeOrigin, snapshot(), true); presenter.update(noticeOrigin, { items: [] }, true);
    f.displayed[0].shown(); expect(f.cursor).toBeUndefined();
    presenter.update('https://other-generated.invalid', snapshot(), true); f.displayed[1].shown();
    presenter.update(noticeOrigin, snapshot(), true); expect(f.displayed).toHaveLength(3);
  });

  it('uses current card APIs even when no notification is eligible and binds clicks to the current session', async () => {
    let config = { ...defaultConfig(), serverUrl: noticeOrigin, token: 'generated-owner-only' }, generation = 0;
    const card = { ...notice, body: 'Generated current result v2', state: 'open', evidence: [], readAt: null };
    const calls: { url: string; body?: unknown }[] = [];
    const reader = new AssistantNotificationReader(() => config, () => generation, async (url, init) => {
      const target = new URL(String(url)); expect(JSON.parse(target.searchParams.get('scope')!)).toEqual({ kind: 'all' });
      calls.push({ url: target.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const response = target.pathname.endsWith('/feedback') ? { ...card, revision: 2, readAt: notice.eligibleAt } :
        target.pathname === '/api/assistant-notifications' ? { items: [] } : target.pathname === '/api/assistant-cards' ? { items: [card], nextCursor: null } : card;
      return new Response(JSON.stringify(response));
    });
    expect(await reader.snapshot(noticeOrigin)).toEqual({ items: [] });
    expect((await reader.page(noticeOrigin)).items[0].body).toBe(card.body);
    expect((await reader.card(noticeOrigin, notice.id, true)).readAt).toBe(notice.eligibleAt);
    expect(calls.at(-1)).toMatchObject({ url: '/api/assistant-cards/' + notice.id + '/feedback', body: { expectedRevision: 1, action: 'read' } });
    await expect(reader.card('https://foreign.invalid', notice.id)).rejects.toThrow();
    await expect(reader.card(noticeOrigin, 'https://foreign.invalid/result')).rejects.toThrow();
    const deferred = new AssistantNotificationReader(() => config, () => generation, async () => {
      config = { ...config, token: 'generated-replacement' }; generation++;
      return new Response(JSON.stringify(card));
    });
    await expect(deferred.card(noticeOrigin, notice.id, true)).rejects.toThrow('登录会话已变更');
  });

  it('re-reads a card changed by another device during read feedback without resending feedback', async () => {
    const config = { ...defaultConfig(), serverUrl: noticeOrigin, token: 'generated-owner' };
    let reads = 0, posts = 0;
    const reader = new AssistantNotificationReader(() => config, () => 0, async (_url, options) => {
      if (options?.method === 'POST') { posts++; return new Response(JSON.stringify({ code: 'invalid_data' }), { status: 409 }); }
      reads++;
      return new Response(JSON.stringify({ ...notice, revision: reads, title: 'Generated current card', body: reads === 1 ? 'Generated prior result' : 'Generated revised result', state: 'open', evidence: [], readAt: reads === 1 ? null : notice.eligibleAt }));
    });
    const result = await reader.card(noticeOrigin, notice.id, true);
    expect(result.body).toBe('Generated revised result'); expect(result.readAt).toBe(notice.eligibleAt);
    expect(reads).toBe(2); expect(posts).toBe(1);
  });
});
