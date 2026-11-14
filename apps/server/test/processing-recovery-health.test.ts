import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

test('a persisted unavailable-processor backlog serves Central health during recovery without changing evidence or spending attempts',{timeout:30000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-processing-health-'));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/processing-recovery-health.ts',import.meta.url)),directory],{
    stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir()},
  });
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-8000);});child.stdout.resume();
  const closed=once(child,'close');
  const messages:{type:string;port?:number;durationMs?:number;timerDuring?:number;transactionDuring?:boolean;total?:number}[]=[];
  child.on('message',message=>messages.push(message as typeof messages[number]));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await closed;await rm(directory,{recursive:true,force:true});
  });
  const next=async(type:string)=>{
    while(!messages.some(message=>message.type===type)){
      assert.equal(child.exitCode,null,errors);assert.equal(child.signalCode,null,errors);
      await Promise.race([once(child,'message'),closed.then(()=>assert.fail(errors||'Recovery child exited early'))]);
    }
    return messages.find(message=>message.type===type)!;
  };
  const ready=await next('ready'),url=`http://127.0.0.1:${ready.port}/api/health`;
  const before=await fetch(url,{signal:AbortSignal.timeout(1000)});assert.equal(before.status,200);assert.equal((await before.json() as {ok:boolean}).ok,true);
  child.send('recover');await next('recovering');
  const began=performance.now();
  // This deadline runs in a separate process, so a starved server cannot also
  // prevent the test's clock and cancellation from firing.
  const during=await fetch(url,{signal:AbortSignal.timeout(1000)}).then(async response=>({status:response.status,body:await response.json()}),error=>({error}));
  const healthMs=performance.now()-began,done=await next('done');
  const [code]=await closed;
  assert.equal(code,0,errors);
  assert.ok('status' in during,`/api/health did not answer within 1000 ms while recovering ${done.total} jobs (drain ${done.durationMs?.toFixed(0)} ms)`);
  assert.equal(during.status,200);assert.equal(during.body.ok,true);
  assert.equal(done.transactionDuring,false,'yield only after committing the durable admission decision');
  assert.ok(done.timerDuring!==undefined&&done.timerDuring>0&&done.timerDuring<64,`a timer must run during the backlog, observed ${done.timerDuring}`);
  assert.equal(done.total,64);
  t.diagnostic(`health ${healthMs.toFixed(0)} ms; recovery ${done.durationMs?.toFixed(0)} ms; ${done.timerDuring}/64 blocked at timer`);
});
