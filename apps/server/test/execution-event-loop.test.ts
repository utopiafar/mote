import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';

test('filling available model slots lets callbacks cancel queued work before its first attempt',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {EvidenceStore: Store}=await import('../src/evidence-store.js'),{ExecutionEngine}=await import('../src/execution-engine.js');
 const directory=mkdtempSync(join(tmpdir(),'mote-slot-admission-turn-')),store=new Store(directory),engine=new ExecutionEngine(store);
 let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),started:string[]=[];
 t.after(async()=>{release();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'generated',pool:'generated',concurrency:()=>32,validate:()=>true,
  execute:async step=>{started.push(step.id);await held;},commit:()=>{}});
 const ids=Array.from({length:64},(_,index)=>engine.enqueue('generated-'+index,'generated',{index}));
 const callback=new Promise<{started:number;transaction:boolean}>(resolve=>setImmediate(()=>{
  const observed={started:started.length,transaction:store.db.isTransaction};engine.cancel(ids[1]);release();resolve(observed);
 }));
 const running=engine.tick(),observed=await callback;
 assert.ok(observed.started>0&&observed.started<32,`callback saw ${observed.started}/32 slots filled`);
 assert.equal(observed.transaction,false,'slot admission must commit before yielding to owner callbacks');
 await running;await engine.drain(ids);
 assert.equal(engine.get(ids[1])!.state,'cancelled');assert.equal(engine.get(ids[1])!.attempts,0);
 assert.equal(started.length,63);assert.equal(new Set(started).size,63);
 for(const id of ids.filter(id=>id!==ids[1])){const step=engine.get(id)!;assert.equal(step.state,'succeeded');assert.equal(step.attempts,1);}
});

test('draining work in a full pool does not join an unrelated completion backlog',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {EvidenceStore: Store}=await import('../src/evidence-store.js'),{ExecutionEngine}=await import('../src/execution-engine.js');
 const directory=mkdtempSync(join(tmpdir(),'mote-independent-drain-')),store=new Store(directory),engine=new ExecutionEngine(store);
 let release!:()=>void,enter!:()=>void,completed=0;const held=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>enter=resolve),backlog:string[]=[];
 t.after(async()=>{release();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 engine.register({kind:'held',pool:'held',concurrency:()=>1,validate:()=>true,execute:async()=>{enter();await held;},commit:()=>{}});
 engine.register({kind:'unrelated',pool:'unrelated',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{if(++completed<64)backlog.push(engine.enqueue('unrelated-'+completed,'unrelated',{}));}});
 const first=engine.enqueue('first','held',{}),waiting=engine.enqueue('waiting','held',{});backlog.push(engine.enqueue('unrelated-0','unrelated',{}));
 const running=engine.tick();await entered;await engine.drain([waiting]);
 assert.ok(completed<64,`drain joined ${completed}/64 unrelated completions despite its own pool being full`);
 assert.equal(engine.get(waiting)!.state,'waiting');assert.equal(engine.get(waiting)!.attempts,0);
 release();await running;await engine.drain([first,waiting]);await engine.drain(backlog);
 assert.equal(engine.get(waiting)!.state,'succeeded');assert.equal(engine.get(waiting)!.attempts,1);assert.equal(completed,64);
});

for(const mode of ['background','drain','mixed-lanes'])test(`a large admission-wait backlog yields to provider callbacks and timers (${mode})`,async()=>{
 // Isolate the historical microtask starvation: its own timeout cannot run
 // when the child never returns to the event loop. No private inputs are used.
 const script=`
  import {mkdtempSync,rmSync} from 'node:fs';
  import {tmpdir} from 'node:os';
  import {join} from 'node:path';
  import {EvidenceStore as Store} from ${JSON.stringify(new URL('../src/evidence-store.ts',import.meta.url).href)};
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

for(const outcome of ['blocked','exhausted','admission-error'] as const)test(`draining ${outcome} decisions lets event-loop callbacks run before the backlog settles`,async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {EvidenceStore: Store}=await import('../src/evidence-store.js'),{ExecutionEngine,ExecutionFailure}=await import('../src/execution-engine.js');
 const directory=mkdtempSync(join(tmpdir(),'mote-terminal-admission-')),store=new Store(directory),engine=new ExecutionEngine(store);
 t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 let executions=0;
 engine.register({kind:'generated',pool:'generated',concurrency:()=>2,maxAttempts:1,validate:()=>true,
  admit:()=>{if(outcome==='admission-error')throw Error('Generated admission failure');if(outcome==='blocked')return new ExecutionFailure('blocked','processor_version_unavailable');},
  execute:async()=>{executions++;},commit:()=>{}});
 const ids=Array.from({length:64},(_,n)=>engine.enqueue('generated-'+n,'generated',{n},outcome==='exhausted'?{initial:{state:'waiting',attempts:1,availableAt:0}}:{}));
 const callback=new Promise<{settled:number;transaction:boolean}>(resolve=>setImmediate(()=>resolve({settled:ids.filter(id=>engine.get(id)!.state!=='waiting').length,transaction:store.db.isTransaction})));
 await engine.drain(ids);const observed=await callback;
 assert.ok(observed.settled>0&&observed.settled<ids.length,`callback saw ${observed.settled}/${ids.length} settled decisions`);
 assert.equal(observed.transaction,false);assert.equal(executions,0);
 for(const id of ids){const step=engine.get(id)!;
  assert.equal(step.state,outcome==='exhausted'?'failed':'blocked');
  assert.equal(step.error,outcome==='blocked'?'processor_version_unavailable':outcome==='exhausted'?'retry_budget_exhausted':'admission_failed');
  assert.equal(step.attempts,outcome==='exhausted'?1:0);
  const stored=store.db.prepare('SELECT fence,lease_until FROM execution_steps WHERE id=?').get(id)!;assert.equal(stored.fence,null);assert.equal(stored.lease_until,0);
 }
});
