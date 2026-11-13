import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { defaultConfig } from '../src/config';
import { DesktopAssistantNotifications } from '../src/assistant-notification-native';

const os = vi.hoisted(() => ({ supported: true, notifications: [] as any[], menus: [] as any[], dialogs: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Notification: class extends EventEmitter {
      static isSupported() { return os.supported; }
      closed = false;
      constructor(readonly options: unknown) { super(); os.notifications.push(this); }
      show() { this.emit('show'); }
      close() { this.closed = true; }
    },
    Menu: { buildFromTemplate: (items: unknown[]) => {
      const menu = { items, popup: vi.fn(), closePopup: vi.fn() }; os.menus.push(menu); return menu;
    } },
    dialog: { showMessageBox: (_owner: unknown, options: any) => {
      os.dialogs.push(options);
      return new Promise(resolve => options.signal?.addEventListener('abort', () => resolve({ response: 0 })));
    } },
  };
});

const directories: string[] = [], bridges: DesktopAssistantNotifications[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }); });
afterEach(() => {
  bridges.forEach(bridge => bridge.close()); bridges.length = 0;
  directories.forEach(directory => rmSync(directory, { recursive: true, force: true })); directories.length = 0;
  os.notifications.length = 0; os.menus.length = 0; os.dialogs.length = 0; os.supported = true;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(process, 'platform', platform);
});
const origin = 'https://generated.invalid', id = '10000000-0000-4000-8000-000000000001';
const event = { id, revision: 1, title: 'Generated private title', reason: 'Generated private reason', eligibleAt: '2026-11-13T10:00:00.000Z', expiresAt: '2026-11-13T11:00:00.000Z' };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mote-notification-adapter-')); directories.push(directory);
  let config = { ...defaultConfig(), serverUrl: origin, token: 'generated-owner-only', deviceName: 'Generated Mac' }, generation = 0;
  let now = Date.parse(event.eligibleAt), withdrawn = false;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const request = vi.fn(async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method!, body: options.body ? JSON.parse(String(options.body)) : undefined });
    const card = { id, revision: options.method === 'POST' ? 3 : 2, title: 'Generated current title', body: 'Generated current result', state: 'open', evidence: [], readAt: event.eligibleAt };
    const value = path === '/api/assistant-notifications' ? { items: withdrawn ? [] : [event] } : path === '/api/assistant-cards' ? { items: [card], nextCursor: null } : card;
    return new Response(JSON.stringify(value), { status: withdrawn && path.includes(id) ? 404 : 200 });
  });
  vi.stubGlobal('fetch', request);
  const owner = { show: vi.fn(), isDestroyed: () => false } as unknown as BrowserWindow;
  const create = () => {
    const bridge = new DesktopAssistantNotifications({ directory, settings: () => config, generation: () => generation, owner: () => owner, openEvidence: vi.fn() });
    bridges.push(bridge); return bridge;
  };
  return { create, directory, calls, advance: () => { now += 16000; }, withdraw: () => { withdrawn = true; }, signOut: () => { config = { ...config, authSignedOut: true }; generation++; } };
}

describe('Mac online notification adapter (simulated Electron boundary)', () => {
  it('persists only a cursor and does not alert again after recreation', async () => {
    const f = fixture(), bridge = f.create(); bridge.tick();
    await vi.waitFor(() => expect(os.notifications).toHaveLength(1));
    expect(os.notifications[0].options).toEqual({ title: '通知', body: '打开 Mote' });
    const stored = readFileSync(join(f.directory, 'assistant-notification-cursor.json'), 'utf8');
    expect(JSON.parse(stored)).toEqual({ origin, id, eligibleAt: event.eligibleAt });
    expect(stored).not.toMatch(/Generated private|generated-owner|result/);
    bridge.close(); const restored = f.create(); restored.tick(); await settle();
    expect(os.notifications).toHaveLength(1);
    expect(os.notifications[0].closed).toBe(true);
  });

  it('keeps the inbox available without OS support and clears an open result on withdrawal', async () => {
    const f = fixture(); os.supported = false;
    const bridge = f.create(); bridge.tick(); await settle();
    expect(os.notifications).toHaveLength(0);
    await bridge.openInbox(); expect(os.menus[0].items[0].label).toBe('Generated current title');
    os.menus[0].items[0].click();
    await vi.waitFor(() => expect(os.dialogs).toHaveLength(1));
    expect(os.dialogs[0].detail).toBe('Generated current result');
    const signal = os.dialogs[0].signal as AbortSignal;
    f.withdraw(); f.advance(); bridge.tick();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(os.notifications).toHaveLength(0);
  });

  it('drops a retained notification click after sign-out instead of reading another session', async () => {
    const f = fixture(), bridge = f.create(); bridge.tick();
    await vi.waitFor(() => expect(os.notifications).toHaveLength(1));
    const delivered = os.notifications[0]; f.signOut(); bridge.tick();
    const before = f.calls.length; delivered.emit('click'); await settle();
    expect(delivered.closed).toBe(true); expect(f.calls).toHaveLength(before);
  });
});
