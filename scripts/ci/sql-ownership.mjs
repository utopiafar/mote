import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import * as policy from './sql-ownership-policy.mjs';

const prefix='apps/server/src/';
const hash=text=>createHash('sha256').update(text).digest('hex');
const slash=text=>text.replaceAll('\\','/');
const unwrap=node=>{
 while(node&&(ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isParenthesizedExpression(node)||ts.isTypeAssertionExpression(node)))node=node.expression;
 return node;
};
function files(directory){
 if(!existsSync(directory))return [];
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(resolve(directory,entry.name)):/\.(?:[cm]?[jt]s)$/.test(entry.name)&&!entry.name.endsWith('.d.ts')?[resolve(directory,entry.name)]:[]);
}

/** SQL lexer, not a new SQL parser. Strings/comments cannot masquerade as table
 * references. Quoted identifiers and schema qualifications retain their names. */
export function sqlTokens(sql){
 const tokens=[];
 for(let i=0;i<sql.length;){
  const rest=sql.slice(i),space=/^\s+/.exec(rest);
  if(space){i+=space[0].length;continue;}
  if(rest.startsWith('--')){const end=sql.indexOf('\n',i);i=end<0?sql.length:end;continue;}
  if(rest.startsWith('/*')){const end=sql.indexOf('*/',i+2);if(end<0)throw Error('Unclosed SQL comment');i=end+2;continue;}
  const quote=sql[i];
  if("'\"`[".includes(quote)){
   const endQuote=quote==='['?']':quote;let value='',closed=false;i++;
   for(;i<sql.length;i++){
    if(sql[i]===endQuote){if(sql[i+1]===endQuote&&quote!=='['){value+=endQuote;i++;}else{i++;closed=true;break;}}
    else value+=sql[i];
   }
   if(!closed)throw Error('Unclosed SQL quote');
   tokens.push({text:quote==="'"?'?':value.toLowerCase(),identifier:quote!=="'",quoted:quote!=="'"});continue;
  }
  const word=/^[\p{L}_][\p{L}\p{N}_$]*/u.exec(rest);
  if(word){tokens.push({text:word[0].toLowerCase(),identifier:true});i+=word[0].length;}
  else{tokens.push({text:sql[i++],identifier:false});}
 }
 return tokens;
}

/** Extract the statically visible relation boundary. CTEs/table-valued functions
 * are local relations. Unknown interpolation remains a separate hard issue even
 * when the visible part can be checked. Foreign keys are schema dependencies,
 * not runtime reads; trigger bodies still expose actual SELECT/UPDATE targets. */
export function sqlAccesses(sql){
 const tokens=sqlTokens(sql),t=tokens.map(token=>token.quoted?"#"+token.text:token.text),accesses=[],created=[],ctes=[];
 const relation=(index,kind)=>{
  if(t[index]==='(')return;
  if(!tokens[index]?.identifier)return;
  let table=tokens[index].text;
  if(t[index+1]==='.'&&tokens[index+2]?.identifier)table=['main','temp'].includes(table)?tokens[index+2].text:table+'.'+tokens[index+2].text;
  else if(t[index+1]==='('&&kind==='read'&&(['json_each','json_tree'].includes(table)||table.startsWith('pragma_')))return;
  if(!ctes.some(cte=>cte.name===table&&index>=cte.start&&index<cte.end))accesses.push({table,kind});
 };
 // WITH [RECURSIVE] name [(columns)] AS [NOT] MATERIALIZED (...), name ...
 for(let i=0;i<t.length;i++)if(t[i]==='with'){
  let nesting=0,end=t.length;
  for(let k=i+1;k<t.length;k++){if(t[k]==='(')nesting++;if(t[k]===')'){if(nesting===0){end=k;break;}nesting--;}if(t[k]===';'&&nesting===0){end=k;break;}}
  let j=i+1;if(t[j]==='recursive')j++;
  while(tokens[j]?.identifier){
   const name=tokens[j++].text;
   if(t[j]==='('){let depth=1;j++;while(j<t.length&&depth){depth+=t[j]==='('?1:t[j]===')'?-1:0;j++;}}
   if(t[j++]!=='as')break;
   if(t[j]==='not')j++;if(t[j]==='materialized')j++;
   if(t[j]!=='(')break;ctes.push({name,start:i,end});
   let depth=1;j++;while(j<t.length&&depth){depth+=t[j]==='('?1:t[j]===')'?-1:0;j++;}
   if(t[j++]!==',')break;
  }
 }
 let depth=0;const fromDepths=new Set();
 for(let i=0;i<t.length;i++){
  if(t[i]==='(')depth++;
  if(t[i]===')'){fromDepths.delete(depth);depth--;}
  if(['where','group','having','order','limit','union','except','intersect','returning','set','values',';'].includes(t[i]))fromDepths.delete(depth);
  if(t[i]==='from'||t[i]==='join'){
   relation(i+1,t[i]==='from'&&t[i-1]==='delete'?'write':'read');
   if(t[i]==='from')fromDepths.add(depth);
  }
  if(t[i]===','&&fromDepths.has(depth))relation(i+1,'read');
  if(t[i]==='into'&&['insert','replace','abort','fail','ignore','rollback'].includes(t[i-1]))relation(i+1,'write');
  if(t[i]==='update'&&!['do','after','before'].includes(t[i-1])&&!['of','on'].includes(t[i+1])){
   let j=i+1;if(t[j]==='or')j+=2;relation(j,'write');
  }
  if(t[i]==='create'){
   let j=i+1;if(['temp','temporary'].includes(t[j]))j++;if(['virtual','unique'].includes(t[j]))j++;
   const type=t[j++];if(t[j]==='if')j+=3;
   if(['table','view','index','trigger'].includes(type)&&tokens[j]?.identifier){
    created.push({type,name:tokens[j].text});
    if(type==='table'||type==='view')relation(j,'write');
    // Index/trigger attachment is a schema write to its target, not a read.
    if(type==='index'||type==='trigger'){
     while(j<t.length&&!['on',';'].includes(t[j]))j++;
     if(t[j]==='on')relation(j+1,'write');
    }
   }
  }
  if(['drop','alter'].includes(t[i])&&['table','view'].includes(t[i+1]))relation(i+2+(t[i+2]==='if'?2:0),'write');
 }
 return {accesses:[...new Map(accesses.map(value=>[JSON.stringify(value),value])).values()],created};
}

/** Resolve only immutable lexical constants and finite literal branches. Unknown
 * values are marked, never treated as an empty/approved SQL statement. */
export function sqlStatements(file,text){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 if(source.parseDiagnostics.length)throw Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText,' ')}`);
 const scopes=new WeakMap();
 const scopeFor=node=>{for(let p=node.parent;p;p=p.parent)if(ts.isSourceFile(p)||ts.isBlock(p)||ts.isFunctionLike(p)||ts.isCatchClause(p)||ts.isForStatement(p)||ts.isForInStatement(p)||ts.isForOfStatement(p))return p;return source;};
 const bind=(node,name,value)=>{if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name)){for(const item of name.elements)if(ts.isBindingElement(item))bind(node,item.name,undefined);return;}if(!ts.isIdentifier(name))return;const scope=scopeFor(node),map=scopes.get(scope)??new Map();map.set(name.text,value);scopes.set(scope,map);};
 const declarations=node=>{
  if(ts.isVariableDeclaration(node))bind(node,node.name,node.parent.flags&ts.NodeFlags.Const?node.initializer:undefined);
  if(ts.isParameter(node))bind(node,node.name,undefined);
  if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name)bind(node,node.name,undefined);
  if(ts.isImportClause(node)&&node.name)bind(node,node.name,undefined);
  if(ts.isImportSpecifier(node)||ts.isNamespaceImport(node))bind(node,node.name,undefined);
  ts.forEachChild(node,declarations);
 };declarations(source);
 const binding=node=>{for(let p=node.parent;p;p=p.parent)if(scopes.get(p)?.has(node.text))return scopes.get(p).get(node.text);};
 const combine=(left,right)=>left.length*right.length>64?['__dynamic__']:left.flatMap(a=>right.map(b=>a+b));
 const literal=(node,seen=new Set())=>{
  node=unwrap(node);if(!node||seen.has(node))return ['__dynamic__'];seen.add(node);
  if(ts.isStringLiteralLike(node))return [node.text];
  if(ts.isIdentifier(node))return literal(binding(node),seen);
  if(ts.isConditionalExpression(node))return [...literal(node.whenTrue,new Set(seen)),...literal(node.whenFalse,new Set(seen))];
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return combine(literal(node.left,new Set(seen)),literal(node.right,new Set(seen)));
  if(ts.isTemplateExpression(node))return node.templateSpans.reduce((values,span)=>combine(values,literal(span.expression,new Set(seen))).map(value=>value+span.literal.text),[node.head.text]);
  return ['__dynamic__'];
 };
 const statements=[],sinkArguments=new Set();
 const record=(node,expression)=>{
  let fn;for(let p=node.parent;p;p=p.parent)if(ts.isFunctionDeclaration(p)){fn=p.name?.text;break;}
  const values=[...new Set(literal(expression))],dynamic=values.some(value=>value.includes('__dynamic__'));
  // An unresolved call is frozen to its enclosing lexical body as well. An
  // edit to a helper cannot silently reuse a generic `prepare(sql)` exception.
  let context=node; if(dynamic)for(let p=node.parent;p;p=p.parent)if(ts.isFunctionLike(p)||ts.isSourceFile(p)){context=p;break;}
  statements.push({line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,fn,expression:expression?.getText(source)??'<missing>',values,
   fingerprint:hash(JSON.stringify([expression?.getText(source),values,dynamic?context.getText(source):null]))});
 };
 const sqlMethod=node=>{
  node=unwrap(node);if(!node)return false;
  if(ts.isPropertyAccessExpression(node))return ['prepare','exec'].includes(node.name.text);
  if(ts.isElementAccessExpression(node)&&ts.isStringLiteralLike(node.argumentExpression))return ['prepare','exec'].includes(node.argumentExpression.text);
  return false;
 };
 const sink=(node,seen=new Set())=>{
  node=unwrap(node);if(!node||seen.has(node))return false;seen.add(node);
  return sqlMethod(node)||ts.isIdentifier(node)&&sink(binding(node),seen)||ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='bind'&&sink(node.expression.expression,seen);
 };
 const visit=node=>{
  if(ts.isCallExpression(node)){
   if(sink(node.expression)){sinkArguments.add(node.arguments[0]);record(node,node.arguments[0]);}
  }
  ts.forEachChild(node,visit);
 };visit(source);
 // Complete SQL literals passed through wrappers/aliases are evidence too.
 // Ignore literal leaves already contained in a checked sink argument.
 const literals=node=>{
  if(sinkArguments.has(node))return;
  if((ts.isStringLiteralLike(node)||ts.isTemplateExpression(node))&&/^\s*(?:select\s[\s\S]*\bfrom\b|with\s+(?:recursive\s+)?[\w"`\[][\s\S]*\bas\s*\(|insert\s+(?:or\s+\w+\s+)?into\b|replace\s+into\b|update\s+(?:or\s+\w+\s+)?\S+\s+set\b|delete\s+from\b|create\s+(?:(?:temp(?:orary)?|unique|virtual)\s+)*(?:table|view|index|trigger)\b|drop\s+(?:table|view|index|trigger)\b|alter\s+table\b)/i.test(ts.isTemplateExpression(node)?node.head.text:node.text)){
   record(node,node);return;
  }
  ts.forEachChild(node,literals);
 };literals(source);
 const occurrences=new Map();
 for(const statement of statements){const count=(occurrences.get(statement.fingerprint)??0)+1;occurrences.set(statement.fingerprint,count);statement.fingerprint=hash(JSON.stringify([statement.fingerprint,count]));}
 return statements;
}

function installerDeclarations(file,text,names){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),result=[];
 const visit=node=>{
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text)){
   const value=unwrap(node.initializer);
   if(!value||!ts.isObjectLiteralExpression(value))throw Error(`${file}: installer ${node.name.text} must be a literal declaration`);
   const properties=new Map(value.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(source),unwrap(p.initializer)]));
   const owner=properties.get('owner'),install=properties.get('install');
   if(!owner||!ts.isStringLiteral(owner)||!install||!ts.isIdentifier(install))throw Error(`${file}: installer owner/function must be explicit`);
   result.push({declaration:node.name.text,owner:owner.text,fn:install.text});
  }
  ts.forEachChild(node,visit);
 };visit(source);
 if(result.length!==names.length)throw Error(`${file}: missing declared installer`);
 return result;
}

export function ownershipInventory(root='.',configuration=policy){
 root=resolve(root);const sources=new Map(files(resolve(root,prefix)).map(file=>[slash(relative(root,file)),readFileSync(file,'utf8')]));
 const statements=new Map([...sources].map(([file,text])=>[file,sqlStatements(file,text)]));
 const owners=[],tables={},functions=new Map();
 for(const [name,names] of Object.entries(configuration.installations)){
  const file=prefix+name,text=sources.get(file);if(text===undefined)throw Error(`Missing SQL owner source: ${file}`);
  for(const installation of installerDeclarations(file,text,names)){
   owners.push({...installation,file});functions.set(file+'#'+installation.fn,installation.owner);
   const body=statements.get(file).filter(statement=>statement.fn===installation.fn);
   if(!body.length)throw Error(`${file}: installer ${installation.fn} has no visible SQL`);
   for(const statement of body)for(const sql of statement.values){
    if(sql.includes('__dynamic__'))throw Error(`${file}: schema owner SQL must be static`);
    for(const object of sqlAccesses(sql).created)if(['table','view'].includes(object.type)){
     if(tables[object.name]&&tables[object.name].owner!==installation.owner)throw Error(`Duplicate SQL table owner: ${object.name}`);
     tables[object.name]={owner:installation.owner,file,installer:installation.declaration};
    }
   }
  }
 }
 const issues=[],uncoveredFiles=new Set(),uncoveredTables=new Set(),coveredFiles=new Set();
 let dynamicStatements=0;
 for(const [file,items] of statements)for(const statement of items){
  const owner=functions.get(file+'#'+statement.fn)??configuration.consumers[file.slice(prefix.length)];
  const add=(rule,to,kind)=>issues.push({rule,from:file,to,kind,symbol:statement.fingerprint,line:statement.line});
  if(!owner){uncoveredFiles.add(file);add('sql-uncovered-consumer','[owner pending]','coverage');}
  else coveredFiles.add(file);
  if(owner&&!owners.some(item=>item.owner===owner))throw Error(`${file}: consumer owner ${owner} has no production installer`);
  if(statement.values.some(sql=>sql.includes('__dynamic__')))dynamicStatements++;
  for(const sql of statement.values){
   if(owner&&sql.includes('__dynamic__'))add('sql-dynamic','[unproved SQL]','dynamic');
   for(const access of sqlAccesses(sql).accesses){
    if(access.table.startsWith('sqlite_'))continue; // SQLite's own schema, never domain data.
    if(access.table.includes('__dynamic__'))continue;
    const target=tables[access.table]?.owner;
    if(!target){uncoveredTables.add(access.table);if(owner)add(sql.includes('__dynamic__')?'sql-unproved-relation':'sql-uncovered-table',access.table,access.kind);}
    else if(owner&&target!==owner)add('sql-cross-owner',access.table,access.kind);
   }
  }
 }
 const unique=[...new Map(issues.map(issue=>[issueKey(issue),issue])).values()].sort((a,b)=>issueKey(a).localeCompare(issueKey(b)));
 return {dynamicStatements,owners,tables:Object.fromEntries(Object.entries(tables).sort()),coveredFiles:[...coveredFiles].sort(),uncoveredFiles:[...uncoveredFiles].sort(),uncoveredTables:[...uncoveredTables].sort(),issues:unique};
}
export const issueKey=issue=>JSON.stringify([issue.rule,issue.from,issue.to,issue.kind,issue.symbol]);
export function checkSqlOwnership(root='.',{configuration=policy,baseline}={}){
 const inventory=ownershipInventory(root,configuration);
 const grants=configuration.sharedReads.map(grant=>{
  if(grant.kind!==undefined&&grant.kind!=='read')throw Error('Shared SQL models only grant reads');
  return {...grant,rule:'sql-cross-owner',kind:'read'};
 });
 const rawDebt=baseline??JSON.parse(readFileSync(resolve(root,'scripts/ci/sql-ownership-baseline.json'),'utf8'));
 const debt=rawDebt.flatMap(({symbols,...item})=>symbols?symbols.map(symbol=>({...item,symbol})):[item]);
 const generated={owners:inventory.owners,tables:inventory.tables};
 if(baseline===undefined&&JSON.stringify(generated)!==JSON.stringify(JSON.parse(readFileSync(resolve(root,'scripts/ci/sql-ownership-map.json'),'utf8'))))throw Error('SQL ownership map is stale; inspect --map output and update the generated map');
 const allowed=new Map();
 for(const item of [...debt,...grants]){
  if(!item.reason?.trim()||!/^([a-f0-9]{64})$/.test(item.symbol)||allowed.has(issueKey(item)))throw Error('SQL exceptions require a reason, unique statement fingerprint and concrete access');
  allowed.set(issueKey(item),item);
 }
 const present=new Set(inventory.issues.map(issueKey));
 return {...inventory,violations:inventory.issues.filter(issue=>!allowed.has(issueKey(issue))),exceptions:inventory.issues.filter(issue=>allowed.has(issueKey(issue))),stale:[...debt,...grants].filter(item=>!present.has(issueKey(item)))};
}
export const sqlOwnershipSummary=result=>`SQL ownership: ${result.owners.length} production owners, ${Object.keys(result.tables).length} tables/views, ${result.coveredFiles.length} covered SQL files; PARTIAL coverage: ${result.uncoveredFiles.length} consumer files, ${result.uncoveredTables.length} referenced relations pending, ${result.dynamicStatements} unproved SQL statements. ${result.exceptions.length} concrete existing exceptions.`;
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const result=process.argv.includes('--inventory')||process.argv.includes('--map')?ownershipInventory():checkSqlOwnership();
  if(process.argv.includes('--map'))console.log(JSON.stringify({owners:result.owners,tables:result.tables},null,1));
  else if(process.argv.includes('--inventory'))console.log(JSON.stringify(result,null,2));
  else{
   for(const issue of result.violations)console.error(`${issue.rule}: ${issue.from}:${issue.line} -> ${issue.to} (${issue.kind}, ${issue.symbol})`);
   for(const issue of result.stale)console.error(`Remove resolved SQL exception: ${issue.from} -> ${issue.to} (${issue.symbol})`);
   console.log(sqlOwnershipSummary(result));

   if(result.violations.length||result.stale.length)process.exitCode=1;
  }
 }catch(error){console.error(error.message);process.exitCode=1;}
}
