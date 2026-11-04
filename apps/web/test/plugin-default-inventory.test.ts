import test from 'node:test';
import assert from 'node:assert/strict';
import {WebFeatureHost} from '../src/features/host.js';
import {bootstrapPlugins, builtinInstance, teardownPlugins} from '../src/plugin-host/bootstrap.js';
import type {WebContribution} from '../src/features/host.js';
import {webFeatures} from '../src/features/registry.js';
import {featuresReady} from '../src/features/bootstrap.js';
import {
  defaultWebPluginSources, loadDefaultWebPlugins, pluginContributions,
} from '../src/plugins/default-inventory.js';

/** The current functional catalogue, kept explicitly so a missing entry fails
 * instead of being skipped when the inventory or a plugin shard shrinks. */
const expectedPages = [
  'agentView', 'notes', 'featureGuide', 'help', 'localPreferences', 'about', 'overview',
  'search', 'ask', 'devices', 'vault', 'statistics', 'sourceCatalog', 'recordings', 'sources',
  'lark', 'imports', 'activity', 'actions', 'processing', 'extensions', 'usage', 'insights',
  'settings', 'coding', 'archive', 'connections', 'deviceConnections', 'developer',
];
const expectedCollections = ['materials', 'records', 'segments', 'sources', 'files', 'activity', 'media', 'memories', 'coding-status'];
const expectedHomes = ['agent-view'];
const expectedRenderers = [
  'source-item.calendar', 'source-item.calendar.v2', 'source-item.file', 'source-item.file.v2',
  'source-item.event', 'source-item.event.v2', 'source-item.message', 'source-item.message.v2',
  'source-item.metric', 'source-item.metric.v2', 'source-item.memory', 'source-item.memory.v2',
];
const expectedPanels = [
  'memory.saved', 'operation.saved', 'owner-questions.standalone-history',
  'owner-questions.standalone-detail', 'owner-questions.history', 'owner-questions.conversation',
  'owner-questions.work', 'owner-questions.material',
];

test('default Web inventory owns every current page, collection, home and view exactly once', async () => {
  const plugins = await loadDefaultWebPlugins();
  assert.deepEqual(plugins.map(plugin => plugin.id), defaultWebPluginSources.map(source => source.packageId),
    'the loader returns exactly the declared default packages in install order');

  const contributions = new Map<string, string>();
  for (const plugin of plugins) {
    for (const contribution of pluginContributions(plugin)) {
      const key = `${contribution.surface}:${contribution.entry.id}`;
      assert.equal(contributions.get(key), undefined, `${key} must have one plugin owner`);
      contributions.set(key, plugin.id);
    }
  }

  await featuresReady;
  const actual = {
    pages: webFeatures.pages().map(entry => entry.id),
    collections: webFeatures.collections().map(entry => entry.id),
    homes: webFeatures.homes().map(entry => entry.id),
    renderers: webFeatures.registry.list('renderer').map(entry => entry.value.entry.id),
    panels: webFeatures.registry.list('panel').map(entry => entry.value.entry.id),
  };
  assert.deepEqual([...actual.pages].sort(), [...expectedPages].sort(), 'a page missing from the default inventory fails');
  assert.deepEqual([...actual.collections].sort(), [...expectedCollections].sort(), 'a collection missing from the default inventory fails');
  assert.deepEqual([...actual.homes].sort(), [...expectedHomes].sort(), 'a home entry missing from the default inventory fails');
  assert.deepEqual([...actual.renderers].sort(), [...expectedRenderers].sort(), 'a renderer missing from the default inventory fails');
  assert.deepEqual([...actual.panels].sort(), [...expectedPanels].sort(), 'a panel missing from the default inventory fails');

  const owned = new Set(plugins.map(plugin => plugin.id));
  for (const [key, owner] of contributions) {
    assert.ok(owned.has(owner), `${key} has no default package owner`);
    assert.ok(actual.pages.includes(key.slice('page:'.length)) || !key.startsWith('page:')
      || expectedPages.includes(key.slice('page:'.length)), `${key} is not in the functional catalogue`);
  }
  for (const page of expectedPages)
    assert.ok(contributions.has(`page:${page}`), `page ${page} has no default plugin owner`);
  for (const collection of expectedCollections)
    assert.ok(contributions.has(`collection:${collection}`), `collection ${collection} has no default plugin owner`);
  for (const home of expectedHomes)
    assert.ok(contributions.has(`home:${home}`), `home ${home} has no default plugin owner`);
});

test('a desired-inactive package is skipped and stopping its scope withdraws its objects', async () => {
  const plugins = await loadDefaultWebPlugins();
  const search = plugins.find(plugin => plugin.id === 'mote.search');
  assert.ok(search, 'the default inventory must contain the search package');
  const contributions = pluginContributions(search) as WebContribution[];
  assert.ok(contributions.some(contribution => contribution.surface === 'page' && contribution.entry.id === 'search'));

  const host = new WebFeatureHost();
  try {
    const inactive = await bootstrapPlugins(host, [{...builtinInstance(search.id, contributions), desired: 'inactive'}]);
    assert.deepEqual(inactive.reports.map(report => report.outcome), [{observed: 'skipped', reason: 'not-desired'}]);
    assert.equal(host.page('search'), undefined, 'a disabled optional package contributes no page');
    await teardownPlugins(inactive.scopes);

    const active = await bootstrapPlugins(host, [builtinInstance(search.id, contributions)]);
    assert.deepEqual(active.reports.map(report => report.outcome), [{observed: 'mounted'}]);
    assert.equal(host.page('search')?.id, 'search');
    const stopped = await teardownPlugins(active.scopes);
    assert.deepEqual(stopped.errors, []);
    assert.equal(host.page('search'), undefined, 'stopping the package scope withdraws the same page');
    assert.equal(host.registry.inventory().features.length, 0, 'no package-owned descriptor survives teardown');
  } finally {
    await host.close();
  }
});
