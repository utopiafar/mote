import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,lstat,readdir,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DiagnosticLogStore} from '../src/diagnostic-log-store.mjs';

type Message={event:string;error?:string};
async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-retention-lock-'));
  const children:ReturnType<typeof writer>[]=[];
  t.after(async()=>{
    for(const child of children){if(child.child.exitCode===null&&child.child.signalCode===null)child.child.kill('SIGKILL');await child.closed;}
    await rm(directory,{recursive:true,force:true});
  });
  function writer(mode:string,family='central'){
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')));
    const child=fork(new URL('./fixtures/diagnostic-lock-worker.mjs',import.meta.url),[directory,mode,family],{execArgv:[],env,stdio:['ignore','ignore','pipe','ipc']});
    const messages:Message[]=[];let stderr='';
    child.stderr!.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    child.on('message',message=>messages.push(message as Message));
    const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    const wait=async(event:string)=>{
      const deadline=Date.now()+15000;
      for(;;){
        const message=messages.find(message=>message.event===event);if(message)return message;
        const failure=messages.find(message=>message.event==='failed');
        assert.ok(!failure,`${event}: ${failure?.error}`);
        assert.ok(child.exitCode===null&&child.signalCode===null,`${event}: writer exited: ${stderr}`);
        assert.ok(Date.now()<deadline,`${event}: writer deadline: ${stderr}`);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    };
    const result={child,closed,wait};children.push(result);return result;
  }
  return {directory,writer,store:new DiagnosticLogStore(directory,{minFreeBytes:0})};
}

test('interruption before lock metadata is written cannot publish an empty retention lock',async t=>{
  const f=await fixture(t),prior='Generated diagnostic evidence must survive the crash\n';
  await writeFile(join(f.directory,'original.log'),prior,{mode:0o600});
  const interrupted=f.writer('publishing');await interrupted.wait('publishing');
  await assert.rejects(lstat(join(f.directory,'retention.lock')),{code:'ENOENT'});
  interrupted.child.kill('SIGKILL');await interrupted.closed;
  await f.store.init();
  assert.equal(await readFile(join(f.directory,'original.log'),'utf8'),prior);
  const at=new Date().toISOString();await f.store.append([{channel:'error',at,line:'{"event":"generated.restarted"}\n'}]);
  assert.equal(f.store.files.length,1);
  assert.equal(await readFile(join(f.directory,f.store.files[0]!.name),'utf8'),'{"event":"generated.restarted"}\n');
});

test('independent module copies in one process cannot steal each other\'s live retention lock',async t=>{
  const f=await fixture(t),writer=f.writer('copies');
  await writer.wait('done');assert.deepEqual(await writer.closed,{code:0,signal:null});
});

test('a crash after atomic publication reuses the marker even before its candidate link is cleaned up',async t=>{
  const f=await fixture(t),owner=f.writer('published');await owner.wait('published');
  const path=join(f.directory,'retention.lock'),identity=await lstat(path);assert.equal(identity.nlink,2);
  owner.child.kill('SIGKILL');await owner.closed;
  await f.store.init();assert.equal((await lstat(path)).ino,identity.ino);
  const next=f.writer('hold');await next.wait('entered');next.child.send('release');await next.wait('done');assert.equal((await next.closed).code,0);
});

test('a live writer remains exclusive regardless of the lock file age',async t=>{
  const f=await fixture(t),owner=f.writer('hold');await owner.wait('entered');
  const path=join(f.directory,'retention.lock'),identity=await lstat(path),before=await readFile(path);
  await utimes(path,new Date(0),new Date(0));
  const contender=f.writer('hold'),failure=await contender.wait('failed');
  assert.match(failure.error!,/Diagnostic retention lock unavailable/);
  assert.equal((await contender.closed).code,1);
  assert.equal((await lstat(path)).ino,identity.ino);assert.deepEqual(await readFile(path),before);
  owner.child.send('release');await owner.wait('done');assert.equal((await owner.closed).code,0);
  const next=f.writer('hold');await next.wait('entered');next.child.send('release');await next.wait('done');assert.equal((await next.closed).code,0);
});

test('a killed owner releases retention for concurrent Central and supervisor appends without losing records',async t=>{
  const f=await fixture(t),owner=f.writer('hold');await owner.wait('entered');
  const identity=await lstat(join(f.directory,'retention.lock'));
  owner.child.kill('SIGKILL');assert.equal((await owner.closed).signal,'SIGKILL');
  const writers=Array.from({length:6},(_,index)=>f.writer('append',index%2?'supervisor':'central'));
  await Promise.all(writers.map(writer=>writer.wait('ready')));
  for(const writer of writers)writer.child.send('append');
  await Promise.all(writers.map(async writer=>{await writer.wait('done');assert.equal((await writer.closed).code,0);}));
  await f.store.refresh();
  const records=(await Promise.all(f.store.files.map(async file=>(await readFile(join(f.directory,file.name),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {writer:number;index:number})))).flat();
  assert.equal(records.length,6*24);assert.equal(new Set(records.map(record=>record.writer+':'+record.index)).size,6*24);
  assert.equal(new Set(f.store.files.map(file=>file.family)).size,2);
  assert.equal((await lstat(join(f.directory,'retention.lock'))).ino,identity.ino,'recovery must not replace the lock identity');
  assert.ok((await readdir(f.directory)).every(name=>!name.endsWith('.tmp')));
});

test('simultaneous first starts publish one protocol and preserve every generated append',async t=>{
  const f=await fixture(t),writers=Array.from({length:6},(_,index)=>f.writer('append',index%2?'supervisor':'central'));
  await Promise.all(writers.map(writer=>writer.wait('ready')));
  for(const writer of writers)writer.child.send('append');
  await Promise.all(writers.map(async writer=>{await writer.wait('done');assert.equal((await writer.closed).code,0);}));
  await f.store.refresh();
  const lines=(await Promise.all(f.store.files.map(async file=>(await readFile(join(f.directory,file.name),'utf8')).trim().split('\n')))).flat();
  assert.equal(lines.length,6*24);assert.equal(new Set(lines).size,6*24);
  assert.ok((await readdir(f.directory)).every(name=>!name.endsWith('.tmp')));
});

test('a live legacy writer paused with an empty file cannot be reclaimed before it finishes creation',async t=>{
  const f=await fixture(t),owner=f.writer('legacy');await owner.wait('entered');
  const path=join(f.directory,'retention.lock'),identity=await lstat(path);assert.equal(identity.size,0);
  await assert.rejects(f.store.init(),/offline recovery/);
  assert.equal((await lstat(path)).ino,identity.ino);assert.equal((await lstat(path)).size,0);
  owner.child.send('release');await owner.wait('done');assert.equal((await owner.closed).code,0);
  await f.store.init();
});

test('unknown empty, malformed and live legacy retention locks require offline recovery and remain untouched',async t=>{
  const f=await fixture(t),path=join(f.directory,'retention.lock'),evidence='Generated protected evidence\n';
  await writeFile(join(f.directory,'original.log'),evidence,{mode:0o600});
  for(const value of ['', '{partial',JSON.stringify({pid:process.pid,startedAt:1})]){
    await writeFile(path,value,{mode:0o600});await utimes(path,new Date(0),new Date(0));const identity=await lstat(path);
    await assert.rejects(f.store.init(),/offline recovery/);
    assert.equal(await readFile(path,'utf8'),value);assert.equal((await lstat(path)).ino,identity.ino);
    assert.equal(await readFile(join(f.directory,'original.log'),'utf8'),evidence);
    await rm(path);
  }
  await f.store.init();
});

test('a retention lock symlink cannot change its target or enable log writes',async t=>{
  const f=await fixture(t),target=join(f.directory,'private-original');await writeFile(target,'Generated private original');
  await symlink(target,join(f.directory,'retention.lock'));
  await assert.rejects(f.store.init(),/offline recovery/);
  assert.equal(await readFile(target,'utf8'),'Generated private original');assert.equal((await lstat(join(f.directory,'retention.lock'))).isSymbolicLink(),true);
});

test('a linked or nonempty retention mutex fails closed without changing protected files',async t=>{
  const f=await fixture(t);await f.store.init();
  const path=join(f.directory,'retention-mutex.sqlite'),target=join(f.directory,'private-original');
  await writeFile(target,'Generated private original');await rm(path);await symlink(target,path);
  await assert.rejects(f.store.refresh(),/Invalid diagnostic retention mutex/);
  assert.equal(await readFile(target,'utf8'),'Generated private original');assert.equal((await lstat(path)).isSymbolicLink(),true);
  await rm(path);await writeFile(path,'Generated unrecognized mutex');
  await assert.rejects(f.store.refresh(),/Invalid diagnostic retention mutex/);
  assert.equal(await readFile(path,'utf8'),'Generated unrecognized mutex');
});
