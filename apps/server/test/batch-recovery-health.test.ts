import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

test('a single persisted recording batch serves Central health while checking every original before model admission',{timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-batch-recovery-health-'));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/batch-recovery-health.ts',import.meta.url)),directory],{
    stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir()},
  });
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-8000);});child.stdout.resume();
  const closed=once(child,'close');
  const messages:{type:string;port?:number;durationMs?:number;timerMs?:number;transactionDuring?:boolean;total?:number}[]=[];
  child.on('message',message=>messages.push(message as typeof messages[number]));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await closed;await rm(directory,{recursive:true,force:true});
  });
  const next=async(type:string)=>{
    while(!messages.some(message=>message.type===type)){
      assert.equal(child.exitCode,null,errors);assert.equal(child.signalCode,null,errors);
      await Promise.race([once(child,'message'),closed.then(()=>assert.fail(errors||'Recording recovery child exited early'))]);
    }
    return messages.find(message=>message.type===type)!;
  };
  const ready=await next('ready'),url=`http://127.0.0.1:${ready.port}/api/health`;
  const before=await fetch(url,{signal:AbortSignal.timeout(1500)});assert.equal(before.status,200);
  child.send('recover');await next('recovering');
  const began=performance.now();
  // The independent parent's deadline still fires if the child's validation
  // monopolizes its event loop. Keep the observed 1.5 s health budget.
  const during=await fetch(url,{signal:AbortSignal.timeout(1500)}).then(async response=>({status:response.status,body:await response.json()}),error=>({error}));
  const healthMs=performance.now()-began,done=await next('done');
  const [code]=await closed;
  assert.equal(code,0,errors);
  assert.ok('status' in during,`/api/health timed out during one ${done.total}-original recording batch (${done.durationMs?.toFixed(0)} ms admission)`);
  assert.equal(during.status,200);assert.equal(during.body.ok,true);
  assert.equal(done.transactionDuring,false,'the HTTP/timer boundary must not expose an open admission transaction');
  assert.ok(done.timerMs!==undefined&&done.timerMs<1500,`recording validation delayed a timer by ${done.timerMs?.toFixed(0)} ms`);
  assert.equal(done.total,4097);
  t.diagnostic(`health ${healthMs.toFixed(0)} ms; admission ${done.durationMs?.toFixed(0)} ms; timer ${done.timerMs?.toFixed(0)} ms; ${done.total} originals`);
});
