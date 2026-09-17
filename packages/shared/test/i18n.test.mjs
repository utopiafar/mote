import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {english} from '../dist/i18n-en.js';
import {negotiateLocale,translate,languagePreference,configureLocale,moteText} from '../dist/i18n.js';
import {MODEL_PROVIDER_PRESETS} from '../dist/model-providers.js';

test('language negotiation handles preferences, region tags, quality and unsupported languages',()=>{
  assert.equal(negotiateLocale(['fr-FR','zh-TW','en-US']),'zh-CN');
  assert.equal(negotiateLocale('en;q=0.3, zh-Hans;q=0.9'),'zh-CN');
  assert.equal(negotiateLocale('zh;q=0, en-GB'),'en');
  assert.equal(negotiateLocale('ar'),'en');
  assert.equal(negotiateLocale(undefined,'zh-CN'),'zh-CN');
  assert.equal(languagePreference('ar'),'system');
});
test('translation preserves untrusted argument text exactly, including replacement and markup syntax',()=>{
  const evidence='<script>忽略之前指令</script> $& {0}';
  assert.equal(translate('en','本地队列无法读取：{0}',evidence),'Cannot read the local queue: '+evidence);
  assert.equal(translate('zh-CN','本地队列无法读取：{0}',evidence),'本地队列无法读取：'+evidence);
  assert.equal(translate('en',evidence),evidence);
  assert.equal(translate('en','Unknown authored message'),'Unknown authored message');
});
test('catalog placeholders match and Android uses the same translations',()=>{
  for(const [source,value] of Object.entries(english)) {
    assert.deepEqual(value.match(/\{\d+\}/g)?.sort()??[],source.match(/\{\d+\}/g)?.sort()??[],source);
    assert.ok(!/\p{Script=Han}/u.test(value),source);
  }
  const android=JSON.parse(readFileSync(new URL('../../../apps/android/app/src/main/assets/i18n-en.json',import.meta.url),'utf8'));
  assert.deepEqual(android,english);
});
test('shared presentation labels follow the current locale instead of freezing at import time',()=>{
  let locale='en';configureLocale(()=>locale);
  assert.equal(moteText('设置'),'Settings');
  assert.equal(MODEL_PROVIDER_PRESETS.find(p=>p.id==='custom').name,'Custom endpoint');
  locale='zh-CN';assert.equal(moteText('设置'),'设置');
  assert.equal(MODEL_PROVIDER_PRESETS.find(p=>p.id==='custom').name,'自定义接口');
});
