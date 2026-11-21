import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  centralNavigationDecision, CentralWindowFallback, centralWindowOpenLocalChannel, centralWindowUrl,
  centralWindowWebPreferences, trustedCentralWindowSender,
} from '../src/central-browser';

const electron = vi.hoisted(() => ({
  exposed: [] as { name: string; api: Record<string, unknown> }[],
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => { electron.exposed.push({ name, api }); },
  },
  ipcRenderer: { send: electron.send },
}));

const origin = 'https://central.example';
const offlineUrl = new URL('../src/offline.html', import.meta.url).href;
const generatedDeviceId = '11111111-2222-4333-8444-555555555555';

describe('MC2-01 Central main-window navigation', () => {
  it('keeps the paired origin inside and hands other web destinations to the browser', () => {
    expect(centralNavigationDecision(origin + '/#/chat', origin)).toBe('allow');
    expect(centralNavigationDecision(origin + '/#/library?deviceId=mac', origin)).toBe('allow');
    expect(centralNavigationDecision('https://elsewhere.example/', origin)).toBe('external');
    expect(centralNavigationDecision('http://127.0.0.1:47832/', origin)).toBe('external');
    expect(centralNavigationDecision('https://central.example.evil/', origin)).toBe('external');
  });

  it('denies non-web schemes, malformed URLs and credentials without opening anything', () => {
    for (const target of [
      'javascript:alert(1)', 'data:text/html,generated', 'file:///etc/passwd',
      'https://user:secret@elsewhere.example/', 'not a url', 'mailto:generated@example.test',
    ]) expect(centralNavigationDecision(target, origin)).toBe('deny');
  });

  it('treats every HTTP destination as external before a Central is paired', () => {
    expect(centralNavigationDecision(origin + '/#/chat', undefined)).toBe('external');
    expect(centralNavigationDecision('javascript:alert(1)', undefined)).toBe('deny');
  });
});

describe('MC2-02 Central main-window preload', () => {
  it('exposes only deviceId and openLocalWindow, and sends only the fixed local-window channel', async () => {
    const previous = [...process.argv];
    process.argv.push('--mote-device-id=' + generatedDeviceId);
    try { await import('../src/central-window-preload'); } finally { process.argv.splice(0, process.argv.length, ...previous); }
    expect(electron.exposed).toHaveLength(1);
    const [{ name, api }] = electron.exposed;
    expect(name).toBe('moteDesktop');
    expect(Object.keys(api)).toEqual(['deviceId', 'openLocalWindow']);
    expect(api.deviceId).toBe(generatedDeviceId);
    expect(api.require).toBeUndefined();
    expect(api.process).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    (api.openLocalWindow as () => void)();
    expect(electron.send).toHaveBeenCalledTimes(1);
    expect(electron.send).toHaveBeenCalledWith(centralWindowOpenLocalChannel);
    expect(centralWindowOpenLocalChannel).toBe('mote:central:open-local-window');
    expect(centralWindowWebPreferences).toEqual({
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    });
  });
});

describe('MC2-04 offline main window', () => {
  it('shows only “连接你的 Mote” and “连接”, and asks the host to open local connection settings', () => {
    const html = readFileSync(fileURLToPath(offlineUrl), 'utf8');
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: offlineUrl });
    try {
      const calls: number[] = [];
      Object.defineProperty(dom.window, 'moteDesktop', {
        configurable: true,
        value: { deviceId: generatedDeviceId, openLocalWindow: () => calls.push(1) },
      });
      const document = dom.window.document;
      expect(document.querySelector('h1')?.textContent).toBe('连接你的 Mote');
      const buttons = [...document.querySelectorAll('button')];
      expect(buttons.map(button => button.textContent?.trim())).toEqual(['连接']);
      expect(document.querySelectorAll('a, form, input, select, textarea, nav')).toHaveLength(0);
      buttons[0]!.click();
      expect(calls).toEqual([1]);
    } finally { dom.window.close(); }
  });
});

describe('MC2-04 repeated offline fallback', () => {
  it('restores offline.html again when a retry fails while the window is already offline', async () => {
    const fallback = new CentralWindowFallback();
    const loads: string[] = [];
    await fallback.restore(async () => { loads.push('first'); });
    expect(fallback.offline).toBe(true);
    // The tray retry starts while this flag is already true; its failure must
    // still put the offline page and its Connect action back.
    await fallback.restore(async () => { loads.push('retry'); });
    expect(loads).toEqual(['first', 'retry']);
    expect(fallback.offline).toBe(true);
  });

  it('deduplicates an in-flight fallback and keeps it usable after a failed load', async () => {
    const fallback = new CentralWindowFallback();
    let finish!: () => void;
    const first = fallback.restore(() => new Promise<void>(resolve => { finish = resolve; }));
    const duplicate = fallback.restore(async () => { throw Error('must not start a second load'); });
    expect(duplicate).toBe(first);
    await Promise.resolve();
    finish();
    await duplicate;
    await expect(fallback.restore(async () => { throw Error('offline page unavailable'); })).resolves.toBeUndefined();
    expect(fallback.offline).toBe(true);
  });

  it('leaves the offline state only after a Central load succeeds', async () => {
    const fallback = new CentralWindowFallback();
    expect(fallback.offline).toBe(false);
    await fallback.restore(async () => {});
    expect(fallback.offline).toBe(true);
    fallback.markOnline();
    expect(fallback.offline).toBe(false);
  });
});

describe('MC2-06 trusted local-window IPC sender', () => {
  const facts = (overrides: Partial<{ senderId: number; mainSenderId: number; frameIsMain: boolean; frameUrl?: string }> = {}) => ({
    senderId: 7, mainSenderId: 7, frameIsMain: true, frameUrl: origin + '/#/chat', ...overrides,
  });

  it('accepts only the Central main frame on the paired origin or the offline page', () => {
    expect(trustedCentralWindowSender(facts(), origin, offlineUrl)).toBe(true);
    expect(trustedCentralWindowSender(facts({ frameUrl: offlineUrl }), origin, offlineUrl)).toBe(true);
  });

  it('ignores another window, a subframe, an unpaired origin and the local product page', () => {
    expect(trustedCentralWindowSender(facts({ senderId: 8 }), origin, offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameIsMain: false }), origin, offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameUrl: 'https://elsewhere.example/' }), origin, offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameUrl: 'file:///generated/index.html' }), origin, offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameUrl: origin + '/#/chat' }), undefined, offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameUrl: origin + '/#/chat' }), 'https://other.example', offlineUrl)).toBe(false);
    expect(trustedCentralWindowSender(facts({ frameUrl: 'https://user:secret@central.example/' }), origin, offlineUrl)).toBe(false);
  });
});

describe('MC2-07 login ticket exchange', () => {
  const ticket = 't'.repeat(43);

  it('puts the short-lived ticket only in the hash query and never puts the token in the address', () => {
    const url = new URL(centralWindowUrl(origin, ticket));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    expect(url.hash.split('?')[0]).toBe('#/chat');
    expect(new URLSearchParams(url.hash.split('?')[1]).get('loginTicket')).toBe(ticket);
    expect(url.href).not.toContain('token=');
    expect(url.href).not.toContain('Bearer');
    const plain = new URL(centralWindowUrl(origin));
    expect(plain.hash).toBe('#/chat');
    expect(plain.href).not.toContain('loginTicket');
  });

  it('rejects malformed tickets and Central addresses before creating a window URL', () => {
    for (const value of ['short', 'x'.repeat(44), 'bad ticket', 'x'.repeat(20) + '\n' + 'x'.repeat(22)]) {
      expect(() => centralWindowUrl(origin, value)).toThrow('Invalid login ticket');
    }
    for (const serverUrl of ['javascript:alert(1)', 'https://user:secret@central.example', 'https://central.example/path', 'http://remote.example']) {
      expect(() => centralWindowUrl(serverUrl, ticket)).toThrow();
    }
  });

  it('exchanges the ticket, removes it from the address before the request and stores only the session', async () => {
    const token = 'a'.repeat(64);
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: centralWindowUrl(origin, ticket) });
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const fetchMock = vi.fn(async () => {
      // The Web app removes the ticket before it exchanges it, so neither the
      // address nor a later render can retain the short-lived code.
      expect(dom.window.location.hash).toBe('#/chat');
      return { ok: true, json: async () => ({ token }) };
    });
    for (const [key, value] of Object.entries({
      window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history,
      localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage, fetch: fetchMock,
    })) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    try {
      const { consumeLoginTicket } = await import('../../web/src/login-handoff');
      await consumeLoginTicket();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(path).toBe('/api/login/exchange');
      expect(JSON.parse(String(init.body))).toEqual({ code: ticket });
      expect(dom.window.location.href).not.toContain(ticket);
      expect(dom.window.location.hash).toBe('#/chat');
      expect(dom.window.sessionStorage.getItem('mote.connection')).toContain(token);
      expect(dom.window.localStorage.getItem('mote.connection')).toBeNull();
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
});
