#!/usr/bin/env node
// Opt-in image consumption proof. Builds are separate; only generated profiles,
// data and this invocation's Compose resources are created or removed here.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {loadProfile,profilePaths,updateProfileConfiguration} from './profile-lib.mjs';
import {cli,command,freePort,note,request} from './profile-fixtures.mjs';
import {assertDockerMediaRuntime} from './docker-media.mjs';

const {values}=parseArgs({options:{variant:{type:'string'},image:{type:'string'}}});
assert.ok(['core','full'].includes(values.variant)&&values.image,'Usage: node scripts/test-docker-images.mjs --variant core|full --image LOCAL_TAG');
const variant=values.variant,image=values.image,directory=await mkdtemp(join(tmpdir(),'mote-o1-image-')),home=join(directory,'profiles'),name='o1'+variant;
let profile;
const progress=message=>console.info(`[docker-images:${variant}] ${message}`);
async function docker(args){
  const result=await command('docker',args,{timeoutMs:120000});
  assert.equal(result.code,0,`docker ${args[0]}: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
const run=(action,args=[],options={})=>cli(home,name,action,args,{timeoutMs:120000,...options});
// Parse each JSON line rather than exposing inspect/environment output.
async function containers(){return (await docker(['ps','--all','--filter',`label=com.docker.compose.project=${profile.project}`,'--format','{{json .}}'])).split('\n').filter(Boolean).map(JSON.parse);}
async function runningServices(){
  const ids=(await docker(['ps','--quiet','--filter',`label=com.docker.compose.project=${profile.project}`])).split(/\s+/).filter(Boolean);
  const services=[];
  for(const id of ids)services.push(await docker(['inspect','--format','{{index .Config.Labels "com.docker.compose.service"}}',id]));
  return services.sort();
}
async function centralId(){return (await run('compose',['--','ps','--quiet','mote'])).stdout.trim();}
async function selectWorkers(roles){
  await updateProfileConfiguration(profile,document=>{document.media.dockerWorkers=roles;});
  profile=await loadProfile(profilePaths(name,home));
}
async function workerHealth(role,available){
  const code=`import assert from 'node:assert/strict';import {readConfigDocument} from '@mote/shared/config-file';
const media=readConfigDocument(process.env.MOTE_CONFIG_FILE).document.media;
const port=media[${JSON.stringify(role==='ocr'?'ocrPort':'asrPort')}],url='http://127.0.0.1:'+port+'/health';
if(!${available}){await assert.rejects(fetch(url,{signal:AbortSignal.timeout(2000)}));}
else{const denied=await fetch(url,{signal:AbortSignal.timeout(5000)});assert.equal(denied.status,401);
const response=await fetch(url,{headers:{Authorization:'Bearer '+media.workerToken},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);
const body=await response.json();assert.equal(body[${JSON.stringify(role==='ocr'?'ocr':'asr')}],false);${role==='asr'?'assert.equal(body.diarization,false);assert.equal(body.loading,false);assert.equal(body.reason,"model_missing");':''}}
console.log('generated-worker-health-checked');`;
  await docker(['exec',await centralId(),'node','--input-type=module','-e',code]);
}
async function assertResources(roles){
  assert.deepEqual(await runningServices(),['mote',...roles.map(role=>role+'-worker')].sort());
  for(const role of ['ocr','asr'])await workerHealth(role,roles.includes(role));
  const models=await request(profile,'/api/media-models');
  for(const role of ['ocr','dialogue'])assert.equal(models[role].runtimeReady,false,'Empty weights never establish model readiness');
}

async function installOfficialPlugins(officialPlugins){
  let view=await request(profile,'/api/plugins');
  assert.deepEqual(view.packages,[],'The Docker volume must start without installed plugins');
  for(const {repository,tag,packageId} of officialPlugins){
    assert.ok(view.catalog.some(item=>item.repository===repository&&item.tag===tag&&item.packageId===packageId),packageId);
    const preview=await request(profile,'/api/plugins/resolve',{method:'POST',body:{repository,tag}});
    assert.equal(preview.installable,true,packageId);
    assert.equal(preview.source.repository,repository);
    assert.equal(preview.source.tag,tag);
    assert.match(preview.source.digest,/^[a-f0-9]{64}$/);
    await request(profile,'/api/plugins/install',{method:'POST',body:{
      previewId:preview.id,expectedRevision:view.revision,operationId:randomUUID(),
    }});
    const id=packageId+'@'+preview.source.digest,deadline=Date.now()+15000;
    let installed;
    do{
      view=await request(profile,'/api/plugins');
      installed=view.packages.find(item=>item.id===id);
      if(installed?.state!=='installing')break;
      await sleep(100);
    }while(Date.now()<deadline);
    assert.equal(installed?.state,'installed',`${id}: ${JSON.stringify(installed?.issues)}`);
    assert.deepEqual(installed.source,preview.source);
    assert.equal(installed.desired,false);
  }
  return view.packages.map(item=>item.id).sort();
}

const runtimeProof=`import assert from 'node:assert/strict';
import {accessSync,constants,existsSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {basename,join,relative,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {tmpdir} from 'node:os';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
import {OFFICIAL_PLUGIN_CATALOG} from './apps/server/dist/official-plugin-catalog.js';
import {prepareImportInput} from './apps/server/dist/import-runtime.js';
import {createLarkRunner} from './apps/server/dist/connectors/lark-cli.js';
import {createDwsRunner} from './apps/server/dist/connectors/dingtalk-recordings.js';
import {cliReleases,managedCliBinary} from './apps/server/dist/connectors/cli-runtime.mjs';
import * as agent from '@mote/agent';import {bundledSkills} from './packages/agent/dist/skills.js';
assert.equal(typeof agent.createImportAgent,'function');assert.equal(typeof agent.createOfficialAgent,'function');
for(const id of ['document-import','memory-extraction','coding-memory'])assert.ok(bundledSkills.some(skill=>skill.id===id&&skill.content.length));
const require=createRequire(import.meta.url),Database=require('better-sqlite3'),db=new Database(':memory:');
try{db.exec('create table proof(value text)');db.prepare('insert into proof values(?)').run('generated');assert.equal(db.prepare('select value from proof').get().value,'generated');}finally{db.close();}
await new Promise((resolve,reject)=>{const shell=require('node-pty').spawn('/bin/bash',['--noprofile','--norc','-c','printf generated-pty'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin',HOME:'/tmp'}});let text='';const timer=setTimeout(()=>{shell.kill();reject(Error('PTY did not finish'));},5000);shell.onData(value=>text+=value);shell.onExit(({exitCode})=>{clearTimeout(timer);try{assert.equal(exitCode,0);assert.match(text,/generated-pty/);resolve();}catch(error){reject(error);}});});
const root=mkdtempSync(join(tmpdir(),'mote-o1-runtime-'));
try{const file='generated.yaml';writeFileSync(join(root,file),'text: generated parser evidence\\n');
const input=prepareImportInput({workspace:root,inputPaths:[file],instruction:'Generated decoding only'});
const result=spawnSync(process.execPath,[input.helperPath,'extract',file],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).data.text,'generated parser evidence');
const lark=createLarkRunner(join(root,'lark')),dws=createDwsRunner(join(root,'dws'));
if(${variant==='core'}){
for(const path of ['/usr/bin/python3','/usr/bin/ffmpeg','/opt/mote-media/ocr/bin/python','/opt/mote-media/dialogue/bin/python',managedCliBinary('lark'),managedCliBinary('dingtalk')])assert.throws(()=>accessSync(path,constants.X_OK));
await assert.rejects(lark({kind:'version'}),error=>error.message==='lark_cli_missing');await assert.rejects(dws({kind:'version'},undefined),error=>error.message==='dingtalk_cli_missing');
}else{
assert.match(await lark({kind:'version'}),new RegExp(cliReleases.lark.version.replaceAll('.','\\\\.')));
const version=await dws({kind:'version'},undefined);assert.equal(String(version.version??version.data?.version).replace(/^v/,''),cliReleases.dingtalk.version);
}
}finally{rmSync(root,{recursive:true,force:true});}
const official=OFFICIAL_PLUGIN_CATALOG.filter(item=>!item.hidden&&item.localDirectory);
assert.ok(official.length>0,'The image must have a public local plugin catalog');
assert.equal(existsSync('test-fixtures'),false,'Repository test fixtures must stay out of the image');
assert.deepEqual(readdirSync('official-plugins').sort(),official.map(item=>basename(item.localDirectory)).sort());
for(const {localDirectory,packageId} of official){
  const manifest=JSON.parse(readFileSync(join(localDirectory,'mote-plugin.json'),'utf8'));
  assert.equal(manifest.id,packageId);
  const entries=[...new Set([manifest.entry,...(manifest.contributions??[]).map(item=>item.entry).filter(Boolean)])];
  const files=readdirSync(localDirectory,{recursive:true,withFileTypes:true})
    .filter(file=>!file.isDirectory()).map(file=>relative(localDirectory,join(file.parentPath,file.name)));
  assert.deepEqual(files.sort(),['mote-plugin.json',...entries].sort(),localDirectory);
  for(const entry of entries)await import(pathToFileURL(resolve(localDirectory,entry)).href);
}
console.log(JSON.stringify(official.map(({repository,tag,packageId})=>({repository,tag,packageId}))));`;

try{
  const id=await docker(['image','inspect','--format','{{.Id}}',image]);
  progress(`Consuming local image ${id}`);
  const officialPlugins=JSON.parse(await docker(['run','--rm','--pull','never','--network','none','--entrypoint','node',image,'--input-type=module','-e',runtimeProof]));
  progress('Actual Agent/import/SQLite/PTY and optional CLI boundaries passed without a network');
  progress(`Found manifests and loaded entrypoints for ${officialPlugins.length} public official plugins without a network`);
  if(variant==='full'){
    const offline=['--env','HF_HUB_OFFLINE=1','--env','TRANSFORMERS_OFFLINE=1','--env','HF_HUB_DISABLE_TELEMETRY=1','--env','PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True'];
    await docker(['run','--rm','--pull','never','--network','none',...offline,'--entrypoint','/opt/mote-media/ocr/bin/python',image,'-c','import paddlex,onnxruntime,PIL; print("generated-ocr-dependencies-loaded")']);
    await docker(['run','--rm','--pull','never','--network','none',...offline,'--entrypoint','/opt/mote-media/dialogue/bin/python',image,'-c','import sys; sys.path.insert(0,"scripts"); from mote_asr_contract import SDK_VERSION; import importlib.metadata,funasr,torch,numpy,imageio_ffmpeg; assert importlib.metadata.version("funasr")==SDK_VERSION; assert not torch.cuda.is_available(); print("generated-audio-dependencies-loaded")']);
    await docker(['run','--rm','--pull','never','--network','none','--entrypoint','/usr/bin/ffmpeg',image,'-version']);
    progress('Fixed OCR/FunASR/CPU Torch/FFmpeg dependencies loaded; no weights were downloaded');
  }
  await run('init',['--runtime','docker','--image',image,'--image-variant',variant,'--media-workers','none','--port',String(await freePort())]);
  profile=await loadProfile(profilePaths(name,home));
  assert.deepEqual(profile.document.media.dockerWorkers,[]);
  await run('start');await assertResources([]);
  await request(profile,'/api/status',{token:'generated-wrong-token',status:401});
  const saved=note();await request(profile,'/api/notes',{method:'POST',body:saved,status:201});
  assert.equal((await request(profile,`/api/notes/${saved.id}`)).ocrText,saved.text);
  const intake=await request(profile,'/api/import-capabilities');assert.ok(Array.isArray(intake.formats)&&intake.formats.length>0);assert.ok(Array.isArray(intake.containers));
  const response=await fetch(profile.url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);assert.match(await response.text(),/<html/);
  const installed=await installOfficialPlugins(officialPlugins);
  progress(`Plugin Center resolved and installed ${installed.length} bundled official releases in an empty volume`);
  const container=await centralId();
  const owner=await docker(['exec',container,'node','--input-type=module','-e',`import assert from 'node:assert/strict';import{statSync,writeFileSync,readFileSync}from'node:fs';import{readRuntimeListener}from'./apps/server/dist/runtime-listener.js';const listener=readRuntimeListener(process.env.MOTE_CONFIG_FILE),environment=readFileSync('/proc/'+listener.pid+'/environ','utf8').split(String.fromCharCode(0));assert.ok(environment.includes('HOME=/data'));writeFileSync('/data/generated-home-proof','generated');for(const path of ['/data','/data/mote.sqlite','/data/generated-home-proof',${JSON.stringify(profile.modelDirectory)}]){const stat=statSync(path);assert.equal(stat.uid,process.getuid());assert.equal(stat.gid,process.getgid());}console.log('generated-owner-home-checked');`]);
  assert.equal(owner,'generated-owner-home-checked');
  progress('Real CLI startup, authenticated HTTP/SQLite write, Web, persistent HOME/UID and zero-worker default passed');
  if(variant==='core'){
    await selectWorkers(['ocr']);const refused=await run('start',[],{fail:true});assert.match(refused.stderr,/require the full image/);
    await assert.rejects(assertDockerMediaRuntime({...profile,meta:{...profile.meta,imageVariant:'full'}},async(binary,args,options)=>{const result=await command(binary,args,options);assert.equal(result.code,0);}),/lacks the requested Docker media runtime/);
    assert.deepEqual(await runningServices(),['mote']);await selectWorkers([]);
    progress('Core and a falsely declared full/core image both rejected managed media before creating any worker');
  }else{
    for(const roles of [['ocr'],['asr'],['ocr','asr'],[]]){
      await selectWorkers(roles);await run('start');await assertResources(roles);
      progress(`Actual worker selection ${roles.join(',')||'none'} passed listener/auth/liveness checks; model readiness stayed false`);
    }
  }
  await run('stop');await run('start');
  assert.equal((await request(profile,`/api/notes/${saved.id}`)).ocrText,saved.text);
  const {packages}=await request(profile,'/api/plugins');
  assert.deepEqual(packages.filter(item=>item.state==='installed').map(item=>item.id).sort(),installed);
  progress('Generated data persisted after stop/start');
}catch(error){
  if(profile)for(const row of await containers().catch(()=>[]))progress(`Failure state: ${JSON.stringify({name:row.Names,state:row.State,status:row.Status})}`);
  throw error;
}finally{
  if(profile){
    await run('compose',['--','down','--volumes','--remove-orphans']).catch(error=>{console.error('Owned Compose cleanup failed:',error.message);process.exitCode=1;});
    for(const volume of [profile.meta.volume,profile.meta.modelsVolume]){
      const exists=await command('docker',['volume','inspect',volume],{timeoutMs:15000});
      if(exists.code===0){const removed=await command('docker',['volume','rm',volume],{timeoutMs:15000});assert.equal(removed.code,0,'Owned volume cleanup failed');}
    }
  }
  await rm(directory,{recursive:true,force:true});
}
