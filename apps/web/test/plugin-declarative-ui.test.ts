import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeclarativeView, DeclarativeViewSession, DeclarativeView, serializeFormInput } from '../src/plugin-host/declarative-view';
import type { UiContributionDescriptor } from '@mote/shared/plugin-ui';
import {decodeWorkspaceView,workspacePath} from '../src/plugins/assistant-workbench';

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

test('workbench decoding rejects new layouts and forged command references, and preserves an empty scope',()=>{
  const request={template:'reading' as const,scope:{kind:'selection' as const,sourceIds:[]}};
  const value={request,descriptor:descriptor(['refresh']),spec:{components:[{type:'status',state:'empty',textKey:'empty'}]},data:{files:[]},commands:[{id:'refresh',apiVersion:'1'}]};
  assert.deepEqual(decodeWorkspaceView(JSON.parse(JSON.stringify(value))).request.scope,request.scope);
  assert.deepEqual(JSON.parse(new URLSearchParams(workspacePath(request).split('?')[1]).get('request')!).scope,request.scope);
  assert.throws(()=>decodeWorkspaceView({...value,request:{...request,template:'script'}}));
  assert.throws(()=>decodeWorkspaceView({...value,request:{...request,queryRef:'anything'}}));
  assert.throws(()=>decodeWorkspaceView({...value,spec:{components:[{type:'script',source:'generated()'}]}}),/unknown component|Invalid object fields/);
  assert.throws(()=>decodeWorkspaceView({...value,spec:{components:[{type:'action',command:'send-message',labelKey:'send'}]}}),/undeclared/);
  assert.throws(()=>decodeWorkspaceView({...value,commands:[{id:'refresh',apiVersion:'2'}]}));
  assert.throws(()=>decodeWorkspaceView({...value,commands:[]}),/command directory/);
  assert.throws(()=>decodeWorkspaceView({...value,commands:[{id:'refresh',apiVersion:'1',url:'https://generated.example/script'}]}));
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

test('plugins-domain adapter emits only allowed actions and the real invoker carries id+revision', async () => {
  const { pluginInstanceDescriptor, pluginInstanceSpec, pluginInstanceInvoker } = await import('../src/features/runtime');
  const instance = { id: 'inst:one', packageId: 'pkg.x', name: 'One', revision: 7, scope: 'owner', desired: true, observed: 'enabled', allowedActions: ['enable', 'disable'], issues: [], capabilities: [] } as any;
  const spec = pluginInstanceSpec(instance);
  const actions = spec.components.filter(c => c.type === 'action').map(c => c.command);
  assert.deepEqual(actions, ['enable', 'disable'], 'check is not DOMAIN-allowed');
  const session = new DeclarativeViewSession(pluginInstanceDescriptor(instance), spec, pluginInstanceInvoker(instance, (path, revision) => { calls.push([path, revision]); }));
  const calls: [string, number][] = [];
  session.lifetime.show();
  assert.deepEqual(await session.command('enable'), { ok: true, value: undefined });
  assert.deepEqual(calls, [['/api/plugin-instances/inst%3Aone/enable', 7]], 'the precise revision-carried path is issued');
  assert.deepEqual(await session.command('check'), { ok: false, reason: 'undeclared' });
  assert.equal(calls.length, 1, 'undeclared action never fires');
});


test('PluginInstanceSurface renders localized scope/state and never raw keys', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const { PluginInstanceSurface } = await import('../src/features/runtime');
  const instance = { id: 'inst:one', packageId: 'pkg.x', name: 'One', revision: 7, scope: 'owner', desired: true, observed: 'enabled', allowedActions: ['enable', 'disable'], issues: [], capabilities: [] } as any;
  const markup = renderToStaticMarkup(createElement(PluginInstanceSurface, {
    instance, busy: false, command: () => {},
    stateLabel: (o: string) => o === 'enabled' ? '已启用' : '未启用',
    labels: { scope: '范围', state: '状态', enable: '启用', disable: '停用' },
  }));
  assert.match(markup, /范围/, 'localized scope label renders');
  assert.match(markup, /状态/, 'localized state label renders');
  assert.match(markup, /已启用/, 'observed renders through the localized state label');
  assert.doesNotMatch(markup, /scope|enabled/, 'no raw wire keys or raw observed leak into the surface');
});
