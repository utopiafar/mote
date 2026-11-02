import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiContribution} from '../dist/plugin-ui.js';
import {PluginI18nRegistry, resolveContributionPresentation} from '../dist/plugin-i18n.js';

/** A contribution descriptor as a real package manifest projects it; the
 * registry consumes the same frozen wire type the host loads. */
const descriptor = parseUiContribution(JSON.parse(JSON.stringify({
  id: 'fixture.library',
  kind: 'page',
  apiVersion: '1',
  platforms: ['web', 'mac', 'android'],
  presentation: {
    labelKey: 'nav.library',
    glyphKey: 'nav.library.glyph',
    a11yKey: 'nav.library.a11y',
    i18nNamespace: 'fixture.plugin',
  },
})));

const english = {
  'nav.library': 'Library',
  'nav.library.glyph': 'library',
  'nav.library.a11y': 'Library navigation',
};
const chinese = {
  'nav.library': '资料库',
  'nav.library.glyph': '资料库',
  'nav.library.a11y': '资料库导航',
};

function registryWith(...locales) {
  const registry = new PluginI18nRegistry();
  for (const [locale, catalog] of locales) registry.register('fixture.plugin', locale, catalog);
  return registry;
}

test('runtime locale switches plugin labels without changing route or data identity', () => {
  const registry = registryWith(['en', english], ['zh-CN', chinese]);
  const zh = resolveContributionPresentation(descriptor, registry, 'zh-CN');
  const en = resolveContributionPresentation(descriptor, registry, 'en');
  assert.equal(zh.routeId, descriptor.id);
  assert.equal(en.routeId, descriptor.id);
  assert.equal(zh.label.text, '资料库');
  assert.equal(en.label.text, 'Library');
  assert.equal(zh.a11y.text, '资料库导航');
  assert.equal(en.a11y.text, 'Library navigation');
  assert.equal(zh.glyph.text, '资料库');
  assert.equal(en.glyph.text, 'library');
  assert.deepEqual(zh.fallbackReasons, []);
  assert.deepEqual(en.fallbackReasons, []);
});

test('a rebuilt registry resolves the same key set and identity', () => {
  const rebuilt = registryWith(['en', english], ['zh-CN', chinese]);
  const first = resolveContributionPresentation(descriptor, registryWith(['en', english]), 'en');
  const second = resolveContributionPresentation(descriptor, rebuilt, 'en');
  assert.deepEqual(second, first);
  assert.equal(second.routeId, 'fixture.library');
});

test('the accessible name falls back to the visible label and glyph stays optional', () => {
  const registry = new PluginI18nRegistry();
  registry.register('fixture.plugin', 'en', {'nav.library': 'Library'});
  const plain = parseUiContribution({
    id: 'fixture.library', kind: 'page', apiVersion: '1', platforms: ['web'],
    presentation: {labelKey: 'nav.library', i18nNamespace: 'fixture.plugin'},
  });
  const resolved = resolveContributionPresentation(plain, registry, 'en');
  assert.equal(resolved.label.text, 'Library');
  assert.equal(resolved.a11y.text, 'Library');
  assert.equal(resolved.glyph, undefined);
  assert.deepEqual(resolved.fallbackReasons, []);
});

test('missing target locale uses English with an explicit reason', () => {
  const registry = registryWith(['en', english]);
  const resolved = resolveContributionPresentation(descriptor, registry, 'ja');
  assert.equal(resolved.label.text, 'Library');
  assert.equal(resolved.a11y.text, 'Library navigation');
  assert.deepEqual(resolved.fallbackReasons, ['locale_missing']);
  assert.deepEqual(resolved.label, {text: 'Library', fallback: 'locale_missing'});
});

test('unknown namespace and unknown key fall back to the key with an explicit reason', () => {
  const registry = registryWith(['en', english]);
  const unknownNamespace = registry.resolve('fixture.unknown', 'nav.library', 'en');
  assert.deepEqual(unknownNamespace, {text: 'nav.library', fallback: 'namespace_missing'});
  const unknownKey = registry.resolve('fixture.plugin', 'nav.missing', 'en');
  assert.deepEqual(unknownKey, {text: 'nav.missing', fallback: 'key_missing'});
  const unresolved = resolveContributionPresentation(
    parseUiContribution({
      id: 'fixture.unknown', kind: 'page', apiVersion: '1', platforms: ['web'],
      presentation: {labelKey: 'nav.library', i18nNamespace: 'fixture.unknown'},
    }),
    registry, 'en',
  );
  assert.equal(unresolved.routeId, 'fixture.unknown');
  assert.equal(unresolved.label.text, 'nav.library');
  assert.deepEqual(unresolved.fallbackReasons, ['namespace_missing']);
});

test('English is the canonical key set for every locale', () => {
  const early = new PluginI18nRegistry();
  early.register('fixture.plugin', 'zh-CN', chinese);
  early.register('fixture.plugin', 'en', english);
  assert.equal(early.resolve('fixture.plugin', 'nav.library', 'zh-CN').text, '资料库');
  assert.throws(
    () => early.register('fixture.plugin', 'fr', {...chinese, 'nav.extra': 'Extra'}),
    /English catalog is missing plugin keys/,
  );
  const late = new PluginI18nRegistry();
  late.register('fixture.plugin', 'de', {'nav.library': 'Bibliothek', 'nav.extra': 'Extra'});
  assert.throws(
    () => late.register('fixture.plugin', 'en', english),
    /English catalog is missing plugin keys/,
  );
});

test('duplicate, invalid and empty catalogs are rejected before they can shadow a provider', () => {
  const registry = registryWith(['en', english]);
  assert.throws(() => registry.register('fixture.plugin', 'en', english), /already registered/);
  assert.throws(() => registry.register('bad namespace', 'en', english), /namespace/);
  assert.throws(() => registry.register('fixture.plugin', 'xx', english), /Unsupported plugin locale/);
  assert.throws(() => registry.register('fixture.other', 'en', {}), /Empty plugin catalog/);
  assert.throws(() => registry.register('fixture.other', 'en', {'bad key': 'value'}), /message key/);
  assert.throws(() => registry.register('fixture.other', 'en', {'nav.library': '   '}), /translation/);
});

test('registered catalogs are immutable snapshots and disposal restores the fallback', () => {
  const registry = new PluginI18nRegistry();
  const mutable = {'nav.library': 'Library'};
  const dispose = registry.register('fixture.plugin', 'en', mutable);
  mutable['nav.library'] = 'Changed after registration';
  assert.equal(registry.resolve('fixture.plugin', 'nav.library', 'en').text, 'Library');
  dispose();
  assert.deepEqual(registry.resolve('fixture.plugin', 'nav.library', 'en'), {text: 'nav.library', fallback: 'namespace_missing'});
});
