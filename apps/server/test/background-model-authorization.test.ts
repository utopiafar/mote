import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BackgroundModelAuthorization,modelConnection,type ModelConnection} from '../src/background-model-authorization.js';
import {Store} from '../src/store.js';
import {ExecutionEngine,type ExecutionStep} from '../src/execution-engine.js';

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-model-authority-')),store=new Store(directory);
  let connections=[modelConnection('fixture',{provider:'generated',model:'small',apiKey:'fixture-only'})];
  let control=new BackgroundModelAuthorization(store,()=>connections);
  t.after(()=>{control.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const receive=(id:string,sourceId='fixture',eligible=true)=>{store.db.exec('BEGIN IMMEDIATE');try{control.receive(id,{sourceId,dataKind:'text'},eligible);store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}};
  const command=(action:'on'|'off'|'stop'|'exclude',excludedSourceIds?:string[])=>control.command({action,operationId:randomUUID(),revision:control.view().revision,...(action==='exclude'?{excludedSourceIds:excludedSourceIds??[]}:{})});
  /** Generated stand-in for a domain that already owns the received originals:
   * every fresh trigger becomes one durable automatic job. */
  const drain=async(sends:{count:number})=>{
    for(const row of store.db.prepare('SELECT identity FROM background_model_receipts ORDER BY seq').all() as {identity:string}[]){
      for(const root of control.freshTriggers([row.identity],'working')){
        const id='drain:'+root;
        try{control.automatic(id,[root],'working');}catch{continue;}
        await control.run(id,async signal=>{signal.throwIfAborted();sends.count++;});
      }
    }
  };
  return {store,get control(){return control;},get connection(){return connections[0];},receive,command,drain,
    replaceConnection(){connections=[modelConnection('fixture',{provider:'generated',model:'replacement',apiKey:'fixture-only'})];},
    restart(){control.close();control=new BackgroundModelAuthorization(store,()=>connections);}};
}

test('A1-08: work received while the switch is off runs once when it opens and does not rerun after restart',async t=>{
  const f=fixture(t),sends={count:0};
  f.receive('first');f.receive('second');f.receive('third');
  await f.drain(sends);assert.equal(sends.count,0,'closed switch admits no automatic work');
  f.command('on');await f.drain(sends);assert.equal(sends.count,3,'every withheld original runs exactly once');
  f.restart();await f.drain(sends);assert.equal(sends.count,3,'restart does not replay claimed triggers');
});

test('A1-09: duplicate delivery and derived publication add no receipt and trigger the root once',async t=>{
  const f=fixture(t),sends={count:0};
  f.receive('input');f.receive('input');
  f.store.db.exec('BEGIN IMMEDIATE');f.control.derive('derived-projection',['input']);f.store.db.exec('COMMIT');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_receipts').get()!.n,1);
  f.command('on');await f.drain(sends);assert.equal(sends.count,1);
  await f.drain(sends);assert.equal(sends.count,1,'the derived identity cannot mint a second trigger');
});

test('A1-10: an ineligible receipt never triggers before or after the switch, restart or re-open',async t=>{
  const f=fixture(t),sends={count:0};
  f.receive('historical','fixture',false);
  f.command('on');await f.drain(sends);assert.equal(sends.count,0);
  f.restart();await f.drain(sends);assert.equal(sends.count,0);
  f.command('off');f.command('on');await f.drain(sends);assert.equal(sends.count,0);
});

test('A1-11: two purposes claim one root once each and reopening does not rerun completed purposes',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');
  f.control.automatic('personal',['input'],'memory:recipe/personal');f.control.automatic('coding',['input'],'memory:recipe/coding');
  let runs=0;await f.control.run('personal',async()=>{runs++;});await f.control.run('coding',async()=>{runs++;});assert.equal(runs,2);
  assert.throws(()=>f.control.automatic('coding-retry-new-id',['input'],'memory:recipe/coding'));
  f.command('stop');f.command('on');
  assert.throws(()=>f.control.automatic('personal-retry-new-id',['input'],'memory:recipe/personal'));
  assert.throws(()=>f.control.automatic('coding-retry-new-id',['input'],'memory:recipe/coding'));
});

test('A1-12: a 25-item backlog drains completely with no missed or duplicate trigger',async t=>{
  const f=fixture(t),sends={count:0},roots:string[]=[];
  for(let n=0;n<25;n++){const id='backlog-'+n;roots.push(id);f.receive(id,'fixture');}
  f.command('on');await f.drain(sends);
  assert.equal(sends.count,25);assert.equal(new Set(roots).size,25);
  await f.drain(sends);assert.equal(sends.count,25);
});

test('A1-13: an automatic step waits 60 seconds while off and executes once after the switch opens',async t=>{
  const f=fixture(t);f.receive('input');
  let now=10000,executions=0,sends=0,engine=new ExecutionEngine(f.store,()=>now);
  const register=()=>engine.register({kind:'generated-authorization-wait',pool:'generated',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executions++;const id=f.control.automatic('waiting-job',['input'],'working');await f.control.run(id,async()=>{f.control.assertCurrent(f.connection);sends++;});},commit:()=>{}});
  t.after(()=>engine.close());register();const id=engine.enqueue('generated:waiting','generated-authorization-wait',{});
  await engine.drain([id]);let step=engine.get(id)!;
  assert.equal(step.state,'waiting');assert.equal(step.error,'background_model_authorization_required');assert.equal(step.attempts,0);
  assert.equal(step.availableAt,now+60000);assert.equal(executions,1);assert.equal(sends,0);
  for(let n=0;n<59;n++){now+=1000;await engine.drain([id]);}assert.equal(executions,1,'closed work must not occupy a worker every second');
  await engine.close();f.restart();engine=new ExecutionEngine(f.store,()=>now);register();await engine.drain([id]);assert.equal(executions,1);
  now+=1000;await engine.drain([id]);step=engine.get(id)!;assert.equal(executions,2);assert.equal(sends,0);assert.equal(step.attempts,0);assert.equal(step.availableAt,now+60000);
  f.command('on');now+=60000;await engine.drain([id]);assert.equal(executions,3);step=engine.get(id)!;assert.equal(step.state,'succeeded');assert.equal(sends,1);
});

test('A1-14: excluding a source withholds its new and previously received originals until it is re-included',async t=>{
  const f=fixture(t),sends={count:0};
  f.receive('s-old','S');f.receive('t-old','T');
  f.command('on');f.command('exclude',['S']);f.receive('s-new','S');
  await f.drain(sends);assert.equal(sends.count,1,'only the included source runs');
  f.command('exclude',[]);await f.drain(sends);assert.equal(sends.count,3,'both withheld originals backfill once');
  await f.drain(sends);assert.equal(sends.count,3);
});

test('A1-15: excluding a source aborts only its in-flight automatic call and fences the late result',async t=>{
  const f=fixture(t);f.command('on');f.receive('s-input','S');f.receive('t-input','T');
  const writes:string[]=[],aborted:boolean[]=[];
  let now=10000,release!:()=>void,arrived=0,bothResolve!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),both=new Promise<void>(resolve=>bothResolve=resolve),arrivedOnce=()=>{if(++arrived===2)bothResolve();};
  const engine=new ExecutionEngine(f.store,()=>now);t.after(()=>engine.close());
  const register=()=>engine.register({kind:'generated-exclusion',pool:'generated-exclusion',concurrency:()=>2,validate:()=>true,
    execute:async step=>{const root=String(step.input.root),id='media:'+root;f.control.automatic(id,[root],'image');await f.control.run(id,async signal=>{
      f.control.assertCurrent(f.connection);arrivedOnce();await held;aborted.push(signal.aborted);signal.throwIfAborted();writes.push(root);
    });},commit:()=>{}});
  register();const s=engine.enqueue('generated:s','generated-exclusion',{root:'s-input'}),u=engine.enqueue('generated:t','generated-exclusion',{root:'t-input'});
  const running=engine.drain([s,u]);await both;f.command('exclude',['S']);release();await running;
  assert.deepEqual(aborted.sort(),[false,true]);assert.deepEqual(writes,['t-input']);
  assert.equal(engine.get(s)!.state,'waiting');assert.equal(engine.get(u)!.state,'succeeded');
});

test('A1-16: re-including a source reruns only the interrupted step and writes once',async t=>{
  const f=fixture(t);f.command('on');f.receive('s-input','S');
  const writes:string[]=[];let now=10000,release!:()=>void,entered!:()=>void,executeCount=0;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const engine=new ExecutionEngine(f.store,()=>now);t.after(()=>engine.close());
  const register=()=>engine.register({kind:'generated-resume',pool:'generated-resume',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executeCount++;const id='media:s-input';f.control.automatic(id,['s-input'],'image');await f.control.run(id,async signal=>{
      f.control.assertCurrent(f.connection);entered();await held;signal.throwIfAborted();writes.push('s-input');
    });},commit:()=>{}});
  register();const id=engine.enqueue('generated:resume','generated-resume',{});
  const running=engine.drain([id]);await started;f.command('exclude',['S']);release();await running;
  assert.deepEqual(writes,[]);assert.equal(engine.get(id)!.state,'waiting');
  f.command('exclude',[]);now+=60000;await engine.drain([id]);
  assert.equal(executeCount,2);assert.deepEqual(writes,['s-input']);assert.equal(engine.get(id)!.state,'succeeded');
});

test('A1-17: automatic disclosure rejects only excluded sources while manual assertions stay unchanged',async t=>{
  const f=fixture(t);f.command('on');f.receive('allowed','T');f.receive('blocked','S');f.command('exclude',['S']);
  f.control.automatic('automatic-disclosure',['allowed'],'working');
  await f.control.run('automatic-disclosure',async()=>{
    f.control.assertDisclosure([{sourceId:'T',dataKind:'text'}]);
    assert.throws(()=>f.control.assertDisclosure([{sourceId:'S',dataKind:'text'}]));
  });
  f.control.manual('manual-disclosure','manual');
  await f.control.run('manual-disclosure',async()=>{f.control.assertDisclosure([{sourceId:'S',dataKind:'text'}]);});
});

test('A1-18: replacing the model connection leaves in-flight and new automatic work running',async t=>{
  const f=fixture(t);f.command('on');f.receive('in-flight');
  f.control.automatic('reconfigured',['in-flight'],'working');
  let entered!:()=>void,release!:()=>void,published=false;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const running=f.control.run('reconfigured',async()=>{entered();await held;f.control.assertCurrent(f.connection);published=true;});
  await started;f.replaceConnection();release();await running;assert.equal(published,true);
  const sends={count:0};f.receive('after-replacement');await f.drain(sends);assert.equal(sends.count,1);
  assert.deepEqual(Object.keys(f.control.view()).sort(),['excludedSourceIds','revision','state'],'no re-confirmation field survives');
});

test('A1-19: a confirmed manual task keeps the connection confirmed at its own boundary',async t=>{
  const f=fixture(t);f.command('on');const confirmed=f.connection;
  f.control.manual('explicit-ask','manual',[], [confirmed]);f.replaceConnection();
  let calls=0;await f.control.run('explicit-ask',async()=>{f.control.assertCurrent(confirmed);calls++;});assert.equal(calls,1);
  await assert.rejects(f.control.run('explicit-ask',async()=>f.control.assertCurrent(f.connection)));
  f.command('stop');await f.control.run('explicit-ask',async()=>f.control.assertCurrent(confirmed));
  assert.throws(()=>f.control.manual('explicit-ask','probe'));
});

test('A1-20: off drains an admitted call, admits nothing new and backfills after reopening',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');f.control.automatic('in-flight',['input'],'working');
  let entered!:()=>void,release!:()=>void,published=false;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const running=f.control.run('in-flight',async()=>{entered();await held;f.control.assertCurrent(f.connection);published=true;});
  await started;f.command('off');release();await running;assert.equal(published,true,'closing drains admitted work');
  const sends={count:0};f.receive('gap');await f.drain(sends);assert.equal(sends.count,0,'nothing admitted while off');
  f.command('on');await f.drain(sends);assert.equal(sends.count,1,'the gap backfills once');
});

test('A1-21: stop aborts an in-flight automatic call, keeps the original and fences its late result',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');f.control.automatic('stopped',['input'],'working');
  let entered!:()=>void,release!:()=>void,aborted=false,published=false;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const running=f.control.run('stopped',async signal=>{entered();await held;aborted=signal.aborted;signal.throwIfAborted();f.control.assertCurrent(f.connection);published=true;});
  await started;f.command('stop');assert.equal(f.control.view().state,'off');release();await assert.rejects(running);
  assert.equal(aborted,true);assert.equal(published,false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_receipts WHERE identity=?').get('input')!.n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_work WHERE id=?').get('stopped')!.n,1);
});

test('A1-22: restart during stop keeps the switch off and drains nothing',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');
  let now=10000,executions=0,sends=0,stop!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>stop=resolve);
  const engine=new ExecutionEngine(f.store,()=>now);t.after(()=>engine.close());
  const register=()=>engine.register({kind:'generated-stop-restart',pool:'generated-stop-restart',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executions++;const id=f.control.automatic('stopped-work',['input'],'working');await f.control.run(id,async signal=>{entered();await held;signal.throwIfAborted();sends++;});},commit:()=>{}});
  register();const id=engine.enqueue('generated:stopped','generated-stop-restart',{});
  const running=engine.drain([id]);await gate;f.command('stop');stop();await running;
  assert.equal(engine.get(id)!.state,'waiting');await engine.close();f.restart();assert.equal(f.control.view().state,'off');
  now+=60000;const restarted=new ExecutionEngine(f.store,()=>now);t.after(()=>restarted.close());
  restarted.register({kind:'generated-stop-restart',pool:'generated-stop-restart',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executions++;const work=f.control.automatic('stopped-work',['input'],'working');await f.control.run(work,async()=>{sends++;});},commit:()=>{}});
  await restarted.drain([id]);assert.equal(sends,0,'a restarted closed switch still admits nothing');
});

test('A1-23: reopening resumes the interrupted step once and backfills work received while off',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');
  let now=10000,executions=0,sends=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const engine=new ExecutionEngine(f.store,()=>now);t.after(()=>engine.close());
  engine.register({kind:'generated-resume-stop',pool:'generated-resume-stop',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executions++;const id=f.control.automatic('interrupted',['input'],'working');await f.control.run(id,async signal=>{
      entered();await held;signal.throwIfAborted();sends++;
    });},commit:()=>{}});
  const id=engine.enqueue('generated:interrupted','generated-resume-stop',{});
  const running=engine.drain([id]);await gate;f.command('stop');release();await running;
  assert.equal(sends,0);assert.equal(engine.get(id)!.state,'waiting');
  await engine.close();f.receive('while-off-a','fixture');f.receive('while-off-b','fixture');f.restart();
  f.command('on');now+=60000;const reopened=new ExecutionEngine(f.store,()=>now);t.after(()=>reopened.close());
  reopened.register({kind:'generated-resume-stop',pool:'generated-resume-stop',concurrency:()=>1,validate:()=>true,
    execute:async()=>{executions++;const work=f.control.automatic('interrupted',['input'],'working');await f.control.run(work,async()=>{sends++;});},commit:()=>{}});
  await reopened.drain([id]);assert.equal(executions,2);assert.equal(sends,1,'the interrupted claim resumes exactly once');
  const backfill={count:0};await f.drain(backfill);assert.equal(backfill.count,2,'each withheld original runs once');
});

test('A1-24: replaying stop with the same operation id does not advance the revision twice',t=>{
  const f=fixture(t);f.command('on');
  const stop={action:'stop',operationId:randomUUID(),revision:f.control.view().revision};
  f.control.command(stop);const revision=f.control.view().revision;
  f.control.command(stop);assert.equal(f.control.view().revision,revision);assert.equal(f.control.view().state,'off');
  assert.throws(()=>f.control.command({...stop,action:'off'}),{statusCode:409});
  assert.throws(()=>f.control.command({action:'on',operationId:randomUUID(),revision:0}),{statusCode:409});
});

test('one durable step cannot combine a broad manual authority and a narrow automatic authority',async t=>{
  const f=fixture(t);f.command('on');f.receive('input');f.control.automatic('background',['input']);f.control.manual('manual','manual');
  const step:ExecutionStep={id:'generated-step',operationId:'generated-operation',kind:'generated',pool:'generated',input:{},state:'waiting',attempts:0,availableAt:0};
  await f.control.run('manual',async()=>f.control.captureStep(step));
  await f.control.runStep(step,async()=>{
    assert.equal(f.control.currentId,'manual');
    await assert.rejects(f.control.run('background',async()=>{throw Error('must never enter mixed authority');}),/different model authority/);
    assert.equal(f.control.currentId,'manual');
  },new AbortController().signal);
});

test('a shared executor restores only its step authority and prevents stopped late publication',async t=>{
  const f=fixture(t),engine=new ExecutionEngine(f.store);engine.bindModelAuthority(f.control);t.after(()=>engine.close());
  f.command('on');f.receive('input');f.control.automatic('background',['input']);f.control.manual('unrelated-owner-request','manual');
  let entered!:()=>void,release!:()=>void,published=false,receivedAbort=false;
  const started=new Promise<void>(resolve=>entered=resolve),provider=new Promise<void>(resolve=>release=resolve);
  engine.register({kind:'generated-model',pool:'generated-model',concurrency:()=>1,validate:()=>true,
    execute:async(_step,signal)=>{assert.equal(f.control.currentId,'background');f.control.assertCurrent(f.connection);entered();await provider;receivedAbort=signal.aborted;return 'generated';},
    commit:()=>{published=true;}});
  await f.control.run('background',async()=>{engine.enqueue('operation','generated-model',{}, {id:'step'});});
  const running=f.control.run('unrelated-owner-request',async()=>engine.drain(['step']));await started;
  f.command('stop');release();await running;
  assert.equal(receivedAbort,true);assert.equal(published,false);assert.notEqual(engine.get('step')!.state,'succeeded');
});

test('committed dependent steps retain the parent admission while unrelated executor callers cannot supply it',async t=>{
 const f=fixture(t),engine=new ExecutionEngine(f.store);engine.bindModelAuthority(f.control);t.after(()=>engine.close());
 f.command('on');f.receive('input');f.control.automatic('parent',['input']);f.control.manual('unrelated','manual');
 engine.register({kind:'parent',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>({}),commit:()=>{engine.enqueue('operation','child',{}, {id:'child'});}});
 let observed:string|undefined;
 engine.register({kind:'child',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>{observed=f.control.currentId;return {};},commit:()=>{}});
 await f.control.run('parent',async()=>{engine.enqueue('operation','parent',{}, {id:'parent-step'});});
 await f.control.run('unrelated',()=>engine.drain(['parent-step']));
 assert.equal(f.control.stepAuthority('child'),'parent');
 f.command('off');f.command('on');await engine.drain(['child']);assert.equal(observed,'parent');assert.equal(engine.get('child')!.state,'succeeded');
});

test('successful step projection cannot lose its admission or inherit the executor wake caller',async t=>{
 const f=fixture(t),engine=new ExecutionEngine(f.store);engine.bindModelAuthority(f.control);t.after(()=>engine.close());
 f.command('on');f.receive('input');f.control.automatic('parent',['input']);f.control.manual('unrelated','manual');
 engine.register({kind:'project-parent',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>({}),commit:()=>{},project:step=>{if(step.state==='succeeded')engine.enqueue('operation','project-child',{}, {id:'project-child'});}});
 let observed:string|undefined;
 engine.register({kind:'project-child',pool:'fixture',concurrency:()=>1,validate:()=>true,execute:async()=>{observed=f.control.currentId;return {};},commit:()=>{}});
 await f.control.run('parent',async()=>{engine.enqueue('operation','project-parent',{}, {id:'project-parent'});});
 await f.control.run('unrelated',()=>engine.drain(['project-parent']));
 assert.equal(f.control.stepAuthority('project-child'),'parent');
 await engine.drain(['project-child']);assert.equal(observed,'parent');
});
