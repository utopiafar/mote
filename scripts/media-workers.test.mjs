import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {mediaEnvironment,mediaWorkerEnvironment,spawnMediaProcess} from './media-workers.mjs';

// Every signal and inspection below is restricted to a process created here.
async function ownedProcess(t,{ignoreTerm=false}={}){
 const root=await mkdtemp(join(tmpdir(),'mote-process-lifecycle-'));
 const owner=spawnMediaProcess(process.execPath,['-e',`${ignoreTerm?"process.on('SIGTERM',()=>{});":''}setInterval(()=>{},60000);process.stdout.write('ready');`],{cwd:root,env:mediaWorkerEnvironment(root,process.execPath,'generated-token'),stdio:['ignore','pipe','ignore']});
 const closed=once(owner.child,'close');
 t.after(async()=>{
  try{if(owner.child.exitCode===null&&owner.child.signalCode===null)owner.child.kill('SIGKILL');await closed;await owner.done.catch(()=>{});}
  finally{await rm(root,{recursive:true,force:true});}
 });
 await once(owner.child.stdout,'data');
 return {owner,closed,kill:process.kill,pid:owner.child.pid};
}
function waitForZombie(pid){
 // Keep Node from waitpid until the kernel state is observable. This controls
 // the exit/probe race without faking Darwin's kill(2) result or reusing a PID.
 for(let n=0;n<200;n++){
  const state=childProcess.execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();
  if(state.startsWith('Z'))return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 }
 assert.fail('Generated worker did not reach its unreaped exit state');
}
for(const phase of ['signal','probe'])test(`close reaps an owned Darwin zombie when the ${phase} returns native EPERM`,{skip:process.platform!=='darwin'},async t=>{
 const {owner,closed,kill,pid}=await ownedProcess(t);let denied=0;
 t.mock.method(process,'kill',function(target,kind){
  try{
   const sent=kill.call(process,target,kind);
   if(phase==='probe'&&target===-pid&&kind==='SIGTERM')waitForZombie(pid);
   return sent;
  }catch(error){if(target===-pid&&error.code==='EPERM')denied++;throw error;}
 });
 if(phase==='signal'){kill.call(process,pid,'SIGKILL');waitForZombie(pid);}
 await owner.close();await closed;await owner.done;
 assert.ok(denied>0,'the actual kernel must exercise the ambiguous EPERM boundary');
 assert.notEqual(owner.child.signalCode,null,'close waits for the child to be reaped');
});
for(const phase of ['signal','probe'])test(`close retains a real cleanup failure when the owned live group denies its ${phase}`,{skip:process.platform==='win32'},async t=>{
 const {owner,kill,pid}=await ownedProcess(t,{ignoreTerm:true}),denied=Object.assign(Error('generated permission denial'),{code:'EPERM'});
 t.mock.method(process,'kill',function(target,kind){if(target===-pid&&kind===(phase==='signal'?'SIGTERM':0))throw denied;return kill.call(process,target,kind);});
 await assert.rejects(owner.close(),error=>error===denied);
 assert.equal(kill.call(process,pid,0),true,'a live worker cannot be certified as stopped');
});
for(const result of [{status:2,stdout:''},{status:0,stdout:'unreadable generated state'}])test(`close cannot certify an EPERM cleanup from ${result.status?'a failed':'a malformed'} process inspection`,{skip:process.platform==='win32'},async t=>{
 const {owner,kill,pid}=await ownedProcess(t,{ignoreTerm:true}),denied=Object.assign(Error('generated permission denial'),{code:'EPERM'}),spawnSync=childProcess.spawnSync;let inspected=0;
 t.mock.method(process,'kill',function(target,kind){if(target===-pid&&kind===0)throw denied;return kill.call(process,target,kind);});
 const inspection=t.mock.method(childProcess,'spawnSync',function(command,args,options){
  if(command==='/bin/ps'&&args.includes('-g')&&args.includes(String(pid))){inspected++;return {...result,signal:null};}
  return spawnSync.call(this,command,args,options);
 });
 syncBuiltinESMExports();
 try{await assert.rejects(owner.close(),/media\.runtime\.process_stop_failed/);assert.equal(inspected,1);assert.equal(kill.call(process,pid,0),true);}
 finally{inspection.mock.restore();syncBuiltinESMExports();}
});
test('close never probes or signals a reused group number after observing its owned group disappear',{skip:process.platform==='win32'},async t=>{
 const {owner,closed,kill,pid}=await ownedProcess(t);let disappeared=false,reusedCalls=0;
 t.mock.method(process,'kill',function(target,kind){
  if(target===-pid){
   if(disappeared){reusedCalls++;throw Error('generated group number now belongs to another owner');}
   if(kind===0){disappeared=true;throw Object.assign(Error('generated group exit'),{code:'ESRCH'});}
  }
  return kill.call(process,target,kind);
 });
 await owner.close();await closed;await owner.close();
 assert.equal(disappeared,true);assert.equal(reusedCalls,0,'an absent owned group must never be reacquired by number');
});

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
// Reuse the current generated FunASR engine boundary and production multipart,
// normalization, process owner and serializers. Missing dependencies must fail
// this ordinary entrypoint instead of silently skipping its regression cases.
const asrHttpRegressions = async names => {
  const {execFileSync}=await import('node:child_process');
  execFileSync('python3',['-c',`import sys, unittest
sys.path.insert(0, sys.argv[1])
suite = unittest.defaultTestLoader.loadTestsFromNames(sys.argv[2:])
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() and not result.skipped else 1)
`,fileURLToPath(new URL('.',import.meta.url)),...names.map(name=>'test_transcription_server.TranscriptionHTTP.'+name)],{stdio:'pipe'});
};
test('audio HTTP worker enforces the authenticated request budget, preserves its host cap and releases timed-out work',()=>asrHttpRegressions([
  'test_directory_only_partial_install_and_failed_load_never_report_ready_and_control_recovers',
  'test_ffmpeg_disappearance_blocks_execution_without_claiming_funasr_packages_are_missing',
  'test_invalid_uploads_and_contracts_never_start_recognition_or_publish_failed_facts',
  'test_request_timeout_and_independent_worker_cap_terminate_before_releasing_capacity',
]));

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

test('ASR health, execution facts and identified POSTs require a configured worker token',()=>asrHttpRegressions([
  'test_no_configured_token_never_accepts_recordings_or_exposes_execution_facts',
]));

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
