import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,relative,dirname} from 'node:path';
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
export function sqlAccesses(sql,{schemaLifecycle=false,maintenance=false}={}){
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
   relation(i+1,t[i]==='from'&&t[i-1]==='delete'?(maintenance?'delete':'write'):'read');
   if(t[i]==='from')fromDepths.add(depth);
  }
  if(t[i]===','&&fromDepths.has(depth))relation(i+1,'read');
  if(t[i]==='into'&&['insert','replace','abort','fail','ignore','rollback'].includes(t[i-1]))relation(i+1,maintenance?'insert':'write');
  if(t[i]==='update'&&!['do','after','before'].includes(t[i-1])&&!['of','on'].includes(t[i+1])){
   let j=i+1;if(t[j]==='or')j+=2;relation(j,maintenance?'update':'write');
  }
  if(t[i]==='create'){
   let j=i+1;if(['temp','temporary'].includes(t[j]))j++;if(['virtual','unique'].includes(t[j]))j++;
   const temporary=['temp','temporary'].includes(t[i+1]),type=t[j++];if(t[j]==='if')j+=3;
   if(['table','view','index','trigger'].includes(type)&&tokens[j]?.identifier){
    created.push({type,name:tokens[j].text});
    if(type==='table'||type==='view')relation(j,maintenance?'create':'write');
    // Index/trigger attachment is a schema write to its target, not a read.
    if(type==='index'||type==='trigger'){
     while(j<t.length&&!['on',';'].includes(t[j]))j++;
     if(t[j]==='on')relation(j+1,type==='trigger'&&(temporary||maintenance)?'observe':maintenance?'index':'write');
    }
   }
  }
  if(schemaLifecycle&&t[i]==='drop'&&t[i+1]==='trigger')relation(i+2+(t[i+2]==='if'?2:0),'drop-trigger');
  if(['drop','alter'].includes(t[i])&&['table','view'].includes(t[i+1]))relation(i+2+(t[i+2]==='if'?2:0),maintenance?t[i]:'write');
 }
 return {accesses:[...new Map(accesses.map(value=>[JSON.stringify(value),value])).values()],created};
}

/** Resolve only immutable lexical constants and finite literal branches. Unknown
 * values are marked, never treated as an empty/approved SQL statement. */
export function sqlStatements(file,text,{finiteScopes=[]}={}){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 if(source.parseDiagnostics.length)throw Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText,' ')}`);
 const scopes=new WeakMap(),declarationsByScope=new WeakMap(),iterationNodes=new Map(),mutated=new Set(),aliases=[];
 const scopeFor=node=>{for(let p=node.parent;p;p=p.parent)if(ts.isSourceFile(p)||ts.isBlock(p)||ts.isFunctionLike(p)||ts.isCatchClause(p)||ts.isForStatement(p)||ts.isForInStatement(p)||ts.isForOfStatement(p))return p;return source;};
 const bind=(node,name,value)=>{if(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name)){for(const item of name.elements)if(ts.isBindingElement(item))bind(node,item.name,undefined);return;}if(!ts.isIdentifier(name))return;const scope=scopeFor(node),map=scopes.get(scope)??new Map();map.set(name.text,value);scopes.set(scope,map);const declarations=declarationsByScope.get(scope)??new Map();declarations.set(name.text,node);declarationsByScope.set(scope,declarations);};
 const declarations=node=>{
  if(ts.isVariableDeclaration(node)){bind(node,node.name,node.parent.flags&ts.NodeFlags.Const?node.initializer:undefined);if(ts.isIdentifier(node.name)&&node.initializer&&ts.isIdentifier(unwrap(node.initializer)))aliases.push([node.name.text,unwrap(node.initializer).text]);if(!node.initializer&&ts.isIdentifier(node.name)&&ts.isForOfStatement(node.parent.parent))iterationNodes.set(node,node.parent.parent.expression);}
  if(ts.isParameter(node))bind(node,node.name,undefined);
  if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name)bind(node,node.name,undefined);
  if(ts.isImportClause(node)&&node.name)bind(node,node.name,undefined);
  if(ts.isImportSpecifier(node)||ts.isNamespaceImport(node))bind(node,node.name,undefined);
  ts.forEachChild(node,declarations);
 };declarations(source);
 const declarationFor=node=>{for(let p=node.parent;p;p=p.parent)if(declarationsByScope.get(p)?.has(node.text))return declarationsByScope.get(p).get(node.text);};
 const rootName=node=>{while(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))node=node.expression;return ts.isIdentifier(node)?node.text:undefined;};
 const mutations=node=>{if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)mutated.add(rootName(node.left));if(ts.isDeleteExpression(node)||ts.isPostfixUnaryExpression(node)||ts.isPrefixUnaryExpression(node)&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator))mutated.add(rootName(node.expression??node.operand));if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['push','pop','shift','unshift','splice','sort','reverse','fill','copyWithin','set','delete','clear','add'].includes(node.expression.name.text))mutated.add(rootName(node.expression.expression));if(ts.isCallExpression(node)&&!(ts.isPropertyAccessExpression(node.expression)&&node.expression.expression.getText(source)==='Object'&&node.expression.name.text==='entries'))for(const argument of node.arguments)if(ts.isIdentifier(argument))mutated.add(argument.text);ts.forEachChild(node,mutations);};mutations(source);
 for(let changed=true;changed;){changed=false;for(const [left,right] of aliases)if(mutated.has(left)||mutated.has(right)){if(!mutated.has(left)||!mutated.has(right))changed=true;mutated.add(left);mutated.add(right);}}
 const binding=node=>{for(let p=node.parent;p;p=p.parent)if(scopes.get(p)?.has(node.text))return scopes.get(p).get(node.text);};
 const combine=(left,right)=>left.length*right.length>64?['__dynamic__']:left.flatMap(a=>right.map(b=>a+b));
 const literal=(node,seen=new Set(),environment=new Map(),helpers=false)=>{
  node=unwrap(node);if(!node||seen.has(node))return ['__dynamic__'];seen.add(node);
  const next=(value,env=environment)=>literal(value,new Set(seen),env,helpers);
  if(ts.isStringLiteralLike(node))return [node.text];
  if(helpers&&ts.isNumericLiteral(node))return [node.text];
  if(helpers&&ts.isPrefixUnaryExpression(node)&&[ts.SyntaxKind.MinusToken,ts.SyntaxKind.PlusToken].includes(node.operator)&&ts.isNumericLiteral(node.operand))return [(node.operator===ts.SyntaxKind.MinusToken?'-':'+')+node.operand.text];
  if(ts.isIdentifier(node)){
   if(environment.has(node.text))return environment.get(node.text);
   if(helpers&&mutated.has(node.text))return ['__dynamic__'];
   const value=binding(node);if(value)return next(value);
   if(helpers){
    const declaration=declarationFor(node);
    if(declaration&&iterationNodes.has(declaration))return next(iterationNodes.get(declaration));
    // Only the explicitly selected lifecycle scope consumes finite parameter
    // types. Its DROP targets are checked against its actual owned objects.
    if(declaration&&ts.isParameter(declaration)&&declaration.type&&ts.isUnionTypeNode(declaration.type)&&declaration.type.types.every(type=>ts.isLiteralTypeNode(type)&&ts.isStringLiteral(type.literal)))return declaration.type.types.map(type=>type.literal.text);
   }
   return ['__dynamic__'];
  }
  if(helpers&&ts.isArrayLiteralExpression(node))return node.elements.flatMap(element=>next(element));
  if(ts.isConditionalExpression(node))return [...next(node.whenTrue),...next(node.whenFalse)];
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return combine(next(node.left),next(node.right));
  if(ts.isTemplateExpression(node))return node.templateSpans.reduce((values,span)=>combine(values,next(span.expression)).map(value=>value+span.literal.text),[node.head.text]);
  if(helpers&&ts.isCallExpression(node)){
   if(ts.isIdentifier(node.expression)){
    const fn=unwrap(binding(node.expression))??declarationFor(node.expression);
    let body=fn&&(ts.isArrowFunction(fn)||ts.isFunctionDeclaration(fn))?fn.body:undefined;
    if(body&&ts.isBlock(body))body=body.statements.length===1&&ts.isReturnStatement(body.statements[0])?body.statements[0].expression:undefined;
    if(body&&!fn.asteriskToken&&!fn.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)&&node.arguments.length<=fn.parameters.length&&!node.arguments.some(ts.isSpreadElement)&&fn.parameters.every(parameter=>ts.isIdentifier(parameter.name)&&!parameter.dotDotDotToken)){
     const env=new Map(environment);
     for(const [index,parameter] of fn.parameters.entries())env.set(parameter.name.text,next(node.arguments[index]??parameter.initializer));
     return next(body,env);
    }
   }
   // The existing finite CASE helper: Object.entries(constObject).map(
   // ([name,value])=>literalTemplate).join(literalSeparator). Never execute JS.
   const join=node.expression;
   if(ts.isPropertyAccessExpression(join)&&join.name.text==='join'&&node.arguments.length===1&&ts.isCallExpression(join.expression)){
    const map=join.expression,mapCall=map.expression;
    if(ts.isPropertyAccessExpression(mapCall)&&mapCall.name.text==='map'&&map.arguments.length===1){
     const fn=map.arguments[0],receiver=mapCall.expression;
     const array=ts.isIdentifier(receiver)?unwrap(binding(receiver)):unwrap(receiver);
     if(array&&ts.isArrayLiteralExpression(array)&&(!ts.isIdentifier(receiver)||!mutated.has(receiver.text))&&fn&&ts.isArrowFunction(fn)&&!ts.isBlock(fn.body)&&!fn.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)&&fn.parameters.length===1&&ts.isIdentifier(fn.parameters[0].name)){
      const pieces=[];
      for(const item of array.elements){const values=next(item);if(values.length!==1)return ['__dynamic__'];const env=new Map(environment);env.set(fn.parameters[0].name.text,values);const value=next(fn.body,env);if(value.length!==1)return ['__dynamic__'];pieces.push(value[0]);}
      const separator=next(node.arguments[0]);if(separator.length===1)return [pieces.join(separator[0])];
     }
     const entries=mapCall.expression,object=ts.isCallExpression(entries)?entries.arguments[0]:undefined;
     if(ts.isCallExpression(entries)&&entries.arguments.length===1&&ts.isPropertyAccessExpression(entries.expression)&&entries.expression.expression.getText(source)==='Object'&&!mutated.has('Object')&&!mutated.has('Array')&&!declarationFor(entries.expression.expression)&&entries.expression.name.text==='entries'&&object&&ts.isIdentifier(object)&&!mutated.has(object.text)&&fn&&ts.isArrowFunction(fn)&&!ts.isBlock(fn.body)&&!fn.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)&&fn.parameters.length===1&&ts.isArrayBindingPattern(fn.parameters[0].name)){
      const values=unwrap(binding(object)),names=fn.parameters[0].name.elements;
      if(values&&ts.isObjectLiteralExpression(values)&&names.length===2&&names.every(name=>ts.isBindingElement(name)&&ts.isIdentifier(name.name))){
       const pieces=[];
       for(const property of values.properties){
        if(!ts.isPropertyAssignment(property)||!ts.isIdentifier(property.name)&&!ts.isStringLiteral(property.name))return ['__dynamic__'];
        const number=next(property.initializer);if(number.length!==1||!/^[-+]?\d+(?:\.\d+)?$/.test(number[0]))return ['__dynamic__'];
        const env=new Map(environment);env.set(names[0].name.text,[property.name.text]);env.set(names[1].name.text,next(property.initializer));
        const value=next(fn.body,env);if(value.length!==1)return ['__dynamic__'];pieces.push(value[0]);
       }
       const separator=next(node.arguments[0]);if(separator.length===1)return [pieces.join(separator[0])];
      }
     }
    }
   }
  }
  return ['__dynamic__'];
 };
 const statements=[],sinkArguments=new Set();
 const record=(node,expression,sink=false)=>{
  let fn;for(let p=node.parent;p;p=p.parent)if(ts.isFunctionDeclaration(p)){fn=p.name?.text;break;}
  let scope,scopeNode;for(let p=node.parent;p;p=p.parent){if(ts.isConstructorDeclaration(p)&&ts.isClassDeclaration(p.parent)){scope=p.parent.name?.text+'.constructor';scopeNode=p;break;}if(ts.isFunctionDeclaration(p)){scope=p.name?.text;scopeNode=p;break;}if(ts.isMethodDeclaration(p)&&ts.isClassDeclaration(p.parent)){scope=p.parent.name?.text+'.'+p.name.getText(source);scopeNode=p;break;}}
  const helpers=sink&&finiteScopes.includes(scope);let environments=[new Map()];
  if(helpers)for(let parent=node.parent;parent;parent=parent.parent)if(ts.isForOfStatement(parent)&&ts.isVariableDeclarationList(parent.initializer)&&parent.initializer.declarations.length===1&&ts.isIdentifier(parent.initializer.declarations[0].name)){
   const name=parent.initializer.declarations[0].name.text;
   environments=environments.flatMap(environment=>(mutated.has(name)?['__dynamic__']:literal(parent.expression,new Set(),environment,true)).map(value=>new Map([...environment,[name,[value]]])));
   if(environments.length>64)environments=[new Map([[name,['__dynamic__']]])];
  }
  const values=[...new Set(environments.flatMap(environment=>literal(expression,new Set(),environment,helpers)))],dynamic=values.some(value=>value.includes('__dynamic__'));
  // An unresolved call is frozen to its enclosing lexical body as well. An
  // edit to a helper cannot silently reuse a generic `prepare(sql)` exception.
  let context=node; if(dynamic)for(let p=node.parent;p;p=p.parent)if(ts.isFunctionLike(p)||ts.isSourceFile(p)){context=p;break;}
  let callback=false;if(sink)for(let p=node.parent;p;p=p.parent){if(ts.isFunctionDeclaration(p)||ts.isConstructorDeclaration(p)||ts.isMethodDeclaration(p))break;if(ts.isFunctionLike(p)){callback=true;break;}}
  statements.push({sink,callback,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,fn,scope,scopeFingerprint:hash((scopeNode??source).getText(source)),expression:expression?.getText(source)??'<missing>',values,
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
   if(node.arguments.length&&sink(node.expression)){sinkArguments.add(node.arguments[0]);record(node,node.arguments[0],true);}
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

/** Follow only direct, same-file, one-db-argument construction helpers.
 * A helper cannot also escape or acquire a runtime caller and retain this path. */
function installerContexts(file,text,installation){
 const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),definitions=new Map();
 const definitionsVisit=node=>{if(ts.isFunctionDeclaration(node)&&node.name)definitions.set(node.name.text,node);ts.forEachChild(node,definitionsVisit);};definitionsVisit(source);
 const contexts=[],calls=new Set(),active=new Set();
 const visitFunction=(name,path)=>{
  if(active.has(name))throw Error(`${file}: recursive schema helper is not supported`);
  if(contexts.some(context=>context.fn===name))throw Error(`${file}: schema db helper must have one concrete construction call`);
  const fn=definitions.get(name);if(!fn?.body||fn.parameters.length!==1||!ts.isIdentifier(fn.parameters[0].name))throw Error(`${file}: schema helper must receive only its explicit db parameter`);
  active.add(name);contexts.push({fn:name,callPath:path});
  const visit=node=>{
   if(node!==fn&&ts.isFunctionLike(node))return;
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&definitions.has(node.expression.text)&&node.arguments.length===1&&ts.isIdentifier(node.arguments[0])&&node.arguments[0].text===fn.parameters[0].name.text){calls.add(node);visitFunction(node.expression.text,[...path,node.expression.text]);}
   ts.forEachChild(node,visit);
  };visit(fn);active.delete(name);
 };
 visitFunction(installation.fn,[installation.declaration,installation.fn]);
 for(const context of contexts){
  const fn=definitions.get(context.fn),db=fn.parameters[0].name.text;
  const validateDb=node=>{
   if(node!==fn&&ts.isFunctionLike(node))return;
   if(ts.isIdentifier(node)&&node.text===db){const parent=node.parent;
    if(ts.isParameter(parent)&&parent.name===node){}
    else if(ts.isPropertyAccessExpression(parent)&&parent.expression===node&&['exec','prepare'].includes(parent.name.text)&&ts.isCallExpression(parent.parent)&&parent.parent.expression===parent){}
    else if(ts.isCallExpression(parent)&&parent.arguments[0]===node&&calls.has(parent)){}
    else throw Error(`${file}: schema db parameter cannot be reassigned, aliased or escape its direct construction path`);
   }
   ts.forEachChild(node,validateDb);
  };validateDb(fn);
 }
 const helpers=new Set(contexts.slice(1).map(context=>context.fn));
 const validate=node=>{
  if(ts.isFunctionDeclaration(node)&&node.name?.text===installation.fn&&node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))throw Error(`${file}: schema installer cannot escape its registered declaration`);
  if(ts.isIdentifier(node)&&node.text===installation.fn){
   const parent=node.parent;let declaration=parent;
   while(declaration&&!ts.isVariableDeclaration(declaration)&&!ts.isSourceFile(declaration))declaration=declaration.parent;
   const registered=ts.isPropertyAssignment(parent)&&parent.name.getText(source)==='install'&&parent.initializer===node&&declaration&&ts.isVariableDeclaration(declaration)&&ts.isIdentifier(declaration.name)&&declaration.name.text===installation.declaration;
   if(!(ts.isFunctionDeclaration(parent)&&parent.name===node)&&!registered)throw Error(`${file}: schema installer cannot acquire another runtime call path`);
  }
  if(ts.isFunctionDeclaration(node)&&node.name&&helpers.has(node.name.text)&&node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))throw Error(`${file}: schema db helper cannot escape its installer path`);
  if(ts.isIdentifier(node)&&helpers.has(node.text)){
   const parent=node.parent;
   if(ts.isFunctionDeclaration(parent)&&parent.name===node){}
   else if(ts.isCallExpression(parent)&&parent.expression===node&&calls.has(parent)){}
   else throw Error(`${file}: schema db helper cannot inherit installer authority at another call path`);
  }
  ts.forEachChild(node,validate);
 };validate(source);return contexts;
}

/** A lifecycle's finite schema parameter is supported by actual production
 * call literals, not by a type assertion alone. Taking the function as a value
 * or passing a computed schema fails until that call boundary can be proved. */
function validateProjectionLifecycleCalls(sources,projections){
 for(const projection of projections)for(const name of projection.lifecycleScopes){
  const target=prefix+projection.file,definition=ts.createSourceFile(target,sources.get(target)??'',ts.ScriptTarget.Latest,true);let parameters;
  const find=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)parameters=node.parameters;ts.forEachChild(node,find);};find(definition);
  if(!parameters)throw Error(`${target}: missing projection lifecycle ${name}`);
  const finite=parameters.flatMap((parameter,index)=>parameter.type&&ts.isUnionTypeNode(parameter.type)&&parameter.type.types.every(type=>ts.isLiteralTypeNode(type)&&ts.isStringLiteral(type.literal))?[{index,values:parameter.type.types.map(type=>type.literal.text)}]:[]);
  let calls=0;
  for(const [file,text] of sources){
   if(!text.includes(name)&&!text.includes(projection.file.replace(/\.ts$/,'.js')))continue;
   const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),names=new Set(file===target?[name]:[]),namespaces=new Set();
   for(const node of source.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&resolve(dirname(file),node.moduleSpecifier.text.replace(/\.js$/,'.ts'))===resolve(target)){
    const imported=node.importClause?.namedBindings;
    if(imported&&ts.isNamedImports(imported))for(const item of imported.elements)if((item.propertyName??item.name).text===name)names.add(item.name.text);
    if(imported&&ts.isNamespaceImport(imported))namespaces.add(imported.name.text);
   }
   const validate=call=>{calls++;for(const {index,values} of finite){const argument=call.arguments[index];if(!argument||!ts.isStringLiteralLike(argument)||!values.includes(argument.text))throw Error(`${file}: projection lifecycle ${name} requires a proved literal schema argument`);}};
   const visit=node=>{
    if(ts.isIdentifier(node)&&names.has(node.text)){
     const parent=node.parent;
     if(ts.isImportSpecifier(parent)||ts.isFunctionDeclaration(parent)&&parent.name===node||ts.isPropertyAccessExpression(parent)&&parent.name===node){}
     else if(ts.isCallExpression(parent)&&parent.expression===node)validate(parent);
     else throw Error(`${file}: projection lifecycle ${name} cannot escape its checked call boundary`);
    }
    if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&namespaces.has(node.expression.text)&&node.name.text===name){
     if(ts.isCallExpression(node.parent)&&node.parent.expression===node)validate(node.parent);
     else throw Error(`${file}: projection lifecycle ${name} cannot escape its checked call boundary`);
    }
    ts.forEachChild(node,visit);
   };visit(source);
  }
  if(!calls)throw Error(`${target}: projection lifecycle has no proved production calls`);
 }
}

export function ownershipInventory(root='.',configuration=policy){
 root=resolve(root);const sources=new Map(files(resolve(root,prefix)).map(file=>[slash(relative(root,file)),readFileSync(file,'utf8')]));
 validateProjectionLifecycleCalls(sources,configuration.projections??[]);
 const finiteNames=new Set(configuration.finiteInstallations??[]),registered=new Map();
 for(const [name,names] of Object.entries(configuration.installations)){
  const file=prefix+name,text=sources.get(file);if(text===undefined)throw Error(`Missing SQL owner source: ${file}`);
  registered.set(file,installerDeclarations(file,text,names).map(installation=>({...installation,finite:finiteNames.has(installation.declaration),contexts:finiteNames.has(installation.declaration)?installerContexts(file,text,installation):[{fn:installation.fn,callPath:[installation.declaration,installation.fn]}]})));
 }
 const statements=new Map([...sources].map(([file,text])=>[file,sqlStatements(file,text,{finiteScopes:[...(configuration.projections??[]).filter(item=>prefix+item.file===file).flatMap(item=>[item.scope,...item.lifecycleScopes]),...(registered.get(file)??[]).filter(item=>item.finite).flatMap(item=>item.contexts.map(context=>context.fn))]})]));
 const owners=[],tables={},functions=new Map(),projectionScopes=new Map(),projectionObjects=new Map();
 for(const [file,installations] of registered){
  for(const installation of installations){
   const {finite,contexts,...declaration}=installation;
   owners.push({...declaration,file,...(contexts.length>1?{callPaths:contexts.map(context=>context.callPath)}:{})});
   for(const context of contexts)functions.set(file+'#'+context.fn,{owner:installation.owner,installer:installation.declaration,callPath:context.callPath,finite});
   const body=statements.get(file).filter(statement=>contexts.some(context=>context.fn===statement.fn)&&(!finite||statement.sink&&!statement.callback));
   if(!body.length)throw Error(`${file}: installer ${installation.fn} has no visible SQL`);
   for(const statement of body)for(const sql of statement.values){
    if(sql.includes('__dynamic__'))throw Error(`${file}: schema owner SQL must be static`);
    for(const object of sqlAccesses(sql).created){projectionObjects.set(object.name,installation.owner);if(['table','view'].includes(object.type)){
     if(tables[object.name]&&tables[object.name].owner!==installation.owner)throw Error(`Duplicate SQL table owner: ${object.name}`);
     tables[object.name]={owner:installation.owner,file,installer:installation.declaration};
    }}
   }
  }
 }
 for(const projection of configuration.projections??[]){
  const file=prefix+projection.file,activationFile=prefix+projection.activationFile,activationText=sources.get(activationFile);
  if(activationText===undefined)throw Error(`Missing projection activation source: ${activationFile}`);
  const activationSource=ts.createSourceFile(activationFile,activationText,ts.ScriptTarget.Latest,true);let feature;
  const find=node=>{if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text===projection.activation){let value=unwrap(node.initializer);if(value&&ts.isCallExpression(value))value=value.expression.getText(activationSource)==='Object.freeze'?unwrap(value.arguments[0]):undefined;if(value&&ts.isObjectLiteralExpression(value)){const activation=value.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(activationSource)==='activation');const body=unwrap(activation?.initializer);const property=body&&ts.isObjectLiteralExpression(body)&&body.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(activationSource)==='featureId');const id=unwrap(property?.initializer);if(id&&ts.isStringLiteral(id))feature=id.text;}}ts.forEachChild(node,find);};find(activationSource);
  if(feature!==projection.feature)throw Error(`${file}: projection must name its actual production feature activation`);
  const body=statements.get(file)?.filter(statement=>statement.scope===projection.scope);if(!body?.length)throw Error(`${file}: missing production projection construction scope`);
  const objects=new Map();
  for(const statement of body)for(const sql of statement.values)for(const object of sqlAccesses(sql).created){
   if(object.name.includes('__dynamic__'))throw Error(`${file}: projection object names must be static`);
   objects.set(object.type+':'+object.name,object);
   if(['table','view'].includes(object.type)){
    if(tables[object.name]&&tables[object.name].owner!==projection.owner)throw Error(`Duplicate SQL table owner: ${object.name}`);
    tables[object.name]={owner:projection.owner,file,installer:projection.scope};
   }
   projectionObjects.set(object.name,projection.owner);
  }
  owners.push({owner:projection.owner,file,declaration:projection.scope,feature,activationFile,activation:projection.activation,objects:[...objects.values()]});
  for(const scope of [projection.scope,...projection.lifecycleScopes])projectionScopes.set(file+'#'+scope,projection.owner);
 }
 const issues=[],uncoveredFiles=new Set(),uncoveredTables=new Set(),coveredFiles=new Set();
 let dynamicStatements=0;
 for(const [file,items] of statements)for(const statement of items){
  const registeredContext=functions.get(file+'#'+statement.fn),context=registeredContext&&(!registeredContext.finite||statement.sink&&!statement.callback)?registeredContext:undefined;
  const owner=projectionScopes.get(file+'#'+statement.scope)??context?.owner??configuration.consumers[file.slice(prefix.length)];
  const add=(rule,to,kind)=>{
   const operations=rule==='sql-cross-owner'?[...new Set(statement.values.flatMap(sql=>sqlAccesses(sql,{maintenance:true}).accesses).filter(access=>access.table===to&&(kind==='read'?access.kind==='read':access.kind!=='read')).map(access=>access.kind))]:[];
   issues.push({rule,from:file,to,kind,symbol:statement.fingerprint,scope:statement.scope,scopeFingerprint:statement.scopeFingerprint,...(operations.length?{operation:operations.length===1?operations[0]:undefined,completeSql:statement.values.every(sql=>!sql.includes('__dynamic__'))}:{}),line:statement.line});
  };
  if(!owner){uncoveredFiles.add(file);add('sql-uncovered-consumer','[owner pending]','coverage');}
  else coveredFiles.add(file);
  if(owner&&!owners.some(item=>item.owner===owner))throw Error(`${file}: consumer owner ${owner} has no production installer`);
  if(statement.values.some(sql=>sql.includes('__dynamic__')))dynamicStatements++;
  for(const sql of statement.values){
   if(owner&&sql.includes('__dynamic__'))add('sql-dynamic','[unproved SQL]','dynamic');
   const accesses=sqlAccesses(sql,{schemaLifecycle:projectionScopes.has(file+'#'+statement.scope),maintenance:context?.finite===true}).accesses;
   const sourceRelations=[...new Set(accesses.filter(access=>access.kind==='observe').map(access=>access.table))].sort();
   for(const access of accesses){
    if(access.table.startsWith('sqlite_'))continue; // SQLite's own schema, never domain data.
    if(access.table.includes('__dynamic__'))continue;
    const target=access.kind==='drop-trigger'?projectionObjects.get(access.table):tables[access.table]?.owner;
    if(context?.finite){if(!target)uncoveredTables.add(access.table);if(target!==owner)issues.push({rule:'sql-schema-maintenance',from:file,to:access.table,kind:access.kind,symbol:hash(sql),statementFingerprint:statement.fingerprint,installer:context.installer,callPath:context.callPath,sourceRelations,line:statement.line});continue;}
    if(!target){uncoveredTables.add(access.table);if(owner)add(sql.includes('__dynamic__')?'sql-unproved-relation':'sql-uncovered-table',access.table,access.kind);}
    else if(owner&&target!==owner)add('sql-cross-owner',access.table,access.kind);
   }
  }
 }
 const unique=[...new Map(issues.map(issue=>[issueKey(issue),issue])).values()].sort((a,b)=>issueKey(a).localeCompare(issueKey(b)));
 return {dynamicStatements,owners,tables:Object.fromEntries(Object.entries(tables).sort()),coveredFiles:[...coveredFiles].sort(),uncoveredFiles:[...uncoveredFiles].sort(),uncoveredTables:[...uncoveredTables].sort(),issues:unique};
}
export const issueKey=issue=>JSON.stringify([issue.rule,issue.from,issue.to,issue.kind,issue.symbol,...(issue.rule==='sql-schema-maintenance'?[issue.installer,issue.callPath,issue.sourceRelations,issue.statementFingerprint]:[])]);
export function checkSqlOwnership(root='.',{configuration=policy,baseline}={}){
 const inventory=ownershipInventory(root,configuration);
 const grants=configuration.sharedReads.map(grant=>{
  if(grant.kind!==undefined&&grant.kind!=='read')throw Error('Shared SQL models only grant reads');
  return {...grant,rule:'sql-cross-owner',kind:'read'};
 });
 for(const grant of configuration.sharedObservations??[]){if(grant.kind!==undefined&&grant.kind!=='observe')throw Error('Shared SQL subscriptions only grant observations');grants.push({...grant,rule:'sql-cross-owner',kind:'observe'});}
 for(const grant of configuration.schemaMaintenance??[]){if(!['read','observe','index','insert','update','delete'].includes(grant.kind)||!grant.installer||!grant.callPath?.length||!Array.isArray(grant.sourceRelations)||!/^[a-f0-9]{64}$/.test(grant.statementFingerprint??''))throw Error('Schema maintenance requires an installer, concrete call path and exact operation');grants.push({...grant,rule:'sql-schema-maintenance'});}
 const rawDebt=baseline??JSON.parse(readFileSync(resolve(root,'scripts/ci/sql-ownership-baseline.json'),'utf8'));
 const debt=rawDebt.flatMap(({symbols,...item})=>symbols?symbols.map(symbol=>({...item,symbol})):[item]);
 const generated={owners:inventory.owners,tables:inventory.tables};
 if(baseline===undefined&&JSON.stringify(generated)!==JSON.stringify(JSON.parse(readFileSync(resolve(root,'scripts/ci/sql-ownership-map.json'),'utf8'))))throw Error('SQL ownership map is stale; inspect --map output and update the generated map');
 const allowed=new Map();
 for(const item of [...debt,...grants]){
  if(!item.reason?.trim()||!/^([a-f0-9]{64})$/.test(item.symbol)||allowed.has(issueKey(item)))throw Error('SQL exceptions require a reason, unique statement fingerprint and concrete access');
  allowed.set(issueKey(item),item);
 }
 // A newly known table owner refines an existing unresolved access into a
 // cross-owner diagnosis. Retain that exact debt without rewriting the ledger;
 // no other file, SQL, relation, access kind or schema-maintenance path matches.
 const match=issue=>{
  if(allowed.has(issueKey(issue)))return allowed.get(issueKey(issue));
  if(issue.rule==='sql-cross-owner'&&['read','write'].includes(issue.kind))for(const rule of ['sql-uncovered-table','sql-unproved-relation']){
   const entry=allowed.get(issueKey({...issue,rule}));
   const witness=(configuration.retainedClassificationScopes??[]).find(item=>issueKey({...item,rule})===issueKey({...issue,rule})&&item.scope===issue.scope&&item.scopeFingerprint===issue.scopeFingerprint&&item.operation===issue.operation&&(issue.kind!=='write'||item.completeSql===true&&issue.completeSql===true));
   if(entry&&witness&&entry.to&&entry.kind===issue.kind&&(issue.kind==='read'?issue.operation==='read':['insert','update','delete'].includes(issue.operation))&&/^[a-f0-9]{64}$/.test(entry.symbol))return entry;
  }
 };
 const matched=inventory.issues.map(issue=>({issue,exception:match(issue)})),present=new Set(matched.filter(item=>item.exception).map(item=>issueKey(item.exception)));
 return {...inventory,violations:matched.filter(item=>!item.exception).map(item=>item.issue),exceptions:matched.filter(item=>item.exception).map(item=>item.issue),retainedClassificationDebt:matched.filter(item=>item.exception&&item.issue.rule!==item.exception.rule).map(item=>({issue:item.issue,originalRule:item.exception.rule})),stale:[...debt,...grants].filter(item=>!present.has(issueKey(item)))};
}
export const sqlOwnershipSummary=result=>{
 const projections=result.owners.filter(owner=>owner.feature).length;
 return `SQL ownership: ${result.owners.length-projections} schema owners + ${projections} scoped projection owner(s), ${Object.keys(result.tables).length} tables/views, ${result.coveredFiles.length} files with covered SQL scopes; PARTIAL coverage: ${result.uncoveredFiles.length} files with pending consumers, ${result.uncoveredTables.length} referenced relations pending, ${result.dynamicStatements} unproved SQL statements. ${result.exceptions.length} concrete existing exceptions (${result.retainedClassificationDebt?.length??0} retained classification debts).`;
};
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
