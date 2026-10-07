import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureMediaRuntime, startMediaWorkers} from './media-workers.mjs';

const fixture = async t => {
  const root=await mkdtemp(join(tmpdir(),'mote-workers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'scripts'));
  for(const name of ['audio','ocr'])await writeFile(join(root,'scripts',`requirements-${name}.txt`),'generated fixture');
  return root;
};
test('runtime installs once, checks imports, repairs missing dependencies and never passes secrets',async t=>{
  const root=await fixture(t),python=join(root,'media-venv/bin/python'),calls=[];
  let broken=false;
  const run=async(cmd,args,env)=>{
    assert.equal(env.MOTE_TOKEN,undefined);assert.equal(env.MOTE_MEDIA_WORKER_TOKEN,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
    calls.push(args);
    if(args[1]==='venv')await mkdir(join(root,'media-venv'),{recursive:true});
    if(args[0]==='-c'&&broken){broken=false;throw Error('fixture missing dependency');}
  };
  const options={root,python,env:{PATH:process.env.PATH,MOTE_TOKEN:'private',MOTE_MEDIA_WORKER_TOKEN:'private',OPENAI_API_KEY:'private'},run};
  await ensureMediaRuntime(options);assert.equal(calls.length,3);
  await ensureMediaRuntime(options);assert.equal(calls.length,4);assert.equal(calls.at(-1)[0],'-c');
  broken=true;await ensureMediaRuntime(options);assert.equal(calls.length,8);
  await writeFile(join(root,'scripts/requirements-ocr.txt'),'changed dependency');
  await ensureMediaRuntime(options);assert.equal(calls.length,11);
});
test('failed installation is not marked ready',async t=>{
  const root=await fixture(t),python=join(root,'media-venv/bin/python');
  await assert.rejects(ensureMediaRuntime({root,python,env:{},run:async()=>{throw Error('generated install failure');}}));
  await assert.rejects(readFile(join(root,'media-venv/mote-requirements.sha256')));
});
test('workers start before model files, restart after exit, and stop with the parent',async t=>{
  const root=await fixture(t),controller=new AbortController();
  const code=`const fs=require('node:fs');const path=require('node:path');const name=path.basename(__filename);fs.appendFileSync(name+'.started',process.pid+'\\n');fs.writeFileSync(name+'.arguments',JSON.stringify(process.argv.slice(2)));setInterval(()=>{if(fs.existsSync('models-ready'))fs.writeFileSync(name+'.ready','yes')},20);`;
  for(const name of ['ocr-server.py','transcription-server.py'])await writeFile(join(root,'scripts',name),code);
  const workers=startMediaWorkers({root,signal:controller.signal,env:{MOTE_RUNTIME:'docker',MOTE_MEDIA_MODEL_DIR:join(root,'models'),MOTE_MEDIA_PYTHON:process.execPath,MOTE_MEDIA_WORKER_TOKEN:'fixture'},report:()=>{}});
  t.after(()=>workers.close());
  const wait=async predicate=>{const until=Date.now()+10000;while(!await predicate()){assert.ok(Date.now()<until,'worker fixture timed out');await new Promise(r=>setTimeout(r,25));}};
  const pids=async name=>(await readFile(join(root,name+'.started'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(Number);
  await wait(async()=> (await pids('ocr-server.py')).length===1&&(await pids('transcription-server.py')).length===1);
  const arguments_=JSON.parse(await readFile(join(root,'transcription-server.py.arguments'),'utf8'));
  assert.equal(arguments_[arguments_.indexOf('--timeout')+1],'3600','managed workers accommodate the existing one-hour product setting maximum');
  await writeFile(join(root,'models-ready'),'generated model installed');
  await wait(async()=>await readFile(join(root,'ocr-server.py.ready'),'utf8').catch(()=>false));
  process.kill((await pids('ocr-server.py'))[0],'SIGTERM');
  await wait(async()=> (await pids('ocr-server.py')).length===2);
  controller.abort();await workers.close();
  for(const name of ['ocr-server.py','transcription-server.py'])for(const pid of await pids(name))assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('audio HTTP worker enforces the authenticated request budget, preserves its host cap and releases timed-out work',async t=>{
  const {spawn}=await import('node:child_process'),{createServer}=await import('node:net'),{once}=await import('node:events');
  const root=await fixture(t),model=join(root,'model');await mkdir(model);await writeFile(join(model,'model.bin'),'generated fixture');
  await writeFile(join(root,'faster_whisper.py'),'# Generated dependency marker\n');
  await writeFile(join(root,'mote_audio.py'),`import time\nfrom pathlib import Path\ndef offline_process(): pass\ndef normalize(source, destination, budget, timeout):\n    Path(destination).write_bytes(b'generated')\n    Path(__file__).with_name('seen-timeout').write_text(str(timeout))\ndef transcribe(wav, model, threads):\n    time.sleep(float(Path(__file__).with_name('delay').read_text()))\n    return {'durationMs':1000,'segments':[{'startMs':0,'endMs':1000,'text':'Generated speech'}]}\ndef diarize(*args): return {}\n`);
  await writeFile(join(root,'delay'),'1.35');
  await mkdir(join(root,'bin'));await writeFile(join(root,'bin/ffmpeg'),'#!/bin/sh\nexit 0\n');await chmod(join(root,'bin/ffmpeg'),0o755);
  await writeFile(join(root,'worker.py'),await readFile(new URL('./transcription-server.py',import.meta.url)));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const child=spawn('python3',[join(root,'worker.py'),'--model',model,'--port',String(port),'--timeout','2'],{cwd:root,env:{PATH:join(root,'bin')+':'+process.env.PATH,LANG:process.env.LANG,PYTHONPATH:root,MOTE_TRANSCRIPTION_TOKEN:'generated-token'},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);let exited=false;const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',()=>{exited=true;resolve();});});
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await closed;});
  const url=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer generated-token','Content-Type':'application/octet-stream'};
  const until=Date.now()+10000;for(;;){try{if((await fetch(url+'/health',{headers,signal:AbortSignal.timeout(1000)})).ok)break;}catch{}assert.ok(!exited&&Date.now()<until,stderr);await new Promise(r=>setTimeout(r,25));}
  const post=async(timeout,authorization=headers.Authorization)=>{const response=await fetch(url+'/transcribe',{method:'POST',headers:{...headers,Authorization:authorization,...(timeout===undefined?{}:{'X-Mote-Processing-Timeout-Ms':String(timeout)})},body:'generated',signal:AbortSignal.timeout(5000)});await response.arrayBuffer();return response.status;};
  assert.equal(await post(2000,'Bearer invalid-generated-token'),401);
  for(const invalid of [999,3600001,'1000.5','100000000000','bad'])assert.equal(await post(invalid),400);
  assert.equal(await post(1000),504,'a shorter configured request must end before the worker host cap');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await post(2000),200,'the next authorized request can use its larger configured budget');
  assert.equal(Number(await readFile(join(root,'seen-timeout'),'utf8')),2);
  await writeFile(join(root,'delay'),'2.2');
  assert.equal(await post(3600000),504,'a caller cannot exceed an independently configured worker host cap');
  await new Promise(r=>setTimeout(r,300));await writeFile(join(root,'delay'),'0.01');
  assert.equal(await post(undefined),200,'legacy calls retain the worker default and the slot remains reusable');
});
