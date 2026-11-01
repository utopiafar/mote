import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

let instance = 0;
const fresh = () => import(`../dist/i18n.js?loading-test=${instance++}`);

test('Chinese startup never invokes a catalog loader', async () => {
  const i18n = await fresh();
  const loads = [];
  const hook = registerHooks({resolve(specifier, context, next) {
    if (/i18n-(en|ja|fr|de|es|ru)\.js$/.test(specifier)) {
      loads.push(specifier);
      throw Error('Chinese startup must not load catalogs');
    }
    return next(specifier, context);
  }});
  try {
    await i18n.loadLocale('zh-CN');
    assert.deepEqual(loads, []);
    assert.equal(i18n.translate('zh-CN', '设置'), '设置');
  } finally { hook.deregister(); }
});

test('a cold registry loads Japanese and real English fallback, preserving unknown source strings', async () => {
  const i18n = await fresh();
  assert.equal(i18n.translate('ja', '设置'), '设置');
  await Promise.all([i18n.loadLocale('ja'), i18n.loadLocale('ja')]);
  assert.equal(i18n.translate('ja', '设置'), '設定');
  i18n.registerCatalog('ja', {});
  assert.equal(i18n.translate('ja', '设置'), 'Settings');
  assert.equal(i18n.translate('ja', 'Generated unknown $& {0}', '<literal>'), 'Generated unknown $& <literal>');
});

test('retained status reverse lookup is lazy and rebuilt after catalog registration', async () => {
  const i18n = await fresh();
  let enumerations = 0;
  const english = new Proxy({'设置': 'Settings'}, {ownKeys(value) { enumerations++; return Reflect.ownKeys(value); }});
  i18n.registerCatalog('en', english);
  i18n.configureLocale(() => 'en');
  assert.equal(i18n.moteText('设置'), 'Settings');
  assert.equal(enumerations, 0, 'ordinary translation does not build status lookup');
  assert.equal(i18n.statusMessage('Settings'), 'Settings');
  assert.equal(enumerations, 1);
  i18n.statusMessage('Settings');
  assert.equal(enumerations, 1, 'status lookup is reused until registration');
  i18n.registerCatalog('fr', {'设置': 'Paramètres'});
  assert.equal(enumerations, 1, 'registration invalidates without eagerly rebuilding');
  assert.equal(i18n.statusMessage('Paramètres'), 'Settings');
  assert.equal(enumerations, 2);
  i18n.registerCatalog('fr', {'设置': 'Generated replacement status'});
  assert.equal(i18n.statusMessage('Generated replacement status'), 'Settings');
  assert.equal(i18n.statusMessage('Paramètres'), 'Paramètres', 'replaced catalog entries do not remain in the cache');
});
