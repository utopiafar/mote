import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {navigationFor, officialNavigation} from '../dist/index.js';

const allEnabled = () => ({
  enabledPackages: new Set(officialNavigation.map(item => item.packageId)),
  registered: new Set(officialNavigation.map(item => item.id)),
});
const ids = items => items.map(item => item.id ?? item.pageId);
const dailyIds = ['chat', 'feed', 'ideas', 'goals', 'library'];
const manageIds = ['memory', 'skills', 'connections', 'settings'];
const root = new URL('../../../', import.meta.url);
const assets = new URL('apps/android/app/src/main/assets/', root);
const readAsset = name => JSON.parse(readFileSync(new URL(name, assets), 'utf8'));

test('NV1-01 groups and orders all nine official items', () => {
  const {daily, manage} = navigationFor(allEnabled());
  assert.deepEqual(ids(daily), dailyIds);
  assert.deepEqual(ids(manage), manageIds);
  assert.deepEqual(daily.map(item => item.label), ['聊天', '动态', '点子', '目标', '资料库']);
  assert.deepEqual(manage.map(item => item.label), ['记忆', '技能', '连接', '设置']);
});

test('NV1-02 hides all entries of a disabled package', () => {
  const input = allEnabled();
  input.enabledPackages.delete('mote.assistant');
  const {daily, manage} = navigationFor(input);
  assert.deepEqual(ids(daily), ['chat', 'library']);
  assert.deepEqual(ids(manage), ['skills', 'connections', 'settings']);
});

test('NV1-03 omits an unregistered page from its group', () => {
  const input = allEnabled();
  input.registered.delete('ideas');
  const {daily, manage} = navigationFor(input);
  assert.deepEqual(ids(daily), ['chat', 'feed', 'goals', 'library']);
  assert.deepEqual(ids(manage), manageIds);
});

test('NV1-04 appends an enabled pinned page once and hides it when disabled', () => {
  const page = {pageId: 'generated.notes', label: 'Generated notes', packageId: 'generated.plugin'};
  const input = {...allEnabled(), pinned: [page, {...page, label: 'Duplicate pin'}]};
  input.enabledPackages.add(page.packageId);
  const {daily, manage} = navigationFor(input);
  assert.deepEqual(ids(daily), [...dailyIds, page.pageId]);
  assert.deepEqual(daily.at(-1), page);
  assert.deepEqual(ids(manage), manageIds);
  input.enabledPackages.delete(page.packageId);
  assert.deepEqual(ids(navigationFor(input).daily), dailyIds);
});

test('NV1-05 sorts tied orders by id on every call', t => {
  const ideas = officialNavigation.find(item => item.id === 'ideas');
  const goals = officialNavigation.find(item => item.id === 'goals');
  assert.ok(ideas && goals);
  t.mock.property(goals, 'order', ideas.order);
  const input = allEnabled();
  const expected = ['chat', 'feed', 'goals', 'ideas', 'library'];
  assert.deepEqual(ids(navigationFor(input).daily), expected);
  assert.deepEqual(ids(navigationFor(input).daily), expected);
});

test('NV1-08 the generated Android navigation matches the shared table', () => {
  const generator = fileURLToPath(new URL('scripts/generate-design-tokens.mjs', root));
  execFileSync(process.execPath, [generator, '--check'], {cwd: tmpdir()});
  assert.deepEqual(readAsset('ui-navigation.json'), {schemaVersion: 1, items: officialNavigation});
});

test('NV1-09 all six catalogs translate the nine official labels', () => {
  for (const locale of ['en', 'ja', 'fr', 'de', 'es', 'ru']) {
    const catalog = readAsset(`i18n-${locale}.json`);
    for (const {label} of officialNavigation) {
      assert.ok(Object.hasOwn(catalog, label) && catalog[label].trim(), `${locale}: ${label}`);
    }
  }
});
