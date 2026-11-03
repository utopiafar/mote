import { afterEach, test as it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMoteLink } from '@mote/shared';
import { buildApp, type QueryAgent } from '../../server/src/app';
import type { Config as ServerConfig } from '../../server/src/config';
import { defaultConfig } from '../src/config';
import { centralRoute, centralScope, pollBrowserLogin, prepareBrowserSession, showCentral, type CentralNavigation } from '../src/central-navigation';
import { consumeLoginTicket } from '../../web/src/login-handoff';
import { createApi } from '../../web/src/api';
import { clearSession, connectionStorageKey, readStoredSession } from '../../web/src/session';

const origin = 'https://fixture.invalid';
const owner = 'generated-navigation-owner-token-123456789';
const inactive: QueryAgent = { configured: false, query: async () => { throw Error('No model calls belong in navigation contracts'); }, close: async () => {} };
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(key: string, value: unknown) {
  if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of savedGlobals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
  savedGlobals.clear();
});

async function fixture(serviceOrigin = origin) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-navigation-'));
  const config: ServerConfig = {
    dataDir: directory, token: owner, tokenPath: join(directory, 'owner-token'), host: '127.0.0.1', port: 0, profile: 'test', tokenFromEnvironment: true,
    maxStorageBytes: 30 * 1024 * 1024, maxExportBytes: 4 * 1024 * 1024, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [serviceOrigin], model: '', modelBaseUrl: 'https://api.deepseek.com', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', diagnosticsEnabled: false,
  };
  const value = await buildApp(config, { agent: inactive, backgroundWorker: false });
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), serviceOrigin);
    assert.equal(url.origin, serviceOrigin);
    assert.equal(init?.redirect, 'error');
    requests.push({ url, init });
    const response = await value.app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.pathname + url.search, headers: Object.fromEntries(new Headers(init?.headers)), payload: init?.body as string | undefined });
    return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
  };
  stubGlobal('fetch', fetcher);
  return { ...value, requests, fetcher, close: async () => { await value.app.close(); await rm(directory, { recursive: true, force: true }); } };
}

function browser(url: string) {
  let href = url, scrollY = 0;
  const local = new Map<string, string>(), session = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  stubGlobal('location', { get href() { return href; }, get hash() { return new URL(href).hash; }, get pathname() { return new URL(href).pathname; }, get search() { return new URL(href).search; }, get origin() { return new URL(href).origin; } });
  stubGlobal('history', { replaceState: (_data: unknown, _unused: string, path: string) => { href = new URL(path, href).href; } });
  stubGlobal('localStorage', storage(local));
  stubGlobal('sessionStorage', storage(session));
  stubGlobal('scrollY', 0);
  return { local, session, href: () => href, scrollY: () => scrollY, setScrollY: (value: number) => { scrollY = value; stubGlobal('scrollY', value); } };
}

function navigation(settings = { ...defaultConfig(), serverUrl: origin, token: owner }): CentralNavigation & { launchChrome: ReturnType<typeof mock.fn>; openDefault: ReturnType<typeof mock.fn> } {
  return { settings: () => settings, authorizationGeneration: () => 0, browserLogin: () => undefined, ensureBrowserLogin: async () => {}, platform: 'darwin', launchChrome: mock.fn(async () => undefined), openDefault: mock.fn(async () => undefined) };
}

it('carries the current desktop ticket into the real Web session consumer and rejects replay', async () => {
  const f = await fixture();
  try {
    const grant = await f.connections.session(origin, 'Generated desktop', { deviceId: 'generated-mac', deviceName: 'Generated Mac', platform: 'macos' }, 86400000);
    const current: import('../src/contracts').Config = { ...defaultConfig(), serverUrl: origin, token: owner };
    const entry = navigation(current);
    entry.ensureBrowserLogin = async () => { current.token = grant.token; current.authExpiresAt = grant.expiresAt; };
    await showCentral(entry, 'ask', 'capture:11111111-2222-4333-8444-555555555555');
    const url = entry.launchChrome.mock.calls[0].arguments[0] as string;
    const target = new URL(url), params = new URLSearchParams(target.hash.split('?')[1]);
    assert.equal(target.origin, origin); assert.equal(target.pathname, '/'); assert.equal(target.search, '');
    assert.ok(!url.includes(owner)); assert.ok(!url.includes(grant.token)); assert.match(params.get('loginTicket')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(f.requests[0].url.pathname, '/api/login/ticket');
    assert.equal(new Headers(f.requests[0].init?.headers).get('authorization'), 'Bearer ' + grant.token);
    assert.deepEqual(JSON.parse(f.requests[0].init?.body as string), { expiresAt: grant.expiresAt });
    const b = browser(url);
    await consumeLoginTicket();
    assert.ok(!b.href().includes('loginTicket')); assert.ok(new URL(b.href()).hash.includes('evidence=capture%3A11111111-2222-4333-8444-555555555555'));
    assert.equal(readStoredSession(origin)?.token, grant.token); assert.equal(readStoredSession(origin)?.serverExpiresAt, grant.expiresAt);
    assert.equal(entry.openDefault.mock.calls.length, 0);
    browser(url);
    localStorage.setItem(connectionStorageKey, JSON.stringify({ token: 'generated-unrelated-old-session' }));
    await assert.rejects(consumeLoginTicket(), /Login link expired/);
    assert.equal(localStorage.getItem(connectionStorageKey), null); assert.equal(sessionStorage.getItem(connectionStorageKey), null);
  } finally { await f.close(); }
});

it('opens the canonical shared scope and route and restores that origin and reader position after login', async () => {
  const f = await fixture();
  try {
    const grant = await f.connections.session(origin, 'Generated desktop', { deviceId: 'generated-scope-mac', deviceName: 'Generated Mac', platform: 'macos' }, 86400000);
    const current: import('../src/contracts').Config = { ...defaultConfig(), serverUrl: origin + '/', token: owner };
    const entry = navigation(current);
    entry.settings = () => current;
    entry.ensureBrowserLogin = async () => { current.token = grant.token; current.authExpiresAt = grant.expiresAt; };
    const reference = 'capture:11111111-2222-4333-8444-555555555555', conversationId = '11111111-2222-4333-8444-555555555555';
    await showCentral(entry, 'ask', reference, undefined, conversationId);
    const link = parseMoteLink(entry.launchChrome.mock.calls[0].arguments[0] as string);
    assert.deepEqual(link, { scope: { origin }, route: { kind: 'reference', ref: reference, conversation: conversationId } });
    const b = browser(entry.launchChrome.mock.calls[0].arguments[0] as string);
    b.setScrollY(240); await consumeLoginTicket();
    assert.equal(b.scrollY(), 240, 'returning from login keeps the reader position');
    assert.deepEqual(parseMoteLink(b.href()), link, 'returning from login keeps the exact origin and route');
    await showCentral(entry, 'activity', undefined, 'generated-work-scope');
    assert.deepEqual(parseMoteLink(entry.launchChrome.mock.calls[1].arguments[0] as string), { scope: { origin }, route: { kind: 'run', id: 'generated-work-scope' } });
  } finally { await f.close(); }
});

it('resolves Mac handoff arguments through the shared route schema before minting a ticket', () => {
  const reference = 'capture:11111111-2222-4333-8444-555555555555', conversationId = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(centralScope({ serverUrl: origin + '/' }), { origin });
  assert.deepEqual(centralRoute(reference), { kind: 'reference', ref: reference });
  assert.deepEqual(centralRoute(reference, undefined, conversationId), { kind: 'reference', ref: reference, conversation: conversationId });
  assert.deepEqual(centralRoute(undefined, 'generated-run-scope'), { kind: 'run', id: 'generated-run-scope' });
  assert.deepEqual(centralRoute(undefined, undefined, conversationId), { kind: 'conversation', id: conversationId });
  assert.equal(centralRoute(), undefined);
  for (const invalid of ['memory:11111111-2222-4333-8444-555555555555', 'artifact:generated:version%3A2', 'not-a-reference', ' ' + reference]) assert.throws(() => centralRoute(invalid), /Invalid evidence reference/);
  assert.throws(() => centralRoute(undefined, 'generated-run', conversationId), /Invalid conversation destination/);
});

it('rejects expired tickets at the real exchange and discards a late exchange after a new login', async () => {
  let now = Date.now();
  mock.method(Date, 'now', () => now);
  const f = await fixture();
  try {
    const entry = navigation({ ...defaultConfig(), serverUrl: origin, token: owner, authExpiresAt: Date.now() + 60_000 });
    await showCentral(entry, 'notes');
    const expiredUrl = entry.launchChrome.mock.calls[0].arguments[0] as string;
    now += 61_000;
    browser(expiredUrl);
    await assert.rejects(consumeLoginTicket(), /Login link expired/);
    assert.equal(readStoredSession(origin), null);
    now -= 61_000;
    const longLived = navigation({ ...defaultConfig(), serverUrl: origin, token: owner, authExpiresAt: now + 600_000 });
    await showCentral(longLived, 'notes');
    now += 61_000;
    browser(longLived.launchChrome.mock.calls[0].arguments[0] as string);
    await assert.rejects(consumeLoginTicket(), /Login link expired/);
    assert.equal(readStoredSession(origin), null, 'The ticket expires even while its parent credential remains valid');
    now -= 61_000;
    await showCentral(entry, 'notes');
    const url = entry.launchChrome.mock.calls[1].arguments[0] as string;
    const b = browser(url), fetcher = globalThis.fetch;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => { const response = await fetcher(...args); await blocked; return response; });
    let active = true;
    const pending = consumeLoginTicket(() => active);
    active = false; localStorage.setItem(connectionStorageKey, JSON.stringify({ token: 'generated-newer-login' }));
    release();
    await assert.rejects(pending, /Login changed/);
    assert.equal(JSON.parse(b.local.get(connectionStorageKey)!).token, 'generated-newer-login');
  } finally { mock.restoreAll(); await f.close(); }
});

it('cannot exchange a desktop ticket at another Central origin or send that origin the bearer', async () => {
  const f = await fixture(), other = await fixture('https://other.invalid');
  try {
    stubGlobal('fetch', f.fetcher);
    const entry = navigation();
    await showCentral(entry, 'notes');
    const url = entry.launchChrome.mock.calls[0].arguments[0] as string;
    const wrongOrigin = new URL(url); wrongOrigin.hostname = 'other.invalid';
    const b = browser(wrongOrigin.href);
    stubGlobal('fetch', other.fetcher);
    await assert.rejects(consumeLoginTicket(), /Login link expired/);
    assert.equal(other.requests.length, 1);
    assert.equal(other.requests[0].url.origin, wrongOrigin.origin);
    assert.equal(new Headers(other.requests[0].init?.headers).has('authorization'), false);
    assert.ok(!(other.requests[0].init?.body as string).includes(owner));
    assert.equal(readStoredSession(wrongOrigin.origin), null);
    assert.ok(!b.href().includes('loginTicket'));
    // The unrelated node did not consume the issuing node's one-time ticket.
    browser(url); stubGlobal('fetch', f.fetcher);
    await consumeLoginTicket();
    assert.equal(readStoredSession(origin)?.token, owner);
  } finally { await other.close(); await f.close(); }
});

it('does not open another node when a ticket response arrives after the connection changes', async () => {
  const f = await fixture();
  try {
    let current = { ...defaultConfig(), serverUrl: origin, token: owner };
    const entry = navigation(current);
    entry.settings = () => current;
    const originalFetch = globalThis.fetch;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith('/api/login/ticket')) { started(); await held; }
      return response;
    });
    const opening = showCentral(entry, 'ask', 'capture:11111111-2222-4333-8444-555555555555', undefined, '11111111-2222-4333-8444-555555555555');
    await requested;
    current = { ...current, serverUrl: 'https://other.invalid', token: 'generated-other-owner-token' };
    release();
    await assert.rejects(opening, /登录会话已变更/);
    assert.equal(entry.launchChrome.mock.calls.length, 0);
    assert.equal(entry.openDefault.mock.calls.length, 0);
  } finally { await f.close(); }
});

it('does not install an old owner credential after a delayed connection check changes nodes', async () => {
  let current = { ...defaultConfig(), serverUrl: origin, token: owner }, generation = 0;
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const install = mock.fn(async (_token: string, _duration: number) => {});
  const preparing = prepareBrowserSession({
    settings: () => current, authorizationGeneration: () => generation,
    inspect: async () => { started(); await held; return {credential:{id:'owner'}}; }, install,
  });
  await requested;
  current = { ...current, serverUrl: 'https://other.invalid', token: 'generated-other-owner-token' }; generation++;
  release();
  await assert.rejects(preparing, /登录会话已变更/);
  assert.equal(install.mock.calls.length, 0);
});

it('never installs or acknowledges a late login grant after switching nodes', async () => {
  let isCurrent = true, release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const install = mock.fn(async (_token: string) => {}), acknowledge = mock.fn(async () => {});
  const pending = pollBrowserLogin({
    current: () => isCurrent,
    poll: async () => { started(); await held; return {ready:true,token:'generated-A-grant'}; },
    install, acknowledge, wait: async () => {},
  });
  await requested; isCurrent = false; release();
  await assert.rejects(pending, /登录会话已变更/);
  assert.equal(install.mock.calls.length, 0); assert.equal(acknowledge.mock.calls.length, 0);
});

it('does not launch a ticket after a connection changes away and back during the request', async () => {
  const f = await fixture();
  try {
    const current = { ...defaultConfig(), serverUrl: origin, token: owner };
    let generation = 0;
    const entry = navigation(current); entry.authorizationGeneration = () => generation;
    const originalFetch = globalThis.fetch;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith('/api/login/ticket')) { started(); await held; }
      return response;
    });
    const opening = showCentral(entry, 'notes');
    await requested; generation += 2; release();
    await assert.rejects(opening, /登录会话已变更/);
    assert.equal(entry.launchChrome.mock.calls.length, 0); assert.equal(entry.openDefault.mock.calls.length, 0);
  } finally { await f.close(); }
});

it('browser logout revokes the shared desktop credential and rejects an outstanding ticket', async () => {
  const f = await fixture();
  try {
    const grant = await f.connections.session(origin, 'Generated desktop', { deviceId: 'generated-logout-mac', deviceName: 'Generated Mac', platform: 'macos' }, 86400000);
    const entry = navigation({ ...defaultConfig(), serverUrl: origin, token: grant.token });
    await showCentral(entry, 'notes');
    browser(entry.launchChrome.mock.calls[0].arguments[0] as string);
    await consumeLoginTicket();
    const api = createApi(readStoredSession(origin)!);
    await api.request('/api/configuration');
    await showCentral(entry, 'notes');
    const outstanding = entry.launchChrome.mock.calls[1].arguments[0] as string;
    await api.request('/api/login/logout', { method: 'POST', body: '{}' });
    clearSession();
    assert.equal(readStoredSession(origin), null);
    await assert.rejects(api.request('/api/configuration'));
    browser(outstanding);
    await assert.rejects(consumeLoginTicket(), /Login link expired/);
    assert.equal(readStoredSession(origin), null);
    await assert.rejects(showCentral(entry, 'notes'));
    assert.equal(entry.launchChrome.mock.calls.length, 2);
  } finally { await f.close(); }
});

it('does not launch a browser after ticket or session preparation failure and repeats a later successful attempt', async () => {
  const f = await fixture();
  try {
    const current = { ...defaultConfig(), serverUrl: origin, token: 'generated-invalid-token'.repeat(3) }, entry = navigation(current);
    await assert.rejects(showCentral(entry, 'notes'));
    assert.equal(entry.launchChrome.mock.calls.length, 0); assert.equal(entry.openDefault.mock.calls.length, 0);
    current.token = owner;
    entry.ensureBrowserLogin = async () => { throw Error('Generated preparation failure'); };
    await assert.rejects(showCentral(entry, 'notes'), /Generated preparation failure/);
    assert.equal(entry.launchChrome.mock.calls.length, 0);
    entry.ensureBrowserLogin = async () => {};
    await showCentral(entry, 'notes');
    assert.equal(entry.launchChrome.mock.calls.length, 1);
  } finally { await f.close(); }
});

it('delegates signed-out navigation to the existing browser login before requesting a ticket', async () => {
  const entry = navigation({ ...defaultConfig(), serverUrl: origin, authSignedOut: true });
  const login = mock.fn(async () => undefined), fetcher = mock.fn();
  stubGlobal('fetch', fetcher);
  entry.browserLogin = () => login;
  await showCentral(entry, 'activity', undefined, 'generated/work');
  assert.deepEqual(login.mock.calls[0].arguments, ['activity', undefined, undefined, 'generated/work', undefined]);
  assert.equal(fetcher.mock.calls.length, 0); assert.equal(entry.launchChrome.mock.calls.length, 0);
});
