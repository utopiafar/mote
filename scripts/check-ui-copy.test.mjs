import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {checkUiCopy,scanUiCopy} from './check-ui-copy.mjs';

const cli=fileURLToPath(new URL('./check-ui-copy.mjs',import.meta.url));
const repoRoot=fileURLToPath(new URL('..',import.meta.url));

/** Generates an isolated current-format tree; every fixture starts from generated copy only. */
function fixture(t,{keys=[],translations={},web='',desktopScript='',html='',server='',baseline=[],promises=[]}={}){
 const root=mkdtempSync(join(tmpdir(),'mote-ui-copy-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const dir of ['packages/shared/src','apps/web/src','apps/desktop/src','apps/server/src','scripts'])mkdirSync(join(root,dir),{recursive:true});
 const catalog=Object.fromEntries(keys.map(key=>[key,translations[key]??`English copy for ${key}`]));
 writeFileSync(join(root,'packages/shared/src/i18n-en.ts'),`export const english: Readonly<Record<string, string>> = ${JSON.stringify(catalog)};\n`);
 writeFileSync(join(root,'apps/web/src/fixture.tsx'),web);
 writeFileSync(join(root,'apps/desktop/src/fixture.ts'),desktopScript);
 writeFileSync(join(root,'apps/desktop/src/fixture.html'),html||'<!doctype html><title>Fixture</title>');
 writeFileSync(join(root,'apps/server/src/fixture.ts'),server);
 writeFileSync(join(root,'scripts/ui-copy-baseline.json'),JSON.stringify(baseline));
 writeFileSync(join(root,'scripts/ui-copy-promises.json'),JSON.stringify(promises));
 return root;
}

function writeCatalog(root,keys,translations={}){
 const catalog=Object.fromEntries(keys.map(key=>[key,translations[key]??`English copy for ${key}`]));
 writeFileSync(join(root,'packages/shared/src/i18n-en.ts'),`export const english: Readonly<Record<string, string>> = ${JSON.stringify(catalog)};\n`);
}

function runCli(root){
 return spawnSync(process.execPath,[cli,root],{encoding:'utf8'});
}

test('X1-01 a new boundary-explaining message reports its key and pattern',t=>{
 const key='连接成功只表示可以同步，不代表全库已经理解。';
 const root=fixture(t,{keys:[key]});
 const result=runCli(root);
 assert.equal(result.status,1);
 assert.ok(result.stdout.includes(JSON.stringify(key)),result.stdout);
 assert.match(result.stdout,/banned-phrase\(不代表\)/);
});

test('X1-02 twenty-five Han characters fail while twenty-four pass',t=>{
 const root=fixture(t,{keys:['甲'.repeat(24),'乙'.repeat(25)]});
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.deepEqual(result.violations.map(violation=>violation.rule),['too-long']);
 assert.equal(result.violations[0].text,'乙'.repeat(25));
 writeCatalog(root,['甲'.repeat(24)]);
 assert.equal(checkUiCopy({root,stdout:()=>{},stderr:()=>{}}).exitCode,0);
});

test('X1-03 an allowlisted deletion promise may exceed the length limit',t=>{
 const key='删除'.repeat(15);
 const root=fixture(t,{keys:[key],promises:[key]});
 assert.equal(checkUiCopy({root,stdout:()=>{},stderr:()=>{}}).exitCode,0);
 writeFileSync(join(root,'scripts/ui-copy-promises.json'),'[]');
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.equal(result.exitCode,1);
 assert.deepEqual(result.violations.map(violation=>violation.rule),['too-long']);
});

test('X1-04 a baselined violation passes until its source text changes',t=>{
 const key='这'.repeat(25),changed='那'.repeat(25);
 const baseline=[{rule:'too-long',location:'message',text:key}];
 const root=fixture(t,{keys:[key],baseline});
 assert.equal(checkUiCopy({root,stdout:()=>{},stderr:()=>{}}).exitCode,0);
 writeCatalog(root,[changed]);
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.equal(result.exitCode,1);
 assert.deepEqual(result.violations.map(violation=>violation.text),[changed]);
});

test('X1-05 central Chinese copy passes only as the first moteText argument',t=>{
 const key='连接成功只表示可以同步，不代表全库已经理解。';
 const raw=fixture(t,{server:`throw new Error('连接失败');\n`});
 let result=checkUiCopy({root:raw,stdout:()=>{},stderr:()=>{}});
 assert.deepEqual(result.violations.map(violation=>violation.rule),['raw-chinese']);
 assert.equal(result.violations[0].text,'连接失败');

 const wrapped=fixture(t,{keys:[key],server:`throw new Error(moteText('${key}'));\n`});
 result=checkUiCopy({root:wrapped,stdout:()=>{},stderr:()=>{}});
 assert.deepEqual(result.violations.map(violation=>violation.rule),['banned-phrase(不代表)','banned-phrase(只表示)']);
 assert.ok(result.violations.every(violation=>violation.text===key));
});

test('X1-06 long English translations are outside the Chinese-source check',t=>{
 const key='短词条';
 const root=fixture(t,{keys:[key],translations:{[key]:'A deliberately long English translation that would exceed the source limit.'.repeat(3)}});
 assert.equal(checkUiCopy({root,stdout:()=>{},stderr:()=>{}}).exitCode,0);
});

test('X1-07 请 fails while authorized 请求 wording passes',t=>{
 const root=fixture(t,{keys:['请先连接中央','请求失败']});
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.equal(result.exitCode,1);
 assert.deepEqual(result.violations.map(violation=>({rule:violation.rule,text:violation.text})),[{rule:'polite',text:'请先连接中央'}]);
});

test('X1-08 a lone character icon inside aria-hidden fails while an icon component passes',t=>{
 const root=fixture(t,{
  web:"export const Glyph=()=> <span aria-hidden>◈</span>;\nexport const Icon=()=> <ArrowRight size={14}/>;\n",
  html:'<!doctype html><span aria-hidden="true">◇</span>',
  desktopScript:"const icon=document.createElement('span');\nicon.setAttribute('aria-hidden','true');\nicon.textContent='⌕';\n",
 });
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.equal(result.exitCode,1);
 assert.deepEqual(result.violations.map(violation=>({rule:violation.rule,text:violation.text})),[
  {rule:'aria-hidden-glyph',text:'◈'},
  {rule:'aria-hidden-glyph',text:'◇'},
  {rule:'aria-hidden-glyph',text:'⌕'},
 ]);
});

test('X1-09 deleting a baseline entry re-enables that violation',t=>{
 const key='打开文件 →';
 const baseline=[{rule:'trailing-arrow',location:'message',text:key}];
 const root=fixture(t,{keys:[key],baseline});
 assert.equal(checkUiCopy({root,stdout:()=>{},stderr:()=>{}}).exitCode,0);
 writeFileSync(join(root,'scripts/ui-copy-baseline.json'),'[]');
 const result=checkUiCopy({root,stdout:()=>{},stderr:()=>{}});
 assert.equal(result.exitCode,1);
 assert.deepEqual(result.violations.map(violation=>violation.rule),['trailing-arrow']);
});

test('X1-10 the repository passes with its frozen baseline',()=>{
 const result=runCli(repoRoot);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/UI copy violations: 0/);
 assert.ok(scanUiCopy({root:repoRoot}).messages.length>0);
});
