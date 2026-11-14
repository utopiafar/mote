import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {serializeConfigDocument} from '@mote/shared/config-file';

test('the real supervisor refuses an unknown empty lock, then starts and restarts Central after offline recovery', {timeout:90000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-retention-startup-')),logs=join(root,'logs'),config=join(root,'mote.yaml');
  const repository=fileURLToPath(new URL('../../../',import.meta.url));
  const children:ReturnType<typeof launch>[]=[];
  t.after(async()=>{
    for(const run of children){if(run.child.exitCode===null&&run.child.signalCode===null)run.child.kill('SIGTERM');await run.closed;}
    await rm(root,{recursive:true,force:true});
  });
  const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const token=randomBytes(32).toString('hex'),url=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`};
  await mkdir(logs,{mode:0o700});
  await writeFile(config,serializeConfigDocument({version:1,revision:0,server:{profile:'generated',runtime:'native',host:'127.0.0.1',port,token},storage:{dataDir:join(root,'data')},models:{deployment:{model:''}},diagnostics:{enabled:true,level:'info',directory:logs,traceEnabled:false}}),{mode:0o600});
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')&&key!=='NODE_OPTIONS')),NODE_OPTIONS:'--import tsx',MOTE_CONFIG_FILE:config};
  function launch(){
    const child=spawn(process.execPath,[join(repository,'scripts/central-runner.mjs'),join(repository,'apps/server/src/index.ts'),join(logs,'central.log'),'--mote-instance='+randomUUID()],{cwd:repository,env,stdio:['ignore','pipe','pipe']});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-12000);});
    let timer:ReturnType<typeof setTimeout>;
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
      timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Generated supervisor failed to exit'));},60000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
    });
    const run={child,closed,get output(){return output;}};children.push(run);return run;
  }
  async function rows(){return (await Promise.all((await readdir(logs)).filter(name=>name.endsWith('.ndjson')).map(name=>readFile(join(logs,name),'utf8')))).join('').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {event?:string;family?:string});}
  async function ready(run:ReturnType<typeof launch>){
    const deadline=Date.now()+20000;
    for(;;){
      assert.equal(run.child.exitCode,null,run.output);
      try{const response=await fetch(url+'/api/status',{headers,signal:AbortSignal.timeout(500)});if(response.ok&&(await rows()).some(row=>row.event==='server.listening'))return;}catch{}
      assert.ok(Date.now()<deadline,'Central must become ready through the real supervisor: '+run.output);await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
  const oldLock=join(logs,'retention.lock');await writeFile(oldLock,'',{mode:0o600});
  const evidence='Generated historical diagnostic evidence\n';await writeFile(join(logs,'original.log'),evidence,{mode:0o600});
  const blocked=launch();assert.equal((await blocked.closed).code,1);assert.match(blocked.output,/offline recovery/);
  await assert.rejects(fetch(url+'/api/health',{signal:AbortSignal.timeout(500)}));
  assert.equal((await lstat(oldLock)).size,0);assert.equal(await readFile(join(logs,'original.log'),'utf8'),evidence);
  // Offline: the only generated supervisor has exited, its Central child was
  // never launched, and no writer can restart. Preserve the ambiguous inode.
  await rename(oldLock,join(logs,'retention.lock.offline-backup'));
  for(let index=0;index<2;index++){
    const run=launch();await ready(run);
    assert.equal((await fetch(url+'/api/status')).status,401);
    const snapshot=await readFile(join(logs,'original.log'),'utf8');assert.equal(snapshot,evidence);
    run.child.kill('SIGTERM');assert.deepEqual(await run.closed,{code:0,signal:null},run.output);
  }
  const names=await readdir(logs);assert.ok(names.some(name=>name.startsWith('central.')));assert.ok(names.some(name=>name.startsWith('supervisor.')));
  assert.equal((await rows()).filter(row=>row.event==='server.listening').length,2);
  assert.equal((await lstat(join(logs,'retention.lock.offline-backup'))).size,0);
  assert.equal((await lstat(join(logs,'retention-mutex.sqlite'))).size,0);
  assert.equal((await lstat(join(logs,'retention-mutex.sqlite'))).mode&0o777,0o600);
});
