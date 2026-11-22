import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  centralNavigationDecision, CentralWindowFallback, CentralWindowLoader, centralWindowLoginTicketChannel,
  centralWindowOpenLocalChannel, centralWindowSessionPartition, installCentralNavigationGuards,
  centralWindowUrl, centralWindowWebPreferences, centralPermissionAllowed, installCentralSessionGuards,
  openCentralBrowser, pairedCentralOrigin, trustedCentralWindowSender,
} from '../src/central-browser';

const electron = vi.hoisted(() => ({
  exposed: [] as { name: string; api: Record<string, unknown> }[],
  send: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, unknown>) => { electron.exposed.push({ name, api }); },
  },
  ipcRenderer: { send: electron.send, invoke: electron.invoke },
}));

const origin = 'https://central.example';
const offlineUrl = new URL('../src/offline.html', import.meta.url).href;
const generatedDeviceId = '11111111-2222-4333-8444-555555555555';
const ticket = 't'.repeat(43);
const credential = 'generated-pairing-credential';

afterEach(() => vi.unstubAllGlobals());

function mockTicketRequest(code = ticket) {
  const request = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ code }));
  vi.stubGlobal('fetch', request);
  return request;
}

function guardedNavigation() {
  const mainFrame = { origin };
  const contents = new EventEmitter();
  const setWindowOpenHandler = vi.fn<(handler: (details: { url: string }) => { action: string }) => void>();
  const openExternal = vi.fn(async (_url: string) => {});
  installCentralNavigationGuards(
    Object.assign(contents, { mainFrame, setWindowOpenHandler }) as unknown as Parameters<typeof installCentralNavigationGuards>[0],
    () => origin, openExternal,
  );
  const navigate = (kind: 'will-frame-navigate' | 'will-redirect', url: string, isMainFrame: boolean, initiator: object | null) => {
    const preventDefault = vi.fn();
    contents.emit(kind, { url, isMainFrame, initiator, preventDefault });
    return preventDefault;
  };
  return { mainFrame, openExternal, navigate, openWindow: setWindowOpenHandler.mock.calls[0]![0] };
}

/** The preload checks Electron's frame flag; the Node test runner has no frame. */
function setMainFrame(value: boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(process, 'isMainFrame');
  Object.defineProperty(process, 'isMainFrame', { value, configurable: true });
  return () => {
    if (previous) Object.defineProperty(process, 'isMainFrame', previous);
    else Reflect.deleteProperty(process, 'isMainFrame');
  };
}

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

  it('denies a window.open callback with no verifiable frame before handing anything off', () => {
    const { openWindow, openExternal } = guardedNavigation();
    expect(openWindow({ url: 'https://elsewhere.example/' })).toEqual({ action: 'deny' });
    expect(openWindow({ url: origin })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each(['will-frame-navigate', 'will-redirect'] as const)('checks both the destination and the initiating frame for %s', kind => {
    const { navigate, mainFrame, openExternal } = guardedNavigation();
    const childFrame = { origin };
    const outside = 'https://elsewhere.example/';
    expect(navigate(kind, outside, false, childFrame)).not.toHaveBeenCalled();
    expect(navigate(kind, outside, false, mainFrame)).not.toHaveBeenCalled();
    expect(navigate(kind, outside, true, childFrame)).toHaveBeenCalledOnce();
    expect(navigate(kind, outside, true, null)).toHaveBeenCalledOnce();
    expect(navigate(kind, origin + '/#/library', true, mainFrame)).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(navigate(kind, outside, true, mainFrame)).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(outside);
  });

  it('cancels ticket-bearing redirects even when a paired main frame initiated the navigation', () => {
    const { navigate, mainFrame, openExternal } = guardedNavigation();
    for (const url of [
      `https://elsewhere.example/#/chat?loginTicket=${ticket}`,
      `https://elsewhere.example/?%6CoginTicket=${ticket}`,
      `https://elsewhere.example/#loginTicket=${ticket}`,
      `${origin}/#/chat?loginTicket=${ticket}`,
    ]) {
      expect(navigate('will-redirect', url, true, mainFrame)).toHaveBeenCalledOnce();
      expect(navigate('will-redirect', url, false, { origin })).toHaveBeenCalledOnce();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('MC2-02 Central main-window preload', () => {
  it('exposes only deviceId and openLocalWindow, and sends only the fixed local-window channel', async () => {
    const previous = [...process.argv];
    const restoreFrame = setMainFrame(true);
    electron.exposed.length = 0;
    vi.stubGlobal('window', new EventTarget());
    process.argv.push('--mote-device-id=' + generatedDeviceId);
    vi.resetModules();
    try { await import('../src/central-window-preload'); } finally {
      process.argv.splice(0, process.argv.length, ...previous);
      restoreFrame();
    }
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
      partition: centralWindowSessionPartition,
    });
    expect(centralWindowSessionPartition).toMatch(/^persist:/);
  });

  it('exposes nothing when the preload runs in a subframe', async () => {
    const restoreFrame = setMainFrame(false);
    electron.exposed.length = 0;
    vi.resetModules();
    try { await import('../src/central-window-preload'); } finally { restoreFrame(); }
    expect(electron.exposed).toHaveLength(0);
  });

  it('serves the login request only on a port from the main document', async () => {
    const restoreFrame = setMainFrame(true);
    const attempt = 'generated-document-marker';
    const dom = new JSDOM('', { url: origin + '/#/chat?desktopLogin=' + attempt });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('location', dom.window.location);
    electron.invoke.mockReset().mockResolvedValue(ticket);
    vi.resetModules();
    try {
      await import('../src/central-window-preload');
      const port = { postMessage: vi.fn(), close: vi.fn() };
      const request = (source: Window | null, from: string) => new dom.window.MessageEvent('message', {
        source: source as Window, origin: from, data: centralWindowLoginTicketChannel,
        ports: [port as unknown as MessagePort],
      });
      dom.window.dispatchEvent(request(null, origin));
      dom.window.dispatchEvent(request(dom.window as unknown as Window, 'https://elsewhere.example'));
      expect(electron.invoke).not.toHaveBeenCalled();
      dom.window.dispatchEvent(request(dom.window as unknown as Window, origin));
      await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(ticket));
      expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(centralWindowLoginTicketChannel, attempt);
      expect(port.close).toHaveBeenCalledOnce();
    } finally { restoreFrame(); dom.window.close(); }
  });
});

describe('MC2 Central session permission boundary', () => {
  it('allows only sanitized clipboard writes from the paired origin', () => {
    expect(centralPermissionAllowed('clipboard-sanitized-write', origin, origin)).toBe(true);
    for (const permission of [
      'clipboard-read', 'media', 'geolocation', 'notifications', 'fullscreen',
      'idle-detection', 'midi', 'pointerLock', 'openExternal', 'fileSystem',
    ]) expect(centralPermissionAllowed(permission, origin, origin)).toBe(false);
    expect(centralPermissionAllowed('clipboard-sanitized-write', 'https://elsewhere.example', origin)).toBe(false);
    expect(centralPermissionAllowed('clipboard-sanitized-write', origin, undefined)).toBe(false);
  });

  it('installs check, request, device and display-media handlers on the Central session', () => {
    let check: ((contents: unknown, permission: string, requestingOrigin: string) => boolean) | undefined;
    let request: ((contents: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string }) => void) | undefined;
    let device: (() => boolean) | undefined;
    let display: ((request: unknown, callback: (streams: Record<string, never>) => void) => void) | undefined;
    installCentralSessionGuards({
      setPermissionCheckHandler: handler => { check = handler as typeof check; },
      setPermissionRequestHandler: handler => { request = handler as typeof request; },
      setDevicePermissionHandler: handler => { device = handler as typeof device; },
      setDisplayMediaRequestHandler: handler => { display = handler as typeof display; },
    } as unknown as Parameters<typeof installCentralSessionGuards>[0], () => origin);

    expect(check!(null, 'media', origin)).toBe(false);
    expect(check!(null, 'clipboard-read', origin)).toBe(false);
    expect(check!(null, 'clipboard-sanitized-write', origin)).toBe(true);
    expect(check!(null, 'clipboard-sanitized-write', origin + '/')).toBe(true);
    expect(check!(null, 'clipboard-sanitized-write', 'https://elsewhere.example')).toBe(false);
    expect(check!(null, 'clipboard-sanitized-write', 'null')).toBe(false);

    const denied = vi.fn();
    request!(null, 'media', denied, { requestingUrl: origin + '/#/chat' });
    expect(denied).toHaveBeenCalledWith(false);
    const allowed = vi.fn();
    request!(null, 'clipboard-sanitized-write', allowed, { requestingUrl: origin + '/#/chat' });
    expect(allowed).toHaveBeenCalledWith(true);
    const foreign = vi.fn();
    request!(null, 'clipboard-sanitized-write', foreign, { requestingUrl: 'https://elsewhere.example/' });
    expect(foreign).toHaveBeenCalledWith(false);
    const missing = vi.fn();
    request!(null, 'clipboard-sanitized-write', missing, {});
    expect(missing).toHaveBeenCalledWith(false);

    expect(device!()).toBe(false);
    const streams = vi.fn();
    display!(null, streams);
    expect(streams).toHaveBeenCalledWith({});
  });

  it('requires both a configured address and a signed-in credential', () => {
    expect(pairedCentralOrigin(origin, 'generated-credential')).toBe(origin);
    expect(pairedCentralOrigin(origin, undefined)).toBeUndefined();
    expect(pairedCentralOrigin(undefined, 'generated-credential')).toBeUndefined();
    expect(pairedCentralOrigin('javascript:alert(1)', 'generated-credential')).toBeUndefined();
    expect(pairedCentralOrigin('https://user:secret@central.example', 'generated-credential')).toBeUndefined();
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

  it.each([false, true])('loads the new pairing when the identity changes during an offline load (initially paired: %s)', async initiallyPaired => {
    const nextOrigin = 'https://next-central.example';
    let current = { serverUrl: origin, token: initiallyPaired ? credential : undefined };
    const request = mockTicketRequest();
    const started = Promise.withResolvers<void>();
    const offline = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (url: string) => {
      if (url === offlineUrl) {
        started.resolve();
        await offline.promise;
      } else if (new URL(url).origin === origin) {
        throw Error('fixture Central load failed');
      }
    });
    const loader = new CentralWindowLoader({ loadURL, isDestroyed: () => false }, () => current, offlineUrl);

    const first = loader.load();
    await started.promise;
    expect(request).toHaveBeenCalledTimes(initiallyPaired ? 1 : 0);
    current = { serverUrl: nextOrigin, token: 'generated-next-credential' };
    expect(loader.load()).toBe(first);
    offline.resolve();
    await first;

    expect(request).toHaveBeenCalledTimes(initiallyPaired ? 2 : 1);
    expect(request.mock.lastCall?.[0]).toBe(nextOrigin + '/api/login/ticket');
    expect(loadURL.mock.calls.filter(([url]) => url === offlineUrl)).toEqual([[offlineUrl]]);
    expect(new URL(loadURL.mock.lastCall![0]).origin).toBe(nextOrigin);
    expect(loader.offline).toBe(false);
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
  it('keeps the existing external browser login ticket in the hash query', async () => {
    const openDefault = vi.fn(async (_url: string) => {});
    await openCentralBrowser(origin, 'ask', 'linux', vi.fn(), openDefault, undefined, ticket);
    const url = new URL(openDefault.mock.lastCall![0]);
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

  it('rejects malformed Central addresses before creating a window URL', () => {
    for (const serverUrl of ['javascript:alert(1)', 'https://user:secret@central.example', 'https://central.example/path', 'http://remote.example']) {
      expect(() => centralWindowUrl(serverUrl)).toThrow();
    }
  });

  it.each(['short', 'x'.repeat(44), 'bad ticket', 'x'.repeat(20) + '\n' + 'x'.repeat(22)])('falls back without loading Central for a malformed ticket', async value => {
    mockTicketRequest(value);
    const loadURL = vi.fn(async (_url: string) => {});
    const loader = new CentralWindowLoader({ loadURL, isDestroyed: () => false }, () => ({serverUrl: origin, token: credential}), offlineUrl);

    await loader.load();

    expect(loadURL).toHaveBeenCalledExactlyOnceWith(offlineUrl);
    expect(loader.offline).toBe(true);
  });

  it('keeps the ticket out of the failed navigation, including the process warning', async () => {
    const request = mockTicketRequest();
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const loadURL = vi.fn(async (url: string) => {
      if (url === offlineUrl) return;
      process.emitWarning('Failed to load URL: ' + url);
      throw Error('fixture Central load failed');
    });
    const loader = new CentralWindowLoader({ loadURL, isDestroyed: () => false }, () => ({serverUrl: origin, token: credential}), offlineUrl);
    try {
      await loader.load();

      expect(request).toHaveBeenCalledTimes(1);
      expect(loadURL).toHaveBeenCalledTimes(2);
      const address = loadURL.mock.calls[0]![0];
      expect(new URL(address).hash.split('?')[0]).toBe('#/chat');
      expect(warning).toHaveBeenCalledExactlyOnceWith('Failed to load URL: ' + address);
      expect(address).not.toContain(ticket);
      expect(address).not.toContain(credential);
      expect(address).not.toContain('loginTicket');
      expect(loader.takeLoginTicket({ origin, url: address }, new URL(address).searchParams.get('desktopLogin'))).toBeUndefined();
      expect(loadURL.mock.lastCall).toEqual([offlineUrl]);
    } finally { warning.mockRestore(); }
  });

  it('rechecks the full identity before releasing a ticket to a loaded page', async () => {
    mockTicketRequest();
    const loadURL = vi.fn(async (_url: string) => {});
    let settings = { serverUrl: origin, token: credential, authSessionOnly: false };
    const loader = new CentralWindowLoader({ loadURL, isDestroyed: () => false }, () => settings, offlineUrl);
    await loader.load();
    const frame = { origin, url: loadURL.mock.lastCall![0] };
    const attempt = new URL(frame.url).searchParams.get('desktopLogin');
    settings = { ...settings, authSessionOnly: true };
    expect(loader.takeLoginTicket(frame, attempt)).toBeUndefined();
  });

  it.each(['browser address', 'Desktop message port', 'Desktop after a same-origin redirect'])('exchanges a ticket from the %s and stores only the session', async transport => {
    const token = 'a'.repeat(64);
    const loadURL = vi.fn(async (_url: string) => {});
    const loader = new CentralWindowLoader({ loadURL, isDestroyed: () => false }, () => ({serverUrl: origin, token: credential}), offlineUrl);
    const address = new URL(centralWindowUrl(origin));
    const isDesktop = transport !== 'browser address';
    let attempt: string | null = null;
    if (!isDesktop) {
      address.hash += '?loginTicket=' + ticket;
    } else {
      mockTicketRequest();
      await loader.load();
      address.href = loadURL.mock.lastCall![0];
      attempt = address.searchParams.get('desktopLogin');
      expect(attempt).toBeTruthy();
      if (transport === 'Desktop after a same-origin redirect') {
        address.pathname = '/fixture';
        address.search = '';
      }
      expect(address.href).not.toContain(ticket);
      expect(address.href).not.toContain(credential);
      expect(loader.takeLoginTicket({ origin: 'https://elsewhere.example', url: address.href }, attempt)).toBeUndefined();
      expect(loader.takeLoginTicket({ origin, url: centralWindowUrl(origin) }, attempt)).toBeUndefined();
      expect(loader.takeLoginTicket({ origin, url: address.href }, 'generated-previous-marker')).toBeUndefined();
    }
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: address.href });
    if (isDesktop) {
      Object.defineProperty(dom.window, 'moteDesktop', { value: { deviceId: generatedDeviceId, openLocalWindow: vi.fn() } });
      vi.spyOn(dom.window, 'postMessage').mockImplementation((message, targetOrigin, transfer) => {
        expect(message).toBe(centralWindowLoginTicketChannel);
        expect(targetOrigin).toBe(origin);
        const port = transfer?.[0] as MessagePort;
        port.postMessage(loader.takeLoginTicket({ origin, url: dom.window.location.href }, attempt));
        port.close();
      });
    }
    const previous = new Map<string, PropertyDescriptor | undefined>();
    const fetchMock = vi.fn(async () => {
      expect(dom.window.location.hash).toBe('#/chat');
      expect(dom.window.location.search).toBe('');
      expect(dom.window.location.href).not.toContain(ticket);
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
      expect(init.redirect).toBe('error');
      expect(dom.window.location.href).not.toContain(ticket);
      expect(dom.window.location.hash).toBe('#/chat');
      expect(dom.window.sessionStorage.getItem('mote.connection')).toContain(token);
      expect(dom.window.localStorage.getItem('mote.connection')).toBeNull();
      expect(loader.takeLoginTicket({ origin, url: address.href }, attempt)).toBeUndefined();
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      dom.window.close();
    }
  });
});
