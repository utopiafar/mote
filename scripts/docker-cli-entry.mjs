import {readFile,mkdir} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {parseMoteArguments} from './mote-options.mjs';
import {profilePaths,initialize,loadProfile,withProfileLock,assertDeploymentCompatible,composeOperation} from './profile-lib.mjs';
import {validateDeploymentContract} from './deployment-contract.mjs';

try{
  const home=process.env.MOTE_DEPLOY_HOME;
  if(process.env.MOTE_DEPLOY_DOCKER_CLI!=='1'||!isAbsolute(home??''))throw Error('Use scripts/mote-docker to bind a local Docker socket and profile home');
  validateDeploymentContract(JSON.parse(await readFile(new URL('../deploy/deployment-contract.json',import.meta.url),'utf8')));
  const input=process.argv.slice(2),split=input.indexOf('--'),head=split<0?input:input.slice(0,split),tail=split<0?[]:input.slice(split);
  let args=[...head,'--home',home,...tail];
  let parsed;
  try{parsed=parseMoteArguments(args);}catch{throw Error('Invalid arguments; use --help. Credentials are never accepted as argument values');}
  const {values,positionals}=parsed,command=positionals[0]??'help';
  const commands=new Set(['help','init','start','stop','status','config','token','backup','restore','backup-schedule','upgrade','rollback','compose','migrate-storage-owner','log-retention','tls']);
  if(!commands.has(command))throw Error('Docker entry supports help, init, start, stop, status, config, token, backup, restore, backup-schedule, upgrade, rollback, compose, migrate-storage-owner, log-retention and tls');
  if(values.runtime&&values.runtime!=='docker'||values.release)throw Error('Docker entry requires Docker profiles and prebuilt local images; use the native Node entry for native deployments');
  if(positionals.length>(command==='backup-schedule'?2:1))throw Error('Unexpected arguments; use -- before compose arguments');
  for(const name of ['out','from'])if(values[name]){
    const path=resolve(process.env.MOTE_DEPLOY_WORKING_DIRECTORY,values[name]),delta=relative(home,path);
    if(delta==='..'||delta.startsWith('../')||isAbsolute(delta))throw Error(`--${name} must be inside the mounted profile home`);
    // The caller's working directory need not exist in this container.
    for(let i=0;i<head.length;i++){
      if(head[i]==='--'+name)head[++i]=path;
      else if(head[i].startsWith('--'+name+'='))head[i]='--'+name+'='+path;
    }
  }
  args=[...head,'--home',home,...tail];
  const paths=profilePaths(values.profile,home);
  if(values.help||command==='help'){
    console.info('Mote Docker profiles (host: POSIX shell + local Docker; no host Node/npm)\n  scripts/mote-docker init --profile prod --home /srv/mote/profiles --image LOCAL_IMAGE\n  scripts/mote-docker start|stop|status|config|token|backup|restore|upgrade|rollback [--profile NAME] [--home PATH]\n  scripts/mote-docker backup-schedule configure|status|run-due|watch|restore-check [--profile NAME] [--home PATH]\nUse --image for upgrade, --restore-data for rollback, --out/--from inside the mounted home for backups. Scheduling defaults to disabled; configure installs no service.\nImages must be built or pulled with the host Docker CLI first. Native/source update commands use node scripts/mote.mjs.');
  }else if(command==='init'){
    const version=JSON.parse(await readFile(new URL('../apps/server/package.json',import.meta.url),'utf8')).version;
    const image=values.image??`mote-central:${version}-${values['image-variant']??'core'}`;
    await assertDeploymentCompatible({...paths,meta:{runtime:'docker',image}});
    await mkdir(paths.directory,{recursive:true,mode:0o700});
    console.info(JSON.stringify(await withProfileLock(paths,()=>initialize(paths,{...values,runtime:'docker',image}))));
  }else{
    const p=await loadProfile(paths);
    if(p.meta.runtime!=='docker')throw Error('Docker entry cannot operate a native profile; use node scripts/mote.mjs on its host');
    if(command==='compose'&&composeOperation(tail.slice(1))==='build')throw Error('Build with the host Docker CLI, then select a local image; this tooling image has no source build context');
    process.argv=[process.execPath,new URL('./mote.mjs',import.meta.url).pathname,...args];
    await import('./mote.mjs');
  }
}catch(error){console.error(`Mote Docker: ${error.message}`);process.exitCode=1;}
