import ts from 'typescript';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const defaultCatalogFile='packages/shared/src/i18n-en.ts';
export const defaultUiDirs=['apps/web/src','apps/desktop/src'];
export const defaultServerDir='apps/server/src';
export const defaultPromisesFile='scripts/ui-copy-promises.json';
export const maxHanLength=24;

/** Source patterns that explain a boundary instead of stating the object and its state. */
export const bannedPatterns=[
 ['banned-phrase(不是…而是)',text=>/不是[^。！？\n]*而是/.test(text)],
 ['banned-phrase(不代表)',text=>text.includes('不代表')],
 ['banned-phrase(不等于)',text=>text.includes('不等于')],
 ['banned-phrase(只表示)',text=>text.includes('只表示')],
 ['banned-phrase(并不意味着)',text=>text.includes('并不意味着')],
];

/** Authorized words that happen to contain 请 are not requests or onboarding prose. */
const permittedQing=/(?:请求|申请|邀请)/g;

const hanCount=text=>(text.match(/\p{Script=Han}/gu)??[]).length;

function walk(dir){
 return readdirSync(dir,{withFileTypes:true})
  .sort((a,b)=>a.name.localeCompare(b.name))
  .flatMap(entry=>entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)]);
}

function readJson(path,fallback){
 if(!existsSync(path))return fallback;
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(!Array.isArray(value))throw new Error(`${path} must contain a JSON array`);
 return value;
}

function readPromises(path){
 const entries=readJson(path,[]);
 for(const entry of entries)if(typeof entry!=='string')throw new Error(`${path} has an invalid promise entry`);
 return entries;
}

function readCatalogKeys(root,file){
 const source=readFileSync(join(root,file),'utf8');
 const start=source.indexOf('= ');
 if(start<0)throw new Error(`${file} does not contain an exported catalog`);
 return Object.keys(JSON.parse(source.slice(start+2).trim().replace(/;$/,''))).filter(key=>/\p{Script=Han}/u.test(key));
}

export function catalogViolations(text,promises){
 const violations=[];
 for(const [rule,matches] of bannedPatterns)if(matches(text))violations.push({rule,location:'message',text});
 if(text.replace(permittedQing,'').includes('请'))violations.push({rule:'polite',location:'message',text});
 if(/[\u2192\u2197]\s*$/.test(text))violations.push({rule:'trailing-arrow',location:'message',text});
 if(hanCount(text)>maxHanLength&&!promises.has(text))violations.push({rule:'too-long',location:'message',text});
 return violations;
}

function isSingleSymbol(text){
 const characters=[...text.trim()];
 return characters.length===1&&!/[\p{L}\p{N}]/u.test(characters[0]);
}

function lineAt(ast,node){
 return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1;
}

function locationFor(root,file,ast,node){
 return `${relative(root,file).split('\\').join('/')}:${lineAt(ast,node)}`;
}

function isAriaHiddenTrue(attributes,ast){
 const attribute=attributes.properties.find(property=>ts.isJsxAttribute(property)&&property.name.getText(ast)==='aria-hidden');
 if(!attribute)return false;
 if(!attribute.initializer)return true;
 if(ts.isStringLiteral(attribute.initializer))return attribute.initializer.text==='true';
 if(ts.isJsxExpression(attribute.initializer)&&attribute.initializer.expression)return attribute.initializer.expression.kind===ts.SyntaxKind.TrueKeyword;
 return false;
}

function directJsxText(element){
 let text='';
 for(const child of element.children){
  if(ts.isJsxText(child))text+=child.text;
  else if(ts.isJsxExpression(child)&&child.expression&&ts.isStringLiteralLike(child.expression))text+=child.expression.text;
 }
 return text;
}

function jsxGlyphViolations(root,file,ast){
 const violations=[];
 const visit=node=>{
  if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)){
   const opening=ts.isJsxElement(node)?node.openingElement:node;
   if(isAriaHiddenTrue(opening.attributes,ast)){
    const text=ts.isJsxElement(node)?directJsxText(node):'';
    if(isSingleSymbol(text))violations.push({rule:'aria-hidden-glyph',location:locationFor(root,file,ast,opening),text:text.trim()});
   }
  }
  ts.forEachChild(node,visit);
 };
 visit(ast);
 return violations;
}

function isHiddenSetAttribute(node){
 if(!ts.isCallExpression(node)||!ts.isPropertyAccessExpression(node.expression))return false;
 if(node.expression.name.text!=='setAttribute'||node.arguments.length<2)return false;
 const [name,value]=node.arguments;
 if(!ts.isStringLiteralLike(name)||name.text!=='aria-hidden')return false;
 return (ts.isStringLiteralLike(value)&&value.text==='true')||value.kind===ts.SyntaxKind.TrueKeyword;
}

/** DOM-built decorations keep the glyph in a separate textContent assignment, so associate
 *  both by the element's variable name within the file. */
function domGlyphViolations(root,file,ast){
 const hiddenNames=new Set(),candidates=[];
 const addCandidates=(name,node)=>{
  const visit=child=>{
   if(ts.isStringLiteralLike(child)&&isSingleSymbol(child.text))candidates.push({name,text:child.text,node:child});
   ts.forEachChild(child,visit);
  };
  visit(node);
 };
 const visit=node=>{
  if(isHiddenSetAttribute(node)&&ts.isIdentifier(node.expression.expression))hiddenNames.add(node.expression.expression.text);
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer)addCandidates(node.name.text,node.initializer);
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&node.left.name.text==='textContent'&&ts.isIdentifier(node.left.expression))addCandidates(node.left.expression.text,node.right);
  ts.forEachChild(node,visit);
 };
 visit(ast);
 return candidates
  .filter(candidate=>hiddenNames.has(candidate.name))
  .map(candidate=>({rule:'aria-hidden-glyph',location:locationFor(root,file,ast,candidate.node),text:candidate.text}));
}

const htmlEntities={amp:'&',apos:"'",gt:'>',lt:'<',nbsp:'\u00a0',quot:'"'};
const voidHtmlElements=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
function decodeHtml(value){
 return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi,(match,decimal,hex,named)=>{
  if(decimal!==undefined||hex!==undefined){
   const code=decimal!==undefined?Number.parseInt(decimal,10):Number.parseInt(hex,16);
   return Number.isInteger(code)&&code>=0&&code<=0x10ffff?String.fromCodePoint(code):match;
  }
  return htmlEntities[named.toLowerCase()]??match;
 });
}

function htmlGlyphViolations(root,file,html){
 const violations=[];
 const source=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
 const tags=/<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
 for(let match;(match=tags.exec(source));){
  if(/\/>$/.test(match[0])||voidHtmlElements.has(match[1].toLowerCase()))continue;
  const attributes=match[2];
  if(!/(?:^|\s)aria-hidden(?:\s*=\s*(?:"true"|'true'|true))?(?:\s|\/|$)/.test(attributes))continue;
  const next=source.indexOf('<',tags.lastIndex);
  const text=decodeHtml(source.slice(tags.lastIndex,next<0?source.length:next));
  if(!isSingleSymbol(text))continue;
  const line=source.slice(0,match.index).split('\n').length;
  violations.push({rule:'aria-hidden-glyph',location:`${relative(root,file).split('\\').join('/')}:${line}`,text:text.trim()});
 }
 return violations;
}

function uiViolations(root,dirs){
 const violations=[];
 for(const dir of dirs.filter(Boolean))for(const file of walk(join(root,dir))){
  if(/\.tsx$/.test(file)){
   const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
   violations.push(...jsxGlyphViolations(root,file,ast),...domGlyphViolations(root,file,ast));
  }else if(/\.ts$/.test(file)){
   const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
   violations.push(...domGlyphViolations(root,file,ast));
  }else if(/\.html$/.test(file)){
   violations.push(...htmlGlyphViolations(root,file,readFileSync(file,'utf8')));
  }
 }
 return violations;
}

function isMoteTextArgument(node){
 const call=node.parent;
 return ts.isCallExpression(call)&&call.arguments[0]===node&&call.expression.getText()==='moteText';
}

/** The owner approved the existing model-only JSON example in this one prompt. */
function isCodingMemoryExample(path,node){
 if(path!=='apps/server/src/memory-profiles.ts'||!ts.isNoSubstitutionTemplateLiteral(node))return false;
 const expression=node.parent;
 if(!ts.isBinaryExpression(expression)||expression.right!==node||expression.operatorToken.kind!==ts.SyntaxKind.PlusToken)return false;
 const declaration=expression.parent;
 if(!ts.isVariableDeclaration(declaration)||!ts.isIdentifier(declaration.name)||declaration.name.text!=='CODING_MEMORY_PROMPT')return false;
 return createHash('sha256').update(node.text).digest('hex')==='1963e101be47f3caab76f7b81389f38f9cc06e04013485704e00b75c42adfc7d';
}

function serverViolations(root,dir){
 const violations=[];
 for(const file of walk(join(root,dir))){
  if(!/\.tsx?$/.test(file)||/\.(?:test|spec)\.tsx?$/.test(file))continue;
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const path=relative(root,file).split('\\').join('/');
  const visit=node=>{
   if(ts.isStringLiteralLike(node)&&/\p{Script=Han}/u.test(node.text)&&!isMoteTextArgument(node)&&!isCodingMemoryExample(path,node)){
    violations.push({rule:'raw-chinese',location:locationFor(root,file,ast,node),text:node.text});
   }
   ts.forEachChild(node,visit);
  };
  visit(ast);
 }
 return violations;
}

/** Collects every authored message and source-level violation. */
export function scanUiCopy({
 root=process.cwd(),
 catalogFile=defaultCatalogFile,
 uiDirs=defaultUiDirs,
 serverDir=defaultServerDir,
 promisesFile=defaultPromisesFile,
}={}){
 const promises=new Set(readPromises(join(root,promisesFile)));
 const messages=readCatalogKeys(root,catalogFile);
 const violations=messages.flatMap(text=>catalogViolations(text,promises));
 violations.push(...uiViolations(root,uiDirs),...serverViolations(root,serverDir));
 return {messages,violations};
}

export function formatReport({violations}){
 const lines=violations.map(violation=>`${violation.rule}  ${violation.location}  ${JSON.stringify(violation.text)}`);
 lines.push(`UI copy violations: ${violations.length}`);
 return lines.join('\n');
}

export function checkUiCopy({root=process.cwd(),stdout=console.log,stderr=console.error,...options}={}){
 try{
  const scan=scanUiCopy({root,...options});
  const {violations}=scan;
  stdout(formatReport(scan));
  if(violations.length){
   const byRule=Object.entries(violations.reduce((counts,violation)=>(counts[violation.rule.split('(')[0]]=(counts[violation.rule.split('(')[0]]??0)+1,counts),{}));
   stderr(`UI copy check failed: ${violations.length} violation(s) (${byRule.map(([rule,count])=>`${rule}: ${count}`).join(', ')})`);
   return {exitCode:1,...scan};
  }
  stdout(`Checked ${scan.messages.length} messages. No UI copy violations.`);
  return {exitCode:0,...scan};
 }catch(error){
  stderr(error instanceof Error?error.message:String(error));
  return {exitCode:1};
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.argv[2]?resolve(process.argv[2]):process.cwd();
 process.exitCode=checkUiCopy({root}).exitCode;
}
