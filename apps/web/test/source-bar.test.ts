import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { connectionUri, type ConnectionInvitation, type SourceConnection } from '@mote/shared';
import { configureLocale } from '@mote/shared/i18n';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import type { Api, Device } from '../src/api.js';
import { SourceBar, type SourceBarFilter } from '../src/plugins/library/SourceBar.js';
import { useResource } from '../src/useResource.js';

const origin = 'https://generated.invalid';
const time = '2026-11-01T00:00:00.000Z';
const sync = { mode: 'interval', state: 'idle', intervalMinutes: 40, batchSize: 20, pendingRecords: 0 } as const;
const device = (deviceId: string, platform: string, fields: Partial<Device> = {}): Device => ({
    deviceId, deviceName: 'Generated ' + deviceId, platform, status: 'capturing', queueDepth: 0, lastSeenAt: time, ...fields,
});
const source = (id: string, fields: Partial<SourceConnection> = {}): SourceConnection => ({
    id, name: 'Generated ' + id, deviceId: 'generated-provider', platform: 'import', kind: 'mote.official.notion',
    enabled: true, retention: 'archive', createdAt: time, updatedAt: time, ...fields,
});
const paired = (id: string, deviceId: string, extra: { scope?: string; platform?: string; revokedAt?: string } = {}) => ({
    id, deviceId, deviceName: 'Generated ' + deviceId, label: 'Generated connection', platform: 'android',
    scope: 'owner', revokedAt: undefined as string | undefined, ...extra,
});

async function fixture(t: TestContext) {
    const dom = new JSDOM('<div id="root"></div>', {
        url: origin + '/#/library?deviceId=generated-filter', pretendToBeVisual: true,
    });
    const previous = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
        window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    configureLocale(() => 'zh-CN');
    const { createRoot } = await import('react-dom/client');
    const document = dom.window.document;
    const root = createRoot(document.getElementById('root')!);
    t.after(async () => {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        dom.window.close();
    });
    return { root, document, window: dom.window };
}

function generatedCentral() {
    const state = {
        devices: [] as Device[],
        offline: [] as string[],
        sources: [] as SourceConnection[],
        connections: [] as ReturnType<typeof paired>[],
        records: [] as { title: string; deviceId: string; sourceId?: string }[],
        nextRevocationFailure: undefined as string | undefined,
    };
    const writes: { path: string; method: string; body: unknown }[] = [];
    const loadedBrowse: string[] = [];
    const api = { request: async (path: string, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        const method = init.method ?? 'GET';
        if (method !== 'GET') writes.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'POST' && path === '/api/connections/invitations') {
            const invitation: ConnectionInvitation = {
                format: 'mote.connection', version: 1, serverUrl: origin, code: 'a'.repeat(43),
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
            };
            return { invitation, scope: 'owner', uri: connectionUri(invitation) };
        }
        if (method === 'DELETE' && path.startsWith('/api/connections/')) {
            const id = decodeURIComponent(path.slice('/api/connections/'.length));
            if (state.nextRevocationFailure === id) {
                state.nextRevocationFailure = undefined;
                throw Error('Generated revocation failure');
            }
            const connection = state.connections.find(connection => connection.id === id);
            assert.ok(connection);
            connection.revokedAt = time;
            return { revoked: true, id };
        }
        if (method === 'GET' && path === '/api/devices') return structuredClone({ items: state.devices, disconnectedDeviceIds: state.offline });
        if (method === 'GET' && path === '/api/sources') return structuredClone({ items: state.sources });
        if (method === 'GET' && path === '/api/connections') return { items: structuredClone(state.connections), mcp: { enabled: false } };
        if (method === 'GET' && path === '/api/configuration') return { domains: [] };
        if (method === 'GET' && path.startsWith('/api/library/browse?')) {
            loadedBrowse.push(path);
            const query = new URL(path, origin).searchParams;
            return { items: state.records.filter(row =>
                (!query.has('sourceId') || row.sourceId === query.get('sourceId')) &&
                (!query.has('deviceId') || row.deviceId === query.get('deviceId')),
            ) };
        }
        throw Error('Unexpected generated request ' + method + ' ' + path);
    } } as unknown as Api;
    return { api, state, writes, loadedBrowse };
}

function grab<T extends Element>(element: ParentNode, selector: string) {
    const found = element.querySelector<T>(selector);
    assert.ok(found, selector);
    return found;
}

const chip = (element: ParentNode, field: 'device' | 'source', id: string) =>
    grab<HTMLButtonElement>(element, `[data-${field}-id="${id}"] button[aria-pressed]`);
const click = (button: HTMLButtonElement) => act(async () => button.click());

test('LB1-01 shows reported pause and sync errors, with device options before external sources', async t => {
    const { root, document } = await fixture(t);
    const { api, state } = generatedCentral();
    state.devices = [
        device('phone', 'ios', { sync: { ...sync, state: 'waiting' } }),
        device('pixel', 'android', { status: 'paused' }),
        device('mac', 'macos'),
        device('import', 'import'),
    ];
    state.sources = [
        source('notion', { status: { state: 'syncing' } }),
        source('paused-service', { enabled: false }),
        source('failed-service', { status: { state: 'error' } }),
        source('manual-import', { kind: 'upload' }),
        source('local-file', { kind: 'local-files', platform: 'macos', deviceId: 'mac' }),
    ];
    const localDevice = { deviceId: 'mac', content: React.createElement('button', { id: 'current-mac' }, 'Generated local Mac') };
    await act(async () => root.render(React.createElement(SourceBar, { api, serverUrl: origin, onFilterChange: () => {}, localDevice })));
    const bar = grab(document, '.library-source-bar');
    assert.deepEqual([...bar.children].slice(1, -1).map(element =>
        (element as HTMLElement).dataset.deviceId ?? (element as HTMLElement).dataset.sourceId ?? element.id,
    ), ['current-mac', 'pixel', 'phone', 'notion', 'paused-service', 'failed-service']);
    assert.deepEqual([...bar.querySelectorAll<HTMLElement>('[data-source-status]')].map(status => status.dataset.sourceStatus),
        ['paused', 'paused', 'error']);
    assert.equal(chip(bar, 'device', 'phone').querySelector('small'), null);
    assert.equal(chip(bar, 'source', 'notion').querySelector('small'), null);
});

test('LB1-02 selects exact Library source and device scopes and keeps settings separate from selection', async t => {
    const { root, document, window } = await fixture(t);
    const { api, state, loadedBrowse } = generatedCentral();
    state.devices = [device('generated-filter', 'macos')];
    state.sources = [source('generated-filter')];
    state.records = [
        { title: 'Generated Mac note', deviceId: 'generated-filter' },
        { title: 'Generated service document', deviceId: 'provider', sourceId: 'generated-filter' },
        { title: 'Generated other record', deviceId: 'other', sourceId: 'other' },
    ];

    function LibraryFixture() {
        const [filter, setFilter] = useState<SourceBarFilter>();
        const query = new URLSearchParams({ limit: '24' });
        if (filter?.deviceId) query.set('deviceId', filter.deviceId);
        if (filter?.sourceId) query.set('sourceId', filter.sourceId);
        const { data } = useResource<{ items: typeof state.records }>(api, '/api/library/browse?' + query);
        return React.createElement(React.Fragment, null,
            React.createElement(SourceBar, { api, serverUrl: origin, filter, onFilterChange: setFilter }),
            React.createElement('ul', null, data?.items.map(item => React.createElement('li', { key: item.title }, item.title))),
        );
    }
    const titles = () => [...document.querySelectorAll('li')].map(item => item.textContent);
    await act(async () => root.render(React.createElement(LibraryFixture)));
    const bar = grab(document, '.library-source-bar');
    assert.equal(titles().length, 3);
    await click(chip(bar, 'source', 'generated-filter'));
    assert.deepEqual(titles(), ['Generated service document']);
    const settings = grab<HTMLButtonElement>(bar, '[data-device-id] button[aria-haspopup="dialog"]');
    await click(settings);
    const dialog = grab(document, '[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.deepEqual(titles(), ['Generated service document']);
    await act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, settings);
    await click(chip(bar, 'device', 'generated-filter'));
    assert.deepEqual(titles(), ['Generated Mac note']);
    assert.equal(chip(bar, 'device', 'generated-filter').getAttribute('aria-pressed'), 'true');
    await click(grab(bar, 'button'));
    assert.equal(titles().length, 3);
    assert.deepEqual(loadedBrowse, [
        '/api/library/browse?limit=24',
        '/api/library/browse?limit=24&sourceId=generated-filter',
        '/api/library/browse?limit=24&deviceId=generated-filter',
        '/api/library/browse?limit=24',
    ]);
});

test('LB1-01 updates from device heartbeats while settings keep pause, resume and sync on the device', async t => {
    const { root, document } = await fixture(t);
    const { api, state, writes } = generatedCentral();
    state.devices = [device('phone', 'android', { sync }), device('mac', 'macos')];
    state.connections = [paired('phone-owner', 'phone')];
    const render = (revision: number) => act(async () =>
        root.render(React.createElement(SourceBar, { api, serverUrl: origin, revision, onFilterChange: () => {} })));
    await render(0);
    const status = () => [...document.querySelectorAll<HTMLElement>('.library-source-bar [data-source-status]')];
    assert.deepEqual(status(), []);
    await click(grab(document, '[data-device-id="phone"] button[aria-haspopup="dialog"]'));
    const settings = grab(document, '.device-settings');
    const interval = grab(settings, 'dd').textContent;
    assert.ok(interval);
    assert.equal(settings.querySelector('select, input, [role="switch"]'), null);
    assert.equal(settings.querySelectorAll('button').length, 1, 'the paired device has only the remove action');
    assert.ok(grab(settings, '.field-note').textContent?.trim());

    state.devices[0] = device('phone', 'android', { status: 'paused', sync });
    await render(1);
    assert.deepEqual(status().map(label => label.dataset.sourceStatus), ['paused']);
    assert.equal(grab<HTMLElement>(chip(document, 'device', 'phone'), '[data-source-status]').dataset.sourceStatus, 'paused');

    state.devices[0] = device('phone', 'android', { sync: { ...sync, mode: 'manual' } });
    await render(2);
    assert.notEqual(grab(settings, 'dd').textContent, interval);
    assert.deepEqual(status(), []);
    assert.deepEqual(writes, []);
});

test('LB1-04 reuses the pairing form, observes redemption and joins the first heartbeat by device ID', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { root, document, window } = await fixture(t);
    const { api, state, writes } = generatedCentral();
    state.devices = [device('generated-filter', 'macos')];
    const render = (revision: number) => act(async () =>
        root.render(React.createElement(SourceBar, { api, serverUrl: origin, revision, onFilterChange: () => {} })));
    await render(0);
    const add = grab<HTMLButtonElement>(document, '.library-source-bar > button[aria-haspopup="dialog"]');
    await click(add);
    const dialog = grab(document, '[role=dialog]');
    const form = grab(dialog, '.device-pair-form');
    const [scope, identity] = form.querySelectorAll('select');
    assert.equal(scope.value, 'owner');
    assert.equal(identity.value, '', 'an active Library filter does not pre-bind the invitation');
    const label = grab<HTMLInputElement>(form, 'input').value;
    await click(grab(form, '.device-pair-actions .primary'));
    assert.deepEqual(writes, [{
        method: 'POST', path: '/api/connections/invitations',
        body: { serverUrl: origin, label },
    }]);
    assert.equal(JSON.parse(grab<HTMLTextAreaElement>(dialog, 'textarea').value).format, 'mote.connection');
    assert.equal(document.querySelector('[data-device-id="paired-phone"]'), null);

    state.connections = [paired('paired-id', 'paired-phone')];
    await act(async () => t.mock.timers.tick(3_000));
    assert.equal(chip(document, 'device', 'paired-phone').querySelector('[data-source-status]'), null);
    await click(grab(dialog, 'header button'));
    assert.equal(window.location.hash, '#/library?deviceId=generated-filter');
    assert.equal(document.activeElement, add);

    state.devices.push(device('paired-phone', 'android', { status: 'paused' }));
    await render(1);
    assert.equal(document.querySelectorAll('[data-device-id="paired-phone"]').length, 1);
    assert.equal(grab<HTMLElement>(chip(document, 'device', 'paired-phone'), '[data-source-status]').dataset.sourceStatus, 'paused');
});

test('LB1-05 consumes Central contact loss and recovery without inferring a deadline in the browser', async t => {
    const { root, document } = await fixture(t);
    const { api, state } = generatedCentral();
    state.devices = [
        device('lost-contact', 'android', { sync }),
        device('manual', 'android', { sync: { ...sync, mode: 'manual' } }),
        device('unreported', 'android'),
        device('sends-error', 'macos', { sync: { ...sync, state: 'error' } }),
        device('reported-offline', 'ios', { status: 'offline' }),
    ];
    const render = (revision: number) => act(async () =>
        root.render(React.createElement(SourceBar, { api, serverUrl: origin, revision, onFilterChange: () => {} })));
    const status = (id: string) => chip(document, 'device', id).querySelector<HTMLElement>('[data-source-status]')?.dataset.sourceStatus;
    await render(0);
    assert.equal(status('lost-contact'), undefined, 'an old timestamp alone is not a Central offline signal');

    state.offline = ['lost-contact'];
    await render(1);
    for (const id of ['lost-contact', 'reported-offline']) {
        assert.equal(status(id), 'offline');
    }
    assert.equal(status('sends-error'), 'error');
    assert.equal(status('manual'), undefined);
    assert.equal(status('unreported'), undefined);

    state.offline = [];
    await render(2);
    assert.equal(status('lost-contact'), undefined);
    assert.equal(status('reported-offline'), 'offline');
});

test('device removal confirms exact credentials, refreshes partial failure and leaves archived reports intact', async t => {
    const { root, document } = await fixture(t);
    const { api, state, writes } = generatedCentral();
    state.devices = [device('phone', 'android'), device('other', 'android')];
    state.connections = [
        paired('phone-owner', 'phone'), paired('phone-collector', 'phone', { scope: 'collector' }),
        paired('other-owner', 'other'), paired('unrelated-token', 'phone', { scope: 'developer' }),
    ];
    state.nextRevocationFailure = 'phone-collector';
    const filters: (SourceBarFilter | undefined)[] = [];
    await act(async () => root.render(React.createElement(SourceBar, {
        api, serverUrl: origin, filter: { deviceId: 'phone' }, onFilterChange: filter => filters.push(filter),
    })));
    await click(grab(document, '[data-device-id="phone"] button[aria-haspopup="dialog"]'));
    const settings = grab(document, '.device-settings');
    await click(grab(settings, 'button'));
    assert.deepEqual(writes, []);
    await click(grab(settings, '.button.danger'));
    assert.ok(settings.querySelector('[role=alert]'));
    assert.equal(filters.length, 0);
    assert.ok(chip(document, 'device', 'phone'));
    await click(grab(settings, 'button'));
    await click(grab(settings, '.button.danger'));
    assert.deepEqual(writes.map(write => write.path), [
        '/api/connections/phone-owner', '/api/connections/phone-collector', '/api/connections/phone-collector',
    ]);
    assert.deepEqual(filters, [undefined]);
    assert.equal(document.querySelector('[role=dialog]'), null);
    assert.equal(document.querySelector('[data-device-id="phone"]'), null);
    assert.ok(chip(document, 'device', 'other'));
    assert.deepEqual(state.devices.map(device => device.deviceId), ['phone', 'other']);
});
