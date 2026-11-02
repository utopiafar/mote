import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUiContribution} from '../dist/plugin-ui.js';
import {PluginI18nRegistry, PresentationContributionRegistry, resolveContributionPresentation} from '@mote/shared/plugin-i18n';

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

test('a declared but missing accessibility key uses the visible label and keeps the diagnostic', () => {
  const registry = new PluginI18nRegistry();
  registry.register('fixture.plugin', 'en', {'nav.library': 'Library'});
  const declared = parseUiContribution({
    id: 'fixture.library', kind: 'page', apiVersion: '1', platforms: ['web'],
    presentation: {labelKey: 'nav.library', a11yKey: 'nav.library.a11y', i18nNamespace: 'fixture.plugin'},
  });
  const resolved = resolveContributionPresentation(declared, registry, 'en');
  assert.equal(resolved.label.text, 'Library');
  assert.equal(resolved.a11y.text, 'Library');
  assert.equal(resolved.a11y.fallback, 'key_missing');
  assert.deepEqual(resolved.fallbackReasons, ['key_missing']);
});

test('a locale-missing accessibility translation keeps the readable English message', () => {
  const registry = registryWith(['en', english]);
  const resolved = resolveContributionPresentation(descriptor, registry, 'ja');
  assert.equal(resolved.label.text, 'Library');
  assert.equal(resolved.a11y.text, 'Library navigation');
  assert.equal(resolved.a11y.fallback, 'locale_missing');
  assert.deepEqual(resolved.fallbackReasons, ['locale_missing']);
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

test('accessor catalogs are rejected before any value is read', () => {
  const registry = new PluginI18nRegistry();
  let reads = 0;
  const catalog = Object.defineProperty({}, 'nav.library', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'Library' : '   ';
    },
  });
  assert.throws(() => registry.register('fixture.plugin', 'en', catalog), /catalog fields/);
  assert.equal(reads, 0, 'registration must reject accessors without executing them');
  assert.deepEqual(registry.resolve('fixture.plugin', 'nav.library', 'en'), {text: 'nav.library', fallback: 'namespace_missing'});
});

test('proto-named JSON keys are stored and resolved as ordinary messages', () => {
  const registry = new PluginI18nRegistry();
  registry.register('fixture.proto', 'en', JSON.parse('{"__proto__":"Prototype label"}'));
  assert.deepEqual(registry.resolve('fixture.proto', '__proto__', 'en'), {text: 'Prototype label'});
  registry.register('fixture.mixed', 'en', JSON.parse('{"__proto__":"Prototype label","nav.library":"Library"}'));
  assert.equal(registry.resolve('fixture.mixed', '__proto__', 'en').text, 'Prototype label');
  assert.equal(registry.resolve('fixture.mixed', 'nav.library', 'en').text, 'Library');
});

const themeDescriptor = parseUiContribution({
  id: 'fixture.theme', kind: 'theme', apiVersion: '1', platforms: ['web', 'mac'],
  presentation: {labelKey: 'theme.name', i18nNamespace: 'fixture.plugin'},
});
const themeContribution = {packageId: 'fixture.pkg', descriptor: themeDescriptor};

test('a theme contribution binds only through its explicit pack mapping', () => {
  const registry = registryWith(
    ['en', {'theme.name': 'Studio'}],
    ['zh-CN', {'theme.name': '影棚'}],
  );
  const bindings = new PresentationContributionRegistry();
  const dispose = bindings.register(themeContribution, {id: 'fixture.theme', version: '1'});
  const facts = {requirementsAvailable: true, registeredNativeCapabilities: new Set()};
  const zh = bindings.bind(themeContribution, registry, 'web', facts, 'zh-CN');
  assert.equal(zh.kind, 'theme');
  assert.deepEqual(zh.reference, {id: 'fixture.theme', version: '1'});
  assert.deepEqual(zh.availability, {state: 'active'});
  assert.equal(zh.presentation.label.text, '影棚');
  assert.equal(zh.presentation.routeId, 'fixture.theme');
  const en = bindings.bind(themeContribution, registry, 'web', facts, 'en');
  assert.equal(en.presentation.label.text, 'Studio');
  assert.equal(en.presentation.routeId, 'fixture.theme');
  dispose();
  assert.throws(() => bindings.bind(themeContribution, registry, 'web', facts, 'en'), /not mapped/);
});

test('two valid pack references cannot cross-bind or reuse one pack', () => {
  const registry = registryWith(['en', {'theme.one': 'One', 'theme.two': 'Two', 'theme.three': 'Three'}]);
  const bindings = new PresentationContributionRegistry();
  const contribution = (packageId, id) => ({
    packageId,
    descriptor: parseUiContribution({
      id, kind: 'theme', apiVersion: '1', platforms: ['web'],
      presentation: {labelKey: id, i18nNamespace: 'fixture.plugin'},
    }),
  });
  const one = contribution('pkg.one', 'theme.one');
  const two = contribution('pkg.two', 'theme.two');
  const three = contribution('pkg.three', 'theme.three');
  bindings.register(one, {id: 'pack.one', version: '1'});
  bindings.register(two, {id: 'pack.two', version: '2'});
  const facts = {requirementsAvailable: true, registeredNativeCapabilities: new Set()};
  assert.deepEqual(bindings.bind(one, registry, 'web', facts, 'en').reference, {id: 'pack.one', version: '1'});
  assert.deepEqual(bindings.bind(two, registry, 'web', facts, 'en').reference, {id: 'pack.two', version: '2'});
  assert.equal(bindings.bind(one, registry, 'web', facts, 'en').presentation.label.text, 'One');
  assert.equal(bindings.bind(two, registry, 'web', facts, 'en').presentation.label.text, 'Two');
  assert.throws(() => bindings.register(three, {id: 'pack.one', version: '1'}), /already mapped to another/);
  assert.throws(
    () => bindings.bind({packageId: 'pkg.other', descriptor: one.descriptor}, registry, 'web', facts, 'en'),
    /not mapped/,
  );
});

test('unsupported platforms, wrong kinds and invalid references never bind as active', () => {
  const registry = registryWith(['en', {'theme.name': 'Studio'}]);
  const facts = {requirementsAvailable: true, registeredNativeCapabilities: new Set()};
  const bindings = new PresentationContributionRegistry();
  bindings.register(themeContribution, {id: 'fixture.theme', version: '1'});
  const unsupported = bindings.bind(themeContribution, registry, 'android', facts, 'en');
  assert.deepEqual(unsupported.availability, {state: 'unsupported', reason: 'platform_unsupported'});
  assert.throws(
    () => bindings.register(themeContribution, {id: 'fixture.theme', version: '1'}),
    /already mapped/,
  );
  assert.throws(
    () => bindings.register({packageId: 'fixture.other', descriptor: themeDescriptor}, {id: 'Fixture Theme', version: '1'}),
    /presentation reference/,
  );
  assert.throws(
    () => bindings.register({packageId: 'fixture.other', descriptor: themeDescriptor}, {id: 'fixture.theme', version: 'v1'}),
    /presentation reference/,
  );
  const page = parseUiContribution({
    id: 'fixture.page', kind: 'page', apiVersion: '1', platforms: ['web'],
    presentation: {labelKey: 'page.name', i18nNamespace: 'fixture.plugin'},
  });
  assert.throws(
    () => bindings.register({packageId: 'fixture.page.pkg', descriptor: page}, {id: 'fixture.page', version: '1'}),
    /theme or layout/,
  );
});

test('a layout with a missing native provider binds as requires-build', () => {
  const layout = parseUiContribution({
    id: 'fixture.layout', kind: 'layout', apiVersion: '1', platforms: ['android'],
    presentation: {labelKey: 'layout.name', i18nNamespace: 'fixture.plugin'},
    nativeRequires: [{capability: 'ui.panes', apiVersion: '1', platforms: ['android'], fallback: 'generic-reader'}],
  });
  const registry = registryWith(['en', {'layout.name': 'Phone'}]);
  const bindings = new PresentationContributionRegistry();
  const contribution = {packageId: 'fixture.layout.pkg', descriptor: layout};
  bindings.register(contribution, {id: 'fixture.layout', version: '1'});
  const binding = bindings.bind(
    contribution, registry, 'android',
    {requirementsAvailable: true, registeredNativeCapabilities: new Set()}, 'en',
  );
  assert.deepEqual(binding.availability, {state: 'requires-build', reason: 'requires_build'});
  assert.equal(binding.presentation.label.text, 'Phone');
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
