import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureMediaRuntime, probeMediaCommands, mediaEnvironment, startMediaWorkers} from './media-workers.mjs';

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
  // The parent consumes .started as readiness, so publish its argument snapshot first.
  const code=`const fs=require('node:fs');const path=require('node:path');const name=path.basename(__filename);fs.writeFileSync(name+'.arguments',JSON.stringify(process.argv.slice(2)));fs.appendFileSync(name+'.started',process.pid+'\\n');setInterval(()=>{if(fs.existsSync('models-ready'))fs.writeFileSync(name+'.ready','yes')},20);`;
  for(const name of ['ocr-server.py','transcription-server.py'])await writeFile(join(root,'scripts',name),code);
  const workers=startMediaWorkers({root,signal:controller.signal,runtime:'docker',configuration:{modelDirectory:join(root,'models'),python:process.execPath,workerToken:'fixture'},report:()=>{}});
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
  const {spawn,execFileSync}=await import('node:child_process'),{createServer}=await import('node:net'),{once}=await import('node:events');
  const root=await fixture(t),model=join(root,'model');await mkdir(model);await writeFile(join(model,'model.bin'),'generated fixture');
  await writeFile(join(root,'faster_whisper.py'),'# Generated dependency marker\n');await writeFile(join(root,'sherpa_onnx.py'),'# Generated dependency marker\n');
  const segmentation=join(root,'segmentation.onnx'),embedding=join(root,'speaker.onnx'),optional=join(root,'optional.onnx');await writeFile(segmentation,'generated segmentation');await writeFile(embedding,'generated default embedding');
  await writeFile(join(root,'mote_audio.py'),`import time\nfrom pathlib import Path\ndef offline_process(): pass\ndef normalize(source, destination, budget, timeout):\n    Path(destination).write_bytes(b'generated')\n    Path(__file__).with_name('seen-timeout').write_text(str(timeout))\n    Path(__file__).with_name('seen-workspace').write_text(str(Path(destination).parent.parent))\ndef transcribe(wav, model, threads):\n    Path(__file__).with_name('transcribe-started').write_text('generated')\n    time.sleep(float(Path(__file__).with_name('delay').read_text()))\n    return {'durationMs':1000,'segments':[{'startMs':0,'endMs':1000,'text':'Generated speech'}]}\ndef diarize(wav, segmentation, embedding, count, threads, speaker_range, model): return {'embedding':model,'count':count,'range':speaker_range,'path':embedding}\n`);
  await writeFile(join(root,'delay'),'1.35');
  await mkdir(join(root,'bin'));await writeFile(join(root,'bin/ffmpeg'),'#!/bin/sh\nexit 0\n');await chmod(join(root,'bin/ffmpeg'),0o755);
  await writeFile(join(root,'worker.py'),await readFile(new URL('./transcription-server.py',import.meta.url)));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
  const child=spawn(python,[join(root,'worker.py'),'--model',model,'--segmentation-model',segmentation,'--speaker-model',embedding,'--wespeaker-model',optional,'--port',String(port),'--timeout','2'],{cwd:root,env:{PATH:join(root,'bin'),LANG:process.env.LANG,PYTHONPATH:root,MOTE_TRANSCRIPTION_TOKEN:'generated-token'},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);let exited=false;const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',()=>{exited=true;resolve();});});
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await closed;});
  const url=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer generated-token','Content-Type':'application/octet-stream','X-Mote-Request-Scope':'a'.repeat(64)};
  const until=Date.now()+10000;for(;;){try{if((await fetch(url+'/health',{headers,signal:AbortSignal.timeout(1000)})).ok)break;}catch{}assert.ok(!exited&&Date.now()<until,stderr);await new Promise(r=>setTimeout(r,25));}
  const post=async(timeout,authorization=headers.Authorization)=>{const response=await fetch(url+'/transcribe',{method:'POST',headers:{...headers,Authorization:authorization,...(timeout===undefined?{}:{'X-Mote-Processing-Timeout-Ms':String(timeout)})},body:'generated',signal:AbortSignal.timeout(5000)});await response.arrayBuffer();return response.status;};
  const health=await (await fetch(url+'/health',{headers})).json();assert.equal(health.dependencies.ffmpeg,true);assert.equal(health.asr,true);assert.equal(health.diarization,true);assert.equal(health.wespeaker,false);
  const diarize=extra=>fetch(url+'/diarize',{method:'POST',headers:{...headers,...extra},body:'generated'});
  const missingOptional=await diarize({'X-Mote-Speaker-Model':'wespeaker-zh'});assert.equal(missingOptional.status,503);assert.equal(missingOptional.headers.get('x-mote-execution-started'),'false');await missingOptional.arrayBuffer();
  await writeFile(optional,'generated optional embedding');assert.equal((await(await fetch(url+'/health',{headers})).json()).wespeaker,true);
  for(const invalid of [{'X-Mote-Speaker-Model':'arbitrary-url'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'3','X-Mote-Speaker-Max':'1'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1','X-Mote-Speaker-Max':'3','X-Mote-Speaker-Count':'2'}]){const response=await diarize(invalid);assert.equal(response.status,400);assert.equal(response.headers.get('x-mote-execution-started'),'false');await response.arrayBuffer();}
  const bounded=await diarize({'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1','X-Mote-Speaker-Max':'3'});assert.equal(bounded.status,200);assert.deepEqual(await bounded.json(),{embedding:'wespeaker-zh',count:0,range:[1,3],path:optional});
  await rm(join(root,'bin/ffmpeg'));const unavailable=await (await fetch(url+'/health',{headers})).json();assert.equal(unavailable.asr,false);assert.ok(unavailable.missingDependencies.includes('ffmpeg'));
  // Rejection must prove execution never started.
  await rm(join(model,'model.bin'));const rejected=await fetch(url+'/transcribe',{method:'POST',headers,body:'generated'});assert.equal(rejected.status,503);assert.equal(rejected.headers.get('x-mote-execution-started'),'false');assert.equal((await rejected.json()).executionStarted,false);
  await writeFile(join(model,'model.bin'),'generated fixture');await writeFile(join(root,'bin/ffmpeg'),'#!/bin/sh\nexit 0\n');await chmod(join(root,'bin/ffmpeg'),0o755);
  assert.equal(await post(2000,'Bearer invalid-generated-token'),401);
  for(const invalid of [999,3600001,'1000.5','100000000000','bad'])assert.equal(await post(invalid),400);
  const held=post(2000);
  for(let i=0;!await readFile(join(root,'transcribe-started'),'utf8').catch(()=>false);i++){assert.ok(i<200,'generated transcription did not start');await new Promise(r=>setTimeout(r,10));}
  const contention=await diarize({});assert.equal(contention.status,429);assert.equal(contention.headers.get('x-mote-execution-started'),'false');assert.equal(contention.headers.get('retry-after'),'5');assert.equal((await contention.json()).executionStarted,false);
  assert.equal((await fetch(url+'/health',{headers})).status,200,'health stays available while shared ASR/diarization capacity is occupied');
  assert.equal(await held,200);
  assert.equal(await post(1000),504,'a shorter configured request must end before the worker host cap');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await post(2000),200,'the next authorized request can use its larger configured budget');
  assert.equal(Number(await readFile(join(root,'seen-timeout'),'utf8')),2);
  const ownedWorkspace=await readFile(join(root,'seen-workspace'),'utf8');assert.ok(ownedWorkspace.includes('mote-audio-'+'a'.repeat(64)+'-'));
  await assert.rejects(readFile(join(ownedWorkspace,'original.audio')),{code:'ENOENT'});
  const invalidScope=await fetch(url+'/transcribe',{method:'POST',headers:{...headers,'X-Mote-Request-Scope':'../foreign'},body:'generated'});assert.equal(invalidScope.status,400);await invalidScope.arrayBuffer();
  await writeFile(join(root,'delay'),'2.2');
  assert.equal(await post(3600000),504,'a caller cannot exceed an independently configured worker host cap');
  await new Promise(r=>setTimeout(r,300));await writeFile(join(root,'delay'),'0.01');
  assert.equal(await post(undefined),200,'legacy calls retain the worker default and the slot remains reusable');
});

test('system command preflight reports missing ffmpeg without claiming model corruption or reinstalling Python',async()=>{
 let calls=0;await assert.rejects(probeMediaCommands('/generated/python',{PATH:'/generated/bin',MOTE_TOKEN:'private'},async(_command,args,env)=>{calls++;assert.equal(env.MOTE_TOKEN,undefined);assert.match(args[1],/shutil.which/);throw Error('generated missing ffmpeg');}),/media.runtime.ffmpeg_missing/);assert.equal(calls,1);
 await probeMediaCommands('/generated/python',{},async()=>{});
});

test('Native worker command lookup preserves configured order and adds standard macOS package-manager locations',()=>{
 const native=mediaEnvironment({PATH:'/generated/bin',MOTE_RUNTIME:'native',MOTE_TOKEN:'private'});assert.equal(native.MOTE_TOKEN,undefined);assert.ok(native.PATH.startsWith('/generated/bin'));if(process.platform==='darwin'){assert.ok(native.PATH.split(':').includes('/opt/homebrew/bin'));assert.ok(native.PATH.split(':').includes('/usr/local/bin'));}
 assert.equal(mediaEnvironment({PATH:'/generated/bin',MOTE_RUNTIME:'docker'}).PATH,'/generated/bin');
});

test('OCR HTTP worker certifies capacity rejection before execution with the same recheck cadence',async t=>{
 const {spawn,execFileSync}=await import('node:child_process'),{createServer}=await import('node:net'),{once}=await import('node:events');
 const root=await fixture(t),models=join(root,'models');
 for(const name of ['det','rec']){await mkdir(join(models,name),{recursive:true});for(const asset of ['inference.onnx','inference.yml'])await writeFile(join(models,name,asset),'generated model marker');}
 await writeFile(join(models,'complete.json'),'{}');await mkdir(join(root,'paddlex/inference'),{recursive:true});
 await writeFile(join(root,'paddlex/__init__.py'),'');await writeFile(join(root,'paddlex/inference/__init__.py'),'');
 await writeFile(join(root,'paddlex/inference/pipelines.py'),`def load_pipeline_config(name): return {'SubModules':{'TextDetection':{},'TextRecognition':{}}}\nclass Pipeline:\n    def predict(self, image): pass\ndef create_pipeline(**kwargs): return Pipeline()\n`);
 await writeFile(join(root,'mote_ocr.py'),`from pathlib import Path\nimport time\nclass UnsupportedImage(Exception): pass\ndef recognize_image(image, predict):\n    Path(__file__).with_name('recognition-started').write_text('generated')\n    time.sleep(0.5)\n    return {'durationMs':0,'segments':[{'startMs':0,'endMs':0,'text':'Generated OCR'}]}\n`);
 await writeFile(join(root,'worker.py'),await readFile(new URL('./ocr-server.py',import.meta.url)));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
 const child=spawn(python,[join(root,'worker.py'),'--model-root',models,'--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:root,MOTE_MEDIA_WORKER_TOKEN:'generated-token'},stdio:'ignore'}),closed=new Promise(resolve=>child.once('close',resolve));
 t.after(async()=>{child.kill('SIGTERM');await closed;});const endpoint=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer generated-token'};
 for(let i=0;;i++){try{if((await fetch(endpoint+'/health',{headers,signal:AbortSignal.timeout(500)})).ok)break;}catch{}assert.ok(i<200,'generated OCR worker did not start');await new Promise(r=>setTimeout(r,10));}
 const call=()=>fetch(endpoint+'/ocr',{method:'POST',headers,body:'generated image'}),held=call();
 for(let i=0;!await readFile(join(root,'recognition-started'),'utf8').catch(()=>false);i++){assert.ok(i<200);await new Promise(r=>setTimeout(r,10));}
 const busy=await call();assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'5');assert.equal(busy.headers.get('x-mote-execution-started'),'false');assert.equal((await busy.json()).executionStarted,false);
 const result=await held;assert.equal(result.status,200);await result.arrayBuffer();
 await rm(join(models,'complete.json'));const missing=await call();assert.equal(missing.status,503);assert.equal(missing.headers.get('x-mote-execution-started'),'false');assert.equal((await missing.json()).executionStarted,false);
});
