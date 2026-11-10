import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases,officialPluginLocalDirectory,type PluginReleaseTransport} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {OFFICIAL_PLUGIN_CATALOG,officialPluginCatalog} from '../src/official-plugin-catalog.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const fixtureRoot=join(repoRoot,'test-fixtures/official-fixture-connector');
const fixtureManifest=JSON.parse(readFileSync(join(fixtureRoot,'mote-plugin.json'),'utf8')) as {id:string;entry:string};
const fixtureEntry=fixtureManifest.entry;
const official={repository:'mote/official-fixture-connector',tag:'v0.1.0',packageId:fixtureManifest.id,localDirectory:'test-fixtures/official-fixture-connector'};
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+8000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}

function rejectingGitHub(calls:string[]):PluginReleaseTransport{
  return async url=>{calls.push(url);throw new Error('GitHub transport must not be used for an in-repository official fixture: '+url);};
}

test('official catalog declares the fixture as an in-repo directory and no longer names the removed external repository',()=>{
  const catalog=officialPluginCatalog();
  const fixture=catalog.find(entry=>entry.group==='connectors'&&entry.packageId===official.packageId);
  assert.ok(fixture);
  assert.equal(fixture.repository,official.repository);
  assert.equal(fixture.tag,official.tag);
  assert.equal('localDirectory' in fixture,false,'the repository-relative directory stays server-side');
  assert.equal(catalog.some(entry=>entry.repository==='utopiafar/mote-official-fixture-connector'),false);
  const internal=OFFICIAL_PLUGIN_CATALOG.find(entry=>entry.packageId===official.packageId);
  assert.equal(internal?.localDirectory,official.localDirectory);
  assert.ok(catalog.some(entry=>entry.group==='memory'&&entry.name==='Mem0'));
  assert.ok(catalog.some(entry=>entry.group==='memory'&&entry.name==='Hindsight'));
  assert.equal(catalog.every(entry=>Boolean(entry.repository&&entry.name&&entry.description&&entry.runtime)),true);
});

test('production resolver packages the in-repo fixture without GitHub, then install, configure, check and enable reach ConnectorHost',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-official-connector-')),githubCalls:string[]=[];
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory),executor=new ExecutionEngine(store);
  const releases=new GitHubPluginReleases(join(directory,'packages'),rejectingGitHub(githubCalls),repoRoot);
  const plugins=new PluginCenter(store,executor,releases);
  t.after(()=>plugins.close());
  const installedConnectors:string[]=[];
  plugins.connectorHost={
    async install(manifest){installedConnectors.push(manifest.id);},
    async stop(id){const index=installedConnectors.indexOf(id);if(index>=0)installedConnectors.splice(index,1);},
    async restart(id){if(!installedConnectors.includes(id))installedConnectors.push(id);},
    inventory:()=>installedConnectors.map(id=>({id,active:true})),
  };

  const view=plugins.view();
  assert.ok(view.catalog.some(entry=>entry.repository===official.repository&&entry.tag===official.tag));
  assert.equal(view.sourceContributions?.length??0,0);

  const preview=await plugins.resolve({repository:official.repository,tag:official.tag});
  assert.equal(preview.runtime,'service');
  assert.equal(preview.installable,true);
  assert.equal(preview.source.repository,official.repository);
  assert.equal(preview.source.tag,official.tag);
  assert.match(preview.source.commit,/^[a-f0-9]{40}$/);
  assert.match(preview.source.digest,/^[a-f0-9]{64}$/);
  assert.equal(githubCalls.length,0,'in-repo resolution never calls GitHub');
  assert.equal(JSON.stringify(preview).includes(official.localDirectory),false,'the preview never exposes a local path');

  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','official connector install');
  const pkg=plugins.view().packages[0]!;
  assert.equal(pkg.runtime,'service');
  assert.equal(pkg.source.digest,preview.source.digest);
  assert.equal(pkg.desired,false);
  assert.equal(plugins.view().instances.length,0,'install creates no default instance and enables nothing');
  const installed=join(directory,'packages',preview.source.digest);
  const archive=readFileSync(join(installed,'mote-source.zip'));
  const lock=JSON.parse(readFileSync(join(installed,'mote-install-lock.json'),'utf8')) as {digest:string;source:{repository:string;tag:string;commit:string;digest:string}};
  assert.equal(sha256(archive),preview.source.digest);
  assert.equal(lock.digest,preview.source.digest);
  assert.deepEqual(lock.source,preview.source);
  assert.equal(readFileSync(join(installed,fixtureEntry)).equals(readFileSync(join(fixtureRoot,fixtureEntry))),true);

  let contributions=plugins.view().sourceContributions??[];
  assert.equal(contributions.length,1);
  assert.equal(contributions[0]!.title,'官方连接器夹具');
  assert.equal(contributions[0]!.kinds[0],'mote.official.fixture-connector');
  assert.equal(contributions[0]!.state,'installed');
  assert.equal(contributions[0]!.target.href,'#/connections?setup=official-fixture-connector');

  const instance=plugins.configure(undefined,{packageId:pkg.id,name:'Fixture connector',scope:'default',configuration:{},expectedRevision:plugins.view().revision,operationId:randomUUID()});
  assert.equal(instance.observed,'configured');
  contributions=plugins.view().sourceContributions??[];
  assert.equal(contributions[0]!.state,'configured');

  plugins.action(instance.id,'check',{expectedRevision:instance.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.instanceView(instance.id).observed==='ready','service connector check');
  const checked=plugins.instanceView(instance.id);
  assert.ok(checked.capabilities.some(value=>value.id==='source.connector'&&value.state==='verified'));
  assert.ok(checked.allowedActions.includes('enable'));

  plugins.action(instance.id,'enable',{expectedRevision:checked.revision,operationId:randomUUID()});
  await waitFor(()=>installedConnectors.includes('official-fixture-connector'),'connector host install');
  await waitFor(()=>plugins.instanceView(instance.id).desired===true&&plugins.instanceView(instance.id).observed==='ready','service connector enable');
  contributions=plugins.view().sourceContributions??[];
  assert.equal(contributions[0]!.state,'enabled');

  const enabled=plugins.instanceView(instance.id);
  plugins.action(instance.id,'disable',{expectedRevision:enabled.revision,operationId:randomUUID()});
  await waitFor(()=>!installedConnectors.includes('official-fixture-connector'),'connector host stop');
});


test('official local identity rejects wrong tags and arbitrary local paths without falling through to GitHub',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-official-security-')),githubCalls:string[]=[];
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const releases=new GitHubPluginReleases(join(directory,'packages'),rejectingGitHub(githubCalls),repoRoot);
  await assert.rejects(releases.resolve({repository:official.repository,tag:'v9.9.9'}),/pinned catalog release/);
  await assert.rejects(releases.resolve({repository:official.repository}),/pinned catalog release/);
  assert.equal(githubCalls.length,0,'a wrong local identity never queries a same-named GitHub repository');

  await assert.rejects(releases.resolve({repository:'../../etc/passwd',tag:official.tag}));
  await assert.rejects(releases.resolve({repository:'/tmp/arbitrary-plugin',tag:official.tag}));
  assert.equal(githubCalls.length,0,'malformed repository identities fail before any transport');

  await assert.rejects(releases.resolve({repository:'generated-fixture/not-official',tag:'v1'}),/GitHub transport must not be used/);
  assert.equal(githubCalls.length,1,'non-catalog identities still use the GitHub path');

  const store=new Store(directory),executor=new ExecutionEngine(store),plugins=new PluginCenter(store,executor,releases);
  t.after(()=>plugins.close());
  await assert.rejects(plugins.resolve({repository:official.repository,tag:official.tag,localDirectory:official.localDirectory}),/Unrecognized key|Invalid input|validation/i);
});

test('a local official artifact mutated after review is refused by install',async t=>{
  const root=mkdtempSync(join(tmpdir(),'mote-official-mutation-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'test-fixtures'),{recursive:true});
  cpSync(fixtureRoot,join(root,'test-fixtures','official-fixture-connector'),{recursive:true});
  const releases=new GitHubPluginReleases(join(root,'packages'),rejectingGitHub([]),root);
  const release=await releases.resolve({repository:official.repository,tag:official.tag});
  appendFileSync(join(root,'test-fixtures','official-fixture-connector',fixtureEntry),'\n// changed after review\n');
  await assert.rejects(releases.install(release),/changed after review/);
});

test('official local directory resolution confines realpaths to the repository and rejects symlink escape',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-official-path-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.equal(officialPluginLocalDirectory(repoRoot,official.localDirectory),join(repoRoot,official.localDirectory));
  assert.throws(()=>officialPluginLocalDirectory(repoRoot,'../outside'),/invalid/);
  assert.throws(()=>officialPluginLocalDirectory(repoRoot,'/absolute/path'),/invalid/);
  assert.throws(()=>officialPluginLocalDirectory(repoRoot,'test-fixtures/../test-fixtures/official-fixture-connector'),/invalid/);

  mkdirSync(join(directory,'test-fixtures'));
  symlinkSync(join(repoRoot,'test-fixtures','official-fixture-connector'),join(directory,'test-fixtures','official-fixture-connector'),'dir');
  assert.throws(()=>officialPluginLocalDirectory(directory,official.localDirectory),/escapes the repository/);

  const fileRoot=mkdtempSync(join(tmpdir(),'mote-official-file-'));
  t.after(()=>rmSync(fileRoot,{recursive:true,force:true}));
  mkdirSync(join(fileRoot,'test-fixtures','official-fixture-connector'),{recursive:true});
  writeFileSync(join(fileRoot,'test-fixtures','official-fixture-connector','mote-plugin.json'),readFileSync(join(fixtureRoot,'mote-plugin.json')));
  writeFileSync(join(fileRoot,'outside.mjs'),'export const escaped = true;\n');
  symlinkSync(join(fileRoot,'outside.mjs'),join(fileRoot,'test-fixtures','official-fixture-connector',fixtureEntry));
  return new GitHubPluginReleases(join(fileRoot,'packages'),rejectingGitHub([]),fileRoot).resolve({repository:official.repository,tag:official.tag}).then(
    ()=>assert.fail('a symlinked executable must not be packed'),
    error=>assert.match(String(error),/escapes its official directory/),
  );
});

test('production HTTP resolve accepts only {repository, tag} and drives the in-repo fixture through the real connector host',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-official-http-')),owner='generated-official-owner-'+randomUUID();
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://api.deepseek.com',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpReadToken:'',mcpWriteEnabled:false,mcpWriteToken:'',mcpWriteSourceIds:[]}};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model request belongs in this fixture');},async close(){}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+owner},githubCalls:string[]=[];
  Object.defineProperty(node.pluginCenter.releases,'transport',{value:rejectingGitHub(githubCalls)});

  const resolved=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:official.repository,tag:official.tag}});
  assert.equal(resolved.statusCode,200);
  const preview=resolved.json() as {id:string;installable:boolean;source:{repository:string;tag:string;commit:string;digest:string}};
  assert.equal(preview.installable,true);
  assert.equal(preview.source.repository,official.repository);
  assert.equal(preview.source.tag,official.tag);
  assert.match(preview.source.digest,/^[a-f0-9]{64}$/);
  assert.equal(resolved.body.includes(official.localDirectory),false,'the resolve response exposes no local path');
  assert.equal(githubCalls.length,0);

  const withPath=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:official.repository,tag:official.tag,localDirectory:official.localDirectory}});
  assert.equal(withPath.statusCode,400,'the resolve contract is exactly {repository, tag}');
  const wrongTag=await node.app.inject({method:'POST',url:'/api/plugins/resolve',headers,payload:{repository:official.repository,tag:'v9.9.9'}});
  assert.equal(wrongTag.statusCode,422);
  assert.equal(githubCalls.length,0);

  let view=node.pluginCenter.view();
  const install=await node.app.inject({method:'POST',url:'/api/plugins/install',headers,payload:{previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(install.statusCode,200);
  await waitFor(()=>node.pluginCenter.view().packages[0]?.state==='installed','official HTTP install');
  view=node.pluginCenter.view();
  const packageId=view.packages[0]!.id;

  const configured=await node.app.inject({method:'POST',url:'/api/plugin-instances',headers,payload:{packageId,name:'Generated official fixture instance',scope:'default',configuration:{},expectedRevision:view.revision,operationId:randomUUID()}});
  assert.equal(configured.statusCode,200);
  const instance=configured.json() as {id:string;revision:number};
  const started=node.pluginCenter.instanceView(instance.id);
  const check=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/check',headers,payload:{expectedRevision:instance.revision,operationId:randomUUID()}});
  assert.equal(check.statusCode,200);
  await waitFor(()=>node.pluginCenter.instanceView(instance.id).observed==='ready','official HTTP check');
  const checked=node.pluginCenter.instanceView(instance.id);
  const enable=await node.app.inject({method:'POST',url:'/api/plugin-instances/'+instance.id+'/enable',headers,payload:{expectedRevision:checked.revision,operationId:randomUUID()}});
  assert.equal(enable.statusCode,200);
  await waitFor(()=>{const value=node.pluginCenter.instanceView(instance.id);return value.desired&&value.observed==='ready';},'official HTTP enable');

  const contributions=(node.pluginCenter.view().sourceContributions??[]);
  assert.equal(contributions.length,1);
  assert.equal(contributions[0]!.state,'enabled');
  assert.equal(contributions[0]!.target.href,'#/connections?setup=official-fixture-connector');
  const status=await node.app.inject({url:'/api/connectors/official-fixture-connector/status',headers});
  assert.equal(status.statusCode,200);
  assert.equal((status.json() as {ready:boolean}).ready,true);
  assert.ok(node.pluginCenter.view().packages[0]!.source.commit.match(/^[a-f0-9]{40}$/));
  assert.ok(started.allowedActions.includes('check'));
});
