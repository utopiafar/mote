import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

for(const mode of ['background','drain','mixed-lanes'])test(`a large admission-wait backlog yields to provider callbacks and timers (${mode})`,async()=>{
 // Isolate the historical microtask starvation: its own timeout cannot run
 // when the child never returns to the event loop. No private inputs are used.
 const script=`
  import {mkdtempSync,rmSync} from 'node:fs';
  import {tmpdir} from 'node:os';
  import {join} from 'node:path';
  import {Store} from ${JSON.stringify(new URL('../src/store.ts',import.meta.url).href)};
  import {ExecutionEngine,ExecutionFailure} from ${JSON.stringify(new URL('../src/execution-engine.ts',import.meta.url).href)};
  const dir=mkdtempSync(join(tmpdir(),'mote-admission-yield-')),store=new Store(dir),engine=new ExecutionEngine(store);
  ${mode==='mixed-lanes'?"engine.configurePool('waiting',{concurrency:{background:()=>1,interactive:()=>1},lane:step=>step.kind==='provider'?'interactive':'background'});":''}
  let ready=false,callbackRan=false;
  engine.register({kind:'waiting',pool:'waiting',concurrency:()=>1,validate:()=>true,
   admit:()=>{if(ready)return new ExecutionFailure('blocked','fixture_ready');
    // Simulate per-input admission work exceeding a short retry interval.
    const until=performance.now()+2;while(performance.now()<until){}
    return new ExecutionFailure('waiting','fixture_pending',1);},
   execute:async()=>{throw Error('Admission wait must not execute');},commit:()=>{}});
  engine.register({kind:'provider',pool:${JSON.stringify(mode==='mixed-lanes'?'waiting':'provider')},concurrency:()=>1,validate:()=>true,
   execute:async()=>{await new Promise(resolve=>setTimeout(resolve,20));callbackRan=true;return null;},commit:()=>{}});
  const ids=Array.from({length:64},(_,n)=>engine.enqueue('wait-'+n,'waiting',{n}));
  const provider=engine.enqueue('provider','provider',{});
  setTimeout(()=>{ready=true;},10);
  try{${mode!=='drain'?'await engine.tick();await engine.drain([...ids,provider]);':'await engine.drain(ids);await engine.drain([provider]);'}
   console.log(JSON.stringify({ready,callbackRan,provider:engine.get(provider).state,waiting:ids.map(id=>({state:engine.get(id).state,attempts:engine.get(id).attempts}))}));
  }finally{await engine.close();store.close();rmSync(dir,{recursive:true,force:true});}
 `;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
 let output='',errors='',timedOut=false;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
 const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},5000);
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(deadline));
 assert.equal(timedOut,false,'admission waits starved the provider callback and readiness timer');
 assert.equal(code,0,errors);
 const result=JSON.parse(output.trim());
 assert.equal(result.ready,true);assert.equal(result.callbackRan,true);assert.equal(result.provider,'succeeded');
 assert.equal(result.waiting.length,64);assert.ok(result.waiting.every((step:{state:string;attempts:number})=>step.state==='blocked'&&step.attempts===0));
});
