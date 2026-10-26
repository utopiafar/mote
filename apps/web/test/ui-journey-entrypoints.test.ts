import test from 'node:test';
import assert from 'node:assert/strict';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale, getLocale} from '@mote/shared/i18n';
import {Overview} from '../src/Overview';
import {Insights} from '../src/Insights';
import {Conversations} from '../src/Conversations';
import {Connections} from '../src/Connections';
import {webFeatures} from '../src/features/registry';
import {featuresReady} from '../src/features/runtime';
import {readPage} from '../src/navigation';
import {primaryDestination} from '../src/WorkspaceNavigation';
import {ApiError, type Api, type Answer, type Status} from '../src/api';
import type {PageProps} from '../src/features/types';
import {modelView} from './fixtures/model-settings';

const when = '2026-10-25T00:00:00Z';
const captureId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(t: import('node:test').TestContext, hash = '#/today') {
  await featuresReady;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://localhost/' + hash, pretendToBeVisual: true});
  const before = new Map<string, PropertyDescriptor | undefined>(), previousLocale = getLocale();
  configureLocale(() => 'zh-CN');
  for (const [key, value] of Object.entries({window: dom.window, location: dom.window.location, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true})) {
    before.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, value] of before) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    configureLocale(() => previousLocale);
    dom.window.close();
  });
  const tick = async () => { await act(async () => new Promise(resolve => setTimeout(resolve, 0))); };
  return {root, d: dom.window.document, tick};
}
const button = (d: Document, label: string) => [...d.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)!;
function apiWith(read: (path: string, init?: RequestInit) => unknown): Api {
  return {request: async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/operations/changes')) return {ids: [], cursor: 0, hasMore: false, reset: false};
    if (path === '/api/model-settings') return modelView();
    return read(path, init);
  }, setAgentTimeout: () => {}} as Api;
}

test('a Home finding opens that exact report, reaches its evidence and does not start a new analysis', async t => {
  const {root, d, tick} = await fixture(t), opened: string[] = [], writes: string[] = [];
  let finishBackground!: (value: unknown) => void;
  const background = new Promise(resolve => { finishBackground = resolve; });
  const report: Answer = {runId: 'chosen-report', answer: 'Generated chosen finding', trace: [], citations: [{id: captureId, appName: 'Generated note', capturedAt: when, excerpt: 'Generated source evidence'}]};
  const other: Answer = {runId: 'newer-unrelated', answer: 'Generated unrelated report', trace: [], citations: []};
  const api = apiWith((path, init) => {
    if (init?.method && init.method !== 'GET') writes.push(path);
    if (path === '/api/insights?limit=30') return {items: [other, report],nextCursor:null};
    if(path==='/api/insights/chosen-report')return report;
    if(path==='/api/insights/newer-unrelated')return other;
    if(path==='/api/insights/unavailable')throw new ApiError('Generated report unavailable',404);
    if (path === '/api/insight-runs') return {items: [{id: 'background-run', status: 'running', scope: {}, createdAt: when, updatedAt: when, events: []}]};
    if (path === '/api/insight-runs/background-run') return background;
    if (path === '/api/connections') return {items: []};
    if (path.startsWith('/api/library/catalog')) return {items: [captureId]};
    return {items: []};
  });
  await act(async () => root.render(React.createElement(Overview, {api, status: {} as Status, devices: [], recent: [], insights: [other, report], activity: {apps: [], devices: [], totalDurationMs: 0, captures: 0}, onPage: () => {}, onOpen: ref => opened.push(ref), range: {}, onMedia: () => {}})));
  const card = d.querySelector<HTMLAnchorElement>('.home-insight')!;
  assert.match(card.textContent!, /Generated chosen finding/);
  await act(async () => card.click()); await tick();
  assert.equal(location.hash, '#/library/insights?insight=chosen-report');
  await act(async () => root.render(React.createElement(Insights, {api, range: {}, configured: true, onOpen: ref => opened.push(ref), onSettings: () => {}, onChanged: () => {}})));
  assert.match(d.querySelector('.insight-report')!.textContent!, /Generated chosen finding/);
  assert.doesNotMatch(d.querySelector('.insight-report')!.textContent!, /Generated unrelated report/);
  assert.equal(d.querySelector('.insight-compose'), null);
  await act(async () => d.querySelector<HTMLButtonElement>('.evidence-card')!.click());
  assert.deepEqual(opened, ['capture:' + captureId]);
  assert.deepEqual(writes, []);
  await act(async () => finishBackground({id: 'background-run', status: 'completed', scope: {}, createdAt: when, updatedAt: when, events: [], result: other}));
  assert.match(d.querySelector('.insight-report')!.textContent!, /Generated chosen finding/, 'a separate background analysis cannot replace the report the owner opened');

  await act(async () => { location.hash = '#/library/insights'; }); await tick();
  assert.match(d.querySelector('.insight-report')!.textContent!, /Generated unrelated report/, 'opening the history defaults to an existing result');
  await act(async () => { location.hash = '#/library/insights?insight=unavailable'; }); await tick();
  assert.equal(d.querySelector('.insight-report'), null, 'an unavailable exact report cannot silently open a different result');
  assert.match(d.body.textContent!, /这份洞察当前不可用/);
  await act(async () => button(d, '新建洞察').click()); await tick();
  assert.ok(d.querySelector('.insight-compose'), 'generation controls appear after an explicit New action');
  assert.deepEqual(writes, [], 'opening the composer does not start model work');
});

test('reusing the connection component for device and AI modes clears prior form defaults and revocation review', async t => {
  const {root, d} = await fixture(t, '#/connections/pair');
  const api = apiWith(path => path === '/api/configuration' ? {groups: []} : {items: [{id: 'generated-device', label: 'Generated device', scope: 'owner', createdAt: when, tokenHint: 'fixture'}], mcp: {enabled: true, writeEnabled: false, writeSourceIds: []}});
  const view = (mode: 'device' | 'chatbot') => React.createElement(Connections, {api, mode, serverUrl: 'http://localhost', devices: []});
  await act(async () => root.render(view('device')));
  assert.equal(d.querySelector<HTMLInputElement>('[aria-label="连接名称"]')!.value, '我的新设备');
  await act(async () => button(d, '撤销').click());
  assert.ok(button(d, '确认撤销'));
  await act(async () => root.render(view('chatbot')));
  assert.equal(d.querySelector<HTMLInputElement>('[aria-label="连接名称"]')!.value, '我的 AI 助手');
  await act(async () => root.render(view('device')));
  assert.equal(button(d, '确认撤销'), undefined);
  assert.ok(button(d, '撤销'));
});

test('source device pairing and AI access use distinct routes and inventories without changing issued authority', async t => {
  const {root, d, tick} = await fixture(t, '#/connections/add');
  const credentials = [
    {id: 'owner-device', label: 'Generated owner Mac', scope: 'owner', deviceId: 'mac'},
    {id: 'collector-device', label: 'Generated collector', scope: 'collector', deviceId: 'collector'},
    {id: 'reader', label: 'Generated read Agent', scope: 'mcp-read'},
    {id: 'writer', label: 'Generated write Agent', scope: 'mcp-write'},
  ].map(item => ({...item, createdAt: when, serverUrl: 'http://localhost', tokenHint: 'generated-only'}));
  const writes: {path: string; body?: unknown}[] = [];
  const api = apiWith((path, init) => {
    if (path === '/api/features') return {schemaVersion: 1, revision: 1, features: [], capabilities: []};
    if (path === '/api/connectors/status') return {};
    if (path === '/api/configuration') return {groups: []};
    if (path === '/api/connections') return {items: credentials, mcp: {enabled: true, writeEnabled: true, writeSourceIds: ['generated-source']}};
    writes.push({path, ...(init?.body ? {body: JSON.parse(String(init.body))} : {})});
    return {revoked: true};
  });
  const props = {api, devices: [], onPage: (page: string) => { location.hash = '#/' + webFeatures.page(page)!.route; }} as PageProps;
  const renderRoute = async (selector = '.connections') => {
    const entry = webFeatures.page(readPage(location.hash))!;
    assert.ok(entry, 'the user route is registered');
    await act(async () => root.render(React.createElement(React.Suspense, {fallback: 'Loading generated route'}, entry.render(props))));
    for (let i = 0; i < 40 && !d.querySelector(selector); i++) await tick();
  };
  await renderRoute('.discovery-source-catalog');
  const deviceCard = [...d.querySelectorAll<HTMLAnchorElement>('.discovery-source-card')].find(card => card.querySelector('h3')?.textContent === '手机与电脑')!;
  assert.equal(deviceCard.getAttribute('href'), '#/connections/pair');
  await act(async () => deviceCard.click()); await tick();
  assert.equal(readPage(location.hash), 'deviceConnections');
  assert.equal(primaryDestination('deviceConnections'), 'sources');
  await renderRoute();
  assert.equal(d.querySelector('h2')!.textContent, '连接设备');
  assert.ok(d.querySelector('[aria-label="设备权限"]'));
  assert.equal(d.querySelector('[aria-label="MCP 访问权限"]'), null);
  assert.match(d.querySelector('.connection-list')!.textContent!, /Generated owner Mac/);
  assert.match(d.querySelector('.connection-list')!.textContent!, /Generated collector/);
  assert.doesNotMatch(d.querySelector('.connection-list')!.textContent!, /Generated read Agent|Generated write Agent/);
  assert.deepEqual(writes, []);

  await act(async () => { location.hash = '#/connections/access'; }); await renderRoute();
  assert.equal(primaryDestination('connections'), 'connections');
  assert.equal(d.querySelector('h2')!.textContent, 'AI 接入');
  assert.equal(d.querySelector('[aria-label="设备权限"]'), null);
  assert.ok(d.querySelector('[aria-label="MCP 访问权限"]'));
  const list = d.querySelector('.connection-list')!;
  assert.match(list.textContent!, /Generated read Agent|Generated write Agent/);
  assert.doesNotMatch(list.textContent!, /Generated owner Mac|Generated collector/);
  assert.equal(d.querySelector<HTMLSelectElement>('[aria-label="MCP 访问权限"]')!.value, 'read');
  assert.ok(d.querySelector('.connection-help summary')!.textContent!.includes('规划中'));
  await act(async () => list.querySelector<HTMLButtonElement>('button')!.click());
  assert.deepEqual(writes, [], 'reviewing revocation does not revoke any authority');
  await act(async () => button(d, '确认撤销').click());
  assert.deepEqual(writes, [{path: '/api/connections/reader'}], 'the existing selected-credential revocation API is preserved');
});

for (const kind of ['anchor', 'strict'] as const) test(`a restored ${kind} conversation can clear its reference only between turns and submits both explicit nulls`, async t => {
  const conversationId = 'generated-' + kind;
  const {root, d, tick} = await fixture(t, '#/ask?' + new URLSearchParams({conversation: conversationId, questionDraft: 'Generated follow-up'}));
  const scope = kind === 'anchor' ? {anchorEvidenceIds: [captureId]} : {evidenceIds: [captureId]};
  const summary = {id: conversationId, title: 'Generated restored conversation', createdAt: when, updatedAt: when, turnCount: 1, scope, status: 'completed'};
  const detail = {...summary, revision: 1, nextCursor: null, turns: [{id: 'generated-turn', question: 'Generated original question', status: 'completed', createdAt: when, result: {runId: 'generated-old', answer: 'Generated original answer', trace: [], citations: []}}]};
  const completed = {id: 'generated-completed', status: 'completed', conversationId, createdAt: when, updatedAt: when, events: []};
  let accept!: (value: unknown) => void;
  const admission = new Promise(resolve => { accept = resolve; });
  const submissions: {input: Record<string, unknown>}[] = [], opened: string[] = [];
  const api = apiWith((path, init) => {
    if (path === '/api/conversations?limit=30') return {items: [summary]};
    if (path === '/api/conversations/' + conversationId) return detail;
    if (path === '/api/query-runs' && init?.method === 'POST') {
      submissions.push(JSON.parse(String(init.body)));
      return submissions.length === 1 ? admission : {id: 'generated-pending', status: 'running', conversationId, createdAt: when, updatedAt: when, events: []};
    }
    if (path === '/api/query-runs/generated-completed') return completed;
    if (path === '/api/query-runs/generated-pending') return new Promise(() => {});
    return {items: []};
  });
  await act(async () => root.render(React.createElement(Conversations, {api, configured: true, devices: [], renderAnswer: answer => answer.answer, onOpen: ref => opened.push(ref)})));
  const scopeBar = () => d.querySelector(kind === 'anchor' ? '[aria-label="参考记录"]' : '[aria-label="查询范围"]')!;
  const clearLabel = kind === 'anchor' ? '清除参考记录' : '清除范围';
  assert.ok(scopeBar());
  await act(async () => scopeBar().querySelector<HTMLButtonElement>('button')!.click());
  assert.deepEqual(opened, ['capture:' + captureId]);
  const submit = async () => { await act(async () => d.querySelector<HTMLTextAreaElement>('[aria-label="向 Mote 提问"]')!.closest('form')!.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}))); };
  await submit();
  assert.equal(submissions.length, 1);
  assert.equal(Object.hasOwn(submissions[0].input, 'anchorEvidenceIds'), false, 'an unchanged scope is inherited from the restored conversation');
  assert.equal(button(d, clearLabel).disabled, true, 'a pending admitted turn keeps its reference fixed');
  await act(async () => button(d, clearLabel).click());
  assert.doesNotMatch(scopeBar().textContent!, /全部资料/);
  await act(async () => accept(completed));
  assert.equal(button(d, clearLabel).disabled, false);
  await act(async () => button(d, clearLabel).click());
  assert.match(scopeBar().textContent!, /全部资料/);
  assert.match(d.querySelector('.conversation-messages')!.textContent!, /Generated original answer/, 'clearing the next turn does not rewrite historical answers');
  await act(async () => {
    location.hash = '#/ask?' + new URLSearchParams({conversation: conversationId, questionDraft: 'Generated unscoped follow-up'});
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  }); await tick();
  await submit();
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].input.conversationId, conversationId);
  assert.equal(submissions[1].input.anchorEvidenceIds, null);
  assert.equal(submissions[1].input.evidenceIds, null);
});
