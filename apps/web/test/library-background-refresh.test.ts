import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { configureLocale, getLocale } from '@mote/shared/i18n';
import type { CaptureSession, WorkActivity } from '@mote/shared';
import { CaptureSessions } from '../src/plugins/library/CaptureSessions.js';
import { LibraryMaterials } from '../src/plugins/library/LibraryBrowse.js';
import { Notes } from '../src/plugins/notes/Notes.js';
import { WorkIssueNotice } from '../src/plugins/work/WorkIssueNotice.js';
import { ApiError } from '../src/api.js';
import { featuresReady } from '../src/features/bootstrap.js';
import { FeatureCollections } from '../src/features/runtime.js';
import { resources } from '../src/resource-cache.js';
import type { CollectionProps } from '../src/features/types.js';
import type { Api, Capture, MediaActivity } from '../src/api.js';

const when = '2026-10-14T01:00:00Z';
const session: CaptureSession = { id: 'generated-session', deviceId: 'generated-device', appId: 'generated.app', appName: 'Generated grouping', firstAt: when, capturedAt: when, after: when, before: '2026-10-14T01:01:00Z', count: 1, imageCount: 0 };
const devices = [{ deviceId: 'generated-device', deviceName: 'Generated device', platform: 'generated', status: 'online', queueDepth: 0, lastSeenAt: when }];
function deferred<T = any>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
async function fixture(t: import('node:test').TestContext) {
    await featuresReady;
    const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/#/library', pretendToBeVisual: true });
    const priorLocale = getLocale(), previous = new Map<string, PropertyDescriptor | undefined>();
    configureLocale(() => 'zh-CN');
    for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, location: dom.window.location, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    const root = createRoot(dom.window.document.getElementById('root')!);
    t.after(async () => {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
        configureLocale(() => priorLocale);
        dom.window.close();
    });
    return { root, d: dom.window.document, w: dom.window };
}
function apiWith(read: (path: string, init?: RequestInit) => unknown): Api {
    return { request: async (path: string, init?: RequestInit) => await read(path, init), setAgentTimeout: () => {} } as Api;
}
const collectionProps = (api: Api, revision = 0): CollectionProps => ({ api, revision, devices, range: {}, activity: { apps: [], devices: [], totalDurationMs: 0, captures: 0 }, onOpen: () => {} });
const media = (observations = 1): MediaActivity => ({ observations, totalDurationMs: 1000, screenLock: { locked: 0, unlocked: 1000, unknown: 0 }, visibility: { foreground: 1000, background: 0, unknown: 0 }, playbackType: { local: 1000, remote: 0, unknown: 0 }, apps: [{ appId: 'generated.app', appName: 'Generated player', durationMs: 1000, evidenceIds: [] }], devices: [] } as MediaActivity);
const note = { id: '11111111-1111-4111-8111-111111111111', capturedAt: when, deviceName: 'Generated device', ocrText: 'Generated note text' } as Capture;

for (const empty of [false, true]) test(`capture grouping keeps ${empty ? 'empty' : 'populated'} results during periodic refresh and clears changed scopes`, async t => {
    const { root, d, w } = await fixture(t), initial = deferred(), refresh = deferred(), changed = deferred();
    const reads: { path: string; signal?: AbortSignal }[] = [];
    const api = apiWith((path, init) => { reads.push({ path, signal: init?.signal as AbortSignal }); return reads.length === 1 ? initial.promise : reads.length === 2 ? refresh.promise : changed.promise; });
    const render = (revision: number) => act(async () => root.render(React.createElement(CaptureSessions, { api, devices, onOpen: () => {}, revision })));
    await render(0);
    assert.match(d.querySelector('[role="status"]')!.textContent!, /正在读取/);
    assert.equal(reads.length, 1);
    const value = { items: empty ? [] : [session], totalCount: empty ? 0 : 1, sessionCount: empty ? 0 : 1, nextCursor: null };
    await act(async () => initial.resolve(value));
    const stableNode = d.querySelector(empty ? '.workspace-empty' : '.session-card');
    assert.ok(stableNode);
    const status = d.querySelector('[role="status"]')!.textContent;
    await render(1);
    assert.equal(reads.length, 2);
    assert.equal(d.querySelector(empty ? '.workspace-empty' : '.session-card'), stableNode);
    assert.equal(d.querySelector('[role="status"]')!.textContent, status);
    assert.doesNotMatch(d.body.textContent!, /正在读取/);
    const device = d.querySelector<HTMLSelectElement>('.capture-session-filters select')!;
    await act(async () => { device.value = 'generated-device'; device.dispatchEvent(new w.Event('change', { bubbles: true })); });
    assert.equal(reads.length, 3, 'a filter change reads its new query once');
    assert.equal(reads[1].signal?.aborted, true, 'the superseded refresh cannot publish into another scope');
    assert.match(d.querySelector('[role="status"]')!.textContent!, /正在读取/);
    assert.equal(d.querySelector('.session-card'), null);
    await act(async () => refresh.resolve({ ...value, items: [session] }));
    assert.equal(d.querySelector('.session-card'), null, 'late results remain fenced');
    await act(async () => changed.resolve({ items: [], totalCount: 0, sessionCount: 0, nextCursor: null }));
    assert.ok(d.querySelector('.workspace-empty'));
});

for (const empty of [false, true]) test(`media collection keeps its ${empty ? 'empty' : 'populated'} mounted view during periodic refresh`, async t => {
    const { root, d } = await fixture(t), refresh = deferred();
    let reads = 0;
    const api = apiWith(path => { assert.ok(path.startsWith('/api/media-activity')); return ++reads === 1 ? media(empty ? 0 : 1) : refresh.promise; });
    const render = (revision: number) => act(async () => root.render(React.createElement(FeatureCollections, { selected: 'media', onSelect: () => {}, props: collectionProps(api, revision) })));
    await render(0);
    const result = d.querySelector(empty ? '.media-empty' : '.media-app-list');
    assert.ok(result);
    await render(1);
    assert.equal(reads, 2);
    assert.equal(d.querySelector(empty ? '.media-empty' : '.media-app-list'), result, 'revision updates the existing view without a React remount');
    assert.equal(d.querySelector('.loading'), null);
    await act(async () => refresh.resolve(media(1)));
    assert.match(d.querySelector('.media-app-list')!.textContent!, /Generated player/);
});

test('media rolling ranges retain data only within the same explicit time selection and authenticated API', async t => {
    const { root, d } = await fixture(t), first = deferred(), rolling = deferred(), changed = deferred();
    let reads = 0;
    const api = apiWith(() => [first.promise, rolling.promise, changed.promise][reads++]);
    const render = (after: string, rangeSelectionKey: string, currentApi = api) => act(async () => root.render(React.createElement(FeatureCollections, { selected: 'media', onSelect: () => {}, props: { ...collectionProps(currentApi), range: { after }, rangeSelectionKey } })));
    await render(when, 'today');
    assert.ok(d.querySelector('.loading'));
    await act(async () => first.resolve(media()));
    const result = d.querySelector('.media-app-list');
    await render('2026-10-14T02:00:00Z', 'today');
    assert.equal(d.querySelector('.media-app-list'), result);
    assert.equal(d.querySelector('.loading'), null);
    await render('2026-10-13T00:00:00Z', 'yesterday');
    assert.equal(d.querySelector('.media-app-list'), null);
    assert.ok(d.querySelector('.loading'));
    await act(async () => rolling.resolve(media()));
    assert.equal(d.querySelector('.media-app-list'), null);
    await act(async () => changed.resolve(media()));
    const otherApi = apiWith(() => new Promise(() => {}));
    await render('2026-10-13T00:00:00Z', 'yesterday', otherApi);
    assert.equal(d.querySelector('.media-app-list'), null);
    assert.ok(d.querySelector('.loading'));
});

test('library materials and application activity start once and refresh the existing empty result once', async t => {
    const { root, d } = await fixture(t), pending = deferred();
    const reads: string[] = [];
    const api = apiWith(path => { reads.push(path); return reads.length === 1 ? { schemaVersion: 1, types: [], sources: [], items: [], nextCursor: null } : pending.promise; });
    const render = (revision: number) => act(async () => root.render(React.createElement(LibraryMaterials, { api, revision, onSelect: () => {} })));
    await render(0);
    assert.equal(reads.length, 1, 'resource subscription owns the initial catalog request');
    const empty = d.querySelector('.empty');
    assert.ok(empty);
    await render(1);
    assert.equal(reads.length, 2);
    assert.equal(d.querySelector('.empty'), empty);
    assert.doesNotMatch(d.body.textContent!, /正在读取/);
    await act(async () => pending.resolve({ schemaVersion: 1, types: [], sources: [], items: [], nextCursor: null }));
    const activityReads: string[] = [], activityRefresh = deferred();
    const activityApi = apiWith(path => { activityReads.push(path); return activityReads.length === 1 ? { apps: [], devices: [], totalDurationMs: 0, captures: 0 } : activityRefresh.promise; });
    const renderActivity = (revision: number) => act(async () => root.render(React.createElement(FeatureCollections, { selected: 'activity', onSelect: () => {}, props: collectionProps(activityApi, revision) })));
    await renderActivity(0);
    assert.equal(activityReads.length, 1, 'resource subscription owns the initial application activity request');
    const content = d.querySelector('.activity-panel');
    assert.ok(content);
    const before = d.body.textContent;
    await renderActivity(1);
    assert.equal(activityReads.length, 2);
    assert.equal(d.body.textContent, before);
    assert.equal(d.querySelector('.activity-panel'), content);
    await act(async () => activityRefresh.resolve({ apps: [], devices: [], totalDurationMs: 0, captures: 0 }));
});

test('work issue guidance stays mounted while its known empty reason is refreshed', async t => {
    const { root, d } = await fixture(t), pending = deferred();
    let reads = 0;
    const api = apiWith(() => ++reads === 1 ? { steps: [], nextCursor: null } : pending.promise);
    const work = { id: 'generated-work', state: 'needs_input', technical: { operationIds: ['generated-operation'] } } as WorkActivity;
    await act(async () => root.render(React.createElement(WorkIssueNotice, { api, work })));
    const guidance = Array.from(d.querySelectorAll('.fine-print')).find(item => item.textContent?.includes('可继续查看下方补充问题'))!;
    assert.ok(guidance);
    await act(async () => resources(api).get('/api/operations/generated-operation?limit=100').refresh());
    assert.ok(guidance.isConnected);
    assert.doesNotMatch(d.body.textContent!, /正在读取等待原因/);
    await act(async () => pending.resolve({ steps: [], nextCursor: null }));
});

for (const empty of [false, true]) test(`notes keep their ${empty ? 'empty' : 'populated'} history during background refresh but still mark requested older pages`, async t => {
    const { root, d } = await fixture(t), initial = deferred(), refresh = deferred(), older = deferred();
    const reads: string[] = [];
    const api = apiWith(path => { reads.push(path); return reads.length === 1 ? initial.promise : reads.length === 2 ? refresh.promise : older.promise; });
    const render = (revision: number) => act(async () => root.render(React.createElement(Notes, { api, namespace: 'generated-node', revision, onOpen: () => {}, onSaved: () => {} })));
    await render(0);
    assert.match(d.querySelector('.notes-history')!.textContent!, /正在读取记录/);
    await act(async () => initial.resolve({ items: empty ? [] : [note], nextCursor: empty ? null : 'generated-older' }));
    const result = d.querySelector(empty ? '.notes-history .empty' : '.note-card');
    assert.ok(result);
    await render(1);
    assert.equal(d.querySelector(empty ? '.notes-history .empty' : '.note-card'), result);
    assert.doesNotMatch(d.querySelector('.notes-history')!.textContent!, /正在读取记录/);
    assert.equal(d.querySelector<HTMLTextAreaElement>('textarea')!.disabled, false, 'refresh does not lock the composer');
    await act(async () => refresh.resolve({ items: empty ? [] : [note], nextCursor: empty ? null : 'generated-older' }));
    if (!empty) {
        const more = Array.from(d.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === '加载更早的记录')!;
        await act(async () => more.click());
        assert.match(d.querySelector('.notes-history')!.textContent!, /正在读取记录/);
        assert.ok(d.querySelector('.note-card'));
        assert.match(reads.at(-1)!, /cursor=generated-older/);
        await act(async () => older.resolve({ items: [], nextCursor: null }));
    }
});

test('notes reload a changed local namespace and fence its previous history refresh', async t => {
    const { root, d } = await fixture(t), oldRefresh = deferred(), next = deferred();
    let reads = 0;
    const api = apiWith(() => ++reads === 1 ? { items: [note], nextCursor: null } : reads === 2 ? oldRefresh.promise : next.promise);
    const render = (namespace: string, revision: number) => act(async () => root.render(React.createElement(Notes, { api, namespace, revision, onOpen: () => {}, onSaved: () => {} })));
    await render('generated-first-node', 0);
    assert.ok(d.querySelector('.note-card'));
    await render('generated-first-node', 1);
    await render('generated-second-node', 1);
    assert.equal(reads, 3, 'a namespace change starts a replacement history read even at the same revision');
    assert.equal(d.querySelector('.note-card'), null);
    assert.match(d.querySelector('.notes-history')!.textContent!, /正在读取记录/);
    await act(async () => next.resolve({ items: [], nextCursor: null }));
    assert.ok(d.querySelector('.notes-history .empty'));
    await act(async () => oldRefresh.resolve({ items: [note], nextCursor: null }));
    assert.equal(d.querySelector('.note-card'), null);
});

for (const status of [401, 403, 404, 410, 503]) test(`notes ${status === 503 ? 'retain transiently unavailable' : 'withdraw denied'} history and keep retry scoped: ${status}`, async t => {
    const { root, d } = await fixture(t), refresh = deferred(), retry = deferred();
    let reads = 0;
    const api = apiWith(() => ++reads === 1 ? { items: [note], nextCursor: 'generated-older' } : reads === 2 ? refresh.promise : retry.promise);
    const render = (revision: number) => act(async () => root.render(React.createElement(Notes, { api, namespace: 'generated-node', revision, onOpen: () => {}, onSaved: () => {} })));
    await render(0);
    assert.ok(d.querySelector('.note-card'));
    await render(1);
    await act(async () => refresh.reject(new ApiError('Generated history read failure', status)));
    assert.match(d.querySelector('.notes-history [role="alert"]')!.textContent!, /Generated history read failure/);
    const denied = status !== 503;
    assert.equal(Boolean(d.querySelector('.note-card')), !denied);
    assert.equal(Boolean(Array.from(d.querySelectorAll('button')).find(item => item.textContent === '加载更早的记录')), !denied);
    await act(async () => d.querySelector<HTMLButtonElement>('.notes-history .section-heading button')!.click());
    assert.equal(Boolean(d.querySelector('.note-card')), !denied, 'retry never restores withdrawn cached records before a successful read');
    assert.equal(/正在读取记录/.test(d.querySelector('.notes-history')!.textContent!), denied);
    await act(async () => retry.resolve({ items: [], nextCursor: null }));
    assert.equal(d.querySelector('.note-card'), null);
    assert.ok(d.querySelector('.notes-history .empty'));
});
