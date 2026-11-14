import {spawn,spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {MEDIA_MODEL_PATHS} from '@mote/shared';
// Environment for the deployment-owned Docker media sidecars.
export function mediaEnvironment(env) {
  const clean=Object.fromEntries(['PATH', 'LANG', 'TMPDIR', 'TMP', 'TEMP'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  // GUI/launchd processes need the standard Native package-manager locations.
  // Preserve configured search order and never forward credentials.
  if(env.MOTE_RUNTIME==='native'&&process.platform==='darwin')clean.PATH=[...new Set([...(clean.PATH??'/usr/bin:/bin:/usr/sbin:/sbin').split(':'),'/opt/homebrew/bin','/usr/local/bin'])].join(':');
  return clean;
}

/** Shared Native/sidecar command, using the frozen installation roots. The new
 * worker owners implement --model-root; never pass the old sherpa model flags. */
export function mediaWorkerArguments(role,{repository,modelDirectory,ocrPort,asrPort,localImagePort}){
 if(!['ocr','dialogue','local-image'].includes(role))throw Error('media.runtime.unsupported_role');
 if(role==='local-image'&&(process.platform!=='darwin'||process.arch!=='arm64'))throw Error('media.runtime.unsupported_platform');
 const script={ocr:'ocr-server.py',dialogue:'transcription-server.py','local-image':'vlm-server.py'}[role];
 const port={ocr:ocrPort,dialogue:asrPort,'local-image':localImagePort}[role];
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('media.runtime.worker_port_missing');
 return [join(repository,'scripts',script),'--model-root',join(modelDirectory,MEDIA_MODEL_PATHS[role]),...(role==='dialogue'?['--timeout','3600']:[]),'--port',String(port)];
}
/** Child HOME/caches are private deployment resources, not the owner's CLI home.
 * Worker processes inherit neither Central/model credentials nor installer config. */
export function mediaWorkerEnvironment(directory,python,token,env=process.env){
 const clean=Object.fromEntries(['LANG','TMPDIR','TMP','TEMP'].filter(key=>env[key]!==undefined).map(key=>[key,env[key]]));
 return {...clean,PATH:`${dirname(python)}:${env.PATH??'/usr/bin:/bin'}`,HOME:directory,XDG_CACHE_HOME:join(directory,'cache'),HF_HOME:join(directory,'cache','huggingface'),PYTHONUNBUFFERED:'1',PYTHONNOUSERSITE:'1',PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:'True',HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',TRANSFORMERS_OFFLINE:'1',MOTE_MEDIA_WORKER_TOKEN:token};
}
function groupRunning(pgid){
 // Darwin killpg can return EPERM for a group containing only unreaped zombies.
 // Inspect only group IDs/states, never command lines or the owner's environment.
 const result=spawnSync('/bin/ps',['-o','pgid=,stat=','-g',String(pgid)],{encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},timeout:2000,maxBuffer:64*1024});
 if(result.error||result.signal||![0,1].includes(result.status)||result.status===1&&result.stdout.trim())throw Error('media.runtime.process_stop_failed');
 const rows=result.stdout.trim().split(/\r?\n/).filter(Boolean).map(row=>row.trim().match(/^(\d+)\s+(\S+)$/));
 if(rows.some(row=>!row))throw Error('media.runtime.process_stop_failed');
 // On Linux -g selects the session; retain only the exact owned process group.
 return rows.some(row=>Number(row[1])===pgid&&!row[2].startsWith('Z'));
}
/** Own the POSIX process group, including descendants with detached output.
 * A leader exiting is not proof that its FFmpeg/model children have stopped. */
export function spawnMediaProcess(command,args,{cwd,env,stdio='ignore',graceMs=5000}={}){
 const child=spawn(command,args,{cwd,env,stdio,detached:process.platform!=='win32'});
 let exited=false,closed=false,stopping,spawnError,groupStopped=false;
 const stopped=error=>{
  if(error.code!=='ESRCH'&&(process.platform==='win32'||error.code!=='EPERM'||groupRunning(child.pid)))return false;
  // Never reacquire an absent/stopped group by number: it could be reused while
  // we still wait for the ChildProcess close event and inherited output pipes.
  groupStopped=true;return true;
 };
 const signal=kind=>{if(groupStopped)return;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,kind);else if(!exited)child.kill(kind);}catch(error){if(!stopped(error))throw error;}};
 const alive=()=>{if(groupStopped||!child.pid)return false;if(process.platform==='win32')return !exited;try{process.kill(-child.pid,0);return true;}catch(error){if(stopped(error))return false;throw error;}};
 let completed,failed;
 const done=new Promise((resolve,reject)=>{completed=resolve;failed=reject;});
 // Install an observer immediately; callers still receive a rejecting done.
 void done.catch(()=>{});
 const stop=()=>stopping??=(async()=>{
  signal('SIGTERM');const until=Date.now()+graceMs;
  while(alive()&&!exited&&Date.now()<until)await delay(10);
  if(alive())signal('SIGKILL');
  const killedUntil=Date.now()+5000;
  while((alive()||!closed)&&Date.now()<killedUntil)await delay(10);
  if(alive()||!closed)throw Error('media.runtime.process_stop_failed');
 })();
 child.once('error',error=>{spawnError=error;});
 child.once('exit',()=>{exited=true;void stop().then(()=>completed(),failed);});
 child.once('close',()=>{closed=true;exited=true;void stop().then(()=>completed(),failed);});
 return {child,done,get error(){return spawnError;},close:async()=>{await stop();await done;}};
}
