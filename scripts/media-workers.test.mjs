import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {mediaEnvironment} from './media-workers.mjs';

const fixture = async t => {
  const root=await mkdtemp(join(tmpdir(),'mote-workers-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'scripts'));
  for(const name of ['audio','ocr'])await writeFile(join(root,'scripts',`requirements-${name}.txt`),'generated fixture');
  return root;
};
test('media execution facts reject incompatible storage before worker readiness and preserve current receipt lifecycles',async()=>{
  const {execFileSync}=await import('node:child_process');
  execFileSync('python3',[fileURLToPath(new URL('./test_mote_execution_facts.py',import.meta.url))],{stdio:'pipe'});
});
test('audio HTTP worker enforces the authenticated request budget, preserves its host cap and releases timed-out work',async t=>{
  const {spawn,execFileSync}=await import('node:child_process'),{createServer}=await import('node:net'),{once}=await import('node:events');
  const root=await fixture(t),model=join(root,'model');await mkdir(model);await writeFile(join(model,'model.bin'),'generated fixture');
  await writeFile(join(root,'faster_whisper.py'),'# Generated dependency marker\n');await writeFile(join(root,'sherpa_onnx.py'),'# Generated dependency marker\n');
  const segmentation=join(root,'segmentation.onnx'),embedding=join(root,'speaker.onnx'),optional=join(root,'optional.onnx');await writeFile(segmentation,'generated segmentation');await writeFile(embedding,'generated default embedding');
  await writeFile(join(root,'mote_audio.py'),`import time\nfrom pathlib import Path\ndef offline_process(): pass\ndef normalize(source, destination, budget, timeout):\n    Path(destination).write_bytes(b'generated')\n    Path(__file__).with_name('seen-timeout').write_text(str(timeout))\ndef transcribe(wav, model, threads):\n    Path(__file__).with_name('transcribe-started').write_text('generated')\n    time.sleep(float(Path(__file__).with_name('delay').read_text()))\n    return {'durationMs':1000,'segments':[{'startMs':0,'endMs':1000,'text':'Generated speech'}]}\ndef diarize(wav, segmentation, embedding, count, threads, speaker_range, model): return {'embedding':model,'count':count,'range':speaker_range,'path':embedding}\n`);
  await writeFile(join(root,'delay'),'1.35');
  await mkdir(join(root,'bin'));await writeFile(join(root,'bin/ffmpeg'),'#!/bin/sh\nexit 0\n');await chmod(join(root,'bin/ffmpeg'),0o755);
  await writeFile(join(root,'worker.py'),await readFile(new URL('./transcription-server.py',import.meta.url)));
  await writeFile(join(root,'mote_execution_facts.py'),await readFile(new URL('./mote_execution_facts.py',import.meta.url)));
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
  const child=spawn(python,[join(root,'worker.py'),'--model',model,'--segmentation-model',segmentation,'--speaker-model',embedding,'--wespeaker-model',optional,'--port',String(port),'--timeout','2'],{cwd:root,env:{PATH:join(root,'bin'),LANG:process.env.LANG,PYTHONPATH:root,MOTE_TRANSCRIPTION_TOKEN:'generated-token'},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);let exited=false;const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',()=>{exited=true;resolve();});});
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await closed;});
  const url=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer generated-token','Content-Type':'application/octet-stream'};
  const until=Date.now()+10000;for(;;){try{if((await fetch(url+'/health',{headers,signal:AbortSignal.timeout(1000)})).ok)break;}catch{}assert.ok(!exited&&Date.now()<until,stderr);await new Promise(r=>setTimeout(r,25));}
  const scope='a'.repeat(64);
  const post=async(timeout,authorization=headers.Authorization,requestId)=>{const response=await fetch(url+'/transcribe',{method:'POST',headers:{...headers,Authorization:authorization,...(requestId?{'X-Mote-Request-Id':requestId,'X-Mote-Request-Scope':scope}:{}),...(timeout===undefined?{}:{'X-Mote-Processing-Timeout-Ms':String(timeout)})},body:'generated',signal:AbortSignal.timeout(5000)});await response.arrayBuffer();return response.status;};
  const health=await (await fetch(url+'/health',{headers})).json();assert.equal(health.dependencies.ffmpeg,true);assert.equal(health.asr,true);assert.equal(health.diarization,true);assert.equal(health.wespeaker,false);
  const diarize=extra=>fetch(url+'/diarize',{method:'POST',headers:{...headers,...extra},body:'generated'});
  const missingOptional=await diarize({'X-Mote-Speaker-Model':'wespeaker-zh'});assert.equal(missingOptional.status,503);assert.equal(missingOptional.headers.get('x-mote-execution-started'),'false');await missingOptional.arrayBuffer();
  await writeFile(optional,'generated optional embedding');assert.equal((await(await fetch(url+'/health',{headers})).json()).wespeaker,true);
  for(const invalid of [{'X-Mote-Speaker-Model':'arbitrary-url'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'3','X-Mote-Speaker-Max':'1'},{'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1','X-Mote-Speaker-Max':'3','X-Mote-Speaker-Count':'2'}]){const response=await diarize(invalid);assert.equal(response.status,400);assert.equal(response.headers.get('x-mote-execution-started'),'false');await response.arrayBuffer();}
  const diarizeId=randomUUID(),bounded=await diarize({'X-Mote-Speaker-Model':'wespeaker-zh','X-Mote-Speaker-Min':'1','X-Mote-Speaker-Max':'3','X-Mote-Request-Id':diarizeId,'X-Mote-Request-Scope':scope});assert.equal(bounded.status,200);assert.equal(bounded.headers.get('x-mote-receipt-id'),diarizeId);assert.deepEqual(await bounded.json(),{embedding:'wespeaker-zh',count:0,range:[1,3],path:optional});
  const receipt=await(await fetch(url+'/executions/'+diarizeId,{headers:{...headers,'X-Mote-Request-Scope':scope}})).json();assert.equal(receipt.state,'succeeded');assert.equal(receipt.stage,'diarize');assert.ok(receipt.finishedAt>=receipt.startedAt);assert.ok(!JSON.stringify(receipt).includes(root),'worker status has no private output paths');
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
  const timeoutId=randomUUID();assert.equal(await post(1000,headers.Authorization,timeoutId),504,'a shorter configured request must end before the worker host cap');
  const failed=await(await fetch(url+'/executions/'+timeoutId,{headers:{...headers,'X-Mote-Request-Scope':scope}})).json();assert.equal(failed.state,'failed');assert.equal(failed.failureCode,'processing_timeout');assert.ok(failed.finishedAt>=failed.startedAt);
  assert.equal((await fetch(url+'/executions/'+timeoutId,{method:'DELETE',headers:{...headers,'X-Mote-Request-Scope':scope}})).status,200);
  assert.equal(await post(1000,headers.Authorization,timeoutId),409,'erased failed ASR identity cannot be submitted again');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await post(2000),200,'the next authorized request can use its larger configured budget');
  assert.equal(Number(await readFile(join(root,'seen-timeout'),'utf8')),2);
  await writeFile(join(root,'delay'),'2.2');
  assert.equal(await post(3600000),504,'a caller cannot exceed an independently configured worker host cap');
  await new Promise(r=>setTimeout(r,300));await writeFile(join(root,'delay'),'0.01');
  assert.equal(await post(undefined),200,'legacy calls retain the worker default and the slot remains reusable');
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
 await writeFile(join(root,'mote_execution_facts.py'),await readFile(new URL('./mote_execution_facts.py',import.meta.url)));
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

test('ASR execution facts and identified POSTs stay private even when the old unauthenticated health endpoint is available',async t=>{
 const {spawn}=await import('node:child_process'),{createServer}=await import('node:net'),{once}=await import('node:events');
 const root=await fixture(t);
 for(const file of ['transcription-server.py','mote_execution_facts.py'])await writeFile(join(root,file),await readFile(new URL('./'+file,import.meta.url)));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn('python3',[join(root,'transcription-server.py'),'--model',join(root,'models'),'--port',String(port)],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:root},stdio:'ignore'}),closed=once(child,'close');
 t.after(async()=>{child.kill('SIGTERM');await closed;});const endpoint=`http://127.0.0.1:${port}`;
 for(let i=0;;i++){try{if((await fetch(endpoint+'/health',{signal:AbortSignal.timeout(500)})).ok)break;}catch{}assert.ok(i<200,'ASR worker did not start');await new Promise(resolve=>setTimeout(resolve,10));}
 const id=randomUUID(),headers={Authorization:'Bearer generated-but-not-configured','X-Mote-Request-Scope':'a'.repeat(64)};
 for(const method of ['GET','DELETE'])assert.equal((await fetch(endpoint+'/executions/'+id,{method,headers})).status,401);
 const response=await fetch(endpoint+'/transcribe',{method:'POST',headers:{...headers,'X-Mote-Request-Id':id},body:'generated'});assert.equal(response.status,401);assert.equal(response.headers.get('x-mote-execution-started'),'false');
});

test('inference receives a private HOME and only its worker credential, never Central, provider or CLI credentials',async()=>{
 const {mediaWorkerEnvironment}=await import('./media-workers.mjs');
 const env=mediaWorkerEnvironment('/generated/private-worker','/generated/python/bin/python','generated-worker-token',{PATH:'/generated/bin',HOME:'/generated/cli-home',OPENAI_API_KEY:'generated-secret',MOTE_TOKEN:'generated-central-token',PYTHONPATH:'/generated/injection',HF_TOKEN:'generated-hub-token',AWS_SECRET_ACCESS_KEY:'generated-secret',HTTPS_PROXY:'http://127.0.0.1:9999'});
 assert.equal(env.HOME,'/generated/private-worker');assert.equal(env.PATH,'/generated/python/bin:/generated/bin');assert.equal(env.MOTE_MEDIA_WORKER_TOKEN,'generated-worker-token');assert.equal(env.HF_HUB_OFFLINE,'1');
 for(const name of ['OPENAI_API_KEY','MOTE_TOKEN','PYTHONPATH','HF_TOKEN','AWS_SECRET_ACCESS_KEY','HTTPS_PROXY'])assert.equal(env[name],undefined,name);
 assert.equal(mediaEnvironment({HOME:'/generated/cli-home'}).HOME,undefined);
});

for(const crash of [false,true])test(`the actual sidecar entry ${crash?'reaps children after an unexpected worker exit':'waits for its entire process group on termination'}`,async t=>{
 const {spawn,execFileSync}=await import('node:child_process'),{once}=await import('node:events');
 const root=await fixture(t),entry=fileURLToPath(new URL('./media-worker-entry.mjs',import.meta.url));
 const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim(),modelDirectory=join(root,'models');await mkdir(modelDirectory);
 await writeFile(join(root,'mote.yaml'),JSON.stringify({version:1,revision:0,media:{modelDirectory,workerToken:'generated-sidecar-worker-token',ocrPort:19001,asrPort:19002}}));
 await writeFile(join(root,'scripts/ocr-server.py'),String.raw`import json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path(__file__).parent.parent
(root/'arguments.json').write_text(json.dumps(sys.argv[1:]))
(root/'environment.json').write_text(json.dumps({key:os.environ.get(key) for key in ['HOME','MOTE_CONFIG_FILE','MOTE_MEDIA_WORKER_TOKEN','OPENAI_API_KEY','MOTE_TOKEN','PYTHONPATH','HF_TOKEN']}))
code='import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('+repr(str(root/'descendant.pid'))+').write_text(str(os.getpid()));time.sleep(60)'
subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(root/'worker.pid').write_text(str(os.getpid()))
while True:
    if (root/'crash-now').exists(): os._exit(7)
    time.sleep(.01)
`);
 const child=spawn(process.execPath,[entry,'ocr',python],{cwd:root,env:{...mediaEnvironment(process.env),MOTE_CONFIG_FILE:join(root,'mote.yaml'),OPENAI_API_KEY:'generated-private-key',MOTE_TOKEN:'generated-central-token',PYTHONPATH:'/generated/injection',HF_TOKEN:'generated-hub-token'},stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const closed=once(child,'close');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;});
 const wait=async name=>{for(let i=0;i<300;i++){const text=await readFile(join(root,name),'utf8').catch(()=>undefined);if(text!==undefined)return text;assert.equal(child.exitCode,null,stderr);await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Generated sidecar did not publish '+name);};
 const descendant=Number(await wait('descendant.pid')),worker=Number(await wait('worker.pid')),env=JSON.parse(await wait('environment.json'));
 assert.deepEqual(JSON.parse(await wait('arguments.json')),['--model-root',join(modelDirectory,'ocr'),'--port','19001']);
 for(const name of ['OPENAI_API_KEY','MOTE_TOKEN','PYTHONPATH','HF_TOKEN','MOTE_CONFIG_FILE'])assert.equal(env[name],null,name);
 assert.equal(env.MOTE_MEDIA_WORKER_TOKEN,'generated-sidecar-worker-token');assert.notEqual(env.HOME,process.env.HOME);
 if(crash)await writeFile(join(root,'crash-now'),'generated');else child.kill('SIGTERM');
 const [code]=await closed;assert.equal(code,crash?7:1,stderr);
 for(const pid of [worker,descendant])assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','sidecar exit must prove its owned children are gone');
 await assert.rejects(readFile(join(env.HOME,'anything')));const {stat}=await import('node:fs/promises');await assert.rejects(stat(env.HOME));
});

test('Docker carries worker/domain sources and isolates CPU audio dependencies from OCR',async()=>{
 const docker=await readFile(new URL('../Dockerfile',import.meta.url),'utf8'),{parse}=await import('yaml'),compose=parse(await readFile(new URL('../compose.yaml',import.meta.url),'utf8'));
 assert.match(docker,/COPY scripts \.\/scripts\//,'all worker sources, contracts and fixed manifests ship together');
 assert.match(docker,/\/opt\/mote-media\/ocr\/bin\/pip install[^\n]+requirements-ocr\.txt/);
 assert.match(docker,/\/opt\/mote-media\/dialogue\/bin\/pip install[^\n]+requirements-audio\.txt/);
 assert.doesNotMatch(docker,/pip install[^\n]+requirements-audio\.txt[^\n]+requirements-ocr\.txt/);
 assert.deepEqual(compose.services['ocr-worker'].command,['node','scripts/media-worker-entry.mjs','ocr','/opt/mote-media/ocr/bin/python']);
 assert.deepEqual(compose.services['asr-worker'].command,['node','scripts/media-worker-entry.mjs','asr','/opt/mote-media/dialogue/bin/python']);
 assert.equal(compose.services['ocr-worker'].volumes.find(volume=>volume.source==='mote-models').read_only,false,'the existing execution-facts store must remain persistent and writable');
 assert.equal(compose.services['local-image-worker'],undefined,'Linux does not advertise an MLX sidecar');
});
