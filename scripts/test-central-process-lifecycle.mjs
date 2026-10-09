// Generated-only process journey using the built Central entry point and actual supervisor.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const repository=resolve(import.meta.dirname,'..'),output=await mkdtemp(join(tmpdir(),'mote-central-process-')),token=randomBytes(32).toString('hex');
const version=JSON.parse(await readFile(join(repository,'apps/server/package.json'),'utf8')).version;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')));
const report={status:'running',version,fixtureOnly:true,liveModel:false,physicalDevice:false,checks:[],output};
let child;
async function until(read,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Central exited before '+label);if(await read())return;await delay(100);}throw Error('Timed out: '+label);}
async function start(name){
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const dataDir=join(output,name),file=join(output,name+'.env'),log=join(output,name+'.log');
  await writeFile(file,`MOTE_DATA_DIR=${dataDir}\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_TOKEN=${token}\nMOTE_MODEL=\nMOTE_MODEL_API_KEY=\nMOTE_EMBEDDING_MODEL=\nMOTE_AGENT_TRACE_ENABLED=0\n`,{mode:0o600});
  child=spawn(process.execPath,[join(repository,'scripts/central-runner.mjs'),join(repository,'apps/server/dist/index.js'),log,'--mote-instance='+randomUUID()],{cwd:repository,env:{...env,MOTE_ENV_FILE:file,MOTE_RUNTIME:'native'},stdio:'ignore'});
  const base='http://127.0.0.1:'+port;
  await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'authenticated-ready server');
  assert.ok((await readFile(log,'utf8')).includes('server.listening'));
  return async(method,path,payload)=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const body=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status}`);return body;};
}
async function stop(name){
  const running=child;child=undefined;const closed=new Promise(resolve=>running.once('close',(code,signal)=>resolve({code,signal})));running.kill('SIGTERM');
  const timer=delay(30000,undefined,{ref:false}).then(()=>({code:'timeout'}));const exit=await Promise.race([closed,timer]);if(exit.code==='timeout')running.kill('SIGKILL');assert.equal(exit.code,0);
  assert.ok((await readFile(join(output,name+'.log'),'utf8')).includes('server.stopped'));
  assert.equal(await stat(join(output,name,'server.pid')).then(()=>true,()=>false),false,'PID lock must be removed');
}
try{
  const id=randomUUID(),text='Generated process lifecycle note: Aurora backup checkpoint code ZX41.';
  let request=await start('vault');await request('POST','/api/notes',{id,deviceId:'generated-process',deviceName:'Generated process',platform:'import',capturedAt:'2026-10-01T08:00:00Z',text});
  assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);await stop('vault');report.checks.push('built entry point + actual supervisor + HTTP note + SIGTERM');
  request=await start('vault');assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);const archive=await request('GET','/api/export');await stop('vault');report.checks.push('same-vault restart preserves exact original and releases PID lock');
  request=await start('restored');await request('POST','/api/import',archive);assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);await request('DELETE','/api/captures/'+id);assert.equal((await request('GET','/api/status')).storage.captures,0);await stop('restored');report.checks.push('portable archive restores in fresh vault and original deletion completes');
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack??String(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null)child.kill('SIGKILL');await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));}
