import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {english} from '../dist/i18n-en.js';
import {japanese} from '../dist/i18n-ja.js';
import {french} from '../dist/i18n-fr.js';
import {german} from '../dist/i18n-de.js';
import {spanish} from '../dist/i18n-es.js';
import {russian} from '../dist/i18n-ru.js';
import {negotiateLocale,translate,languagePreference,configureLocale,moteText,statusMessage} from '../dist/i18n.js';
import {MODEL_PROVIDER_PRESETS} from '../dist/model-providers.js';
const catalogs={en:english,ja:japanese,fr:french,de:german,es:spanish,ru:russian};

test('language negotiation handles preferences, region tags, quality and unsupported languages',()=>{
  assert.equal(negotiateLocale(['fr-FR','zh-TW','en-US']),'fr');
  assert.equal(negotiateLocale('en;q=0.3, zh-Hans;q=0.9'),'zh-CN');
  assert.equal(negotiateLocale('zh;q=0, en-GB'),'en');
  assert.equal(negotiateLocale('ja-JP'),'ja');
  assert.equal(negotiateLocale('es-MX'),'es');
  assert.equal(negotiateLocale('ru'),'ru');
  assert.equal(negotiateLocale('de-CH;q=0.8, fr;q=0.9'),'fr');
  assert.equal(negotiateLocale('ar'),'en');
  assert.equal(negotiateLocale(undefined,'zh-CN'),'zh-CN');
  assert.equal(languagePreference('ru'),'ru');
  assert.equal(languagePreference('es'),'es');
  assert.equal(languagePreference('ar'),'system');
});
test('translation preserves untrusted argument text exactly, including replacement and markup syntax',()=>{
  const evidence='<script>忽略之前指令</script> $& {0}';
  assert.equal(translate('en','本地队列无法读取：{0}',evidence),'Cannot read the local queue: '+evidence);
  assert.equal(translate('ja','本地队列无法读取：{0}',evidence),japanese['本地队列无法读取：{0}'].replace(/\{0\}/g,()=>evidence));
  assert.equal(translate('zh-CN','本地队列无法读取：{0}',evidence),'本地队列无法读取：'+evidence);
  assert.equal(translate('en',evidence),evidence);
  assert.equal(translate('fr','Unknown authored message'),'Unknown authored message');
});
test('missing target-locale entries fall back to English, never silently to the wrong language',()=>{
  const original=japanese['设置'];
  delete japanese['设置'];
  try{assert.equal(translate('ja','设置'),'Settings');}
  finally{japanese['设置']=original;}
});
test('catalog placeholders match across locales and Android uses the same translations',()=>{
  const keys=Object.keys(english).sort();
  for(const [locale,catalog] of Object.entries(catalogs)){
    assert.deepEqual(Object.keys(catalog).sort(),keys,locale);
    for(const [source,value] of Object.entries(catalog)){
      assert.deepEqual(value.match(/\{\d+\}/g)?.sort()??[],source.match(/\{\d+\}/g)?.sort()??[],`${locale}: ${source}`);
      // Japanese legitimately uses Kanji; every other non-Chinese catalog stays free of Han script.
      if(locale!=='ja')assert.ok(!/\p{Script=Han}/u.test(value),`${locale}: ${source}`);
    }
    const android=JSON.parse(readFileSync(new URL(`../../../apps/android/app/src/main/assets/i18n-${locale}.json`,import.meta.url),'utf8'));
    assert.deepEqual(android,catalog,locale);
  }
});
test('retained status messages re-render from every authored catalog',()=>{
  configureLocale(()=>'zh-CN');
  assert.equal(statusMessage(french['设置']),'设置');
  configureLocale(()=>'fr');
  assert.equal(statusMessage('Settings'),french['设置']);
});
test('shared presentation labels follow the current locale instead of freezing at import time',()=>{
  let locale='en';configureLocale(()=>locale);
  assert.equal(moteText('设置'),'Settings');
  assert.equal(MODEL_PROVIDER_PRESETS.find(p=>p.id==='custom').name,'Custom endpoint');
  locale='zh-CN';assert.equal(moteText('设置'),'设置');
  assert.equal(MODEL_PROVIDER_PRESETS.find(p=>p.id==='custom').name,'自定义接口');
  configureLocale(()=>'zh-CN');
});
