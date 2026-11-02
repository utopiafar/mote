import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebFeatureHost } from '../src/features/host';
import { bootstrapPlugins, builtinInstance, teardownPlugins } from '../src/plugin-host/bootstrap';
import type { InstanceSnapshot } from '../src/plugin-host/contributions';

const page = (id: string) => ({ surface: 'page' as const, entry: { id, featureId: id, title: id, order: 0, render: () => null } });

test('desired+compatible snapshot mounts only admitted instances with observed outcomes', async () => {
  const host = new WebFeatureHost();
  const { reports } = await bootstrapPlugins(host, [
    builtinInstance('pkg.a', [page('a1')]),
    { ...builtinInstance('pkg.b', [page('b1')]), desired: 'inactive' },
    { ...builtinInstance('pkg.c', [page('c1')]), compatible: false },
  ]);
  assert.deepEqual(reports.map(r => r.outcome.observed), ['mounted', 'skipped', 'skipped']);
  assert.deepEqual(reports[1]!.outcome, { observed: 'skipped', reason: 'not-desired' });
  assert.deepEqual(reports[2]!.outcome, { observed: 'skipped', reason: 'incompatible' });
  assert.deepEqual(host.pages().map(p => p.id), ['a1']);
});

test('a failing plugin rolls back its scope with instance identity, siblings survive', async () => {
  const host = new WebFeatureHost();
  const { reports, scopes } = await bootstrapPlugins(host, [
    builtinInstance('pkg.good', [page('good')]),
    builtinInstance('pkg.bad', [page('shared'), page('shared')]),
  ]);
  assert.equal(reports[0]!.outcome.observed, 'mounted');
  const bad = reports[1]!.outcome;
  assert.equal(bad.observed, 'failed');
  if (bad.observed === 'failed') {
    assert.equal(bad.error.instanceId, 'builtin:pkg.bad');
    assert.equal(bad.error.pluginId, 'pkg.bad');
  }
  assert.deepEqual(host.pages().map(p => p.id), ['good'], 'no dead route left by the failed scope');
  assert.equal(scopes.get('builtin:pkg.bad')!.mounted, false);
});

test('external contributions need the isolated loader; unisolated ones never fake-mount', async () => {
  const host = new WebFeatureHost();
  const ext: InstanceSnapshot = { ...builtinInstance('pkg.ext', [page('x1')]), loader: 'external' };
  const { reports } = await bootstrapPlugins(host, [ext]);
  assert.deepEqual(reports[0]!.outcome, { observed: 'skipped', reason: 'unsupported-loader' });
  assert.equal(host.pages().length, 0);
  let mounts = 0;
  const { reports: ok } = await bootstrapPlugins(host, [ext], {
    isolatedLoaders: new Map([[ext.instanceId, { mount: scope => { mounts++; scope.defer(() => {}); } }]]),
  });
  assert.equal(ok[0]!.outcome.observed, 'mounted');
  assert.equal(mounts, 1);
  assert.equal(host.pages().length, 0, 'isolated mount does not register into the trusted registry');
});

test('rollback withdraws the scope contributions and a re-enable mounts fresh', async () => {
  const host = new WebFeatureHost();
  const inst = builtinInstance('pkg.re', [page('re1')]);
  const first = await bootstrapPlugins(host, [inst]);
  assert.equal(host.pages().length, 1);
  await first.scopes.get(inst.instanceId)!.rollback();
  assert.equal(host.pages().length, 0, 'revoked scope leaves no dead route');
  const second = await bootstrapPlugins(host, [inst]);
  assert.equal(second.reports[0]!.outcome.observed, 'mounted');
  assert.equal(host.pages().length, 1);
});

test('two instances of one package coexist and repeated mount is idempotent', async () => {
  const host = new WebFeatureHost();
  const inst = (id: string, pageId: string): InstanceSnapshot => ({ ...builtinInstance('pkg.shared', [page(pageId)]), instanceId: id, installationId: id });
  const { reports, scopes } = await bootstrapPlugins(host, [inst('inst.work', 'work-page'), inst('inst.personal', 'personal-page')]);
  assert.deepEqual(reports.map(r => r.outcome.observed), ['mounted', 'mounted']);
  assert.deepEqual(host.pages().map(p => p.id).sort(), ['personal-page', 'work-page']);
  const work = scopes.get('inst.work')!;
  assert.deepEqual(await work.mount(), { observed: 'mounted' }, 're-mount is idempotent, prior install kept');
  assert.equal(host.page('inst.work/work-page')?.id, 'work-page');
  await work.rollback();
  assert.deepEqual(host.pages().map(p => p.id), ['personal-page'], 'sibling instance untouched');
});

test('rollback awaits asynchronous cleanup including fiber disposal before remount', async () => {
  const host = new WebFeatureHost();
  const inst = builtinInstance('pkg.async', [page('async-page')]);
  const { scopes } = await bootstrapPlugins(host, [inst]);
  const scope = scopes.get(inst.instanceId)!;
  let released = false;
  scope.defer(async () => { await new Promise(r => setTimeout(r, 30)); released = true; });
  await scope.rollback();
  assert.equal(released, true, 'async disposer finished before rollback resolved');
  assert.equal(host.pages().length, 0, 'fiber disposal completed: no lingering route');
  const second = await bootstrapPlugins(host, [inst]);
  assert.equal(second.reports[0]!.outcome.observed, 'mounted', 'remount races nothing from the old scope');
});

test('identical component IDs across instances are namespaced and sibling survives rollback', async () => {
  const host = new WebFeatureHost();
  const inst = (id: string): InstanceSnapshot => ({ ...builtinInstance('pkg.dup', [page('notes')]), instanceId: id, installationId: `ext:${id}` });
  const { scopes } = await bootstrapPlugins(host, [inst('inst.one'), inst('inst.two')]);
  // Public entry.id stays declared for catalog matching; the qualified
  // descriptor key owns the route.
  assert.equal(host.page('inst.one/notes')?.id, 'notes');
  assert.equal(host.page('inst.two/notes')?.id, 'notes');
  await scopes.get('inst.one')!.rollback();
  assert.equal(host.page('inst.one/notes'), undefined);
  assert.equal(host.page('inst.two/notes')?.id, 'notes');
});

test('rollback reports cleanup failures and the teardown entrypoint releases scopes', async () => {
  const host = new WebFeatureHost();
  const inst = builtinInstance('pkg.td', [page('td-page')]);
  const { scopes } = await bootstrapPlugins(host, [inst]);
  const scope = scopes.get(inst.instanceId)!;
  let released = 0;
  scope.defer(() => { released++; });
  scope.defer(() => Promise.reject(new Error('cleanup boom')));
  const result = await teardownPlugins(scopes);
  assert.equal(released, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(host.pages().length, 0, 'teardown withdrew the registration');
});


test('local dependency references are rewritten to qualified descriptor IDs', async () => {
  const host = new WebFeatureHost();
  const inst: InstanceSnapshot = {
    ...builtinInstance('pkg.deps', [
      page('reader'),
      { surface: 'panel', entry: { id: 'reader-panel', featureId: 'deps', kind: 'mote.journal', schemaVersion: 1, representation: 'panel', requires: [{ id: 'page:reader', version: '1', host: 'local' }], render: () => null } },
    ]),
    instanceId: 'inst.dep', installationId: 'ext:inst.dep',
  };
  const { reports } = await bootstrapPlugins(host, [inst]);
  assert.equal(reports[0]!.outcome.observed, 'mounted');
  const registered = (host as any).registry.list('panel').map((r: any) => r.value.entry);
  assert.equal(registered[0]?.requires?.[0]?.id, 'page:inst.dep/reader', 'local dep rewritten to qualified id');
  assert.equal(host.page('inst.dep/reader')?.id, 'reader');
});

test('catalog-facing view ids stay declared for external instances', async () => {
  const host = new WebFeatureHost();
  const inst: InstanceSnapshot = {
    ...builtinInstance('pkg.cat', [
      { surface: 'renderer', entry: { id: 'fixture.journal-detail', featureId: 'cat', kind: 'mote.journal', schemaVersion: 1, representation: 'detail', render: () => null } },
    ]),
    instanceId: 'inst.cat', installationId: 'ext:inst.cat',
  };
  await bootstrapPlugins(host, [inst]);
  const views = host.views('renderer', { kind: 'mote.journal', schemaVersion: 1, representation: 'detail' });
  assert.equal(views.length, 1);
  assert.equal(views[0]!.id, 'fixture.journal-detail', 'catalog ID preserved for matching');
});

test('a throwing lifetime dispose does not strand sibling scopes on teardown', async () => {
  const host = new WebFeatureHost();
  const { scopes } = await bootstrapPlugins(host, [builtinInstance('pkg.s1', [page('s1')]), builtinInstance('pkg.s2', [page('s2')])]);
  const first = scopes.values().next().value!;
  (first.lifetime as unknown as { dispose: () => void }).dispose = () => { throw new Error('lifetime boom'); };
  const result = await teardownPlugins(scopes);
  assert.equal(result.errors.length, 1);
  assert.equal(host.pages().length, 0, 'sibling scope still released');
});


test('production bootstrap/teardown entrypoint owns and releases real scopes', async () => {
  const { featuresReady, featuresTeardown, featureScopes } = await import('../src/features/bootstrap');
  const { webFeatures } = await import('../src/features/registry');
  await featuresReady;
  assert.ok(featureScopes.size > 0, 'production bootstrap retains its scopes');
  assert.ok(webFeatures.pages().length > 0, 'builtin pages mounted through the same path');
  const result = await featuresTeardown();
  assert.equal(result.errors.length, 0);
  assert.equal(featureScopes.size, 0);
  assert.equal(webFeatures.pages().length, 0, 'teardown released every builtin registration');
});
