import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {configureLocale, getLocale} from '@mote/shared/i18n';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {materialId, type MaterialDraft} from '../../server/src/materials.js';
import {ApiError, createApi, type Api} from '../src/api.js';
import {MaterialDetail, type Material} from '../src/Materials.js';
import {featuresReady} from '../src/features/bootstrap.js';
import {resources} from '../src/resource-cache.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

async function settle(check: () => boolean) {
  for (let attempt = 0; attempt < 80 && !check(); attempt++) {
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  }
  assert.ok(check(), 'the generated Material route did not settle in the real detail view');
}

async function fixture(t: TestContext) {
  await featuresReady;
  const directory = await mkdtemp(join(tmpdir(), 'mote-web-material-contract-'));
  const token = 'generated-material-contract-owner';
  const config: Config = {dataDir: directory, token, tokenPath: 'fixture', host: '127.0.0.1', port: 0,  maxExportBytes: 1_000_000,  insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent'};
  let node: Awaited<ReturnType<typeof buildApp>> | undefined;
  let root: ReturnType<typeof createRoot> | undefined;
  let dom: JSDOM | undefined;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const previousLocale = getLocale();
  t.after(async () => {
    if (root) await act(async () => root!.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    configureLocale(() => previousLocale);
    dom?.window.close();
    await node?.app.close();
    await rm(directory, {recursive: true, force: true});
  });
  node = await buildApp(config, {backgroundWorker: false, agent: {configured: false, query: async () => { throw Error('No model work belongs in this generated Material contract'); }, close: async () => {}}});
  node.materialOrganizer.tick = async () => 0;
  const sourceId = 'generated-material-source';
  node.sources.register({id: sourceId, name: 'Generated source name', kind: 'custom', deviceId: 'generated-phone', platform: 'android', retention: 'snapshot'});
  const original = await node.sources.upsert(sourceId, {externalId: 'generated-original', revision: 'source-v1', observedAt: '2026-10-01T10:00:00.000Z', title: 'Generated original title', kind: 'message', layer: 'snapshot', text: 'Generated original evidence', deleted: false});
  const draft = (text: string): MaterialDraft => ({id: materialId(sourceId, 'generated-document'), kind: 'mote.generated-document', schemaVersion: 1, title: 'Generated Material title', origin: {sourceId, externalId: 'generated-document', deviceId: 'generated-phone'}, members: [{id: 'original', kind: 'capture', ref: 'capture:' + original.id}], blocks: [{id: 'body', kind: 'text', format: 'plain', text, memberIds: ['original']}], coverage: {state: 'complete'}, fidelity: {state: 'derived'}, retention: {original: 'retained', policy: 'keep'}});
  const first = node.materials.publish(draft('Generated first page. ' + 'a'.repeat(4100) + ' Generated final page.'));
  const reads: {path: string; status: number; signal?: AbortSignal | null}[] = [];
  let hold: ((path: string, response: Response) => Promise<Response> | undefined) | undefined;
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit = {}) => {
    const response = await node!.app.inject({method: (init.method ?? 'GET') as 'GET' | 'POST', url: path, headers: Object.fromEntries(new Headers(init.headers)), ...(init.body ? {payload: String(init.body)} : {})});
    reads.push({path, status: response.statusCode, signal: init.signal});
    const serialized = new Response(response.body, {status: response.statusCode, headers: {'content-type': String(response.headers['content-type'] ?? ''), 'x-request-id': String(response.headers['x-request-id'] ?? '')}});
    return hold?.(path, serialized) ?? serialized;
  });
  dom = new JSDOM('<!doctype html><div id="root"></div>', {url: 'http://localhost/#/library', pretendToBeVisual: true});
  configureLocale(() => 'zh-CN');
  for (const [key, value] of Object.entries({window: dom.window, document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true})) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  root = createRoot(dom.window.document.getElementById('root')!);
  const opened: string[] = [];
  const render = (api: Api, material: Material = first) => act(async () => root!.render(React.createElement(MaterialDetail, {key: material.ref, api, material, onOpen: ref => opened.push(ref)})));
  const button = (text: string) => Array.from(dom!.window.document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!;
  return {node, token, sourceId, original, first, draft, reads, opened, render, button, d: dom.window.document, hold: (value?: typeof hold) => { hold = value; }};
}

test('real Material responses drive revision-pinned body continuation and exact source navigation in the Web detail view', async t => {
  const f = await fixture(t), api = createApi({token: f.token});
  const selected = await api.request<Material>('/api/materials/' + f.first.id);
  assert.equal(selected.ref, f.first.ref);
  assert.equal(selected.revision, f.first.revision);
  assert.equal(selected.memorySource?.status, 'ready');
  await f.render(api, selected);
  await settle(() => f.d.body.textContent!.includes('Generated first page.'));
  assert.equal(f.d.querySelector('h2')?.textContent, f.first.title);
  assert.equal(f.d.body.textContent!.includes('Generated final page.'), false);
  await act(async () => f.button('继续展开').click());
  await settle(() => f.d.body.textContent!.includes('Generated final page.'));
  assert.equal(f.d.body.textContent!.includes('Generated first page.'), false, 'continuation replaces the displayed body range');
  assert.ok(f.reads.some(read => read.path.includes('revision=' + f.first.revision) && read.path.includes('offset=4000') && read.status === 200));
  assert.equal(f.button('继续展开'), undefined, 'the real null continuation ends pagination');
  await act(async () => f.button('返回第一页').click());
  await settle(() => f.d.body.textContent!.includes('Generated first page.'));
  const current = f.node.materials.publish(f.draft('Generated replacement revision.'), {expectedRevision: f.first.revision});
  await f.render(createApi({token: f.token}), selected);
  await settle(() => f.d.body.textContent!.includes('这是历史版本'));
  assert.ok(f.d.body.textContent!.includes('Generated first page.'));
  assert.equal(f.d.body.textContent!.includes('Generated replacement revision.'), false);
  await act(async () => f.button('查看当前版本').click());
  assert.deepEqual(f.opened, [current.ref]);
  await act(async () => f.button('来源与处理').click());
  await settle(() => f.d.body.textContent!.includes('capture:' + f.original.id));
  assert.ok(f.d.body.textContent!.includes('Generated source name'));
  await act(async () => f.button('查看原始记录').click());
  assert.deepEqual(f.opened, [current.ref, 'capture:' + f.original.id]);
  assert.ok(f.reads.some(read => read.path.includes('/members?revision=' + f.first.revision) && read.status === 200));
});

test('real owner denial withdraws Material text, fences a late successful read, and permits a verified retry', async t => {
  const f = await fixture(t), owner = createApi({token: f.token}), pending = deferred<void>(), started = deferred<void>();
  await f.render(owner);
  await settle(() => f.d.body.textContent!.includes('Generated first page.'));
  const readPath = f.reads.find(read => read.path.includes('/read?'))!.path;
  f.hold((path, response) => {
    if (!path.includes('/read?')) return;
    started.resolve();
    return pending.promise.then(() => response);
  });
  await act(async () => resources(owner).get(readPath).refresh());
  await started.promise;
  const lateRead = f.reads.filter(read => read.path.includes('/read?')).at(-1)!;
  assert.ok(f.d.body.textContent!.includes('Generated first page.'), 'the active owner keeps the current body during its background read');
  const ownerHeaders = {authorization: 'Bearer ' + f.token};
  const invitation = await f.node.app.inject({method: 'POST', url: '/api/connections/collector-invitations', headers: ownerHeaders, payload: {serverUrl: 'https://generated.invalid', label: 'Generated limited reader'}});
  assert.equal(invitation.statusCode, 200, invitation.body);
  const redeemed = await f.node.app.inject({method: 'POST', url: '/api/connections/redeem', payload: {code: invitation.json().invitation.code, deviceId: 'generated-limited-phone', deviceName: 'Generated phone', platform: 'android'}});
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  assert.equal(redeemed.json().scope, 'collector');
  let unauthorized = 0;
  const limited = createApi({token: redeemed.json().token}, () => unauthorized++);
  f.hold();
  await f.render(limited);
  assert.equal(f.d.body.textContent!.includes('Generated first page.'), false, 'changing identity withdraws the previous owner body immediately');
  await settle(() => Boolean(f.d.querySelector('[role="alert"]')));
  assert.equal(lateRead.signal?.aborted, true);
  await assert.rejects(limited.request('/api/materials/' + f.first.id), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.match(error.requestId!, /^[a-f0-9-]{36}$/);
    return true;
  });
  await act(async () => pending.resolve());
  assert.equal(f.d.body.textContent!.includes('Generated first page.'), false, 'an old successful owner response cannot restore data in a denied identity');
  assert.equal(unauthorized, 0, 'a collector permission failure does not clear its authenticated connection');
  const invalid = createApi({token: 'generated-invalid-token'}, () => unauthorized++);
  await assert.rejects(invalid.request('/api/materials/' + f.first.id), error => error instanceof ApiError && error.status === 401);
  assert.equal(unauthorized, 1);
  await f.render(createApi({token: f.token}));
  await settle(() => f.d.body.textContent!.includes('Generated first page.'));
  assert.equal(f.d.querySelector('[role="alert"]'), null);
});
