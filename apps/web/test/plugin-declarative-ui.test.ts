import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeclarativeView, DeclarativeViewSession } from '../src/plugin-host/declarative-view';
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
