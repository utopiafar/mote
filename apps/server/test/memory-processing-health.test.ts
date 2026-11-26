import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

test('Central serves health throughout 51 recording/note Memory jobs and preserves every original',{timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-memory-processing-health-'));
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/memory-processing-health.ts',import.meta.url)),directory],{
    stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,TMPDIR:tmpdir()},
  });
  let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-8000);});child.stdout.resume();
  const closed=once(child,'close'),messages:{type:string;port?:number;durationMs?:number;jobs?:number;batches?:number;originals?:number;dispatches?:Record<string,number>;followupCalls?:number;error?:string}[]=[];
  child.on('message',message=>messages.push(message as typeof messages[number]));
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await closed;await rm(directory,{recursive:true,force:true});
  });
  const next=async(type:string)=>{
    while(!messages.some(message=>message.type===type)){
      assert.equal(child.exitCode,null,errors);assert.equal(child.signalCode,null,errors);
      await Promise.race([once(child,'message'),closed.then(()=>assert.fail(errors||'Memory health fixture exited early'))]);
    }
    return messages.find(message=>message.type===type)!;
  };
  const ready=await next('ready'),url=`http://127.0.0.1:${ready.port}/api/health`;
  const health=async()=>{
    const began=performance.now();
    // The independent parent's deadline still fires while Central is busy in
    // synchronous admission, model callbacks or publication validation.
    const response=await fetch(url,{signal:AbortSignal.timeout(1500)}).catch(error=>assert.fail(messages.find(message=>message.type==='failed')?.error??`Health request failed within the 1500 ms check (${error.name}); last progress: ${JSON.stringify(messages.at(-1))}`));
    assert.equal(response.status,200);assert.equal((await response.json() as {ok:boolean}).ok,true);
    return performance.now()-began;
  };
  await health();child.send('process');await next('processing');
  const latencies:number[]=[];
  do{
    latencies.push(await health());await delay(25);
    const failure=messages.find(message=>message.type==='failed');assert.equal(failure,undefined,failure?.error);
  }while(!messages.some(message=>message.type==='done'));
  const done=await next('done');
  assert.equal(done.jobs,51);assert.equal(done.batches,67);assert.equal(done.originals,2712);assert.deepEqual(done.dispatches,{extract:67,review:67});
  child.send('finish');const [code]=await closed;assert.equal(code,0,errors);
  t.diagnostic(`${latencies.length} HTTP health probes; max ${Math.max(...latencies).toFixed(0)} ms; ${done.durationMs?.toFixed(0)} ms processing; ${done.originals} exact originals; ${done.followupCalls} independent assistant checks`);
});
