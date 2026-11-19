import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,Socket} from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MediaPreparation} from '../src/media-preparation.js';
import {MEDIA_CATALOG,MediaAssets,type MediaRole} from '../src/media-assets.js';

const asrProducer=execFileSync('python3',[fileURLToPath(new URL('../../../scripts/test_mote_asr_contract.py',import.meta.url)),'--emit'],{encoding:'utf8'});
const asrIdentity=JSON.parse(asrProducer).request.identity;
const asrHealth={protocol:'mote.funasr/1',execution:'local',asr:true,diarization:true,identity:asrIdentity};

test('ASR shutdown reaps its actual normalization subprocess after recognizer exit',()=>{
 execFileSync('python3',[fileURLToPath(new URL('../../../scripts/test_media_worker_shutdown.py',import.meta.url))],{stdio:'pipe'});
});

async function fixture(t:Parameters<Parameters<typeof test>[1]>[0]){
 const directory=await mkdtemp(join(tmpdir(),'mote-prepare-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'scripts'));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 class Assets extends MediaAssets { installed=new Set<MediaRole>();installs=0;sources:(('auto'|'official'|'mirror')|undefined)[]=[];override ready(role:MediaRole){return this.installed.has(role);}override async installAsync(role:MediaRole,source?:'auto'|'official'|'mirror',signal?:AbortSignal){signal?.throwIfAborted();this.installs++;this.sources.push(source);this.installed.add(role);}}
 const assets=new Assets(join(directory,'models'));
 const media={modelDirectory:assets.root,python:process.execPath,workerToken:'generated-worker-token',ocrPort:port,asrPort:port,ocrEndpoint:`http://127.0.0.1:${port}/ocr`,asrEndpoint:`http://127.0.0.1:${port}/transcribe`};
 return {directory,assets,media,runtimeRoot:join(directory,'media-runtime')};
}
async function settled(preparation:MediaPreparation,role:MediaRole){for(let index=0;index<300;index++){const status=await preparation.status(role);if(['prepared','ready','failed','cancelled','unsupported'].includes(status.state))return status;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Preparation did not settle');}
test('one preparation owns repeated clicks; cancel fences late dependency completion and retry remains possible',async t=>{
 const f=await fixture(t);let release!:()=>void,calls=0;const prepared=new Promise<void>(resolve=>release=resolve);
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>{calls++;await prepared;return {python:process.execPath};},fetch:async()=>new Response('{}')});t.after(()=>preparation.close());
 assert.equal(preparation.preparing('ocr',f.media.ocrEndpoint),false);
 const pending=preparation.start('ocr');assert.equal(preparation.preparing('ocr',f.media.ocrEndpoint),true,'queued native work is already owned');
 const first=await pending,second=await preparation.start('ocr');assert.equal(first.id,second.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 assert.equal(preparation.preparing('ocr',f.media.ocrEndpoint+'/custom'),false);assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),false);
 const cancel=preparation.cancel('ocr');assert.equal(preparation.preparing('ocr',f.media.ocrEndpoint),false,'cancel takes effect before dependency completion');release();await cancel;assert.equal((await preparation.status('ocr')).state,'cancelled');assert.equal(f.assets.installs,0);
 const retry=await preparation.start('ocr');assert.notEqual(retry.id,first.id);await preparation.cancel('ocr');assert.equal(f.assets.installs,0);
});
test('configuration change cancels queued dependency work before any model installation or worker spawn',async t=>{
 const f=await fixture(t);let release!:()=>void;const prepared=new Promise<void>(resolve=>release=resolve);
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>{await prepared;return {python:process.execPath};}});t.after(()=>preparation.close());
 await preparation.start('ocr');await preparation.start('dialogue');assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),true);preparation.invalidate();assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),false);release();await preparation.close();assert.equal(f.assets.installs,0);assert.equal((await preparation.status('ocr')).error,'configuration_changed');
});
test('native model installation remains a preparation wait until cancellation fences the late installer',async t=>{
 const f=await fixture(t);let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve),install=f.assets.installAsync.bind(f.assets);
 f.assets.installAsync=async(role,source,signal)=>{entered();await held;return install(role,source,signal);};
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath})});t.after(async()=>{release();await preparation.close();});
 await preparation.start('dialogue');await started;assert.equal((await preparation.status('dialogue')).state,'models');assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),true);
 const cancelled=preparation.cancel('dialogue');assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),false);release();await cancelled;assert.equal(f.assets.installs,0);assert.equal((await preparation.status('dialogue')).state,'cancelled');
});
test('native start failure is not ready, retry runs an owned authenticated HTTP worker, and close frees its port',async t=>{
 const f=await fixture(t),script=join(f.directory,'scripts','ocr-server.py');await writeFile(script,'process.exit(1)');
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath}),startupTimeoutMs:2000});t.after(()=>preparation.close());
 await preparation.start('ocr');assert.equal((await settled(preparation,'ocr')).state,'failed');
 await writeFile(script,"const http=require('node:http');http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.MOTE_MEDIA_WORKER_TOKEN){res.writeHead(401);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,execution:'local',ocr:true}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');");
 await preparation.start('ocr');const result=await settled(preparation,'ocr');assert.equal(result.state,'ready');assert.equal(result.runtimeReady,true);assert.ok(!JSON.stringify(result).includes(f.media.workerToken));
 assert.equal((await fetch(f.media.ocrEndpoint.replace('/ocr','/health'))).status,401);preparation.invalidate();await preparation.close();await assert.rejects(fetch(f.media.ocrEndpoint));assert.equal((await preparation.status('ocr')).error,'configuration_changed');
});
test('Docker prepares model files and checks its existing sidecar without invoking native dependency installation',async t=>{
 const f=await fixture(t);let native=0;const preparation=new MediaPreparation({runtime:'docker',...f,prepare:async()=>{native++;throw Error('must not run');},fetch:async()=>Response.json(asrHealth)});t.after(()=>preparation.close());
 const pending=preparation.start('dialogue');assert.equal(preparation.preparing('dialogue',f.media.asrEndpoint),false,'deployment-owned sidecars are not Central-owned native listeners');await pending;assert.equal((await settled(preparation,'dialogue')).state,'ready');assert.equal(native,0);assert.equal(f.assets.installs,1);
});
test('preparation uses the automatic model source so an unreachable official host can fall back to the mirror',async t=>{
 const f=await fixture(t),preparation=new MediaPreparation({runtime:'docker',...f,fetch:async()=>Response.json(asrHealth)});t.after(()=>preparation.close());
 await preparation.start('dialogue');assert.equal((await settled(preparation,'dialogue')).state,'ready');assert.deepEqual(f.assets.sources,['auto']);
});
test('cancelling startup waits for its owned unready worker to exit before reporting cancelled',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'scripts','ocr-server.py'),"const http=require('node:http');http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,execution:'local',ocr:false}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');");
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath}),startupTimeoutMs:5000});t.after(()=>preparation.close());
 await preparation.start('ocr');let listening=false;for(let index=0;index<100;index++){try{await fetch(f.media.ocrEndpoint);listening=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
 assert.equal(listening,true);assert.equal((await preparation.status('ocr')).state,'starting');const result=await preparation.cancel('ocr');assert.equal(result.state,'cancelled');assert.equal(result.runtimeReady,false);await assert.rejects(fetch(f.media.ocrEndpoint));
});
test('custom native endpoints remain explicit and are never installed over or claimed managed',async t=>{
 const f=await fixture(t),preparation=new MediaPreparation({runtime:'native',...f,media:{...f.media,ocrEndpoint:'https://example.invalid/ocr'}});t.after(()=>preparation.close());
 assert.equal((await preparation.status('ocr')).error,'external_worker');assert.throws(()=>preparation.start('ocr'),/external_worker/);assert.equal(f.assets.installs,0);
});

for(const failure of ['timeout','EACCES','EMFILE','ECONNRESET'] as const)test(`native ${failure} port probes report uncertainty without spawning, and explicit preparation can recover`,async t=>{
 const {readFile}=await import('node:fs/promises'),f=await fixture(t),marker=join(f.directory,'worker-started');
 await writeFile(join(f.directory,'scripts','transcription-server.py'),`const http=require('node:http'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'generated');http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.MOTE_MEDIA_WORKER_TOKEN){res.writeHead(401);res.end();return;}res.setHeader('content-type','application/json');res.end(${JSON.stringify(JSON.stringify(asrHealth))});}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath}),startupTimeoutMs:2000});t.after(()=>preparation.close());
 // Only the unavailable OS socket result is controlled. Keep the real
 // preparation, assets, process owner, HTTP worker and retry entrypoint.
 const original=Socket.prototype.connect;let probes=0,oneTimeout=false;
 const socketBoundary=t.mock.method(Socket.prototype,'connect',function(this:Socket,...args:any[]){
  const options=Array.isArray(args[0])?args[0][0]:args[0];
  if(options&&options.host==='127.0.0.1'&&Number(options.port)===f.media.asrPort&&Object.keys(options).every(key=>key==='host'||key==='port')){
   probes++;
   if(!oneTimeout||probes===1){
    queueMicrotask(()=>{if(failure==='timeout')this.emit('timeout');else this.emit('error',Object.assign(Error('Generated private probe detail'),{code:failure}));});return this;
   }
  }
  return Reflect.apply(original,this,args);
 });
 await preparation.start('dialogue');const failed=await settled(preparation,'dialogue');
 assert.equal(failed.state,'failed');assert.equal(failed.runtimeReady,false);
 assert.equal(failed.error,failure==='timeout'?'worker_port_probe_timeout':'worker_port_probe_failed');
 assert.ok(probes>0);assert.doesNotMatch(JSON.stringify(failed),/Generated private probe detail|generated-worker-token/);
 await assert.rejects(readFile(marker),{code:'ENOENT'},'an uncertain probe cannot authorize a worker spawn');
 if(failure==='timeout'){oneTimeout=true;probes=0;}else socketBoundary.mock.restore();
 await preparation.start('dialogue');const recovered=await settled(preparation,'dialogue');
 assert.equal(recovered.state,'ready');assert.equal(recovered.runtimeReady,true);assert.equal(await readFile(marker,'utf8'),'generated');
 if(oneTimeout)assert.equal(probes,2,'a single inconclusive probe must be followed by a fresh bind check');
 await preparation.close();await assert.rejects(fetch(f.media.asrEndpoint),'owned recovery must free its listener');
});


test('configuration invalidation aborts an in-flight worker health request',async t=>{
 const f=await fixture(t);f.assets.installed.add('ocr');let signal:AbortSignal|undefined;
 const preparation=new MediaPreparation({runtime:'docker',...f,fetch:async(_input,init)=>{signal=init?.signal as AbortSignal;await new Promise<void>((_resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return Response.json({version:1,execution:'local',ocr:true});}});t.after(()=>preparation.close());
 const reading=preparation.status('ocr');for(let index=0;index<100&&!signal;index++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(signal);preparation.invalidate();assert.equal(signal.aborted,true);assert.equal((await reading).runtimeReady,false);await preparation.close();
});

async function lifecycle(t:import('node:test').TestContext){
 const {readFile,symlink}=await import('node:fs/promises');
 const {prepareNativeMediaRuntime,nativeMediaPlatform,MEDIA_UV_VERSION,mediaRoleSupported}=await import('../src/media-native-runtime.mjs');
 const {createHash}=await import('node:crypto');
 const root=await mkdtemp(join(tmpdir(),'mote-role-lifecycle-')),repository=join(root,'repository'),scripts=join(repository,'scripts'),runtime=join(root,'models/runtime');
 await mkdir(scripts,{recursive:true});
 const preparations:MediaPreparation[]=[];
 t.after(async()=>{try{await Promise.all(preparations.map(preparation=>preparation.close()));}finally{await rm(root,{recursive:true,force:true});}});
 const reservations=await Promise.all(Array.from({length:3},async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');return server;}));
 const ports=reservations.map(server=>(server.address() as {port:number}).port);await Promise.all(reservations.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
 const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
 await writeFile(join(scripts,'mote_asr_contract.py'),await readFile(new URL('../../../scripts/mote_asr_contract.py',import.meta.url)));
 await writeFile(join(scripts,'identity.json'),JSON.stringify(asrIdentity));
 const {LOCAL_IMAGE_MODEL,LOCAL_IMAGE_PROMPT_VERSION}=await import('../src/local-image-contract.js');
 await writeFile(join(scripts,'image-model.json'),JSON.stringify({...LOCAL_IMAGE_MODEL,revision:'generated-model-revision',engine:'mlx',engineVersion:'generated-engine',promptVersion:LOCAL_IMAGE_PROMPT_VERSION}));
 const worker=String.raw`import json,os,sys,time,signal,subprocess
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from mote_asr_contract import serialize,PROTOCOL
root=Path(__file__).parent
role={'ocr-server.py':'ocr','transcription-server.py':'dialogue','vlm-server.py':'local-image'}[Path(__file__).name]
port=int(sys.argv[sys.argv.index('--port')+1])
(root/(role+'.pid')).write_text(str(os.getpid()))
(root/(role+'.environment.json')).write_text(json.dumps({name:os.environ.get(name) for name in ['HOME','OPENAI_API_KEY','MOTE_TOKEN','MOTE_CONFIG_FILE','PYTHONPATH','HF_TOKEN','AWS_SECRET_ACCESS_KEY','MOTE_MEDIA_WORKER_TOKEN']}))
mode=lambda:(root/(role+'.mode')).read_text() if (root/(role+'.mode')).exists() else 'ready'
if mode()=='crash': sys.exit(3)
if (root/(role+'.descendant')).exists():
    child_code='import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('+repr(str(root/(role+'.child-pid')))+').write_text(str(os.getpid()));time.sleep(60)'
    subprocess.Popen([sys.executable,'-c',child_code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.headers.get('Authorization')!='Bearer '+os.environ['MOTE_MEDIA_WORKER_TOKEN']:
            self.send_response(401);self.end_headers();return
        state=mode();(root/(role+'.health-seen')).write_text(state)
        if state=='late':
            while not (root/(role+'.release')).exists(): time.sleep(.01)
        if state=='legacy': payload={'version':2,'execution':'local','asr':True,'diarization':True,'wespeaker':True}
        elif role=='ocr': payload={'version':1,'execution':'local','ocr':state not in ('loading','load-failure')}
        elif role=='dialogue': payload={'protocol':PROTOCOL,'execution':'local','asr':state not in ('loading','load-failure'),'diarization':True,'identity':json.loads((root/'identity.json').read_text())}
        else: payload={'version':1,'execution':'local','localImage':state not in ('loading','load-failure'),'model':json.loads((root/'image-model.json').read_text())}
        if state=='load-failure': payload['loadError']=True
        if state=='busy': payload['busy']=True
        raw=serialize(payload).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers()
        try:self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):pass
ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
`;
 for(const script of ['ocr-server.py','transcription-server.py','vlm-server.py'])await writeFile(join(scripts,script),worker);
 const allRoles=['ocr','dialogue','local-image'] as const,bootstrapBytes=Buffer.from('generated verified bootstrap');
 const platform=nativeMediaPlatform();
 for(const role of allRoles){
  await writeFile(join(scripts,`requirements-${role==='dialogue'?'audio':role==='local-image'?'vlm':'ocr'}.txt`),'# Generated dependency boundary\n');
  const bootstrap=join(runtime,role,'bootstrap',MEDIA_UV_VERSION,platform.target);await mkdir(bootstrap,{recursive:true});
  await writeFile(join(bootstrap,'uv'),bootstrapBytes);await writeFile(join(bootstrap,'receipt.json'),JSON.stringify({archiveSha256:platform.sha256,binarySha256:createHash('sha256').update(bootstrapBytes).digest('hex')}));
 }
 let installs=0,pip=0;
 const installed=new Set<import('@mote/shared').MediaRole>();
 const assets={root:join(root,'models'),ready:(role:import('@mote/shared').MediaRole)=>installed.has(role),status:(role:import('@mote/shared').MediaRole)=>({role,state:installed.has(role)?'ready':'not_installed',version:'generated-assets-v1',bytes:0,totalBytes:0,source:''}),async installAsync(role:import('@mote/shared').MediaRole,_source?:string,signal?:AbortSignal){signal?.throwIfAborted();installs++;installed.add(role);}};
 const media={modelDirectory:assets.root,python,workerToken:'generated-lifecycle-token',ocrPort:ports[0],asrPort:ports[1],localImagePort:ports[2],ocrEndpoint:`http://127.0.0.1:${ports[0]}/ocr`,asrEndpoint:`http://127.0.0.1:${ports[1]}/transcribe`,localImageEndpoint:`http://127.0.0.1:${ports[2]}/v1/interpret`};
 const prepare:NonNullable<ConstructorParameters<typeof MediaPreparation>[0]['prepare']>=options=>prepareNativeMediaRuntime({...options,sourcePython:python,fetchImpl:async()=>{throw Error('Lifecycle fixtures never download dependencies');},run:async(command:string,args:string[])=>{
  if(args[0]==='venv'){
   const target=args.at(-1)!;await mkdir(join(target,'bin'),{recursive:true});await symlink(python,join(target,'bin/python'));await mkdir(join(target,'lib'));await writeFile(join(target,'lib/ffmpeg'),'generated ffmpeg');
  }
  if(args[0]==='pip')pip++;
  if(args[0]==='-c')return Buffer.from(JSON.stringify({python:'3.11.17',ffmpeg:join(command.replace(/\/bin\/python$/,''),'lib/ffmpeg')}));
  return Buffer.alloc(0);
 }});
 const options={runtime:'native' as const,media,assets,runtimeRoot:runtime,repository,prepare,startupTimeoutMs:2000};
 return {root,scripts,media,assets,runtimeRoot:runtime,python,repository,prepare,counts:()=>({installs,pip}),supported:allRoles.filter(role=>mediaRoleSupported(role)),make(overrides:Partial<ConstructorParameters<typeof MediaPreparation>[0]>={}){const preparation=new MediaPreparation({...options,...overrides});preparations.push(preparation);return preparation;},async mode(role:string,value:string){await writeFile(join(scripts,role+'.mode'),value);},async waitFile(name:string){for(let i=0;i<300;i++){const value=await readFile(join(scripts,name),'utf8').catch(()=>undefined);if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated lifecycle did not reach '+name);}};
}
const gone=(pid:number)=>{try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}};
const settleRole=settled as (preparation:MediaPreparation,role:import('@mote/shared').MediaRole)=>ReturnType<typeof settled>;

async function installedAssets(t:import('node:test').TestContext,f:Awaited<ReturnType<typeof lifecycle>>,role:MediaRole){
 const {createHash}=await import('node:crypto');
 const prior=MEDIA_CATALOG[role],bytes=Buffer.alloc(64*1024,27),file={name:'model.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),official:'https://fixture.invalid/model'};
 MEDIA_CATALOG[role]={version:'generated-repair-'+role,files:[file]};
 const bundle=join(f.root,'bundle');await mkdir(bundle);await writeFile(join(bundle,file.name),bytes);
 const assets=new MediaAssets(f.assets.root);t.after(async()=>{await assets.close();MEDIA_CATALOG[role]=prior;});
 await assets.importBundle(role,bundle);
 return {assets,bytes,file,path:join(assets.path(role),file.name)};
}

test('explicit OCR and dialogue preparation verifies a healthy installation and repairs changed bytes before reporting ready',async t=>{
 const {readFile}=await import('node:fs/promises'),fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
 for(const role of ['ocr','dialogue'] as const)await t.test(role,async child=>{
  const f=await lifecycle(child),installed=await installedAssets(child,f,role),preparation=f.make({assets:installed.assets});
  const originalFetch=fetch;child.mock.method(globalThis,'fetch',(input,init)=>{assert.equal(new URL(String(input)).protocol,'http:','repair reuses the verified generated download cache');return originalFetch(input,init);});
  let verified=0;const read=fs.createReadStream;
  child.mock.method(fs,'createReadStream',((...args:Parameters<typeof fs.createReadStream>)=>{if(String(args[0])===installed.path)verified++;return read(...args);}) as typeof fs.createReadStream);syncBuiltinESMExports();
  child.after(()=>{child.mock.restoreAll();syncBuiltinESMExports();});
  await preparation.start(role);assert.equal((await settled(preparation,role)).runtimeReady,true);
  const pid=Number(await f.waitFile(role+'.pid')),first=verified;
  await preparation.start(role);assert.equal((await settled(preparation,role)).runtimeReady,true);
  assert.ok(verified>first,'the existing healthy-worker shortcut cannot bypass explicit full verification');
  assert.equal(Number(await f.waitFile(role+'.pid')),pid,'healthy verified workers remain owned');
  const checked=verified;await preparation.start(role,false);assert.equal((await settled(preparation,role)).runtimeReady,true);await preparation.status(role);
  assert.equal(verified,checked,'normal resume and status do not hash installed model bytes');
  await writeFile(installed.path,Buffer.alloc(installed.bytes.length,1));
  assert.equal(installed.assets.ready(role),role==='dialogue','large assets retain the worker hash boundary; small OCR verifies metadata changes');
  await preparation.start(role);assert.equal((await settled(preparation,role)).runtimeReady,true);
  assert.deepEqual(await readFile(installed.path),installed.bytes,'an explicit retry repairs same-size corruption from the verified cache');
  await preparation.close();await assert.rejects(fetch(role==='ocr'?f.media.ocrEndpoint:f.media.asrEndpoint));
 });
});

test('an explicit worker activation joins the same in-flight setup while duplicate setup never requests a worker itself',async t=>{
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const f=await lifecycle(t);if(!f.supported.includes('local-image')){t.skip('local image workers require Apple Silicon');return;}
 const installed=await installedAssets(t,f,'local-image');
 const preparation=f.make({assets:installed.assets,prepare:async options=>{entered();await held;return f.prepare(options);}});
 const first=await preparation.prepare('local-image');await started;
 const repeated=await preparation.prepare('local-image');assert.equal(repeated.id,first.id);
 await assert.rejects(import('node:fs/promises').then(fs=>fs.readFile(join(f.scripts,'local-image.pid'))),{code:'ENOENT'});
 const activation=await preparation.start('local-image',false);assert.equal(activation.id,first.id,'only the separately authorized start joins setup with a worker request');
 release();const ready=await settled(preparation,'local-image');assert.equal(ready.state,'ready');assert.equal(ready.runtimeReady,true);assert.equal(f.counts().pip,1);
 const pid=Number(await f.waitFile('local-image.pid'));await preparation.stop('local-image');assert.equal(gone(pid),true);
});

for(const action of ['cancel','stop','invalidate'] as const)test(`${action} fences late setup after an explicit local-image activation joins it`,async t=>{
 let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
 const {readFile}=await import('node:fs/promises'),f=await lifecycle(t);if(!f.supported.includes('local-image')){t.skip('local image workers require Apple Silicon');return;}
 const installed=await installedAssets(t,f,'local-image');
 const preparation=f.make({assets:installed.assets,prepare:async options=>{const result=await f.prepare(options);entered();await held;return result;}});
 await preparation.prepare('local-image');await started;await preparation.start('local-image',false);
 const stopping=action==='invalidate'?(preparation.invalidate(),preparation.close()):preparation[action]('local-image');
 release();await stopping;const status=await preparation.status('local-image');assert.equal(status.runtimeReady,false);
 assert.equal(status.state,action==='stop'?'idle':action==='invalidate'?'unsupported':'cancelled');
 await assert.rejects(readFile(join(f.scripts,'local-image.pid')),{code:'ENOENT'},'late preparation cannot start a worker after withdrawal');
});

test('local-image asset repair leaves selection unchanged and the existing plugin refresh reloads verified bytes into an owned worker',async t=>{
 const {readFile}=await import('node:fs/promises'),{PluginHost}=await import('@mote/plugin-host'),Fastify=(await import('fastify')).default;
 const {mediaModelsFeature}=await import('../src/features/media.js');
 const {createLocalImageProcessing,LOCAL_IMAGE_PROCESSING_INSTANCE,localImageProcessingSelection,localImageProcessingDeclaration}=await import('../src/plugins/local-image-processing.js');
 const f=await lifecycle(t);if(!f.supported.includes('local-image')){t.skip('local image workers require Apple Silicon');return;}
 const installed=await installedAssets(t,f,'local-image'),preparation=f.make({assets:installed.assets}),script=join(f.scripts,'vlm-server.py');
 // Only inference/dependency loading is generated. The physical child runs the
 // actual loader's pinned-byte verifier before publishing its real HTTP health.
 const original=await readFile(script,'utf8'),scripts=fileURLToPath(new URL('../../../scripts/',import.meta.url));
 await writeFile(script,`import sys\nsys.path.insert(0,${JSON.stringify(scripts)})\nfrom mote_vlm import verify_assets\nverify_assets(sys.argv[sys.argv.index('--model-root')+1],${JSON.stringify([[installed.file.name,installed.file.size,installed.file.sha256]])})\n`+original);
 await f.prepare({repository:f.repository,directory:f.runtimeRoot,role:'local-image',signal:new AbortController().signal});
 await writeFile(installed.path,Buffer.alloc(installed.bytes.length,1));assert.equal(installed.assets.ready('local-image'),true);
 const host=new PluginHost({kind:'central',id:'generated-image-repair'});t.after(()=>host.close());
 const desired=localImageProcessingSelection;
 const local=createLocalImageProcessing({desired:()=>desired,modelStatus:async()=>({...installed.assets.status('local-image'),runtimeReady:(await preparation.status('local-image')).runtimeReady}),createWorker:()=>({prepare(){},async start(){await preparation.start('local-image',false);const status=await settled(preparation,'local-image');if(!status.runtimeReady)throw Error('Generated worker rejected corrupt bytes');},quiesce(){},stop:async()=>{await preparation.stop('local-image');},dispose(){}})});
 await host.install({identity:{host:host.identity,packageId:desired.packageId,installationId:'generated-image-repair',instanceId:LOCAL_IMAGE_PROCESSING_INSTANCE,activationId:'generated-first'},contributions:[localImageProcessingDeclaration],factory:local.factory});
 assert.deepEqual(local.port.state(),{enabled:true,state:'failed',reason:'worker_unavailable'});
 assert.equal((await preparation.status('local-image')).runtimeReady,false);
 const app=Fastify();mediaModelsFeature({mediaAssets:installed.assets,runtimeStatus:async()=>({runtimeReady:false})}).mount(app,{} as never);t.after(()=>app.close());
 assert.equal((await app.inject({method:'POST',url:'/api/media-models/local-image/install',payload:{}})).statusCode,202);
 for(let i=0;installed.assets.status('local-image').state!=='ready';i++){assert.ok(i<300);await new Promise(resolve=>setTimeout(resolve,10));}
 assert.deepEqual(await readFile(installed.path),installed.bytes);
 assert.equal(local.port.state().state,'failed','installing assets does not enable or restart optional inference');
 assert.equal((await preparation.status('local-image')).runtimeReady,false);
 assert.deepEqual(await local.port.refresh(),{enabled:true,state:'ready'},'the existing explicit plugin retry starts a freshly verified child');
 assert.equal((await preparation.status('local-image')).runtimeReady,true);
 const pid=Number(await f.waitFile('local-image.pid'));await host.close();assert.equal(gone(pid),true);
});

test('stopping during explicit model verification cancels it before a late result can restart the owned worker',async t=>{
 const fs=(await import('node:fs')).default,{syncBuiltinESMExports}=await import('node:module');
 const f=await lifecycle(t),installed=await installedAssets(t,f,'dialogue'),preparation=f.make({assets:installed.assets});
 await preparation.start('dialogue');assert.equal((await settled(preparation,'dialogue')).runtimeReady,true);const pid=Number(await f.waitFile('dialogue.pid'));
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>began=resolve),gate=new Promise<void>(resolve=>release=resolve),read=fs.createReadStream;
 t.mock.method(fs,'createReadStream',((...args:Parameters<typeof fs.createReadStream>)=>{
  const stream=read(...args),iterate=stream[Symbol.asyncIterator].bind(stream);
  if(String(args[0])===installed.path){stream.on('error',()=>{});stream[Symbol.asyncIterator]=async function*(){began();await gate;yield* iterate();};}
  return stream;
 }) as typeof fs.createReadStream);syncBuiltinESMExports();t.after(()=>{release();t.mock.restoreAll();syncBuiltinESMExports();});
 await preparation.start('dialogue');await started;assert.equal((await preparation.status('dialogue')).model.state,'verifying');
 const stopping=preparation.stop('dialogue');release();const stopped=await stopping;
 assert.equal(stopped.runtimeReady,false);assert.equal(gone(pid),true);assert.equal(Number(await f.waitFile('dialogue.pid')),pid);
 assert.equal(installed.assets.status('dialogue').state,'cancelled');await assert.rejects(fetch(f.media.asrEndpoint));
});

test('the actual preparer isolates three worker roles, stops only VLM, reaps descendants and resumes only prepared OCR/ASR after Central restart',async t=>{
 const f=await lifecycle(t),preparation=f.make();
 const saved=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='generated-must-not-inherit';t.after(()=>{if(saved===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=saved;});
 if(f.supported.includes('local-image'))await writeFile(join(f.scripts,'local-image.descendant'),'generated');
 await Promise.all(f.supported.map(role=>preparation.start(role)));
 for(const role of f.supported)assert.equal((await settleRole(preparation,role)).runtimeReady,true,role);
 const pids=Object.fromEntries(await Promise.all(f.supported.map(async role=>[role,Number(await f.waitFile(role+'.pid'))])));
 const environment=JSON.parse(await f.waitFile('ocr.environment.json'));
 for(const name of ['OPENAI_API_KEY','MOTE_TOKEN','MOTE_CONFIG_FILE','PYTHONPATH','HF_TOKEN','AWS_SECRET_ACCESS_KEY'])assert.equal(environment[name],null,name);
 assert.equal(environment.MOTE_MEDIA_WORKER_TOKEN,f.media.workerToken);assert.ok(environment.HOME.startsWith(join(f.runtimeRoot,'ocr/worker')));
 if(f.supported.includes('local-image')){
  const child=Number(await f.waitFile('local-image.child-pid'));
  await preparation.stop('local-image');assert.equal(gone(pids['local-image']),true);assert.equal(gone(child),true,'a detached-output model child must be gone before stop returns');
  assert.equal((await preparation.status('local-image')).runtimeReady,false);await assert.rejects(fetch(f.media.localImageEndpoint));
  for(const role of ['ocr','dialogue'] as const){assert.equal(gone(pids[role]),false);assert.equal((await preparation.status(role)).runtimeReady,true);}
  await preparation.restart('local-image');assert.equal((await settleRole(preparation,'local-image')).runtimeReady,true);
 }
 const counts=f.counts();await preparation.close();
 for(const endpoint of [f.media.ocrEndpoint,f.media.asrEndpoint])await assert.rejects(fetch(endpoint));
 const restarted=f.make();restarted.resume();
 for(const role of ['ocr','dialogue'] as const){assert.equal((await settled(restarted,role)).runtimeReady,true);assert.notEqual(Number(await f.waitFile(role+'.pid')),pids[role]);}
 assert.equal((await restarted.status('local-image')).runtimeReady,false,'a Central restart does not enable the optional plugin');
 assert.deepEqual(f.counts(),counts,'restart probes prepared role environments without package or model installation');
});

test('cancelling an actual loading Python worker frees its port before cancellation and an explicit retry starts a new owner',async t=>{
 const f=await lifecycle(t),preparation=f.make();await f.mode('ocr','loading');await preparation.start('ocr');
 await f.waitFile('ocr.health-seen');const pid=Number(await f.waitFile('ocr.pid'));
 assert.equal((await preparation.cancel('ocr')).state,'cancelled');assert.equal(gone(pid),true);await assert.rejects(fetch(f.media.ocrEndpoint));
 await f.mode('ocr','ready');await preparation.start('ocr');assert.equal((await settled(preparation,'ocr')).runtimeReady,true);assert.notEqual(Number(await f.waitFile('ocr.pid')),pid);
});

for(const mode of ['load-failure','loading','crash'] as const)test(`actual Python ${mode} never publishes ready and leaves no owned listener`,async t=>{
 const f=await lifecycle(t),preparation=f.make({startupTimeoutMs:500});await f.mode('ocr',mode);await preparation.start('ocr');
 const status=await settled(preparation,'ocr');assert.equal(status.state,'failed');assert.equal(status.runtimeReady,false);assert.equal(status.error,mode==='load-failure'?'model_load_failed':'worker_start_failed');
 assert.equal(gone(Number(await f.waitFile('ocr.pid'))),true);await assert.rejects(fetch(f.media.ocrEndpoint));
});

test('busy loaded models stay ready without a replacement, while late health after invalidation cannot restore availability',async t=>{
 const {unlink}=await import('node:fs/promises');
 const f=await lifecycle(t),preparation=f.make();await preparation.start('dialogue');assert.equal((await settled(preparation,'dialogue')).runtimeReady,true);
 const pid=Number(await f.waitFile('dialogue.pid'));await f.mode('dialogue','busy');await preparation.start('dialogue');assert.equal((await settled(preparation,'dialogue')).runtimeReady,true);assert.equal(Number(await f.waitFile('dialogue.pid')),pid);
 await unlink(join(f.scripts,'dialogue.health-seen'));await f.mode('dialogue','late');const pending=preparation.status('dialogue');await f.waitFile('dialogue.health-seen');
 preparation.invalidate();assert.equal((await pending).runtimeReady,false);await preparation.close();assert.equal(gone(pid),true);
});

test('an occupied port is never adopted or killed, and an old ASR health producer cannot impersonate FunASR',async t=>{
 const {spawnMediaProcess,mediaWorkerEnvironment}=await import('../src/media-native-runtime.mjs');
 const f=await lifecycle(t);await f.assets.installAsync('dialogue');await f.mode('dialogue','legacy');
 const external=spawnMediaProcess(f.python,[join(f.scripts,'transcription-server.py'),'--port',String(f.media.asrPort)],{cwd:f.repository,env:mediaWorkerEnvironment(join(f.root,'external'),f.python,f.media.workerToken)});t.after(()=>external.close());
 await f.waitFile('dialogue.pid');
 // Trigger the generated legacy HTTP producer, rather than returning a fake
 // fetch result to the new model-health consumer.
 const headers={Authorization:'Bearer '+f.media.workerToken};
 for(let i=0;;i++){try{const response=await fetch(new URL('/health',f.media.asrEndpoint),{headers});if(response.ok){assert.equal((await response.json() as any).asr,true);break;}}catch{}assert.ok(i<200);await new Promise(resolve=>setTimeout(resolve,10));}
 const docker=f.make({runtime:'docker',startupTimeoutMs:300});assert.equal((await docker.status('dialogue')).runtimeReady,false);await docker.start('dialogue');assert.equal((await settled(docker,'dialogue')).state,'failed');
 const native=f.make();await native.start('dialogue');assert.equal((await settled(native,'dialogue')).error,'worker_port_in_use');await native.close();assert.equal(gone(external.child.pid!),false);
 assert.equal((await fetch(new URL('/health',f.media.asrEndpoint),{headers})).status,200);
 await external.close();
});

test('a real failed asset import cannot start an inference process',async t=>{
 const f=await lifecycle(t),assets=new MediaAssets(f.assets.root),bundle=join(f.root,'bad-bundle');await mkdir(bundle);await writeFile(join(bundle,'config.json'),'generated invalid asset');
 await f.prepare({repository:f.repository,directory:f.runtimeRoot,role:'dialogue',signal:new AbortController().signal});
 await assert.rejects(assets.importBundle('dialogue',bundle),/Invalid model asset/);assert.equal(assets.status('dialogue').state,'failed');
 let dependenciesAccepted=false;
 const preparation=f.make({assets,prepare:async options=>{const result=await f.prepare(options);dependenciesAccepted=true;return result;}});await preparation.start('dialogue',false);const status=await settled(preparation,'dialogue');
 assert.equal(dependenciesAccepted,true,'the actual preparer must accept the environment before testing the asset failure gate');assert.equal(status.state,'failed');assert.equal(status.error,'not_prepared');assert.equal(status.runtimeReady,false);assert.equal(status.model.state,'failed');assert.equal(f.counts().pip,1);await assert.rejects(import('node:fs/promises').then(fs=>fs.readFile(join(f.scripts,'dialogue.pid'))));
});

test('a model becoming unavailable during real health HTTP cannot publish a stale ready result',async t=>{
 const {unlink}=await import('node:fs/promises');const f=await lifecycle(t),preparation=f.make();
 await preparation.start('ocr');assert.equal((await settled(preparation,'ocr')).runtimeReady,true);
 await unlink(join(f.scripts,'ocr.health-seen'));await f.mode('ocr','late');const pending=preparation.status('ocr');await f.waitFile('ocr.health-seen');
 const prior=f.assets.status;f.assets.status=role=>({...prior(role),state:'failed',error:'generated-verification-failure'});await writeFile(join(f.scripts,'ocr.release'),'generated');
 const status=await pending;assert.equal(status.runtimeReady,false);assert.equal(status.model.state,'failed');
});

test('model readiness rejects malformed dependency diagnostics and mismatched actual SDK identities',async()=>{
 const {mediaModelHealth}=await import('../src/media-configuration.js');
 assert.equal(mediaModelHealth('dialogue',asrHealth).ready,true);
 const {settingsFingerprint:_settings,recipe:_recipe,extract:_extract,diarize:_diarize,align:_align,...loadedIdentity}=asrIdentity;
 assert.equal(mediaModelHealth('dialogue',{...asrHealth,identity:loadedIdentity}).ready,false,'the current worker reports complete implementation pins and its own inference settings at boot');
 for(const identity of [
  {...asrIdentity,extra:'generated'},
  {...asrIdentity,settingsFingerprint:'invalid'},
  {...asrIdentity,sdkWheelSha256:'0'.repeat(64)},
  ...['recipe','extract','diarize','align'].map(pin=>({...asrIdentity,[pin]:{...asrIdentity[pin],version:'0'}})),
 ])assert.equal(mediaModelHealth('dialogue',{...asrHealth,identity}).ready,false);
 assert.equal(mediaModelHealth('dialogue',{...asrHealth,identity:{...asrIdentity,sdkVersion:'generated-wrong-sdk'}}).ready,false);
 assert.equal(mediaModelHealth('dialogue',{...asrHealth,identity:{...asrIdentity,models:{...asrIdentity.models,speaker:{...asrIdentity.models.speaker,id:'generated-wrong-speaker'}}}}).ready,false);
 assert.deepEqual(mediaModelHealth('dialogue',{...asrHealth,missingDependencies:['funasr']}),{ready:false,missingDependencies:['funasr']});
 assert.deepEqual(mediaModelHealth('dialogue',{...asrHealth,missingDependencies:['/generated/private/path']}),{ready:false,error:'worker_health_invalid'});
 assert.equal(mediaModelHealth('dialogue',{...asrHealth,execution:'cloud'}).ready,false);
});
