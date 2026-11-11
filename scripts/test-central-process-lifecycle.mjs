// Generated-only process journey using the built Central entry point and actual supervisor.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,open,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {serializeConfigDocument} from '../packages/shared/src/config-file.ts';
import {runtimeListenerPath} from '../apps/server/dist/runtime-listener.js';
import {command} from './profile-fixtures.mjs';

const repository=resolve(import.meta.dirname,'..'),output=await mkdtemp(join(tmpdir(),'mote-central-process-')),token=randomBytes(32).toString('hex');
const version=JSON.parse(await readFile(join(repository,'apps/server/package.json'),'utf8')).version;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')));
const supervisorLogs=async()=>(await Promise.all((await readdir(output)).filter(name=>/^supervisor\./.test(name)).map(name=>readFile(join(output,name),'utf8')))).join('');
const report={status:'running',version,fixtureOnly:true,liveModel:false,physicalDevice:false,checks:[],output};
let child;
async function until(read,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Central exited before '+label);if(await read())return;await delay(100);}throw Error('Timed out: '+label);}
async function start(name){
  const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const dataDir=join(output,name),file=join(output,name+'.yaml'),log=join(output,name+'.log');
  await writeFile(file,serializeConfigDocument({version:1,revision:0,server:{profile:'test',runtime:'native',host:'127.0.0.1',port,token},storage:{dataDir},models:{deployment:{model:''}},diagnostics:{traceEnabled:false}}),{mode:0o600});
  child=spawn(process.execPath,[join(repository,'scripts/central-runner.mjs'),join(repository,'apps/server/dist/index.js'),log,'--mote-instance='+randomUUID()],{cwd:repository,env:{...env,MOTE_CONFIG_FILE:file},stdio:'ignore'});
  const base='http://127.0.0.1:'+port;
  await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}},'authenticated-ready server');
  await until(async()=> (await supervisorLogs()).includes('server.listening'),'supervisor listening event and runtime locator');
  await until(async()=>{const locator=JSON.parse(await readFile(runtimeListenerPath(file),'utf8').catch(()=> 'null'));return locator?.port===port;},'current startup runtime locator');
  const runtime=JSON.parse(await readFile(runtimeListenerPath(file),'utf8')); assert.equal(runtime.port,port);assert.equal((await stat(runtimeListenerPath(file))).mode&0o777,0o600);
  const health=()=>command(process.execPath,[join(repository,'apps/server/dist/healthcheck.js')],{env:{...env,MOTE_CONFIG_FILE:file}});
  assert.equal((await health()).code,0);
  await writeFile(file,serializeConfigDocument({version:1,revision:0,server:{profile:'test',runtime:'native',host:'127.0.0.1',port:port===65535?port-1:port+1,token},storage:{dataDir},models:{deployment:{model:''}},diagnostics:{traceEnabled:false}}),{mode:0o600});
  await until(async()=>{const response=await fetch(base+'/api/configuration',{headers:{authorization:'Bearer '+token}});const view=await response.json();return view.domains?.find(domain=>domain.id==='server')?.status==='restart-required';},'pending port change');
  assert.equal((await health()).code,0,'the Docker health command must check the startup port while a different port is saved');
  return async(method,path,payload)=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const body=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status}`);return body;};
}
async function stop(name){
  const running=child;child=undefined;const closed=new Promise(resolve=>running.once('close',(code,signal)=>resolve({code,signal})));running.kill('SIGTERM');
  const timer=delay(30000,undefined,{ref:false}).then(()=>({code:'timeout'}));const exit=await Promise.race([closed,timer]);if(exit.code==='timeout')running.kill('SIGKILL');assert.equal(exit.code,0);
  assert.ok((await supervisorLogs()).includes('server.stopped'));
  assert.equal(await stat(join(output,name,'server.pid')).then(()=>true,()=>false),false,'PID lock must be removed');
  assert.equal(await stat(runtimeListenerPath(join(output,name+'.yaml'))).then(()=>true,()=>false),false,'matching runtime locator must be removed');
  assert.equal((await command(process.execPath,[join(repository,'apps/server/dist/healthcheck.js')],{env:{...env,MOTE_CONFIG_FILE:join(output,name+'.yaml')}})).code,1,'a stopped listener cannot remain healthy');
}
async function bootstrapConsistency() {
  const reserve=async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
  const oldPort=await reserve();let port=await reserve();while(port===oldPort)port=await reserve();
  const name='boot-new',file=join(output,name+'.yaml'),log=join(output,name+'.log'),oldDirectory=join(output,'boot-old'),dataDir=join(output,name),hook=join(output,'bootstrap-edit.mjs');
  const first={version:1,revision:0,server:{profile:'test',runtime:'native',host:'127.0.0.1',port:oldPort,token},storage:{dataDir:oldDirectory},models:{deployment:{model:''}},diagnostics:{traceEnabled:false}};
  const next={...first,server:{...first.server,port},storage:{dataDir}};
  await writeFile(file,serializeConfigDocument(first),{mode:0o600});
  // Edit immediately after the entry point's pure file read, before ConfigService
  // initializes. This makes the prior two-document boot race deterministic.
  await writeFile(hook,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const open=fs.openSync,read=fs.readFileSync;let target,edited=false;fs.openSync=function(path,...args){const fd=open.call(this,path,...args);if(path===${JSON.stringify(file)})target=fd;return fd;};fs.readFileSync=function(path,...args){const raw=read.call(this,path,...args);if(path===target&&!edited){edited=true;fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(serializeConfigDocument(next))});fs.openSync=open;fs.readFileSync=read;syncBuiltinESMExports();}return raw;};syncBuiltinESMExports();`,{mode:0o600});
  const destination=await open(log,'wx',0o600);
  try {child=spawn(process.execPath,['--import',hook,join(repository,'apps/server/dist/index.js'),'--mote-instance='+randomUUID()],{cwd:repository,env:{...env,MOTE_CONFIG_FILE:file},stdio:['ignore',destination.fd,destination.fd]});} finally {await destination.close();}
  const base='http://127.0.0.1:'+port;
  await until(async()=> (await readFile(log,'utf8').catch(()=>'' )).includes('server.listening'),'single initialized bootstrap listener');
  const runtime=JSON.parse(await readFile(runtimeListenerPath(file),'utf8'));assert.equal(runtime.port,port);
  assert.equal(await stat(oldDirectory).then(()=>true,()=>false),false,'the pure first read must not create or lock its stale data directory');
  assert.equal(Number(await readFile(join(dataDir,'server.pid'),'utf8')),runtime.pid,'PID lock belongs to the initialized data directory');
  const response=await fetch(base+'/api/configuration',{headers:{authorization:'Bearer '+token}}),view=await response.json();assert.equal(response.status,200);assert.equal(view.storage.dataDir,dataDir);assert.equal(view.domains.find(domain=>domain.id==='server').effective.port,port);
  assert.equal((await command(process.execPath,[join(repository,'apps/server/dist/healthcheck.js')],{env:{...env,MOTE_CONFIG_FILE:file}})).code,0);
  await stop(name);report.checks.push('controlled YAML change between pure load and ConfigService initialization keeps credential directory, PID lock, Store and listener on one boot document');
}
try{
  await bootstrapConsistency();
  const id=randomUUID(),text='Generated process lifecycle note: Aurora backup checkpoint code ZX41.';
  let request=await start('vault');await request('POST','/api/notes',{id,deviceId:'generated-process',deviceName:'Generated process',platform:'import',capturedAt:'2026-10-01T08:00:00Z',text});
  assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);await stop('vault');report.checks.push('built entry point + actual supervisor + HTTP note + SIGTERM + private runtime locator + pending-port Docker health probe');
  request=await start('vault');assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);const archive=await request('GET','/api/export');await stop('vault');report.checks.push('same-vault restart preserves exact original and releases PID lock');
  request=await start('restored');await request('POST','/api/import',archive);assert.equal((await request('GET','/api/notes/'+id)).ocrText,text);await request('DELETE','/api/captures/'+id);assert.equal((await request('GET','/api/status')).storage.captures,0);await stop('restored');report.checks.push('portable archive restores in fresh vault and original deletion completes');
  report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack??String(error);process.exitCode=1;}
finally{if(child&&child.exitCode===null){const running=child,closed=new Promise(resolve=>running.once('close',resolve));running.kill('SIGTERM');const stopped=await Promise.race([closed.then(()=>true),delay(30000,undefined,{ref:false}).then(()=>false)]);if(!stopped)running.kill('SIGKILL');}await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));}
