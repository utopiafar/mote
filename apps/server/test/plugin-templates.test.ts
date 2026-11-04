import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {WorkerPluginRuntime} from '../src/plugin-runtime.js';
import {WorkerMemoryProvider} from '../src/worker-memory-provider.js';
import {probeMemoryProvider} from '../src/memory-provider-probe.js';

/** EXT03 acceptance: every SDK template generates a plugin project in a
 * temporary external directory and builds, and the built artifact installs
 * and runs on the real host for its runtime surface. Generated fixtures and
 * private plugin-dev homes only. */
const root=fileURLToPath(new URL('../../../',import.meta.url));
const cli=join(root,'scripts/plugin-dev.mjs');
const run=(args:string[],cwd=root)=>execFileSync(process.execPath,[cli,...args],{cwd,encoding:'utf8',stdio:'pipe'});
const npm=(args:string[],cwd:string,env:Record<string,string>={})=>execFileSync('npm',args,{cwd,encoding:'utf8',stdio:'pipe',env:{...process.env,...env}});

let sdk:{tarball?:string;base?:string;task?:Promise<string>};
async function packSdk(t:TestContext){
  sdk??={};
  sdk.task??=(async()=>{
    sdk.base=await mkdtemp(join(tmpdir(),'mote-ext03-sdk-'));
    const directory=join(sdk.base,'pack');
    await mkdir(directory,{recursive:true,mode:0o700});
    npm(['run','pack:sdk','-w','@mote/plugin-sdk','--','--pack-destination',directory],root);
    const tarballs=(await readdir(directory)).filter(name=>name.endsWith('.tgz'));
    assert.equal(tarballs.length,1,'the SDK pack produced exactly one tarball');
    sdk.tarball=join(directory,tarballs[0]);
    return sdk.tarball;
  })();
  const tarball=await sdk.task;
  t.after(async()=>{const base=sdk.base;sdk=undefined;if(base)await rm(base,{recursive:true,force:true});});
  return tarball;
}
const jsonLines=(output:string)=>output.trim().split('\n').filter(line=>line.trim().startsWith('{')).map(line=>JSON.parse(line));
function create(tarball:string,target:string,template:string){
  const created=jsonLines(run(['create',target,'--template',template,'--sdk-tarball',tarball])).at(-1);
  assert.equal(created.created,target);assert.equal(created.template,template);
}
async function builtArchive(project:string){
  const manifest=JSON.parse(await readFile(join(project,'dist/mote-plugin.json'),'utf8'));
  assert.match(manifest.archive.sha256,/^[0-9a-f]{64}$/);
  assert.notEqual(manifest.archive.sha256,'0'.repeat(64),'build completed the archive digest');
  assert.ok((await readdir(join(project,'dist'))).includes(manifest.archive.asset));
  return manifest;
}

test('[U] every template generates a plugin project that builds in a temporary directory',async t=>{
  const base=await mkdtemp(join(tmpdir(),'mote-ext03-u-'));
  t.after(async()=>{await rm(base,{recursive:true,force:true});});
  const tarball=await packSdk(t);
  for(const template of['connector','worker','domain']){
    const project=join(base,template);
    create(tarball,project,template);
    npm(['run','build'],project,{MOTE_REPOSITORY:root});
    if(template!=='connector')await builtArchive(project);
  }
});

test('[K] the real Central host installs and runs the generated connector and domain plugins',async t=>{
  const base=await mkdtemp(join(tmpdir(),'mote-ext03-k-'));
  t.after(async()=>{await rm(base,{recursive:true,force:true});});
  const tarball=await packSdk(t);
  for(const template of['connector','domain']){
    const project=join(base,template);
    create(tarball,project,template);
    const output=run(['dev','--plugin',project,'--home',join(base,'home-'+template),'--once','--seed']);
    const lines=jsonLines(output);
    const result=lines.at(-1);
    assert.equal(result.stopped,true,`${template}: plugin-dev stopped the profile`);
    if(template==='connector'){
      const status=result.connectors['example-external-source'];
      assert.equal(status?.ready,true,'connector status is published by the real registry');
      assert.equal(status?.sdkVersion,'0.1.0');
      const seed=lines.find(line=>line.sourceId);
      assert.equal(seed?.itemCount,1,'the generated connector wrote through real ingress');
    }else{
      const status=result.connectors.collection;
      assert.equal(status?.sdkVersion,'0.1.0','domain adapter status is published by the real registry');
      const seed=lines.find(line=>line.itemId);
      assert.equal(seed?.itemsAfter-seed?.itemsBefore,1,'the domain adapter wrote through its owner routes');
      assert.equal(seed?.refused,'invalid_item_text','the error branch fails through the real mount mapping');
    }
  }
});

test('[K] the real worker runtime installs the built worker payload and passes the host capability probe',async t=>{
  const base=await mkdtemp(join(tmpdir(),'mote-ext03-worker-'));
  t.after(async()=>{await rm(base,{recursive:true,force:true});});
  const tarball=await packSdk(t);
  const project=join(base,'project');
  create(tarball,project,'worker');
  npm(['run','build'],project,{MOTE_REPOSITORY:root});
  const manifest=await builtArchive(project);

  // Install like the release resolver: verify the payload expands and the
  // declared entry is present, then run it in a private install directory.
  const install=join(base,'installed');
  await mkdir(install,{recursive:true,mode:0o700});
  const entries=unzipSync(new Uint8Array(await readFile(join(project,'dist',manifest.archive.asset))));
  assert.ok(entries[manifest.entry],`the archive carries ${manifest.entry}`);
  for(const[name,data]of Object.entries(entries))await writeFile(join(install,name),data,{mode:0o600});
  const state=join(base,'state');
  await mkdir(state,{recursive:true,mode:0o700});
  const entry=join(install,manifest.entry);
  const open=()=>new WorkerMemoryProvider(new WorkerPluginRuntime(entry,{dataFile:join(state,'provider.json')},state));
  let provider=open();
  try{
    const health=await probeMemoryProvider({
      provider,
      restart:async()=>{await provider.close();provider=open();return provider;},
      namespace:{ownerId:'generated-template-owner',instanceId:'generated-template-instance',bindingRevision:1},
      providerId:manifest.id,
      version:manifest.version,
    });
    assert.equal(health.ready,true,JSON.stringify(health.problems));
    assert.deepEqual(health.verified,{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false});
  }finally{await provider.close();}
});
