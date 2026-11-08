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
function fixture(t,{enKeys,localeKeys={},source}){
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
 writeFileSync(join(root,'apps/desktop/src/index.html'),'<!doctype html><title>Fixture</title>');
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
