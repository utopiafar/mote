import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {runtimeListenerPath} from '../src/runtime-listener.js';

async function shutdownDuringPublication(t:TestContext,signal:'SIGTERM'|'SIGINT'){
    const root=await mkdtemp(join(tmpdir(),'mote-startup-shutdown-'));
    let stop:(()=>Promise<void>)|undefined;
    t.after(async()=>{try{await stop?.();}finally{await rm(root,{recursive:true,force:true});}});
    const repository=fileURLToPath(new URL('../../../',import.meta.url));
    const config=join(root,'mote.yaml'),logs=join(root,'logs'),data=join(root,'data');
    const reached=join(root,'publication-pending'),release=join(root,'publication-release'),hook=join(root,'pause-publication.mjs');
    const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
    const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
    const token=randomBytes(32).toString('hex'),url=`http://127.0.0.1:${port}`;
    await writeFile(config,serializeConfigDocument({version:1,revision:0,server:{profile:'generated',runtime:'native',host:'127.0.0.1',port,token},storage:{dataDir:data},models:{deployment:{model:''}},diagnostics:{enabled:true,level:'info',directory:logs,traceEnabled:false}}),{mode:0o600});
    // Hold the real filesystem publication after listen(), without replacing
    // Central, its supervisor, signal handlers or lifecycle hooks. The test
    // releases it only after shutdown has stopped accepting HTTP requests.
    await writeFile(hook,`
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const rename=fs.rename;
fs.rename=async function(from,to){
  if(to===${JSON.stringify(runtimeListenerPath(config))}){
    await fs.writeFile(${JSON.stringify(reached)},'',{mode:0o600});
    for(;;){try{await fs.access(${JSON.stringify(release)});break;}catch{await delay(5);}}
  }
  return rename(from,to);
};
syncBuiltinESMExports();
`,{mode:0o600});
    const child=spawn(process.execPath,[join(repository,'scripts/central-runner.mjs'),join(repository,'apps/server/src/index.ts'),join(logs,'central.log'),'--mote-instance='+randomUUID()],{
      cwd:repository,stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH,TMPDIR:tmpdir(),NODE_OPTIONS:`--import tsx --import ${pathToFileURL(hook).href}`,MOTE_CONFIG_FILE:config},
    });
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-12000);});
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    stop=async()=>{
      await writeFile(release,'',{mode:0o600});
      if(child.exitCode===null&&child.signalCode===null){
        const force=setTimeout(()=>child.kill('SIGKILL'),5000);
        child.kill('SIGTERM');try{await closed;}finally{clearTimeout(force);}
      }else await closed;
    };
    const deadline=Date.now()+20000;
    for(;;){
      assert.equal(child.exitCode,null,output);assert.equal(child.signalCode,null,output);
      try{await readFile(reached);break;}catch{}
      assert.ok(Date.now()<deadline,'Central must reach pending runtime publication: '+output);await delay(10);
    }
    assert.equal((await fetch(url+'/api/status',{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)})).status,200);
    await assert.rejects(readFile(runtimeListenerPath(config)),{code:'ENOENT'});
    child.kill(signal);
    // With the regression, the child dies from the forwarded signal here.
    // A graceful stop closes the real listener while publication stays held.
    for(;;){
      assert.equal(child.exitCode,null,output);assert.equal(child.signalCode,null,output);
      try{await fetch(url+'/api/health',{signal:AbortSignal.timeout(500)});}catch(error){
        if((error as {cause?:{code?:string}})?.cause?.code==='ECONNREFUSED')break;
      }
      assert.ok(Date.now()<deadline,'Shutdown must stop HTTP before publishing the runtime listener: '+output);await delay(10);
    }
    await writeFile(release,'',{mode:0o600});
    assert.deepEqual(await closed,{code:0,signal:null},output);
    await assert.rejects(readFile(join(data,'server.pid')),{code:'ENOENT'});
    await assert.rejects(readFile(join(logs,'central.lock')),{code:'ENOENT'});
    await assert.rejects(readFile(runtimeListenerPath(config)),{code:'ENOENT'});
    assert.ok(!(await readdir(root)).some(name=>name.endsWith('.tmp')),'Shutdown must finish the pending runtime publication and its cleanup');
    const rows=(await Promise.all((await readdir(logs)).filter(name=>name.endsWith('.ndjson')).map(name=>readFile(join(logs,name),'utf8')))).join('').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {event?:string;seq:number});
    const listening=rows.filter(row=>row.event==='server.listening'),stopped=rows.filter(row=>row.event==='server.stopped');
    assert.equal(listening.length,1,'Each live HTTP listener retains its startup diagnostic, including during shutdown');
    assert.equal(stopped.length,1);
    assert.ok(listening[0]!.seq<stopped[0]!.seq,'Pending startup diagnostics must finish before the stop diagnostic');
    assert.ok(!rows.some(row=>row.event==='process.exited'||row.event==='server.stop_failed'||row.event==='server.start_failed'));
    await assert.rejects(fetch(url+'/api/health',{signal:AbortSignal.timeout(500)}));
}

test('Central shuts down cleanly on SIGTERM while HTTP is live and runtime listener publication is pending',{timeout:30000},t=>shutdownDuringPublication(t,'SIGTERM'));
test('Central shuts down cleanly on SIGINT while HTTP is live and runtime listener publication is pending',{timeout:30000},t=>shutdownDuringPublication(t,'SIGINT'));
