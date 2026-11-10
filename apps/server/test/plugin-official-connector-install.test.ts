import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {Store,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {GitHubPluginReleases,type PluginManifest,type PluginReleaseTransport} from '../src/plugin-release.js';
import {PluginCenter} from '../src/plugin-center.js';
import {officialPluginCatalog} from '../src/official-plugin-catalog.js';

const fixtureRoot=join(process.cwd(),'test-fixtures/official-fixture-connector');
const fixtureEntry=readFileSync(join(fixtureRoot,'plugin.mjs'));
const fixtureManifest=JSON.parse(readFileSync(join(fixtureRoot,'mote-plugin.json'),'utf8')) as PluginManifest;

function waitFor(check:()=>boolean,description:string){
  const until=Date.now()+8000;
  return (async()=>{while(Date.now()<until){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out waiting for '+description);})();
}

function fixtureRelease(){
  const repository='utopiafar/mote-official-fixture-connector',tag='v0.1.0',commit='b'.repeat(40);
  const archive=zipSync({'plugin.mjs':fixtureEntry});
  const digest=sha256(archive);
  const manifest:PluginManifest={...fixtureManifest,archive:{asset:'mote-official-fixture-connector-0.1.0.zip',sha256:digest}};
  const base=`https://github.com/${repository}/releases/download/${tag}/`;
  const transport:PluginReleaseTransport=async url=>{
    if(url===`https://api.github.com/repos/${repository}/releases/tags/${tag}`)return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[
      {name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},
      {name:manifest.archive.asset,browser_download_url:base+manifest.archive.asset},
    ]}))};
    if(url===`https://api.github.com/repos/${repository}/commits/${tag}`)return {bytes:strToU8(JSON.stringify({sha:commit}))};
    if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(manifest))};
    if(url===base+manifest.archive.asset)return {bytes:archive};
    throw new Error('Fixture transport rejects '+url);
  };
  return {repository,tag,commit,manifest,transport,digest};
}

test('official catalog lists connectors, Memory recipes and keeps Mem0/Hindsight entries',()=>{
  const catalog=officialPluginCatalog();
  assert.ok(catalog.some(entry=>entry.group==='connectors'&&entry.packageId==='mote.official.fixture-connector'));
  assert.ok(catalog.some(entry=>entry.group==='memory'&&entry.name==='Mem0'));
  assert.ok(catalog.some(entry=>entry.group==='memory'&&entry.name==='Hindsight'));
  assert.equal(catalog.every(entry=>Boolean(entry.repository&&entry.name&&entry.description&&entry.runtime)),true);
});

test('official connector package installs through plugin center and projects declarative source contributions',async t=>{
  const release=fixtureRelease();
  const directory=mkdtempSync(join(tmpdir(),'mote-official-connector-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory),executor=new ExecutionEngine(store);
  const plugins=new PluginCenter(store,executor,new GitHubPluginReleases(join(directory,'packages'),release.transport));
  t.after(()=>plugins.close());
  const installedConnectors:string[]=[];
  plugins.connectorHost={
    async install(manifest){installedConnectors.push(manifest.id);},
    async stop(id){const index=installedConnectors.indexOf(id);if(index>=0)installedConnectors.splice(index,1);},
    async restart(id){if(!installedConnectors.includes(id))installedConnectors.push(id);},
    inventory:()=>installedConnectors.map(id=>({id,active:true})),
  };

  const view=plugins.view();
  assert.ok(view.catalog.some(entry=>entry.repository===release.repository));
  assert.equal(view.sourceContributions?.length??0,0);

  const preview=await plugins.resolve({repository:release.repository,tag:release.tag});
  assert.equal(preview.runtime,'service');
  assert.equal(preview.installable,true);
  plugins.install({previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID()});
  await waitFor(()=>plugins.view().packages[0]?.state==='installed','official connector install');
  const pkg=plugins.view().packages[0]!;
  assert.equal(pkg.runtime,'service');
  assert.equal(pkg.source.digest,release.digest);

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
  assert.equal(createHash('sha256').update(fixtureEntry).digest('hex').length,64);
});
