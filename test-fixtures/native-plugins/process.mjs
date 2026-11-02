import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {candidateSha,requestJson} from './runs.mjs';

const repository=new URL('../..',import.meta.url).pathname;
const entry=join(repository,'apps/server/src/index.ts');

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  return port;
}

/** Actual source entrypoint in a private YAML profile, with explicit stop/start. */
export async function createPrivateProcess({version='1',directory,healthTimeoutMs=15000,entry:entrypoint=entry}={}){
  const parent=directory??mkdtempSync(join(tmpdir(),'mote-native-plugin-process-'));
  if(directory)mkdirSync(parent,{recursive:true,mode:0o700});
  const root=directory?join(parent,`process-${randomUUID()}`):parent;
  if(directory)mkdirSync(root,{recursive:true,mode:0o700});
  const dataDir=join(root,'data'),configFile=join(root,'mote.yaml'),token=randomBytes(32).toString('hex'),runId=randomUUID();
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  let port=await freePort(),child,output='',baseUrl=`http://127.0.0.1:${port}`;
  writeFileSync(configFile,serializeConfigDocument({version:1,revision:0,server:{profile:'generated',runtime:'native',host:'127.0.0.1',port,token},storage:{dataDir},models:{deployment:{model:''}},diagnostics:{traceEnabled:false,level:'silent'}}),{mode:0o600});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')));
  async function start(){
    const spawned=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(entrypoint)})`],{cwd:repository,env:{...env,MOTE_CONFIG_FILE:configFile},stdio:['ignore','pipe','pipe']});
    child=spawned;
    for(const stream of [spawned.stdout,spawned.stderr])stream.on('data',chunk=>{output=(output+chunk.toString('utf8')).slice(-12000);});
    const deadline=Date.now()+healthTimeoutMs;
    for(;;){
      if(spawned.exitCode!==null)throw Error(`Central process exited before health: ${output.slice(-2000)}`);
      try{const response=await fetch(baseUrl+'/api/health',{signal:AbortSignal.timeout(500)});if(response.ok)break;}catch{}
      if(Date.now()>=deadline)throw Error(`Central process health deadline: ${output.slice(-2000)}`);
      await delay(20);
    }
  }
  async function stop({strict=true}={}){
    const running=child;if(!running)return {code:0,signal:null,forced:false,timeout:false};
    child=undefined;
    const closed=new Promise(resolve=>running.once('close',(code,signal)=>resolve({code,signal})));
    const deadline=Date.now()+10000;
    let forced=false,result;
    if(running.exitCode!==null||running.signalCode!==null)result={code:running.exitCode,signal:running.signalCode};
    else{
      running.kill('SIGTERM');
      for(;;){
        if(running.exitCode!==null||running.signalCode!==null){result=await closed;break;}
        if(Date.now()>=deadline){forced=true;running.kill('SIGKILL');result=await Promise.race([closed,delay(1000).then(()=>({timeout:true}))]);break;}
        await delay(20);
      }
    }
    const timeout=!result||result.timeout===true;
    const outcome={...(result??{}),forced,timeout};
    if(strict&&(forced||timeout||outcome.code!==0||outcome.signal))throw new Error(`Central process did not shut down gracefully: code=${outcome.code??'none'} signal=${outcome.signal??'none'} forced=${forced} timeout=${timeout}`);
    return outcome;
  }
  try{await start();}
  catch(error){
    let cleanup;
    try{await stop({strict:false});}catch(cleanupError){cleanup=cleanupError;}
    rmSync(root,{recursive:true,force:true});
    if(cleanup)throw new AggregateError([error,cleanup],'Central process startup and cleanup failed',{cause:error});
    throw error;
  }
  return {runId,candidateSha:candidateSha(),version,dataDir,configFile,token,
    get url(){return baseUrl;},get output(){return output;},
    metadata(){return {runId,candidateSha:candidateSha(),version};},
    request(path,options={}){return requestJson(baseUrl,path,{token,...options});},
    async writeNote(note){return this.request('/api/notes',{method:'POST',body:note});},
    async readNote(id){return this.request('/api/notes/'+encodeURIComponent(id));},
    async stop(){return stop();},
    async restart(){await stop();writeFileSync(configFile,serializeConfigDocument({version:1,revision:0,server:{profile:'generated',runtime:'native',host:'127.0.0.1',port,token},storage:{dataDir},models:{deployment:{model:''}},diagnostics:{traceEnabled:false,level:'silent'}}),{mode:0o600});await start();return this;},
    async close({remove=true,strict=true}={}){let failure;try{await stop({strict});}catch(error){failure=error;}finally{if(remove)rmSync(root,{recursive:true,force:true});}if(failure)throw failure;}
  };
}
