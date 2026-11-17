import ts from 'typescript';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const locales={en:'i18n-en.ts',ja:'i18n-ja.ts',fr:'i18n-fr.ts',de:'i18n-de.ts',es:'i18n-es.ts',ru:'i18n-ru.ts'};
export const defaultSourceDirs=['apps/web/src','apps/desktop/src','apps/server/src','packages/shared/src','packages/diagnostics/src'];
export const defaultAndroidDir='apps/android/app/src/main/java';
export const defaultHtmlFile='apps/desktop/src/index.html';
export const defaultCatalogDir='packages/shared/src';
export const defaultAndroidAssetDir='apps/android/app/src/main/assets';

/** Keys selected through data at runtime rather than passed directly to moteText.
 *  The scanner currently also sees their authored literals; registering them keeps
 *  the unused report correct if a lookup moves behind computed data. */
export const dynamicKeyAllowlist=[
 '解析未说明置信度与歧义，请核对预览。',
 '解析置信度不足或仍有歧义，请核对预览。',
 '解析未说明高置信度的依据，请核对预览。',
 '处理产生了提醒，请核对预览后再保存。',
 '尚未核对全部原件，请检查文件解析情况。',
 '部分原件未作为证据解析，请核对原件与预览。',
 '解析记录已通过校验，置信度高且无歧义。',
 '缺少逐文件解析情况；未列出的原件不能视为已解析。',
];

function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);}

function catalogFor(root,dir){
 const catalogs={};
 for(const [locale,file] of Object.entries(locales)){
  const source=readFileSync(join(root,dir,file),'utf8');
  catalogs[locale]=JSON.parse(source.slice(source.indexOf('= ')+2).trim().replace(/;$/,''));
 }
 return catalogs;
}

function kotlinLiteral(value){try{return JSON.parse(value.replaceAll('\\$','$').replaceAll("\\'","'"))}catch{return undefined;}}

/** ui-bootstrap translates these attribute values in place; the marker itself has no key. */
const htmlAttributeKeys={
 'data-i18n-placeholder':'placeholder',
 'data-i18n-title':'title',
 'data-i18n-aria-label':'aria-label',
 'data-i18n-alt':'alt',
};
const htmlEntities={amp:'&',apos:"'",gt:'>',lt:'<',nbsp:'\u00a0',quot:'"'};

function decodeHtmlAttribute(value){
 return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,(match,decimal,hex,named)=>{
  if(decimal!==undefined||hex!==undefined){
   const code=decimal!==undefined?Number.parseInt(decimal,10):Number.parseInt(hex,16);
   return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):match;
  }
  return htmlEntities[named.toLowerCase()]??match;
 });
}

/** HTML parses these elements' contents as text, not as child elements. */
const htmlRawTextElements=new Set(['script','style','textarea','title','xmp','iframe','noembed','noframes','noscript']);
const htmlPlainTextElements=new Set(['plaintext']);

function htmlEndTag(html,name,from){
 const lower=html.toLowerCase(),needle=`</${name}`;
 for(let at=lower.indexOf(needle,from);at>=0;at=lower.indexOf(needle,at+needle.length)){
  const next=html[at+needle.length];
  if(next===undefined||next==='>'||next==='/'||/\s/.test(next))return at;
 }
 return -1;
}

/** Minimal tag scanner: quoted `>` stays inside an attribute value, and raw-text/RCDATA
 *  contents (plus comments) are skipped instead of being reinterpreted as markup. */
function htmlStartTags(html){
 const tags=[];
 for(let cursor=0;cursor<html.length;){
  const open=html.indexOf('<',cursor);
  if(open<0)break;
  if(html.startsWith('<!--',open)){
   const close=html.indexOf('-->',open+4);cursor=close<0?html.length:close+3;continue;
  }
  if(!/[A-Za-z]/.test(html[open+1]??'')){cursor=open+1;continue;}
  let end=open+1,quote;
  for(;end<html.length;end++){
   const char=html[end];
   if(quote){if(char===quote)quote=undefined;continue;}
   if(char==='"'||char==="'"){quote=char;continue;}
   if(char==='>')break;
  }
  if(end>=html.length)break;
  const tag=html.slice(open,end+1),name=/^<\s*([^\s/>]+)/.exec(tag)?.[1].toLowerCase();
  tags.push({tag,end});
  cursor=end+1;
  if(name&&htmlPlainTextElements.has(name)){cursor=html.length;break;}
  if(name&&htmlRawTextElements.has(name)){
   const close=htmlEndTag(html,name,cursor);
   cursor=close<0?html.length:close;
  }
 }
 return tags;
}

function htmlAttributes(tag){
 const name=/^<\s*[^\s/>]+/.exec(tag);
 const body=tag.slice(name?name[0].length:1).replace(/\/?>$/,'');
 const attributes=new Map();
 for(const match of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)){
  attributes.set(match[1].toLowerCase(),decodeHtmlAttribute(match[2]??match[3]??match[4]??''));
 }
 return attributes;
}

/** Scans authored call sites, catalogs and generated report data for one root.
 *  `sourceDirs` are relative to `root` so fixture tests can point at a temp tree. */
export function scanI18n({
 root=process.cwd(),
 sourceDirs=defaultSourceDirs,
 androidDir=defaultAndroidDir,
 htmlFile=defaultHtmlFile,
 catalogDir=defaultCatalogDir,
 allowlist=dynamicKeyAllowlist,
}={}){
 const catalogs=catalogFor(root,catalogDir),catalog=catalogs.en;
 const catalogFiles=new Set(Object.values(locales).map(file=>join(root,catalogDir,file)));
 const referenced=new Set(),missing=[];
 const check=(key,file)=>{if(/\p{Script=Han}/u.test(key)&&!Object.hasOwn(catalog,key))missing.push({file,key});};

 for(const dir of sourceDirs)for(const file of walk(join(root,dir)).filter(f=>/\.tsx?$/.test(f))){
  if(catalogFiles.has(file))continue;
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const visit=n=>{
   if(ts.isCallExpression(n)&&n.expression.getText(ast)==='moteText'&&n.arguments[0]&&ts.isStringLiteralLike(n.arguments[0]))check(n.arguments[0].text,file);
   // This authored protocol-code catalog is translated through a dynamic key.
   if(file===join(root,'apps/web/src/failure-message.ts')&&ts.isVariableDeclaration(n)&&n.name.getText(ast)==='messages'&&n.initializer&&ts.isObjectLiteralExpression(n.initializer))for(const entry of n.initializer.properties){assert.ok(ts.isPropertyAssignment(entry)&&ts.isStringLiteralLike(entry.initializer),'Failure messages must be authored literals');check(entry.initializer.text,file);}
   if(ts.isStringLiteralLike(n))referenced.add(n.text);
   ts.forEachChild(n,visit);
  };
  visit(ast);
 }

 for(const file of walk(join(root,androidDir)).filter(f=>f.endsWith('.kt'))){
  const text=readFileSync(file,'utf8');
  // These explicit route descriptors provide dynamic translation keys to native navigation.
  if(file.endsWith('/PrimaryNavigation.kt'))for(const m of text.matchAll(/(?:MoteNavigationGroup|^\s*[A-Z_]+)\(("(?:[^"\\]|\\.)*")/gm)){const key=JSON.parse(m[1]);check(key,file);referenced.add(key);}
  // A literal argument is an authored key even when the call sits inside a Kotlin string template,
  // where the generic quoted-string scan cannot safely pair nested quotes.
  for(const m of text.matchAll(/MoteI18n\.text\(("(?:[^"\\]|\\.)*")/g)){const key=JSON.parse(m[1].replaceAll('\\$','$'));check(key,file);referenced.add(key);}
  for(const m of text.matchAll(/"(?:[^"\\]|\\.)*"/g)){const value=kotlinLiteral(m[0]);if(value!==undefined)referenced.add(value);}
  for(const m of text.matchAll(/"""([\s\S]*?)"""/g))referenced.add(m[1]);
 }

 const html=readFileSync(join(root,htmlFile),'utf8');
 // Only actual start tags count; comments and raw-text/RCDATA contents are not elements.
 for(const {tag,end} of htmlStartTags(html)){
  const attributes=htmlAttributes(tag);
  if(attributes.has('data-i18n')){
   const next=html.indexOf('<',end+1);
   const key=html.slice(end+1,next<0?html.length:next);
   if(key){check(key,'desktop HTML');referenced.add(key);}
  }
  for(const [marker,attribute] of Object.entries(htmlAttributeKeys)){
   if(!attributes.has(marker))continue;
   const key=attributes.get(attribute);
   if(!key)continue;check(key,'desktop HTML');referenced.add(key);
  }
 }

 // A key counts as used when its exact authored text appears as a source literal.
 // Catalog files never count, and runtime-composed keys must be allowlisted.
 const allowed=new Set(allowlist);
 const unused=Object.keys(catalog).filter(key=>!referenced.has(key)&&!allowed.has(key));
 const staleAllowlist=allowlist.filter(key=>!Object.hasOwn(catalog,key));
 return {catalogs,catalog,missing,referenced,unused,staleAllowlist};
}

/** Both lists are actionable: unused keys belong out of the catalog and stale allowlist entries no longer exist. */
export function formatReport({unused,staleAllowlist}){
 const lines=[`Unused messages: ${unused.length}`];
 for(const key of unused)lines.push(`  ${JSON.stringify(key)}`);
 lines.push(`Stale dynamic-key allowlist entries: ${staleAllowlist.length}`);
 for(const key of staleAllowlist)lines.push(`  ${JSON.stringify(key)}`);
 return lines.join('\n');
}

function validateCatalogs({catalogs,catalog},root,androidAssetDir){
 for(const [locale,entries] of Object.entries(catalogs)){
  for(const [key,value] of Object.entries(entries)){
   assert.ok(value.trim(),`Empty ${locale} translation: `+key);
   assert.deepEqual(value.match(/\{\d+\}/g)?.sort()??[],key.match(/\{\d+\}/g)?.sort()??[],`Placeholder mismatch (${locale}): `+key);
  }
  assert.deepEqual(Object.keys(entries).sort(),Object.keys(catalog).sort(),`${locale} catalog keys differ from the English catalog`);
  // Japanese legitimately uses Kanji; every other non-Chinese catalog must stay free of Han script.
  if(locale!=='ja')for(const [key,value] of Object.entries(entries))assert.ok(!/\p{Script=Han}/u.test(value),`${locale} translation contains Han script: `+key);
  assert.deepEqual(JSON.parse(readFileSync(join(root,androidAssetDir,`i18n-${locale}.json`),'utf8')),entries,`Android ${locale} catalog is out of sync`);
 }
}

/** Runs the full check and returns the process exit code instead of throwing. */
export function checkI18n({root=process.cwd(),stdout=console.log,stderr=console.error,...options}={}){
 try{
  const result=scanI18n({root,...options});
  stdout(formatReport(result));
  assert.deepEqual(result.missing,[],'Missing English translations');
  assert.deepEqual(result.unused,[],'Unused messages');
  assert.deepEqual(result.staleAllowlist,[],'Stale dynamic-key allowlist entries');
  validateCatalogs(result,root,options.androidAssetDir??defaultAndroidAssetDir);
  stdout(`Checked ${Object.keys(result.catalog).length} messages across ${Object.keys(result.catalogs).length} locales and TS/Kotlin call sites.`);
  return {...result,exitCode:0};
 }catch(error){
  stderr(error instanceof Error?error.message:String(error));
  return {exitCode:1};
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv[2]?resolve(process.argv[2]):process.cwd();
 process.exitCode=checkI18n({root}).exitCode;
}
