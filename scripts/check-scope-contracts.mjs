import ts from 'typescript';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const sourceRoot='apps/server/src';
function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(directory,entry.name)):/\.(?:[cm]?tsx?|[cm]?js)$/.test(entry.name)?[resolve(directory,entry.name)]:[]);}
const compact=value=>value.replace(/\s+/g,' ').trim();
/** Conservative inventory of SQL schema strings and host boundary calls. Dynamic
 * expressions are registered verbatim instead of silently being treated public.
 * This is a change detector, not a proof that arbitrary plugin/SQL code is safe. */
export function scopeSurfaces(source,path='fixture.ts'){
  const tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true),found=new Set();
  const add=(kind,value)=>found.add(`${kind}:${compact(value)}`);
  const receivers=new Set(['app','child','fastify','server']);
  const keyArgument=node=>{
    if(!node)return '';
    if(ts.isObjectLiteralExpression(node)){
      const keys=node.properties.filter(p=>ts.isPropertyAssignment(p)&&['kind','id','scope','method','url','service'].includes(p.name.getText(tree)));
      return keys.length?keys.map(p=>p.getText(tree)).join(','):node.getText(tree);
    }
    return node.getText(tree);
  };
  function visit(node){
    if(ts.isVariableDeclaration(node)&&node.initializer&&(/^(?:Fastify|fastify)\(/.test(node.initializer.getText(tree))||receivers.has(node.initializer.getText(tree))))receivers.add(node.name.getText(tree));
    if(ts.isStringLiteralLike(node)||ts.isTemplateExpression(node)){
      const value=ts.isTemplateExpression(node)?node.getText(tree):node.text;
      for(const match of value.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w$]+|\$\{[^}]+\})/gi))add('table',match[1]);
    }
    if(ts.isCallExpression(node)){
      const expression=node.expression.getText(tree),method=ts.isPropertyAccessExpression(node.expression)?node.expression.name.text:'';
      const argument=keyArgument(node.arguments[0]);
      const receiver=ts.isPropertyAccessExpression(node.expression)?node.expression.expression.getText(tree):'';
      if(/^(?:get|post|put|patch|delete|head|options|all|route)$/.test(method)&&(receivers.has(receiver)||/^['"`]\//.test(argument)))add('api',`${method}:${argument}`);
      if(expression==='registerUserRoute')add('api',`registerUserRoute:${keyArgument(node.arguments[1])}`);
      if(/(?:^|\.)(?:mkdir|mkdirSync|mkdtemp|mkdtempSync|privateDirectory)$/.test(expression))add('directory',argument);
      if(/\b(?:executor|execution|engine|this\.executor|this\.execution)\.(?:register|enqueue|program)$/.test(expression))add('task',`${expression}:${argument}`);
      if(/\.(?:provide|plugin|install|registerCapability|registerUser|registerInstance)$/.test(expression)||/^register\w+(?:Routes|Extensions|Connectors)$/.test(expression))add('extension',`${expression}:${argument}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);return [...found].sort();
}
export function currentScopeInventory(directory=root){
  return Object.fromEntries([...files(resolve(directory,sourceRoot)),resolve(directory,'apps/server/test/fixtures/legacy-app.ts')].sort().map(path=>[relative(directory,path),scopeSurfaces(readFileSync(path,'utf8'),path)]).filter(([,surfaces])=>surfaces.length));
}
export function checkScopeInventory(current,declared){
  const failures=[];
  for(const [path,surfaces] of Object.entries(current)){
    const entry=declared[path];
    if(!entry||!['instance','user','legacy-quarantined','mixed'].includes(entry.scope)||!/^M\d{2}$/.test(entry.module)) {failures.push(`undeclared scope: ${path}`);continue;}
    for(const surface of surfaces)if(!entry.surfaces.includes(surface))failures.push(`undeclared surface: ${path}: ${surface}`);
    for(const surface of entry.surfaces)if(!surfaces.includes(surface))failures.push(`stale surface: ${path}: ${surface}`);
  }
  for(const path of Object.keys(declared))if(!current[path])failures.push(`stale declaration: ${path}`);
  return failures;
}
/** New runtime code may not import the old single-owner composition or stores.
 * Any exception needs an explicit reviewed addition, not a broad directory allow. */
export function checkProductionImports(directory=root){
  const failures=[];
  const allowed=new Set(['apps/server/src/app.ts','apps/server/src/query-agent.ts','apps/server/src/config.ts','apps/server/src/private-storage.ts','apps/server/src/runtime-listener.ts']);
  const entries=[resolve(directory,sourceRoot,'index.ts'),resolve(directory,sourceRoot,'app.ts'),...files(resolve(directory,sourceRoot,'scope'))];
  const pending=entries.slice(),seen=new Set();
  while(pending.length){
    const path=pending.pop();if(seen.has(path))continue;seen.add(path);
    const source=readFileSync(path,'utf8'),tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
    function visit(node){
      if(ts.isImportDeclaration(node)&&node.importClause?.isTypeOnly)return;
      if(ts.isExportDeclaration(node)&&node.isTypeOnly)return;
      const dynamic=ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||node.expression.getText(tree)==='require');
      const specifier=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier:dynamic?node.arguments[0]:undefined;
      // The existing trusted processor loader is reachable as a configuration
      // definition but is not constructed by the foundation. Its exact loader
      // expression is the sole retained exception, pending M06/M09 adaptation.
      const processorLoader=relative(directory,path)==='apps/server/src/file-processors.ts'&&node.getText(tree)==='import(isAbsolute(specifier)?pathToFileURL(specifier).href:specifier)';
      if(dynamic&&(!specifier||!ts.isStringLiteralLike(specifier))&&!processorLoader)failures.push(`computed production import: ${relative(directory,path)}`);
      if(specifier&&ts.isStringLiteralLike(specifier)&&specifier.text.startsWith('.')){
        const candidates=[specifier.text.replace(/\.mjs$/,'.mts').replace(/\.cjs$/,'.cts').replace(/\.js$/,'.ts'),specifier.text];
        const target=relative(directory,candidates.map(value=>resolve(path,'..',value)).find(value=>existsSync(value))??resolve(path,'..',candidates[0]));
        if(!target.startsWith(sourceRoot+'/'))failures.push(`non-production import: ${relative(directory,path)} -> ${target}`);
        if(entries.includes(path)&&!target.startsWith(sourceRoot+'/scope/')&&!allowed.has(target))failures.push(`unscoped production import: ${relative(directory,path)} -> ${target}`);
        if(target.startsWith(sourceRoot+'/')&&/\.(?:[cm]?tsx?|[cm]?js)$/.test(target))pending.push(resolve(directory,target));
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  return failures;
}
export function checkScopes(directory=root){
  const declared=JSON.parse(readFileSync(resolve(directory,'docs/design/scope-inventory.json'),'utf8'));
  return [...checkScopeInventory(currentScopeInventory(directory),declared),...checkProductionImports(directory),...checkPrivateDataSql(directory)];
}
/** M02 keeps private SQL behind one owner-binding gateway. Schema/trigger
 * installation is the explicit, inventoried exception; it is never a user API.
 * This detects new bypasses, and complements real A/B and composite-FK tests. */
export function privateSqlViolations(source,path){
  if(path==='apps/server/src/scope/private-data-schema.ts'||path==='apps/server/src/scope/private-data-sql.ts')return [];
  const failures=[],tree=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
  function visit(node){
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
      const method=node.expression.name.text,receiver=node.expression.expression.getText(tree),arg=node.arguments[0];
      if(method==='prepare'||method==='exec'&&node.expression.expression.kind!==ts.SyntaxKind.RegularExpressionLiteral)failures.push(`private SQL bypass: ${path}`);
      if(['get','all','run'].includes(method)&&/(?:^|\.)sql$/.test(receiver)){
        if(!arg||!(ts.isStringLiteralLike(arg)||ts.isTemplateExpression(arg))||!/(?:\buser_id\s*=\s*\$user|\bVALUES\s*\(\s*\$user)/i.test(arg.getText(tree)))failures.push(`private SQL missing owner binding: ${path}`);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(tree);return failures;
}
export function checkPrivateDataSql(directory=root){
  const src=resolve(directory,sourceRoot);if(!existsSync(src))return [];
  return files(src).flatMap(path=>{
    const source=readFileSync(path,'utf8');
    return /\bpd_[a-z_]+\b|\bPrivateSql\b/.test(source)||/\/private-data[^/]*\.ts$/.test(path)?privateSqlViolations(source,relative(directory,path)):[];
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const failures=checkScopes();if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}else console.log('Scope inventory and production import boundary passed');
}
