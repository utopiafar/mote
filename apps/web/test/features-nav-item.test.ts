import assert from 'node:assert/strict';
import test from 'node:test';
import type {NavItemId} from '@mote/shared';
import {WebFeatureHost, type WebContribution} from '../src/features/host.js';
import {webFeatures} from '../src/features/registry.js';
import {readPage} from '../src/navigation.js';

const manifest = (id: string) => ({id, version: '1', components: []});
const page = (featureId: string, id: string, navItem?: NavItemId): Extract<WebContribution, {surface: 'page'}> => ({
  surface: 'page',
  entry: {id, route: `generated-nav/${id}`, featureId, navItem, render: () => id},
});

test('NV1-06 rejects only the page with an unknown navItem and logs its plugin id', async t => {
  const host = new WebFeatureHost();
  t.after(async () => { await host.close(); });
  const errors = t.mock.method(console, 'error', () => {});
  const pluginId = 'generated.nav-package';
  await host.install(manifest('generated.nav-instance'), [
    page(pluginId, 'invalid', 'unknown-nav-item' as NavItemId),
    page(pluginId, 'valid', 'chat'),
    page(pluginId, 'plain'),
  ]);

  assert.equal(host.page('invalid'), undefined);
  assert.deepEqual(host.pages().map(entry => entry.id), ['valid', 'plain']);
  assert.equal(host.page('valid')?.navItem, 'chat');
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments.join(' '), /generated\.nav-package/);
});

test('NV1-07 the first navItem claimant wins while the second page still resolves by route', async t => {
  t.after(async () => { await webFeatures.close(); });
  const warnings = t.mock.method(console, 'warn', () => {});
  const first = page('generated.nav-first', 'first', 'ideas');
  const second = page('generated.nav-second', 'second', 'ideas');
  const firstFiber = await webFeatures.install(manifest(first.entry.featureId), [first]);
  await webFeatures.install(manifest(second.entry.featureId), [second]);

  const claimants = webFeatures.pages().filter(entry => entry.navItem === 'ideas');
  assert.deepEqual(claimants.map(entry => entry.id), ['first']);
  const routedPage = readPage(`#/${second.entry.route}`);
  assert.equal(routedPage, second.entry.id);
  assert.equal(webFeatures.page(routedPage)?.render, second.entry.render);
  assert.equal(webFeatures.page(routedPage)?.navItem, undefined);
  assert.equal(second.entry.navItem, 'ideas');
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(warnings.mock.calls[0].arguments.join(' '), /generated\.nav-second/);

  await firstFiber.dispose();
  const replacement = page('generated.nav-replacement', 'replacement', 'ideas');
  await webFeatures.install(manifest(replacement.entry.featureId), [replacement]);
  assert.equal(webFeatures.page(replacement.entry.id)?.navItem, 'ideas');
});
