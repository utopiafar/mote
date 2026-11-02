import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeclarativeView, DeclarativeViewSession, DeclarativeView, serializeFormInput } from '../src/plugin-host/declarative-view';
import type { UiContributionDescriptor } from '@mote/shared/plugin-ui';

const descriptor = (commands = ['save']): UiContributionDescriptor => ({
  id: 'v1', kind: 'declarative-view', apiVersion: '1', platforms: ['web'],
  presentation: { labelKey: 'v', i18nNamespace: 'test' },
  commands: commands.map(id => ({ id, apiVersion: '1' })),
});

test('strict parsing rejects unknown components, executables, oversized arrays and undeclared commands', () => {
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'script' }] }, descriptor()), /unknown component/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'action', command: 'rm' }] }, descriptor()), /undeclared action command/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'form', fields: [{ key: 'a', input: 'text' }], submitCommand: 'rm' }] }, descriptor()), /undeclared submitCommand/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'list', itemKey: 'i', fields: Array(40).fill({ key: 'a' }) }] }, descriptor()), /Invalid array|too large/);
  const evil = { components: [{ type: 'action', command: 'save' }] };
  Object.defineProperty(evil.components[0], 'labelKey', { get: () => { throw new Error('must not execute'); } });
  assert.throws(() => parseDeclarativeView(evil, descriptor()), /Invalid object fields/, 'accessor payloads are rejected, never executed');
});

test('a valid spec parses with the declared state and action surfaces', () => {
  const spec = parseDeclarativeView({ components: [
    { type: 'status', state: 'pending', textKey: 'loading' },
    { type: 'list', itemKey: 'items', fields: [{ key: 'name' }, { key: 'count', format: 'number' }] },
    { type: 'action', command: 'save', labelKey: 'save' },
  ] }, descriptor());
  assert.equal(spec.components.length, 3);
});

test('commands resolve declared ids only and stale generations drop late results', async () => {
  const spec = parseDeclarativeView({ components: [{ type: 'action', command: 'save' }] }, descriptor());
  let calls = 0;
  let release!: (v: unknown) => void;
  const gate = new Promise(r => { release = r; });
  const session = new DeclarativeViewSession(descriptor(), spec, async cmd => { calls++; await gate; return 'done'; });
  assert.deepEqual(await session.command('unknown'), { ok: false, reason: 'undeclared' });
  assert.equal(calls, 0);
  session.lifetime.show();
  const pending = session.command('save');
  session.lifetime.suspend();
  release('done');
  assert.deepEqual(await pending, { ok: false, reason: 'stale' }, 'hidden view drops the late answer');
  assert.equal(calls, 1);
});

test('scalar metadata is strictly typed: wrong types and accessor-free function values are rejected', () => {
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'form', fields: [{ key: 'a', input: 'text', required: 'false' }] }] }, descriptor()), /required must be boolean/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'action', command: 'save', labelKey: {} }] }, descriptor()), /labelKey must be a token string/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'status', state: 'pending', textKey: () => 'x' }] }, descriptor()), /textKey must be a token string/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'status', state: 'pending', onClick: 'x' }] }, descriptor()), /Invalid object fields/);
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'form', fields: [{ key: 'a' }] }] }, descriptor()), /invalid form field/, 'missing input is rejected, not defaulted');
  assert.throws(() => parseDeclarativeView({ components: [{ type: 'status', state: 'PENDING' }] }, descriptor()), /unknown state/, 'uppercase wire state is rejected');
});

test('serializeFormInput produces typed payloads for checked, unchecked, numeric and empty fields', () => {
  const elements: Record<string, unknown> = {
    enabled: { value: 'on', checked: true },
    disabled: { value: 'on', checked: false },
    count: { value: '3' },
    missing: { value: '' },
    name: { value: 'hi' },
  };
  const fields = [
    { key: 'enabled', input: 'boolean' }, { key: 'disabled', input: 'boolean' },
    { key: 'count', input: 'number' }, { key: 'missing', input: 'number' }, { key: 'name', input: 'text' },
  ] as const;
  const input = serializeFormInput({ elements: { namedItem: (k: string) => elements[k] } }, fields as never);
  assert.deepEqual(input, { enabled: true, disabled: false, count: 3, missing: undefined, name: 'hi' });
});

test('list rendering shows pending for absent data and error for malformed arrays without crashing', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const spec = parseDeclarativeView({ components: [{ type: 'list', itemKey: 'items', fields: [{ key: 'n' }] }] }, descriptor());
  const session = new DeclarativeViewSession(descriptor(), spec, async () => null);
  const t = (k: string) => k;
  const pending = renderToStaticMarkup(createElement(DeclarativeView, { session, translate: t }));
  assert.match(pending, /pending/, 'absent data renders the pending state');
  const malformed = renderToStaticMarkup(createElement(DeclarativeView, { session, data: { items: 'not-an-array' }, translate: t }));
  assert.match(malformed, /error/, 'a malformed array renders the error state');
  const empty = renderToStaticMarkup(createElement(DeclarativeView, { session, data: { items: [] }, translate: t }));
  assert.match(empty, /empty/, 'an empty array renders the empty state');
});

test('a command rejected in an old generation reports stale, not failed', async () => {
  const spec = parseDeclarativeView({ components: [{ type: 'action', command: 'save' }] }, descriptor());
  let reject!: (e: unknown) => void;
  const gate = new Promise((_, r) => { reject = r; });
  const session = new DeclarativeViewSession(descriptor(), spec, async () => { await gate; throw new Error('late'); });
  session.lifetime.show();
  const pending = session.command('save');
  session.lifetime.suspend();
  reject(new Error('late'));
  assert.deepEqual(await pending, { ok: false, reason: 'stale' }, 'late rejection stays stale');
});

test('the desktop mirror accepts the same fixture with full field metadata', async () => {
  const { parseDesktopDeclarative } = await import('../../desktop/src/plugin-host/declarative-view');
  const fixture = { components: [
    { type: 'status', state: 'pending', textKey: 'loading' },
    { type: 'list', itemKey: 'items', fields: [{ key: 'name', labelKey: 'name', format: 'text' }] },
    { type: 'form', fields: [{ key: 'enabled', input: 'boolean', required: true, labelKey: 'enabled' }], submitCommand: 'save' },
    { type: 'action', command: 'save', labelKey: 'save' },
  ] };
  const parsed = parseDesktopDeclarative(fixture, descriptor());
  assert.equal(parsed.length, 4);
  const list = parsed[1] as { fields: readonly { key: string; labelKey?: string }[] };
  assert.equal(list.fields[0]?.labelKey, 'name', 'field metadata preserved');
  const form = parsed[2] as { submitCommand?: string; fields: readonly { input: string }[] };
  assert.equal(form.submitCommand, 'save');
  assert.equal(form.fields[0]?.input, 'boolean');
  assert.throws(() => parseDesktopDeclarative({ components: [{ type: 'status', state: 'pending', input: 'x' }] }, descriptor()), /Invalid object fields/, 'component-level field keys rejected');
});
