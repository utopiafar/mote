import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';

async function bootFixture(scenario: string) {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /src="\/src\/boot\.ts"/);
  const dom = new JSDOM(html, {url: 'http://localhost/', pretendToBeVisual: true});
  const locale = scenario === 'chinese' ? 'zh-CN' : scenario === 'english' ? 'en' : 'ja';
  dom.window.localStorage.setItem('mote.language', locale);
  for (const key of ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node'] as const) {
    Object.defineProperty(globalThis, key, {value: key === 'window' ? dom.window : (dom.window as any)[key], configurable: true});
  }
  Object.assign(globalThis, {__MOTE_WEB_VERSION__: 'generated-boot-fixture'});
  const catalogs: string[] = [];
  let mainLoaded = false, releaseEnglish!: () => void;
  const gate = new Promise<void>(resolve => {releaseEnglish = resolve;});
  Object.assign(globalThis, {generatedEnglishGate: gate});
  const hook = registerHooks({load(url, context, next) {
    if (url.endsWith('.css')) return {format: 'module', source: 'export {};', shortCircuit: true};
    if (/\/main\.tsx$/.test(url)) mainLoaded = true;
    const catalog = /\/i18n-(en|ja|fr|de|es|ru)\.js$/.exec(url)?.[1];
    if (catalog) {
      catalogs.push(catalog);
      if (catalog === 'ja' && scenario === 'failed-target') return {format: 'module', source: 'throw Error("Generated unavailable Japanese chunk");', shortCircuit: true};
      if (catalog === 'ja' && scenario === 'missing-entry') return {format: 'module', source: 'export const japanese = {};', shortCircuit: true};
      const loaded = next(url, context);
      if (catalog === 'en') return {...loaded, source: 'await globalThis.generatedEnglishGate;\n' + loaded.source};
      return loaded;
    }
    return next(url, context);
  }});
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!ready()) {
      assert.ok(Date.now() < deadline, 'real boot/main did not reach the expected startup state');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await import('../src/boot');
    if (locale !== 'zh-CN') {
      await until(() => catalogs.includes('en') && (locale === 'en' || catalogs.includes('ja')));
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(mainLoaded, false, 'main must wait for English even when the target load fails');
      assert.equal(dom.window.document.getElementById('root')!.childElementCount, 0);
    }
    releaseEnglish();
    await until(() => !!dom.window.document.querySelector('.welcome'));
    const {sourceLabels} = await import('../src/Metadata');
    const i18n = await import('@mote/shared/i18n');
    const expected = locale === 'zh-CN' ? '文件' : scenario === 'japanese' ? 'ファイル' : 'File';
    assert.equal(sourceLabels.file, expected, 'the real main dependency evaluates module-level text after catalogs load');
    assert.equal(dom.window.document.documentElement.lang, locale);
    assert.ok(dom.window.document.body.textContent!.includes(i18n.translate(locale, '由你决定留下什么')));
    assert.deepEqual(catalogs.sort(), locale === 'zh-CN' ? [] : locale === 'en' ? ['en'] : ['en', 'ja']);
    dom.window.localStorage.setItem('mote.language', 'ru');
    assert.equal(i18n.getLocale(), locale, 'negotiation stays fixed until the existing language reload');
  } finally {hook.deregister(); dom.window.close();}
}

if (process.env.MOTE_LOCALE_BOOT_FIXTURE) {
  await bootFixture(process.env.MOTE_LOCALE_BOOT_FIXTURE);
  process.exit(0);
} else {
  for (const scenario of ['chinese', 'english', 'japanese', 'missing-entry', 'failed-target']) {
    test(`real Web boot mounts main with localized top-level labels: ${scenario}`, {timeout: 30_000}, () => {
      const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
        env: {...process.env, MOTE_LOCALE_BOOT_FIXTURE: scenario}, encoding: 'utf8', timeout: 25_000,
      });
      assert.equal(child.status, 0, child.stdout + child.stderr + (child.error?.message ?? ''));
    });
  }
}
