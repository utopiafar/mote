import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {checkI18n,defaultSourceDirs,formatReport,scanI18n} from './check-i18n.mjs';

const localeNames=['en','ja','fr','de','es','ru'];
const cli=fileURLToPath(new URL('./check-i18n.mjs',import.meta.url));

function translated(key,locale){
 const placeholders=key.match(/\{\d+\}/g)??[];
 return `${locale} message${placeholders.length?' '+placeholders.join(' '):''}`;
}

/** Generates a private current-format tree with authored catalogs and sources. */
function fixture(t,{enKeys,localeKeys={},source,html='<!doctype html><title>Fixture</title>'}){
 const root=mkdtempSync(join(tmpdir(),'mote-i18n-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const dir of defaultSourceDirs)mkdirSync(join(root,dir),{recursive:true});
 mkdirSync(join(root,'apps/android/app/src/main/java'),{recursive:true});
 mkdirSync(join(root,'apps/android/app/src/main/assets'),{recursive:true});
 for(const locale of localeNames){
  const keys=locale==='en'?enKeys:localeKeys[locale]??enKeys;
  const entries=Object.fromEntries(keys.map(key=>[key,translated(key,locale)]));
  writeFileSync(join(root,'packages/shared/src',`i18n-${locale}.ts`),`export const ${locale} = ${JSON.stringify(entries)};\n`);
  writeFileSync(join(root,'apps/android/app/src/main/assets',`i18n-${locale}.json`),JSON.stringify(entries));
 }
 writeFileSync(join(root,'apps/web/src/fixture.ts'),source);
 writeFileSync(join(root,'apps/desktop/src/index.html'),html);
 return root;
}

function runCli(root){
 return spawnSync(process.execPath,[cli,root],{encoding:'utf8'});
}

test('G2-01 an unreferenced key is reported without failing the translation check',t=>{
 const root=fixture(t,{
  enKeys:['有引用的词条','没有任何引用的词条'],
  source:"import {moteText} from '@mote/shared/i18n';\nexport const label=moteText('有引用的词条');\n",
 });
 const result=runCli(root);
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/Unused messages: 1 \(warning only/);
 assert.ok(result.stdout.includes('没有任何引用的词条'),result.stdout);
 assert.ok(!result.stdout.includes('有引用的词条'),result.stdout);
});

test('G2-02 an allowlisted dynamic key stays out of the unused report',t=>{
 const root=fixture(t,{
  enKeys:['有引用的词条','动态拼接：{0}'],
  source:"import {moteText} from '@mote/shared/i18n';\nconst suffix='value';\nexport const used=moteText('有引用的词条');\nexport const dynamic=moteText(`动态拼接：${suffix}`);\n",
 });
 const unregistered=formatReport(scanI18n({root,allowlist:[]}));
 assert.ok(unregistered.includes('动态拼接：{0}'),unregistered);
 const output=[],errors=[];
 const result=checkI18n({root,allowlist:['动态拼接：{0}'],stdout:text=>output.push(text),stderr:text=>errors.push(text)});
 assert.equal(result.exitCode,0,errors.join('\n'));
 const report=output.join('\n');
 assert.match(report,/Unused messages: 0 \(warning only/);
 assert.ok(!report.includes('动态拼接：{0}'),report);
});

test('G2-03 a missing English entry still fails with a non-zero exit code',t=>{
 const root=fixture(t,{
  enKeys:['有引用的词条'],
  localeKeys:Object.fromEntries(localeNames.filter(locale=>locale!=='en').map(locale=>[locale,['有引用的词条','缺英文词条']])),
  source:"import {moteText} from '@mote/shared/i18n';\nexport const label=moteText('缺英文词条');\n",
 });
 const result=runCli(root);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Missing English translations/);
});

test('G2-04 a stale allowlist entry is listed separately and only warns',t=>{
 const root=fixture(t,{
  enKeys:['有引用的词条'],
  source:"import {moteText} from '@mote/shared/i18n';\nexport const label=moteText('有引用的词条');\n",
 });
 const output=[],errors=[];
 const result=checkI18n({root,allowlist:['有引用的词条','已删除的动态词条'],stdout:text=>output.push(text),stderr:text=>errors.push(text)});
 assert.equal(result.exitCode,0,errors.join('\n'));
 assert.deepEqual(result.staleAllowlist,['已删除的动态词条']);
 const report=output.join('\n');
 assert.match(report,/Stale dynamic-key allowlist entries: 1 \(warning only/);
 assert.ok(report.includes('已删除的动态词条'),report);
 assert.ok(!report.includes('有引用的词条'),report);
});

test('G2-05 four data-i18n attribute forms are referenced while unmarked HTML stays untranslated',t=>{
 const keys=['问一问…','所选参数的 JPEG','有未保存的设置','采集状态','引号 "词条"'];
 const root=fixture(t,{
  enKeys:keys,
  source:'export {};\n',
  html:`<!doctype html>
<textarea id="home-question" rows="2" maxlength="8000" placeholder="问一问…" data-i18n-placeholder=""></textarea>
<img id="record-detail-image" alt="所选参数的 JPEG" data-i18n-alt="">
<section data-i18n-title="" title="有未保存的设置"></section>
<div data-i18n-aria-label='' aria-label='采集状态'></div>
<textarea data-i18n-placeholder="不是词条" placeholder="引号 &quot;词条&quot;"></textarea>
<p aria-label="未标记的属性">普通文案</p>`,
 });
 const result=scanI18n({root});
 for(const key of keys)assert.ok(result.referenced.has(key),key);
 assert.ok(!result.referenced.has('不是词条'));
 assert.deepEqual(result.unused,[]);
 assert.deepEqual(result.missing,[]);
 const output=[],errors=[];
 const checked=checkI18n({root,stdout:text=>output.push(text),stderr:text=>errors.push(text)});
 assert.equal(checked.exitCode,0,errors.join('\n'));
 assert.match(output.join('\n'),/Unused messages: 0 \(warning only/);
});

test('G2-06 a missing data-i18n attribute key fails the translation check',t=>{
 const root=fixture(t,{
  enKeys:['有引用的词条'],
  source:"import {moteText} from '@mote/shared/i18n';\nexport const label=moteText('有引用的词条');\n",
  html:'<img id="compression-before" alt="压缩前图片" data-i18n-alt="">',
 });
 const result=scanI18n({root});
 assert.deepEqual(result.missing,[{file:'desktop HTML',key:'压缩前图片'}]);
 const output=[],errors=[];
 const checked=checkI18n({root,stdout:text=>output.push(text),stderr:text=>errors.push(text)});
 assert.equal(checked.exitCode,1);
 assert.match(errors.join('\n'),/Missing English translations/);
});

test('G2-07 comments and raw-text/RCDATA contents are not translated elements',t=>{
 const keys=['真实标题','真实文本','真实占位'];
 const root=fixture(t,{
  enKeys:keys,
  source:'export {};\n',
  html:`<!doctype html>
<html><head>
<title><img alt="标题伪键" data-i18n-alt><span data-i18n>标题伪文本</span></title>
</head><body>
<!-- <img alt="注释伪键" data-i18n-alt><span data-i18n>注释伪文本</span> -->
<script type="application/json">{"example":"<img alt='脚本伪键' data-i18n-alt><span data-i18n>脚本伪文本</span>"}</script>
<style>.example::before { content: "<img alt='样式伪键' data-i18n-alt><span data-i18n>样式伪文本</span>"; }</style>
<textarea><img alt="文本域伪键" data-i18n-alt><span data-i18n>文本域伪文本</span></textarea>
<div title="真实标题" data-i18n-title></div>
<span data-i18n>真实文本</span>
<input placeholder="真实占位" data-i18n-placeholder>
</body></html>`,
 });
 const result=scanI18n({root});
 assert.deepEqual([...result.referenced].sort(),[...keys].sort());
 assert.deepEqual(result.missing,[]);
 assert.deepEqual(result.unused,[]);
 const output=[],errors=[];
 const checked=checkI18n({root,stdout:text=>output.push(text),stderr:text=>errors.push(text)});
 assert.equal(checked.exitCode,0,errors.join('\n'));
 assert.match(output.join('\n'),/Unused messages: 0 \(warning only/);
});
