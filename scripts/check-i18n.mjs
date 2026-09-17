import ts from 'typescript';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const source=readFileSync('packages/shared/src/i18n-en.ts','utf8');
const catalog=JSON.parse(source.slice(source.indexOf('= ')+2).trim().replace(/;$/,''));
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}
const missing=[];
function check(key,file){if(/\p{Script=Han}/u.test(key)&&!Object.hasOwn(catalog,key))missing.push({file,key});}
for(const dir of ['apps/web/src','apps/desktop/src','apps/server/src','packages/shared/src','packages/local-inference/src','packages/diagnostics/src'])for(const file of walk(dir).filter(f=>/\.tsx?$/.test(f))){
 const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 const visit=n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)==='moteText'&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))check(n.arguments[0].text,file);ts.forEachChild(n,visit);};visit(ast);
}
for(const file of walk('apps/android/app/src/main/java').filter(f=>f.endsWith('.kt'))){
 const text=readFileSync(file,'utf8');
 for(const m of text.matchAll(/MoteI18n\.text\(("(?:[^"\\]|\\.)*")/g))check(JSON.parse(m[1].replaceAll('\\$','$')),file);
}
const html=readFileSync('apps/desktop/src/index.html','utf8');
for(const m of html.matchAll(/<[^>]*data-i18n(?:\s|>)[^<]*|<[^>]*data-i18n>/g)){
 const key=m[0].slice(m[0].indexOf('>')+1);if(key)check(key,'desktop HTML');
}
assert.deepEqual(missing,[],'Missing English translations');
for(const [key,value] of Object.entries(catalog)){
 assert.ok(value.trim(),'Empty translation: '+key);
 assert.deepEqual(value.match(/\{\d+\}/g)?.sort()??[],key.match(/\{\d+\}/g)?.sort()??[],'Placeholder mismatch: '+key);
}
assert.deepEqual(JSON.parse(readFileSync('apps/android/app/src/main/assets/i18n-en.json','utf8')),catalog,'Android catalog is out of sync');
console.log(`Checked ${Object.keys(catalog).length} bilingual messages and TS/Kotlin call sites.`);
