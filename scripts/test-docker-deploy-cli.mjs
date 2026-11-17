// Opt-in, generated-data deployment journey. Images must already be local.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {command,freePort,note,request} from './profile-fixtures.mjs';
import {profilePaths,loadProfile,repository,atomicJson} from './profile-lib.mjs';

const {values}=parseArgs({options:{image:{type:'string'},cli:{type:'string'},prefix:{type:'string',default:'o2-20261117'}}});
if(!values.image||!values.cli)throw Error('Usage: node scripts/test-docker-deploy-cli.mjs --image LOCAL_CORE --cli LOCAL_DEPLOY_CLI [--prefix o2-20261117]');
if(!/^o2-[a-z0-9-]{1,20}$/.test(values.prefix))throw Error('Use an isolated o2- prefixed fixture');
const root=await mkdtemp(join(tmpdir(),`mote-${values.prefix}-`)),home=join(root,'profile home $literal 中文'),profile=values.prefix,paths=profilePaths(profile,home),records=[];
const docker=async(args,{fail=false,...options}={})=>{
  const result=await command('docker',args,options);
  if(fail)assert.notEqual(result.code,0);else assert.equal(result.code,0,`docker ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
};
// Docker's JSON format is NDJSON on some client versions.
const originalInventory=async()=>{
  const raw=await docker(['ps','--all','--no-trunc','--format','{{json .}}']);
  return {containers:raw.split('\n').filter(Boolean).map(row=>{const {ID,Names,State}=JSON.parse(row);return {ID,Names,State};}).sort((a,b)=>a.ID.localeCompare(b.ID)),volumes:(await docker(['volume','ls','--format','{{.Name}}'])).split('\n').filter(Boolean).sort()};
};
const before=await originalInventory(),tags=[`mote-${profile}:incompatible`,`mote-${profile}:next`],holder=`mote-${profile}-lock-holder`;
let p,ownedVolumes=[],ownedProject=paths.project,cleanupError;
const record=name=>{records.push(name);console.info('[docker-deploy-cli] '+name);};
try{
  // This PATH contains exactly the host executables the shell bootstrap uses.
  // No host node, npm or Compose binary/plugin can be found through it.
  const bin=join(root,'host-bin');await mkdir(bin);
  for(const binary of ['docker','id','stat','uname','mkdir','dirname']){
    const found=await command('/bin/sh',['-c','command -v "$1"','fixture',binary]);assert.equal(found.code,0);
    await symlink(found.stdout.trim(),join(bin,binary));
  }
  const context=await docker(['context','show']),env={PATH:bin,LC_ALL:'C',MOTE_DEPLOY_CLI_IMAGE:values.cli,DOCKER_CONTEXT:context,DOCKER_HOST:'tcp://127.0.0.1:1'};
  const security=JSON.parse(await docker(['info','--format','{{json .SecurityOptions}}'])),runtimeUser=security.includes('name=rootless')?'0:0':`${process.getuid()}:${process.getgid()}`;
  const run=async(action,args=[],{fail=false,allowFailure=false,extraEnv={}}={})=>{
    const result=await command(join(repository,'scripts/mote-docker'),[action,'--home',home,'--profile',profile,...args],{env:{...env,...extraEnv},timeoutMs:180000});
    if(fail)assert.notEqual(result.code,0,action+' should refuse');else if(!allowFailure)assert.equal(result.code,0,action+': '+result.stderr);
    return result;
  };
  const missing=await command('/bin/sh',['-c','command -v node || command -v npm'],{env:{PATH:bin}});assert.notEqual(missing.code,0);
  for(const endpoint of ['tcp://127.0.0.1:1','ssh://generated.invalid']){
    const remoteHome=join(root,'remote-'+endpoint.split(':')[0]);
    const result=await command(join(repository,'scripts/mote-docker'),['init','--home',remoteHome,'--profile',profile,'--image',values.image],{env:{...env,DOCKER_CONTEXT:'',DOCKER_HOST:endpoint}});
    assert.notEqual(result.code,0);assert.match(result.stderr,/local Unix Docker engine/);
    assert.equal(await stat(remoteHome).then(()=>true,()=>false),false,'Remote refusal precedes home/profile creation');
  }
  record('host PATH excludes Node/npm; SSH/TCP refuse before profile writes');
  assert.match(await docker(['image','inspect','--format','{{.Id}}',values.image]),/^sha256:[a-f0-9]{64}$/);
  const build=join(root,'image-fixtures');await mkdir(build);
  for(const [index,tag] of tags.entries()){
    const instructions=`ARG FIXTURE_BASE\nFROM \${FIXTURE_BASE}\nUSER root\n${index===0?'RUN node -e \'const fs=require("node:fs"),p="/app/apps/server/dist/deployment-contract.json",v=JSON.parse(fs.readFileSync(p));v.version=2;fs.writeFileSync(p,JSON.stringify(v));\'':'LABEL org.mote.generated-fixture="compatible-next"'}\nUSER node\n`;
    await writeFile(join(build,'Dockerfile'),instructions);
    await docker(['build','--build-arg','FIXTURE_BASE='+values.image,'--tag',tag,build],{timeoutMs:120000});
  }
  const bad=await run('init',['--port',String(await freePort()),'--image',tags[0]],{fail:true});
  assert.match(bad.stderr,/expected mote.deployment version 1, received 2/);assert.equal(await stat(paths.directory).then(()=>true,()=>false),false);
  assert.match((await run('init',['--runtime','native'],{fail:true})).stderr,/Docker profiles/);
  await run('init',['--port',String(await freePort()),'--image',values.image]);p=await loadProfile(paths);ownedVolumes=[p.meta.volume,p.meta.modelsVolume];
  assert.equal((await stat(p.configFile)).mode&0o777,0o600);assert.equal((await stat(p.configFile)).uid,process.getuid());
  assert.deepEqual(p.document.media.dockerWorkers,[]);assert.equal(p.meta.imageVariant,'core');
  assert.equal(p.document.server.hostConfigFile,p.configFile,'Same absolute host path reaches the tooling container');
  assert.equal((await run('token')).stdout.trim(),p.env.MOTE_TOKEN);
  assert.ok(!(await run('config')).stdout.includes(p.env.MOTE_TOKEN),'Normal inspection redacts the owner token');
  assert.match((await run('compose',['--','build'],{fail:true})).stderr,/host Docker CLI/);
  record('incompatible init refuses; local-context precedence, spaced paths and private owner YAML work');
  await run('start');
  const status=JSON.parse((await run('status')).stdout);assert.equal(status.healthy,true);assert.equal(status.runtime,'docker');
  const id=async()=>(await docker(['ps','--all','--quiet','--no-trunc','--filter',`label=com.docker.compose.project=${p.project}`,'--filter','label=com.docker.compose.service=mote'])).trim();
  const first=await id();assert.match(first,/^[a-f0-9]{64}$/);
  assert.equal(await docker(['inspect','--format','{{.Config.User}}',first]),runtimeUser);
  const roles=await docker(['ps','--all','--format','{{.Label "com.docker.compose.service"}}','--filter',`label=com.docker.compose.project=${p.project}`]);
  assert.deepEqual(roles.split('\n').sort(),['mote','storage-init']);
  await request(p,'/api/status',{token:'',status:401});await request(p,'/api/status');
  const web=await fetch(p.url,{signal:AbortSignal.timeout(15000)});assert.equal(web.status,200);assert.match(web.headers.get('content-type'),/text\/html/);assert.match(await web.text(),/<html/i);
  const saved=note();await request(p,'/api/notes',{method:'POST',body:saved,status:201});
  await run('stop');assert.equal(JSON.parse((await run('status')).stdout).healthy,false);
  await run('backup',['--out',join(home,'manual snapshot')]);assert.ok(JSON.parse(await readFile(join(home,'manual snapshot/backup-manifest.json'),'utf8')).checksums['mote.sqlite']);
  await run('start');assert.equal((await request(p,`/api/notes/${saved.id}`)).ocrText,saved.text);
  record('actual Central/Web auth, container health, default resource selection, stop/backup/restart and persisted note pass');
  const state=async()=>({config:await readFile(p.configFile,'utf8'),meta:await readFile(p.metaFile,'utf8'),backups:await readdir(join(p.directory,'backups')),container:await docker(['inspect','--format','{{.Id}} {{.State.Running}} {{.State.StartedAt}}',await id()])});
  const original=await state();
  assert.match((await run('upgrade',['--image',tags[0]],{fail:true})).stderr,/expected mote.deployment version 1, received 2/);
  assert.deepEqual(await state(),original,'Target mismatch must precede stop, snapshot or selection');
  await atomicJson(p.metaFile,{...p.meta,image:tags[0]});const invalid=await state();
  assert.match((await run('start',[],{fail:true})).stderr,/expected mote.deployment version 1, received 2/);assert.deepEqual(await state(),invalid);
  await writeFile(p.metaFile,original.meta);assert.equal((await request(p,`/api/notes/${saved.id}`)).ocrText,saved.text);
  record('mismatched start/upgrade leave the existing process, configuration, snapshot list and data unchanged');
  await rm(join(p.directory,'backups'),{recursive:true});await writeFile(join(p.directory,'backups'),'Generated backup obstruction',{mode:0o600});
  await run('upgrade',['--image',tags[1]],{fail:true});assert.equal(JSON.parse((await run('status')).stdout).healthy,true);assert.equal(await readFile(p.metaFile,'utf8'),original.meta);
  assert.equal((await request(p,`/api/notes/${saved.id}`)).ocrText,saved.text);
  await run('stop');await run('upgrade',['--image',tags[1]],{fail:true});assert.equal(JSON.parse((await run('status')).stdout).healthy,false);assert.equal(await readFile(p.metaFile,'utf8'),original.meta);
  await rm(join(p.directory,'backups'));await mkdir(join(p.directory,'backups'),{mode:0o700});await run('start');
  record('backup failure restores a running deployment and preserves an intentionally stopped deployment');
  const socket=JSON.parse(await docker(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'])).replace(/^unix:\/\//,'');
  const lockScript=`import{profilePaths,withProfileLock}from'/app/scripts/profile-lib.mjs';const p=profilePaths(process.argv[1],process.argv[2]);await withProfileLock(p,async()=>{console.log('lock-held');await new Promise(resolve=>setTimeout(resolve,120000));});`;
  await docker(['run','--detach','--name',holder,'--network','none','--user',runtimeUser,'--group-add',String((await stat(socket)).gid),'--group-add','0','--mount',`type=bind,source=${socket},target=/var/run/docker.sock`,'--mount',`type=bind,source=${home},target=${home}`,'--env','HOME=/tmp','--env','DOCKER_HOST=unix:///var/run/docker.sock','--env','MOTE_DEPLOY_DOCKER_CLI=1','--entrypoint','node',values.cli,'--input-type=module','-e',lockScript,profile,home]);
  for(let retry=0;retry<100;retry++){if(await readFile(join(p.directory,'lifecycle.lock'),'utf8').then(value=>value.includes('container'),()=>false))break;await sleep(100);}
  const lock=await readFile(join(p.directory,'lifecycle.lock'),'utf8');assert.match(JSON.parse(lock).container,/^[a-f0-9]{64}$/);
  assert.match((await run('stop',[],{fail:true})).stderr,/Another profile command is running/);assert.equal(await readFile(join(p.directory,'lifecycle.lock'),'utf8'),lock);
  assert.equal(JSON.parse((await run('status')).stdout).healthy,true,'Read-only status remains available during an operation');
  await docker(['rm','--force',holder]);
  const exclusive="const fs=require('node:fs'),p='/data/o2-exclusive-probe';fs.writeFileSync(p,'generated probe',{flag:'wx'});setTimeout(()=>fs.unlinkSync(p),1000);";
  const contenders=await Promise.all([0,1].map(()=>run('compose',['--','run','--rm','--no-deps','mote','node','-e',exclusive],{allowFailure:true})));
  assert.ok(contenders.some(result=>result.code===0),'A contender must recover the stale lock');
  for(const result of contenders)if(result.code!==0)assert.match(result.stderr,/Another profile command|Lifecycle recovery|Invalid lifecycle lock|ENOENT/,'A concurrent refusal must precede execution of the exclusive data probe');
  await run('stop');assert.equal(await stat(join(p.directory,'lifecycle.lock')).then(()=>true,()=>false),false);await run('start');
  await writeFile(join(p.directory,'lifecycle.lock'),'2147483647',{mode:0o600});
  assert.match((await run('stop',[],{fail:true})).stderr,/native CLI lifecycle lock/);await rm(join(p.directory,'lifecycle.lock'));
  record('live CLI container lock excludes another writer; dead-container recovery works; host PID locks refuse');
  const upgraded=JSON.parse((await run('upgrade',['--image',tags[1]])).stdout.trim().split('\n').at(-1));assert.ok(upgraded.snapshot);
  assert.equal(JSON.parse((await run('status')).stdout).healthy,true);assert.equal((await request(p,`/api/notes/${saved.id}`)).ocrText,saved.text);
  p=await loadProfile(paths);assert.equal(p.meta.image,await docker(['image','inspect','--format','{{.Id}}',tags[1]]));
  const later=note();await request(p,'/api/notes',{method:'POST',body:later,status:201});
  await run('rollback',['--restore-data']);p=await loadProfile(paths);ownedVolumes.push(p.meta.volume);
  assert.equal((await request(p,`/api/notes/${saved.id}`)).ocrText,saved.text);await request(p,`/api/notes/${later.id}`,{status:404});
  record('compatible image upgrade and explicit snapshot rollback preserve generated data and owner configuration');
}finally{
  const holderIds=await docker(['ps','--all','--quiet','--filter','name=^/'+holder+'$']);if(holderIds)await docker(['rm','--force',holder]);
  if(p){
    const current=await loadProfile(paths).catch(()=>p);ownedVolumes.push(current.meta.volume,current.meta.modelsVolume);
    const env={MOTE_DEPLOY_CLI_IMAGE:values.cli};
    const down=await command(join(repository,'scripts/mote-docker'),['compose','--home',home,'--profile',profile,'--','down','--remove-orphans'],{env,timeoutMs:120000});
    if(down.code!==0)cleanupError=Error('Fixture Compose cleanup failed: '+down.stderr);
  }
  const remaining=await docker(['ps','--all','--quiet','--filter',`label=com.docker.compose.project=${ownedProject}`]);
  if(remaining)await docker(['rm','--force',...remaining.split('\n')]);
  for(const volume of new Set(ownedVolumes.filter(Boolean))){assert.ok(volume.startsWith(ownedProject+'-'));await docker(['volume','rm',volume],{fail:false}).catch(error=>{cleanupError??=error;});}
  for(const tag of tags)await docker(['image','rm',tag],{fail:false}).catch(()=>undefined);
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  const after=await originalInventory();
  assert.deepEqual(after,before,'Only this journey may own/delete its fixture containers and volumes');
  if(cleanupError)throw cleanupError;
}
console.info(JSON.stringify({passed:true,checks:records,image:values.image,cli:values.cli,hostNodeAvailable:false,resourcesRestored:true}));
