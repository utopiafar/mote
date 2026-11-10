import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases,officialPluginLocalDirectory,pluginManifestSchema,type PluginReleaseTransport} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {OFFICIAL_PLUGIN_CATALOG,officialPluginCatalog} from '../src/official-plugin-catalog.js';
import {isOutboundExportCapability,outboundExportFromModule} from '../src/plugins/service-plugin-loader.js';
import {OutboundExportHost} from '../src/plugins/outbound-export-host.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const packageRoot=join(repoRoot,'official-plugins/markdown-export');
const official={repository:'mote/official-markdown-export',tag:'v0.1.0',packageId:'mote.official.markdown-export',localDirectory:'official-plugins/markdown-export'};
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for the in-repository Markdown exporter: '+url);};
}
function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+8000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}
function files(root:string):string[]{
  if(!existsSync(root))return [];
  const result:string[]=[];
  const walk=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const path=join(directory,entry.name);if(entry.isDirectory())walk(path);else result.push(path);}};
  walk(root);return result.sort();
}
function draft(sourceId:string,externalId:string,text:string,title='Generated note',kind='mote.note'):MaterialDraft{
  return {id:materialId(sourceId,externalId),kind,schemaVersion:1,title,
    origin:{sourceId,externalId,firstAt:'2026-11-01T00:00:00.000Z',lastAt:'2026-11-01T00:00:00.000Z'},
    members:[{id:'original',kind:'source-item',ref:'source-item:'+sourceId+':'+externalId,revision:'1'}],
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
}

test('the official catalog exposes a Markdown/Obsidian outbound package without leaking its local directory',()=>{
  const catalog=officialPluginCatalog();
  const entry=catalog.find(value=>value.packageId===official.packageId);
  assert.ok(entry);
  assert.equal(entry.repository,official.repository);
  assert.equal(entry.tag,official.tag);
  assert.equal(entry.name,'Markdown / Obsidian 导出');
  assert.equal(entry.group,'outbound-processing');
  assert.equal(entry.runtime,'service');
  assert.equal('localDirectory' in entry,false,'the repository-relative directory stays server-side');
  const internal=OFFICIAL_PLUGIN_CATALOG.find(value=>value.packageId===official.packageId);
  assert.equal(internal?.localDirectory,official.localDirectory);
  assert.equal(officialPluginLocalDirectory(repoRoot,official.localDirectory),join(repoRoot,official.localDirectory));

  const manifest=pluginManifestSchema.parse(JSON.parse(readFileSync(join(packageRoot,'mote-plugin.json'),'utf8')));
  assert.equal(manifest.id,official.packageId);
  assert.equal(manifest.runtime,'service');
  assert.equal(manifest.contributions?.[0]?.surface,'processing');
  assert.deepEqual(manifest.contributions?.[0]?.capabilities,['outbound.export']);
  assert.equal(manifest.capabilities.includes('source.connector'),false);
  assert.equal(manifest.capabilities.includes('message.send'),false);
  assert.equal(manifest.capabilities.includes('calendar.manage'),false);
  assert.equal(manifest.sourceCatalog,undefined,'an outbound package contributes no source card');
  assert.ok(manifest.configuration.some(field=>field.id==='targetFolder'));
  assert.ok(manifest.configuration.some(field=>field.id==='sourceIds'));
});

test('the package exports a declarative outbound contract and no inbound or Memory worker surface',async()=>{
  const module=await import(join(packageRoot,'plugin.mjs')) as Record<string,unknown>;
  const descriptor=outboundExportFromModule(module);
  assert.equal(descriptor.id,official.packageId);
  assert.deepEqual(descriptor.format,{extension:'md',frontmatter:'yaml',folder:'Mote'});
  assert.equal(isOutboundExportCapability('outbound.export'),true);
  assert.equal(isOutboundExportCapability('outbound.markdown'),true);
  assert.equal(isOutboundExportCapability('processing.pack'),false);
  assert.equal('connector' in module,false);
  assert.equal('backendPlugin' in module,false);
  assert.equal('createMemoryProvider' in module,false);
  assert.throws(()=>outboundExportFromModule({outboundExport:{apiVersion:1,id:official.packageId,format:{extension:'js',frontmatter:'yaml',folder:'Mote'}}}),/host contract/);
  assert.throws(()=>outboundExportFromModule({outboundExport:{apiVersion:1,id:official.packageId,format:{extension:'md',frontmatter:'yaml',folder:'../escape'}}}),/host contract/);
});

test('in-repository Markdown export resolves without GitHub, rejects wrong tags, installs without exporting, then follows its cursor',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mote-markdown-state-')),vault=mkdtempSync(join(tmpdir(),'mote-markdown-vault-')),githubCalls:string[]=[];
  t.after(()=>{rmSync(state,{recursive:true,force:true});rmSync(vault,{recursive:true,force:true});});
  const store=new Store(state),materials=new MaterialStore(store),plugins=new PluginCenter(store,new ExecutionEngine(store),
    new GitHubPluginReleases(join(state,'packages'),rejectingGitHub(githubCalls),repoRoot));
  const outbound=new OutboundExportHost({store,materials,repoRoot,dataDir:state,home:homedir(),sourceKind:()=>'custom',intervalMs:3_600_000});
  plugins.outboundHost=outbound;
  t.after(async()=>{await plugins.close();store.close();});
  const sourceId='generated-notes',screenId='generated-screen',codingId='generated-coding';
  const first=materials.publish(draft(sourceId,'one','Generated first body'));
  materials.publish(draft(sourceId,'two','Generated second body','Second note'));
  materials.publish(draft(screenId,'screen','Generated screenshot original','Screen capture','mote.screen-segment'));
  materials.publish(draft(codingId,'coding','Generated Coding transcript','Coding session','mote.coding-session'));

  let view=plugins.view();
  const catalog=view.catalog.find(value=>value.packageId===official.packageId);
  assert.ok(catalog);
  assert.equal('localDirectory' in catalog,false);
  const preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  assert.equal(preview.installable,true);
  assert.equal(preview.runtime,'service');
  assert.equal(JSON.stringify(preview).includes(official.localDirectory),false);
  assert.equal(githubCalls.length,0);
  await assert.rejects(plugins.resolve({repository:official.repository,tag:'v9.9.9'}),/pinned catalog release/);
  await assert.rejects(plugins.resolve({repository:official.repository,tag:official.tag,localDirectory:official.localDirectory}),/Unrecognized key|Invalid input|validation/i);
  assert.equal(githubCalls.length,0);

  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','Markdown export install');
  assert.equal(plugins.view().instances.length,0,'install creates no instance, enables nothing and writes nothing');

  const target=join(vault,'Obsidian Vault');
  const instance=plugins.configure(undefined,{packageId:plugins.view().packages[0]!.id,name:'Markdown export',scope:'default',
    configuration:{targetFolder:target,sourceIds:[sourceId,screenId,codingId].join(', ')},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  assert.equal(instance.observed,'configured');
  assert.equal(existsSync(target),false);
  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='ready','Markdown export check');
  const checked=plugins.instanceView(instance.id);
  assert.ok(checked.capabilities.some(value=>value.id==='outbound.export'&&value.state==='verified'));
  assert.equal(checked.issues.length,0);
  assert.equal(existsSync(target),false,'check does not create the target or write a file');

  plugins.action(instance.id,'enable',{expectedRevision:checked.revision,operationId:randomUUID()});
  await waitFor(()=>files(target).length===2,'first cursor export');
  const exported=files(target);
  assert.equal(exported.every(path=>path.endsWith('.md')),true);
  assert.equal(exported.some(path=>path.includes('Screen')||path.includes('Coding')),false);
  assert.equal(exported.some(path=>readFileSync(path,'utf8').includes('Generated screenshot original')),false);
  assert.equal(exported.some(path=>readFileSync(path,'utf8').includes('Generated Coding transcript')),false);

  const before=new Map(exported.map(path=>[path,{body:readFileSync(path,'utf8'),inode:statSync(path).ino}]));
  const firstPath=[...before.keys()].find(path=>before.get(path)!.body.includes('Generated first body'))!;
  const secondPath=[...before.keys()].find(path=>before.get(path)!.body.includes('Generated second body'))!;
  let enabled=plugins.instanceView(instance.id);
  await plugins.outboundSync(instance.id,{expectedRevision:enabled.revision,operationId:randomUUID()});
  for(const [path,value] of before)assert.deepEqual({body:readFileSync(path,'utf8'),inode:statSync(path).ino},value,'an unchanged cursor does not rewrite a file');
  assert.equal(plugins.outboundStatus(instance.id).conflicts.length,0);

  const revised=materials.publish({...draft(sourceId,'one','Generated revised body'),id:first.id,origin:first.origin},{expectedRevision:first.revision});
  enabled=plugins.instanceView(instance.id);
  await plugins.outboundSync(instance.id,{expectedRevision:enabled.revision,operationId:randomUUID()});
  assert.ok(firstPath);
  assert.match(readFileSync(firstPath,'utf8'),/Generated revised body/);
  assert.doesNotMatch(readFileSync(firstPath,'utf8'),/Generated first body/);
  assert.ok(plugins.outboundStatus(instance.id).exported>=2);

  writeFileSync(secondPath,'Generated owner edit\n');
  materials.publish({...draft(sourceId,'one','Generated third body'),id:first.id,origin:first.origin},{expectedRevision:revised.revision});
  materials.publish(draft(sourceId,'three','Generated third note','Third note'));
  enabled=plugins.instanceView(instance.id);
  const afterConflict=await plugins.outboundSync(instance.id,{expectedRevision:enabled.revision,operationId:randomUUID()});
  assert.equal(readFileSync(secondPath,'utf8'),'Generated owner edit\n','a hand-edited file is never silently overwritten');
  assert.match(readFileSync(firstPath,'utf8'),/Generated third body/,'the other cursor entries keep advancing');
  const thirdPath=files(target).find(path=>readFileSync(path,'utf8').includes('Generated third note'));
  assert.ok(thirdPath,'a newly published material is exported in the same pass');
  assert.equal(afterConflict.conflicts.length,1);
  assert.match(afterConflict.conflicts[0]!.relativePath,/Second note/);
  assert.equal(afterConflict.conflicts[0]!.actualHash,sha256('Generated owner edit\n'));
  assert.ok(afterConflict.conflicts[0]!.expectedHash);

  const beforeDisable=files(target).length;
  plugins.action(instance.id,'disable',{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()});
  await waitFor(()=>!plugins.instanceView(instance.id).desired,'Markdown export disable');
  materials.publish({...draft(sourceId,'one','Generated fourth body'),id:first.id,origin:first.origin},{expectedRevision:(materials.get(first.id)!).revision});
  assert.throws(()=>plugins.outboundSync(instance.id,{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()}),/Enable/);
  assert.equal(files(target).length,beforeDisable,'a disabled export writes nothing new and keeps existing files');
});

test('path safety rejects traversal, repository/data/home roots and symlink escape',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mote-markdown-safety-')),vault=mkdtempSync(join(tmpdir(),'mote-markdown-safe-vault-'));
  const escapeRoot=mkdtempSync(join(tmpdir(),'mote-markdown-escape-root-')),outside=mkdtempSync(join(tmpdir(),'mote-markdown-outside-'));
  t.after(()=>{for(const directory of [state,vault,escapeRoot,outside])rmSync(directory,{recursive:true,force:true});});
  const store=new Store(state),materials=new MaterialStore(store);
  const plugins=new PluginCenter(store,new ExecutionEngine(store),new GitHubPluginReleases(join(state,'packages'),rejectingGitHub([]),repoRoot));
  const outbound=new OutboundExportHost({store,materials,repoRoot,dataDir:state,home:homedir(),sourceKind:()=>'custom',intervalMs:3_600_000});
  plugins.outboundHost=outbound;
  t.after(async()=>{await plugins.close();store.close();});
  assert.deepEqual(outbound.inspectTarget(''),{ok:false,reason:'empty_path'});
  assert.deepEqual(outbound.inspectTarget('relative/vault'),{ok:false,reason:'not_absolute'});
  assert.deepEqual(outbound.inspectTarget(vault+'/../escape'),{ok:false,reason:'parent_segment'});
  assert.equal(outbound.inspectTarget(repoRoot).ok,false);
  assert.equal(outbound.inspectTarget(state).ok,false);
  assert.equal(outbound.inspectTarget(homedir()).ok,false);
  assert.equal(outbound.inspectTarget(vault).ok,true);

  const sourceId='generated-notes';
  materials.publish(draft(sourceId,'safe','Generated safe body'));
  mkdirSync(join(escapeRoot,'Mote'));
  symlinkSync(outside,join(escapeRoot,'Mote','generated-notes'),'dir');

  const view=plugins.view(),preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','safety install');
  const instance=plugins.configure(undefined,{packageId:plugins.view().packages[0]!.id,name:'Escaping export',scope:'default',
    configuration:{targetFolder:escapeRoot,sourceIds:sourceId},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='ready','safety check');
  plugins.action(instance.id,'enable',{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).desired,'safety enable');
  await assert.rejects(plugins.outboundSync(instance.id,{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()}),/symbolic link|escapes/);
  assert.equal(files(outside).length,0,'a symlink below the root cannot redirect a write');
});

test('an empty target or empty scope enables nothing and never dumps the library',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mote-markdown-empty-')),target=mkdtempSync(join(tmpdir(),'mote-markdown-empty-target-'));
  t.after(()=>{rmSync(state,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
  const store=new Store(state),materials=new MaterialStore(store);
  const plugins=new PluginCenter(store,new ExecutionEngine(store),new GitHubPluginReleases(join(state,'packages'),rejectingGitHub([]),repoRoot));
  plugins.outboundHost=new OutboundExportHost({store,materials,repoRoot,dataDir:state,home:homedir(),sourceKind:()=>'custom',intervalMs:3_600_000});
  t.after(async()=>{await plugins.close();store.close();});
  materials.publish(draft('generated-notes','empty','Generated empty-scope body'));
  const view=plugins.view(),preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','empty scope install');
  const packageId=plugins.view().packages[0]!.id;
  const noScope=plugins.configure(undefined,{packageId,name:'No scope',scope:'default',configuration:{targetFolder:target},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  plugins.action(noScope.id,'check',{expectedRevision:noScope.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(noScope.id).observed==='ready','no-scope check');
  plugins.action(noScope.id,'enable',{expectedRevision:plugins.instanceView(noScope.id).revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(noScope.id).desired,'no-scope enable');
  const noScopeStatus=await plugins.outboundSync(noScope.id,{expectedRevision:plugins.instanceView(noScope.id).revision,operationId:randomUUID()});
  assert.ok(noScopeStatus.issues.includes('outbound_scope_empty'));
  assert.equal(noScopeStatus.exported,0);
  assert.equal(files(target).length,0,'an empty scope never becomes the whole library');

  const noTarget=plugins.configure(undefined,{packageId,name:'No target',scope:'default',configuration:{sourceIds:'generated-notes'},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  plugins.action(noTarget.id,'check',{expectedRevision:noTarget.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(noTarget.id).observed==='ready','no-target check');
  plugins.action(noTarget.id,'enable',{expectedRevision:plugins.instanceView(noTarget.id).revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(noTarget.id).desired,'no-target enable');
  const noTargetStatus=await plugins.outboundSync(noTarget.id,{expectedRevision:plugins.instanceView(noTarget.id).revision,operationId:randomUUID()});
  assert.ok(noTargetStatus.issues.includes('outbound_target_not_configured'));
  assert.equal(noTargetStatus.targetConfigured,false);
  assert.equal(files(target).length,0,'a missing target never writes anywhere');
});

test('an enabled export resumes its cursor after a Central process restart without rewriting unchanged files',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mote-markdown-restart-')),target=mkdtempSync(join(tmpdir(),'mote-markdown-restart-vault-'));
  const store=new Store(state),materials=new MaterialStore(store);
  const create=()=>{
    const plugins=new PluginCenter(store,new ExecutionEngine(store),new GitHubPluginReleases(join(state,'packages'),rejectingGitHub([]),repoRoot));
    plugins.outboundHost=new OutboundExportHost({store,materials,repoRoot,dataDir:state,home:homedir(),sourceKind:()=>'custom',intervalMs:3_600_000});
    return plugins;
  };
  let plugins=create();
  t.after(async()=>{await plugins.close();if(store.db.isOpen)store.close();rmSync(state,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
  const sourceId='generated-notes',first=materials.publish(draft(sourceId,'one','Generated restart body')),second=materials.publish(draft(sourceId,'two','Generated stable body','Stable note'));
  const view=plugins.view(),preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','restart install');
  const instance=plugins.configure(undefined,{packageId:plugins.view().packages[0]!.id,name:'Restart export',scope:'default',
    configuration:{targetFolder:target,sourceIds:sourceId},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='ready','restart check');
  plugins.action(instance.id,'enable',{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()});
  await waitFor(()=>files(target).length===2,'restart first export');
  const stablePath=files(target).find(path=>readFileSync(path,'utf8').includes('Generated stable body'))!;
  const stableInode=statSync(stablePath).ino;
  await plugins.close();

  plugins=create();
  plugins.resumeOutboundInstances();
  await waitFor(()=>plugins.outboundStatus(instance.id).active,'restart resume');
  const revised=materials.publish({...draft(sourceId,'one','Generated restart revised body'),id:first.id,origin:first.origin},{expectedRevision:first.revision});
  await plugins.outboundSync(instance.id,{expectedRevision:plugins.instanceView(instance.id).revision,operationId:randomUUID()});
  const firstPath=files(target).find(path=>readFileSync(path,'utf8').includes('Generated restart revised body'));
  assert.ok(firstPath,'the resumed host follows the stored cursor for a new revision');
  assert.equal(readFileSync(stablePath,'utf8').includes('Generated stable body'),true);
  assert.equal(statSync(stablePath).ino,stableInode,'an unchanged entry is not rewritten after restart');
  assert.equal(second.revision,materials.get(second.id)!.revision);
  assert.ok(revised.revision);
});

test('an unsafe configured target fails check instead of enabling a sandbox',async t=>{
  const state=mkdtempSync(join(tmpdir(),'mote-markdown-check-'));
  t.after(()=>rmSync(state,{recursive:true,force:true}));
  const store=new Store(state),materials=new MaterialStore(store);
  const plugins=new PluginCenter(store,new ExecutionEngine(store),new GitHubPluginReleases(join(state,'packages'),rejectingGitHub([]),repoRoot));
  plugins.outboundHost=new OutboundExportHost({store,materials,repoRoot,dataDir:state,home:homedir(),sourceKind:()=>'custom',intervalMs:3_600_000});
  t.after(async()=>{await plugins.close();store.close();});
  const view=plugins.view(),preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','unsafe target install');
  const instance=plugins.configure(undefined,{packageId:plugins.view().packages[0]!.id,name:'Unsafe export',scope:'default',
    configuration:{targetFolder:state,sourceIds:'generated-notes'},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='blocked','unsafe target check blocks');
  const checked=plugins.instanceView(instance.id);
  assert.ok(checked.issues.some(issue=>issue.startsWith('outbound_target_unsafe')));
  assert.equal(checked.allowedActions.includes('enable'),false);
});

test('owner HTTP status and explicit sync work while a collector credential cannot configure or start export',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-markdown-http-')),target=mkdtempSync(join(tmpdir(),'mote-markdown-http-vault-')),owner='generated-markdown-owner-'+randomUUID();
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model request belongs in this fixture');},async close(){}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+owner},githubCalls:string[]=[];
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:rejectingGitHub(githubCalls)});
  const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
  const sourceId='generated-notes';
  node.materials.publish(draft(sourceId,'http','Generated HTTP body'));

  const resolved=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:official.repository,tag:official.tag}});
  assert.equal(resolved.statusCode,200,resolved.body);
  const preview=resolved.json() as {id:string;source:{digest:string}};
  assert.equal(resolved.body.includes(official.localDirectory),false);
  const wrongTag=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:official.repository,tag:'v9.9.9'}});
  assert.equal(wrongTag.statusCode,422);
  assert.equal(githubCalls.length,0);

  let view=node.pluginCenter.view();
  assert.equal((await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{...command(view.revision),previewId:preview.id}})).statusCode,200);
  await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','HTTP Markdown export install');
  view=node.pluginCenter.view();
  const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{...command(view.revision),packageId:view.packages[0]!.id,name:'HTTP Markdown export',scope:'default',configuration:{targetFolder:target,sourceIds:sourceId}}});
  assert.equal(configured.statusCode,200,configured.body);
  const instance=configured.json() as {id:string;revision:number};
  assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:command(instance.revision)})).statusCode,200);
  await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','HTTP Markdown export check');
  const checked=node.pluginCenter.instanceView(instance.id);
  assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:command(checked.revision)})).statusCode,200);
  await waitFor(()=>files(target).length===1,'HTTP Markdown export enable');
  assert.equal(files(target).length,1);
  const status=await node.app.inject({url:'/api/plugin-instances/'+instance.id+'/outbound-export',headers});
  assert.equal(status.statusCode,200,status.body);
  assert.equal((status.json() as {exported:number}).exported,1);
  const sync=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/outbound-export/sync',headers,payload:command(node.pluginCenter.instanceView(instance.id).revision)});
  assert.equal(sync.statusCode,200,sync.body);
  assert.equal(githubCalls.length,0);

  const invitation=await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated collector'}});
  assert.equal(invitation.statusCode,200,invitation.body);
  const paired=await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:(invitation.json() as {invitation:{code:string}}).invitation.code,deviceId:'generated-markdown-collector',deviceName:'Generated collector',platform:'macos'}});
  assert.equal(paired.statusCode,200,paired.body);
  const collector={authorization:'Bearer '+(paired.json() as {token:string}).token};
  assert.equal((await node.app.inject({url:'/api/plugin-instances/'+instance.id+'/outbound-export',headers:collector})).statusCode,403);
  assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/outbound-export/sync',headers:collector,payload:command(node.pluginCenter.instanceView(instance.id).revision)})).statusCode,403);
  assert.equal((await node.app.inject({method:'PATCH',url:'/api/plugin-instances/'+instance.id,headers:collector,payload:{...command(node.pluginCenter.instanceView(instance.id).revision),name:'Collector change',scope:'default',configuration:{targetFolder:target,sourceIds:sourceId}}})).statusCode,403);
  assert.equal((await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/disable',headers:collector,payload:command(node.pluginCenter.instanceView(instance.id).revision)})).statusCode,403);
});
