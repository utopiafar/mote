import {readFileSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {builtinModules} from 'node:module';
import {dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const sourceDirectories=['packages/agent/src','packages/shared/src','packages/plugin-api/src','packages/plugin-host/src','packages/plugin-sdk/src','apps/server/src','apps/desktop/src','apps/web/src'];
const sourceExtension=/\.(?:[cm]?[jt]sx?)$/;
const builtinNames=new Set(builtinModules.flatMap(name=>[name,name.replace(/^node:/,'')]));
const nodeBuiltin=name=>name.startsWith('node:')||builtinNames.has(name);
const slash=value=>value.replaceAll('\\','/');
const inside=(file,directory)=>file.startsWith(directory+'/');
const key=edge=>JSON.stringify([edge.rule,edge.from,edge.to,edge.kind,edge.symbol??'']);

function sourceFiles(directory){
  if(!existsSync(directory))return [];
  return readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.name!=='node_modules').flatMap(entry=>entry.isDirectory()?sourceFiles(resolve(directory,entry.name)):sourceExtension.test(entry.name)?[resolve(directory,entry.name)]:[]);
}

/** Parse dependency syntax, retaining erased type edges separately from runtime edges. */
export function moduleReferences(file,text){
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  if(source.parseDiagnostics.length)throw Error(`${file}: ${ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText,' ')}`);
  const references=[];
  const add=(node,specifier,kind,bindings)=>{
    if(specifier===undefined)return;
    references.push({specifier,kind:source.isDeclarationFile?'type':kind,bindings,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
  };
  const scopes=new WeakMap();
  const scopeFor=node=>{
    for(let parent=node.parent;parent;parent=parent.parent)
      if(ts.isSourceFile(parent)||ts.isBlock(parent)||ts.isFunctionLike(parent)||ts.isModuleBlock(parent)||ts.isCatchClause(parent))return parent;
    return source;
  };
  const bind=(node,name,value)=>{
    if(!ts.isIdentifier(name))return;
    const scope=scopeFor(node),bindings=scopes.get(scope)??new Map();scopes.set(scope,bindings);bindings.set(name.text,value);
  };
  const declarations=node=>{
    if(ts.isVariableDeclaration(node))bind(node,node.name,node.parent.flags&ts.NodeFlags.Const?node.initializer:undefined);
    if(ts.isParameter(node))bind(node,node.name,undefined);
    if(ts.isImportClause(node)&&node.name)bind(node,node.name,undefined);
    if(ts.isImportSpecifier(node)||ts.isNamespaceImport(node))bind(node,node.name,undefined);
    ts.forEachChild(node,declarations);
  };
  declarations(source);
  const binding=node=>{
    for(let parent=node.parent;parent;parent=parent.parent){
      const bindings=scopes.get(parent);
      if(bindings?.has(node.text))return {found:true,value:bindings.get(node.text)};
    }
    return {found:false};
  };
  const literal=(node,seen=new Set())=>{
    if(!node||seen.has(node))return undefined;seen.add(node);
    if(ts.isStringLiteralLike(node))return node.text;
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isTypeAssertionExpression(node))return literal(node.expression,seen);
    if(ts.isIdentifier(node))return literal(binding(node).value,seen);
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken){
      const left=literal(node.left,new Set(seen)),right=literal(node.right,new Set(seen));
      if(left!==undefined&&right!==undefined)return left+right;
    }
  };
  const requireCall=(node,seen=new Set())=>{
    if(!ts.isIdentifier(node)||seen.has(node))return false;seen.add(node);
    const bound=binding(node);
    return bound.found?bound.value&&requireCall(bound.value,seen):node.text==='require';
  };
  const importedBindings=clause=>{
    if(!clause)return {names:[],whole:false};
    const named=clause.namedBindings,names=clause.name?['default']:[];
    if(named&&ts.isNamedImports(named))names.push(...named.elements.map(element=>(element.propertyName??element.name).text));
    return {names,whole:named!==undefined&&ts.isNamespaceImport(named)};
  };
  const exportedBindings=named=>{
    if(!named||ts.isNamespaceExport(named))return {names:[],whole:true};
    return {names:ts.isNamedExports(named)?named.elements.map(element=>(element.propertyName??element.name).text):[],whole:false};
  };
  const typeReferenceName=qualifier=>{
    let name=qualifier;
    while(name&&ts.isQualifiedName(name))name=name.left;
    return name&&ts.isIdentifier(name)?name.text:undefined;
  };
  const visit=node=>{
    if(ts.isImportDeclaration(node)){
      const clause=node.importClause,named=clause?.namedBindings;
      const types=clause?.isTypeOnly||!clause?.name&&named&&ts.isNamedImports(named)&&named.elements.length>0&&named.elements.every(item=>item.isTypeOnly);
      add(node,literal(node.moduleSpecifier),types?'type':'runtime',importedBindings(clause));
    }else if(ts.isExportDeclaration(node)&&node.moduleSpecifier){
      const named=node.exportClause;
      const types=node.isTypeOnly||named&&ts.isNamedExports(named)&&named.elements.length>0&&named.elements.every(item=>item.isTypeOnly);
      add(node,literal(node.moduleSpecifier),types?'type':'runtime',exportedBindings(named));
    }else if(ts.isImportTypeNode(node)){
      if(ts.isLiteralTypeNode(node.argument)){
        const name=typeReferenceName(node.qualifier);
        add(node,literal(node.argument.literal),'type',name?{names:[name],whole:false}:{names:[],whole:true});
      }
    }else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)){
      add(node,literal(node.moduleReference.expression),node.isTypeOnly?'type':'runtime',{names:[],whole:true});
    }else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||requireCall(node.expression))){
      const specifier=literal(node.arguments[0]);
      if(specifier!==undefined)add(node,specifier,'runtime',{names:[],whole:true});
      else references.push({specifier:null,expression:node.arguments[0]?.getText(source)??'<missing>',kind:'runtime',line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  return references;
}

/** Resolve repository source without using built dist or another worktree's workspace symlinks. */
export function dependencyGraph(root){
  root=realpathSync(resolve(root));
  const files=sourceDirectories.flatMap(directory=>sourceFiles(resolve(root,directory)));
  const manifests=new Map();
  for(const directory of ['packages','apps']){
    if(!existsSync(resolve(root,directory)))continue;
    for(const entry of readdirSync(resolve(root,directory),{withFileTypes:true})){
      const folder=resolve(root,directory,entry.name),manifest=resolve(folder,'package.json');
      if(entry.isDirectory()&&existsSync(manifest)){
        const value=JSON.parse(readFileSync(manifest,'utf8'));
        if(value.name)manifests.set(value.name,{folder,value});
      }
    }
  }
  const sourcePath=file=>{
    const candidates=[file,file.replace(/\.d\.(c|m)?ts$/,(_,prefix)=>'.'+(prefix??'')+'ts'),file.replace(/\.(c|m)?js$/,(_,prefix)=>'.'+(prefix??'')+'ts'),file.replace(/\.jsx?$/,'.tsx'),resolve(file,'index.ts'),resolve(file,'index.tsx'),file+'.ts',file+'.tsx'];
    return candidates.find(candidate=>sourceExtension.test(candidate)&&existsSync(candidate));
  };
  const exported=value=>typeof value==='string'?value:value&&typeof value==='object'?exported(value.browser??value.import??value.default??value.require??value.types):undefined;
  const workspaceTarget=specifier=>{
    for(const [name,{folder,value}] of manifests){
      if(specifier!==name&&!specifier.startsWith(name+'/'))continue;
      const subpath=specifier===name?'.':'./'+specifier.slice(name.length+1);
      const declaration=value.exports;
      const rootExport=typeof declaration==='string'||declaration&&!Object.keys(declaration).some(key=>key.startsWith('.'))?declaration:undefined;
      const target=exported(declaration?.[subpath]??(subpath==='.'?rootExport??(!declaration?value.main:undefined):undefined));
      if(!target)return undefined;
      return sourcePath(resolve(folder,target.replace(/^(?:\.\/)?dist\//,'src/')));
    }
  };
  const configs=new Map();
  const optionsFor=file=>{
    const config=ts.findConfigFile(dirname(file),ts.sys.fileExists);
    if(!config)return {moduleResolution:ts.ModuleResolutionKind.Bundler};
    if(!configs.has(config)){
      const loaded=ts.readConfigFile(config,ts.sys.readFile);
      if(loaded.error)throw Error(`${config}: ${ts.flattenDiagnosticMessageText(loaded.error.messageText,' ')}`);
      const parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,dirname(config));
      const error=parsed.errors.find(error=>error.code!==18003); // Input discovery is not this graph's job.
      if(error)throw Error(`${config}: ${ts.flattenDiagnosticMessageText(error.messageText,' ')}`);
      configs.set(config,parsed.options);
    }
    return configs.get(config);
  };
  const name=file=>slash(relative(root,file));
  const nodes=new Map(),unresolved=[];
  const load=file=>{
    file=resolve(file);
    if(nodes.has(name(file)))return;
    const references=moduleReferences(file,readFileSync(file,'utf8'));
    const edges=[];nodes.set(name(file),edges);
    for(const reference of references){
      const specifier=reference.specifier;
      if(specifier===null){edges.push({...reference,from:name(file),to:'[dynamic] '+reference.expression});continue;}
      let target;
      if(nodeBuiltin(specifier))target=specifier;
      else{
        const resolved=workspaceTarget(specifier)??ts.resolveModuleName(specifier,file,optionsFor(file),ts.sys).resolvedModule?.resolvedFileName;
        // npm can place external dependencies below any workspace, not only at
        // the root. Explicit workspace exports above already map to owned src.
        if(resolved&&name(resolved).split('/').includes('node_modules'))continue;
        if(resolved&&!name(resolved).startsWith('../'))target=name(resolved);
      }
      if(!target){
        // External npm dependencies are outside this source-boundary check.
        const workspace=[...manifests.keys()].some(name=>specifier===name||specifier.startsWith(name+'/'));
        if(workspace||specifier.startsWith('.')&&!/\.(?:css|json|svg|png|jpg|webp)$/.test(specifier))unresolved.push({from:name(file),specifier,line:reference.line});
        continue;
      }
      edges.push({...reference,from:name(file),to:target});
      if(!nodeBuiltin(target))load(resolve(root,target));
    }
  };
  files.forEach(load);
  const browserEntries=[];
  // These are the established browser API entries, not every shared subpath.
  const browserExports=['.','./actions','./connection','./metadata','./feedback','./models','./capture-sessions','./i18n','./state-series','./execution','./native-status','./document-decoder','./protocol','./collector-receipt'];
  const shared=manifests.get('@mote/shared');
  if(shared)for(const entry of browserExports){
    if(!shared.value.exports?.[entry])throw Error(`Missing declared browser export @mote/shared${entry==='.'?'':entry.slice(1)}`);
    const target=workspaceTarget('@mote/shared'+(entry==='.'?'':entry.slice(1)));
    if(!target)throw Error(`Cannot resolve browser export ${entry} to source`);
    browserEntries.push(name(target));load(target);
  }
  const sdk=manifests.get('@mote/plugin-sdk');
  if(sdk){
    if(!sdk.value.exports?.['./browser'])throw Error('Missing declared browser export @mote/plugin-sdk/browser');
    const target=workspaceTarget('@mote/plugin-sdk/browser');
    if(!target)throw Error('Cannot resolve browser export @mote/plugin-sdk/browser to source');
    browserEntries.push(name(target));load(target);
  }
  browserEntries.push(...files.filter(file=>inside(name(file),'apps/web/src')).map(name));
  return {nodes,browserEntries,unresolved};
}

/** Runtime import cycles inside the Agent are ESM initialization-order bugs.
 * Erased type-only edges never participate in module evaluation. */
function agentRuntimeCycles(nodes){
  const directory='packages/agent/src';
  const issues=[],state=new Map(),stack=[];
  const visit=file=>{
    state.set(file,1);stack.push(file);
    for(const edge of nodes.get(file)??[]){
      if(edge.kind!=='runtime'||edge.specifier===null||!inside(edge.to,directory)||!nodes.has(edge.to))continue;
      const seen=state.get(edge.to);
      if(seen===1){
        const start=stack.indexOf(edge.to);
        issues.push({...edge,rule:'agent-import-cycle',chain:[...stack.slice(start),edge.to]});
      }else if(seen===undefined)visit(edge.to);
    }
    stack.pop();state.set(file,2);
  };
  for(const file of nodes.keys())if(inside(file,directory)&&state.get(file)===undefined)visit(file);
  return issues;
}

export function architectureViolations({nodes,browserEntries,unresolved=[]}){
  const issues=[];
  const desktopContract=file=>file==='apps/desktop/src/contracts.ts'||inside(file,'apps/desktop/src/contracts');
  for(const edges of nodes.values())for(const edge of edges){
    const runtime=edge.kind==='runtime';
    let rule;
    if(edge.specifier===null)rule='analyzable-module-reference';
    if(inside(edge.from,'packages/plugin-sdk/src')&&(inside(edge.to,'apps')||inside(edge.to,'packages/shared/src')||inside(edge.to,'packages/agent/src')||inside(edge.to,'packages/diagnostics/src')))rule='sdk-public-boundary';
    if(runtime&&inside(edge.from,'packages/agent/src')&&edge.to==='packages/agent/src/index.ts')rule='agent-no-assembly-import';
    if(runtime&&inside(edge.from,'apps/server/src')&&['apps/server/src/index.ts','apps/server/src/app.ts'].includes(edge.to)&&!(edge.from==='apps/server/src/index.ts'&&edge.to==='apps/server/src/app.ts'))rule='server-no-assembly-import';
    if(desktopContract(edge.from)&&inside(edge.to,'apps/desktop/src')&&!desktopContract(edge.to))rule='desktop-contract-leaf';
    if(runtime&&inside(edge.from,'apps/web/src')){
      const ownsAssembly=edge.from==='apps/web/src/main.tsx'||edge.from==='apps/web/src/boot.ts'&&edge.to==='apps/web/src/main.tsx';
      if(!ownsAssembly&&['apps/web/src/boot.ts','apps/web/src/main.tsx','apps/web/src/features/bootstrap.tsx','apps/web/src/features/bootstrap.ts'].includes(edge.to))rule='web-no-bootstrap-import';
    }
    if(runtime&&edge.from==='apps/web/src/features/runtime.tsx'&&['apps/web/src/features/entries.ts','apps/web/src/plugins/library/collections.tsx','apps/web/src/features/agent-view.tsx','apps/web/src/features/agent-view.ts'].includes(edge.to))rule='web-runtime-no-builtins';
    if(inside(edge.from,'apps/server/src/plugins')&&edge.to==='apps/server/src/store.ts'&&(edge.bindings?.whole||edge.bindings?.names.includes('Store')))rule='server-plugins-no-store';
    if(rule)issues.push({...edge,rule,...(rule==='server-plugins-no-store'?{symbol:edge.bindings?.whole?'*':'Store'}:{})});
  }
  issues.push(...agentRuntimeCycles(nodes));
  const visited=new Set();
  const visit=(file,chain)=>{
    if(visited.has(file))return;visited.add(file);
    for(const edge of nodes.get(file)??[]){
      if(edge.kind!=='runtime'||edge.specifier===null)continue;
      if(nodeBuiltin(edge.to))issues.push({...edge,rule:'browser-no-node',chain:[...chain,file,edge.to]});
      else visit(edge.to,[...chain,file]);
    }
  };
  browserEntries.forEach(entry=>visit(entry,[]));
  for(const edge of unresolved)issues.push({...edge,to:edge.specifier,kind:'unresolved',rule:'resolve-local-module'});
  return [...new Map(issues.map(issue=>[key(issue),issue])).values()].sort((a,b)=>key(a).localeCompare(key(b)));
}

export function checkArchitecture(root='.',baseline){
  root=resolve(root);
  const graph=dependencyGraph(root),issues=architectureViolations(graph);
  const exceptions=baseline??JSON.parse(readFileSync(resolve(root,'scripts/ci/architecture-baseline.json'),'utf8'));
  const allowed=new Map();
  for(const exception of exceptions){
    if(!exception.reason?.trim()||allowed.has(key(exception)))throw Error('Architecture exceptions require a reason and unique concrete edge');
    allowed.set(key(exception),exception);
  }
  const present=new Set(issues.map(key));
  return {files:graph.nodes.size,violations:issues.filter(issue=>!allowed.has(key(issue))),exceptions:issues.filter(issue=>allowed.has(key(issue))),stale:exceptions.filter(exception=>!present.has(key(exception)))};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=checkArchitecture();
    for(const issue of result.violations)console.error(`${issue.rule}: ${issue.from}:${issue.line} -> ${issue.to} (${issue.kind})${issue.chain?' via '+issue.chain.join(' -> '):''}`);
    for(const issue of result.stale)console.error(`Remove resolved architecture exception: ${issue.rule}: ${issue.from} -> ${issue.to} (${issue.kind})`);
    if(result.violations.length||result.stale.length)process.exitCode=1;
    else console.log(`Architecture boundaries passed (${result.files} source files, ${result.exceptions.length} concrete existing exceptions).`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
