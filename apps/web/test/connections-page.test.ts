import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {pageHash, type ServiceItem} from '@mote/shared';
import {configureLocale} from '@mote/shared/i18n';
import {JSDOM} from 'jsdom';
import React, {act} from 'react';
import {buildApp} from '../../server/src/app';
import {ApiError, type Api} from '../src/api';
import {webFeatures} from '../src/features/registry';
import type {PageProps} from '../src/features/types';
import {readPage, workspaceNavigation} from '../src/navigation';
import {agentAccess} from '../src/plugins/agent-access';
import {ask} from '../src/plugins/ask';
import {pluginContributions} from '../src/plugins/default-inventory';
import {connections, sources} from '../src/plugins/sources';
import {ConnectionsPage} from '../src/plugins/sources/ConnectionsPage';
import {resources} from '../src/resource-cache';
import {useHashChoice} from '../src/useHashChoice';
import {NavStateContext, navStateReader, useNavStateRead} from '../src/use-nav-state';
import {WorkspaceSidebar} from '../src/WorkspaceSidebar';

configureLocale(() => 'zh-CN');
const servicesPath = '/api/connections/services';
const scanPath = '/api/assistant/onboarding';
const gmail = {id: 'generated-inbox', name: 'Generated inbox', kind: 'gmail', platform: 'import', deviceId: 'generated-mail'} as const;
const device = {id: 'generated-device-files', name: 'Generated device files', kind: 'local-files', platform: 'macos', deviceId: 'generated-mac'} as const;
const lastRun = '00000000-0000-4000-8000-000000000101';
const newRun = '00000000-0000-4000-8000-000000000102';
const gmailCard: ServiceItem = {id: 'gmail', name: 'Generated Gmail', kind: 'service', state: 'connected',
  jobs: [], tools: [], actions: ['sync', 'dry-run', 'pause', 'remove']};

async function dom(t: TestContext, route = pageHash('connections')) {
  const browser = new JSDOM('<div id="root"></div>', {url: 'https://generated.invalid/' + route, pretendToBeVisual: true});
  const {window} = browser;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    location: window.location, sessionStorage: window.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true})) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
  }
  const {createRoot} = await import('react-dom/client');
  const root = createRoot(window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.close();
  });
  return {window, document: window.document, render: (node: React.ReactNode) => act(async () => root.render(node))};
}

async function central(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-connections-page-'));
  const token = randomUUID() + randomUUID();
  const node = await buildApp({
    path: join(directory, 'mote.yaml'), privateCredential: {token, tokenPath: join(directory, 'owner-token')},
    initialDocument: {version: 1, revision: 0, storage: {dataDir: directory, maxExportBytes: 4 * 1024 * 1024},
      server: {profile: 'test', host: '127.0.0.1', port: 0, allowedOrigins: []}, execution: {insightIntervalHours: 0},
      models: {deployment: {model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high'}, embedding: {model: '', baseUrl: '', apiKey: ''}},
      connectors: {directory: join(directory, 'connectors'), mcpEnabled: true, mcpReadToken: randomUUID() + randomUUID(), syncIntervalMs: 300_000}},
  }, {backgroundWorker: false, agent: {configured: false, query: async () => {throw new Error('Unexpected model call');}, close: async () => {}}});
  t.after(async () => {await node.app.close(); await rm(directory, {recursive: true, force: true});});
  const writes: Array<{method: string; path: string}> = [];
  async function raw(path: string, init?: RequestInit) {
    init?.signal?.throwIfAborted();
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    if (method !== 'GET') writes.push({method, path});
    const response = await node.app.inject({url: path, method,
      headers: {...Object.fromEntries(new Headers(init?.headers)), authorization: 'Bearer ' + token},
      ...(init?.body ? {payload: JSON.parse(String(init.body))} : {}),
    });
    init?.signal?.throwIfAborted();
    if (response.statusCode >= 400) throw new ApiError('Generated request failed', response.statusCode);
    return new Response(response.body || null, {status: response.statusCode, headers: new Headers(response.headers as Record<string, string>)});
  }
  const api = {raw, request: async (path: string, init?: RequestInit) => (await raw(path, init)).json()} as Api;
  return {node, api, writes};
}

async function installPages(t: TestContext) {
  for (const plugin of [sources, connections, agentAccess]) {
    const installed = await webFeatures.install({id: plugin.id, version: '1', components: []}, pluginContributions(plugin));
    t.after(() => installed.dispose());
  }
}

const readLocationPage = (hash: string) => readPage(hash);
function Workspace({api}: {api: Api}) {
  const nav = useNavStateRead(api);
  const [page] = useHashChoice('page', readLocationPage);
  return React.createElement(NavStateContext.Provider, {value: nav.value},
    React.createElement(WorkspaceSidebar, {groups: workspaceNavigation(), page, onPage: () => {}}),
    webFeatures.page(page)?.render({api, onPage: () => {}, onOpen: () => {}} as PageProps));
}

function find<T extends Element>(document: ParentNode, selector: string) {
  const element = document.querySelector<T>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

function button(root: ParentNode, label: string) {
  const value = [...root.querySelectorAll('button')].find(element => element.textContent === label);
  assert.ok(value, `Expected action ${label}`);
  return value;
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 10));});
  }
  assert.fail('Generated interface did not settle');
}

test('CN3-01 CN1 revision replaces expired authorization actions and NV2 lights the Connections badge', async t => {
  const {api, node, writes} = await central(t);
  await installPages(t);
  const {document, render} = await dom(t);
  node.sources.register(gmail);
  node.sources.register(device);
  const at = new Date().toISOString();
  node.sources.reportStatus(gmail.id, {state: 'idle', lastSyncAt: at,
    coverage: {state: 'complete', window: {to: at}, processed: 0, remaining: 0, failed: 0, limitations: [], updatedAt: at}});

  await render(React.createElement(Workspace, {api}));
  await until(() => Boolean(document.querySelector('[data-service-id=gmail]')));
  const card = () => find(document, '[data-service-id=gmail]');
  const actions = () => [...card().querySelectorAll<HTMLElement>('[data-action]')].map(element => element.dataset.action);
  const badge = () => document.querySelector('[data-nav-item=connections] [data-nav-badge=connections]');
  assert.equal(card().getAttribute('data-state'), 'connected');
  assert.deepEqual(actions(), ['sync', 'dry-run', 'settings']);
  assert.equal(find(card(), '[role=switch]').getAttribute('aria-checked'), 'true');
  assert.equal(find(card(), '[data-job-kind=gmail] time').getAttribute('datetime'), at);
  assert.match(find(card(), '[data-job-kind=gmail]').textContent ?? '', /0/);
  assert.equal(document.querySelector('[data-service-id=local-files]'), null);
  assert.equal(document.querySelector('a[href^="#/connections/pair"]'), null);
  assert.equal(badge(), null);
  assert.equal(readPage('#/connections/access/agent'), 'agentView');
  assert.equal(readPage('#/agent?tab=input'), 'agentView');
  assert.equal(webFeatures.page('deviceConnections')?.section, 'library');

  await act(async () => find<HTMLButtonElement>(card(), '[data-action=dry-run]').click());
  await until(() => Boolean(card().querySelector('p[role=status]')));
  assert.deepEqual(writes, [{method: 'POST', path: `${servicesPath}/gmail/dry-run`}]);

  await act(async () => find<HTMLButtonElement>(card(), '[role=switch]').click());
  await until(() => card().getAttribute('data-state') === 'paused');
  assert.equal(find(card(), '[role=switch]').getAttribute('aria-checked'), 'false');
  assert.deepEqual(actions(), ['settings']);
  await act(async () => find<HTMLButtonElement>(card(), '[role=switch]').click());
  await until(() => card().getAttribute('data-state') === 'connected');
  assert.deepEqual(writes.slice(1), Array.from({length: 2}, () => ({method: 'PATCH', path: '/api/plugin-builds/bundled%3Agmail'})));

  node.sources.reportStatus(gmail.id, {state: 'permission_required', code: 'generated_auth_expired'});
  await act(async () => navStateReader(api).refresh());
  await until(() => Boolean(badge()) && card().getAttribute('data-state') === 'reauth');
  assert.deepEqual(actions(), ['reauth', 'settings']);
  assert.equal(card().querySelector('[role=switch]'), null);
  assert.equal(find(card(), '[data-action=reauth]').getAttribute('href'), pageHash('connections', {setup: 'gmail'}));
});

test('CN3-02 cancelling preserves AI access and confirmation removes the row and revokes the credential', async t => {
  const {api, node, writes} = await central(t);
  node.sources.register(gmail);
  const create = (label: string) => api.request<{credential: {id: string}; config: {mcpServers: {mote: {headers: {Authorization: string}}}}}>(
    '/api/connections/mcp', {method: 'POST', body: JSON.stringify({label, access: 'read', serverUrl: 'https://generated.invalid'})});
  const first = await create('Generated read agent');
  const second = await create('Generated other agent');
  const id = first.credential.id;
  const authorization = first.config.mcpServers.mote.headers.Authorization;
  const {document, render} = await dom(t);
  await render(React.createElement(ConnectionsPage, {api}));
  const row = () => document.querySelector(`[data-access-id="${id}"]`);
  await until(() => Boolean(row()?.querySelector('button:not(:disabled)')));
  assert.ok(!document.body.textContent!.includes(authorization));
  assert.ok(!document.querySelector('textarea'));

  await act(async () => find<HTMLButtonElement>(row()!, 'button').click());
  await act(async () => button(find(document, '[role=dialog]'), '取消').click());
  assert.ok(row() && node.connections.authenticate(authorization));
  assert.equal(writes.filter(write => write.method === 'DELETE').length, 0);

  await act(async () => find<HTMLButtonElement>(row()!, 'button').click());
  const confirm = button(find(document, '[role=dialog]'), '确认撤销');
  await act(async () => {confirm.click(); confirm.click();});
  await until(() => row() === null);
  assert.deepEqual(writes.filter(write => write.method === 'DELETE'), [{method: 'DELETE', path: '/api/connections/' + id}]);
  assert.ok(!node.connections.authenticate(authorization), 'the revoked bearer no longer authenticates');
  assert.ok(node.connections.authenticate(second.config.mcpServers.mote.headers.Authorization), 'the other bearer still authenticates');
  assert.ok(document.querySelector(`[data-access-id="${second.credential.id}"]`));
});

test('CN3-03 CT1 selection links to the real Chat page and its progress follows the generated run', async t => {
  await installPages(t);
  const askInstalled = await webFeatures.install({id: ask.id, version: '1', components: []}, pluginContributions(ask));
  t.after(() => askInstalled.dispose());
  const {document, window, render} = await dom(t, pageHash('connections', {onboarding: lastRun}));
  const chatId = '00000000-0000-4000-8000-000000000103';
  const requests: unknown[] = [];
  let state = 'running';
  const counts = {sources: 1, materials: 7, memories: 2, ideas: 4, feed: 3};
  const api = {request: async (path: string, init?: RequestInit) => {
    if (path === servicesPath) return {revision: 'generated-services', services: [gmailCard]};
    if (path === '/api/sources') return {items: [gmail, device]};
    if (path === `${scanPath}/${lastRun}`) return {state: 'completed', counts};
    if (path === `${scanPath}/${newRun}`) return {state, counts};
    if (path === scanPath && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)));
      return {id: newRun, revision: 1};
    }
    if (path === '/api/conversations/main') return {id: chatId};
    if (path === `/api/conversations/${chatId}`) return {id: chatId, scope: {}, revision: 1, turns: []};
    if (path.startsWith('/api/operations/changes?')) return {ids: [], cursor: 0, hasMore: false, reset: false};
    throw new Error('Unexpected generated request ' + path);
  }} as Api;
  const status = {agent: {configured: true, model: null, provider: 'generated'}} as unknown as PageProps['status'];
  const pageProps = {api, status, devices: [], onPage: () => {}, onOpen: () => {}} as unknown as PageProps;
  function Route() {
    const [page] = useHashChoice('page', readLocationPage);
    const entry = webFeatures.page(page);
    return entry ? React.createElement(React.Fragment, null, entry.render(pageProps)) : null;
  }

  await render(React.createElement(Route));
  const summary = find(document, '[data-onboarding-summary]');
  assert.equal(document.querySelector('[data-onboarding-chat-progress], .chat-page, progress'), null);
  await act(async () => button(summary, '再认识一次').click());
  const dialog = find(document, '[role=dialog]');
  const submit = find<HTMLButtonElement>(dialog, 'button[type=submit]');
  assert.equal(submit.disabled, true);
  await act(async () => find<HTMLInputElement>(dialog, `input[value=${gmail.id}]`).click());
  assert.equal(submit.disabled, true);
  const days = find<HTMLInputElement>(dialog, 'input[name=days]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {setValue.call(days, '14'); days.dispatchEvent(new window.Event('input', {bubbles: true}));});
  assert.equal(submit.disabled, false);
  await act(async () => submit.click());
  await until(() => Boolean(document.querySelector('.chat-page [data-onboarding-chat-progress][data-state=running]')));
  assert.ok(document.querySelector('.chat-page .chat-thread [data-onboarding-chat-progress]'),
    'the real AskPage mounts the progress card in its chat thread');
  assert.deepEqual(requests, [{sources: [gmail.id], window: {days: 14}}]);
  assert.equal(window.location.hash, pageHash('chat', {onboarding: newRun}));
  assert.equal(document.querySelector('[data-onboarding-summary]'), null);
  state = 'completed';
  await act(async () => resources(api).get(`${scanPath}/${newRun}`).refresh());
  assert.ok(document.querySelector('.chat-page [data-onboarding-chat-progress][data-state=completed]'));
});

test('the empty state offers New, and failures withdraw stale service cards and retry only the failed read', async t => {
  const {document, render} = await dom(t);
  let result: ServiceItem[] | Error = [];
  let sourceError = false;
  const reads: string[] = [];
  const api = {request: async (path: string) => {
    reads.push(path);
    if (path === servicesPath) {
      if (result instanceof Error) throw result;
      return {revision: 'generated-services', services: result};
    }
    if (path === '/api/sources') {
      if (sourceError) throw new Error('Generated sources failure');
      return {items: []};
    }
    throw new Error('Unexpected generated request ' + path);
  }} as Api;
  await render(React.createElement(ConnectionsPage, {api}));
  const page = find(document, '.connections-overview');
  assert.ok(page.querySelector('.connection-empty'));
  assert.equal(page.querySelectorAll('a,button').length, 1);
  assert.equal(find(page, 'a').getAttribute('href'), '#/connections/add');

  result = [gmailCard];
  sourceError = true;
  await act(async () => resources(api).invalidate(path => path === servicesPath || path === '/api/sources'));
  assert.equal(page.getAttribute('data-state'), 'partial');
  assert.ok(page.querySelector('[data-service-id=gmail]'));
  sourceError = false;
  reads.length = 0;
  await act(async () => find<HTMLButtonElement>(page, '[role=alert] button').click());
  assert.deepEqual(reads, ['/api/sources']);

  for (const [failure, state] of [[new TypeError('Generated offline'), 'offline'], [new Error('Generated failure'), 'failed'],
    [new ApiError('Generated withdrawn access', 403), 'expired']] as const) {
    result = failure;
    await act(async () => resources(api).get(servicesPath).refresh());
    assert.equal(page.getAttribute('data-state'), state);
    assert.equal(page.querySelector('[data-service-id]'), null);
  }
});
