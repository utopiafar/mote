import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MediaPreparation} from '../src/media-preparation.js';
import {MediaAssets,type MediaRole} from '../src/media-assets.js';

test('ASR shutdown reaps its actual normalization subprocess after recognizer exit',()=>{
 execFileSync('python3',[fileURLToPath(new URL('../../../scripts/test_media_worker_shutdown.py',import.meta.url))],{stdio:'pipe'});
});

async function fixture(t:Parameters<Parameters<typeof test>[1]>[0]){
 const directory=await mkdtemp(join(tmpdir(),'mote-prepare-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'scripts'));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 class Assets extends MediaAssets { installed=new Set<MediaRole>();installs=0;override ready(role:MediaRole){return this.installed.has(role);}override async installAsync(role:MediaRole,_source?:'auto'|'official'|'mirror',signal?:AbortSignal){signal?.throwIfAborted();this.installs++;this.installed.add(role);}}
 const assets=new Assets(join(directory,'models'));
 const media={modelDirectory:assets.root,python:process.execPath,workerToken:'generated-worker-token',ocrPort:port,asrPort:port,ocrEndpoint:`http://127.0.0.1:${port}/ocr`,asrEndpoint:`http://127.0.0.1:${port}/transcribe`};
 return {directory,assets,media};
}
async function settled(preparation:MediaPreparation,role:MediaRole){for(let index=0;index<300;index++){const status=await preparation.status(role);if(['ready','failed','cancelled','unsupported'].includes(status.state))return status;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Preparation did not settle');}
test('one preparation owns repeated clicks; cancel fences late dependency completion and retry remains possible',async t=>{
 const f=await fixture(t);let release!:()=>void,calls=0;const prepared=new Promise<void>(resolve=>release=resolve);
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>{calls++;await prepared;return {python:process.execPath};},fetch:async()=>new Response('{}')});t.after(()=>preparation.close());
 const first=await preparation.start('ocr'),second=await preparation.start('ocr');assert.equal(first.id,second.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 const cancel=preparation.cancel('ocr');release();await cancel;assert.equal((await preparation.status('ocr')).state,'cancelled');assert.equal(f.assets.installs,0);
 const retry=await preparation.start('ocr');assert.notEqual(retry.id,first.id);await preparation.cancel('ocr');assert.equal(f.assets.installs,0);
});
test('configuration change cancels queued dependency work before any model installation or worker spawn',async t=>{
 const f=await fixture(t);let release!:()=>void;const prepared=new Promise<void>(resolve=>release=resolve);
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>{await prepared;return {python:process.execPath};}});t.after(()=>preparation.close());
 await preparation.start('ocr');await preparation.start('dialogue');preparation.invalidate();release();await preparation.close();assert.equal(f.assets.installs,0);assert.equal((await preparation.status('ocr')).error,'configuration_changed');
});
test('native start failure is not ready, retry runs an owned authenticated HTTP worker, and close frees its port',async t=>{
 const f=await fixture(t),script=join(f.directory,'scripts','ocr-server.py');await writeFile(script,'process.exit(1)');
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath}),startupTimeoutMs:2000});t.after(()=>preparation.close());
 await preparation.start('ocr');assert.equal((await settled(preparation,'ocr')).state,'failed');
 await writeFile(script,"const http=require('node:http');http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.MOTE_MEDIA_WORKER_TOKEN){res.writeHead(401);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({ocr:true}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');");
 await preparation.start('ocr');const result=await settled(preparation,'ocr');assert.equal(result.state,'ready');assert.equal(result.runtimeReady,true);assert.ok(!JSON.stringify(result).includes(f.media.workerToken));
 assert.equal((await fetch(f.media.ocrEndpoint.replace('/ocr','/health'))).status,401);preparation.invalidate();await preparation.close();await assert.rejects(fetch(f.media.ocrEndpoint));assert.equal((await preparation.status('ocr')).error,'configuration_changed');
});
test('Docker prepares model files and checks its existing sidecar without invoking native dependency installation',async t=>{
 const f=await fixture(t);let native=0;const preparation=new MediaPreparation({runtime:'docker',...f,prepare:async()=>{native++;throw Error('must not run');},fetch:async()=>Response.json({asr:true,diarization:true})});t.after(()=>preparation.close());
 await preparation.start('dialogue');assert.equal((await settled(preparation,'dialogue')).state,'ready');assert.equal(native,0);assert.equal(f.assets.installs,1);
});
test('cancelling startup waits for its owned unready worker to exit before reporting cancelled',async t=>{
 const f=await fixture(t);await writeFile(join(f.directory,'scripts','ocr-server.py'),"const http=require('node:http');http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ocr:false}));}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');");
 const preparation=new MediaPreparation({runtime:'native',...f,repository:f.directory,prepare:async()=>({python:process.execPath}),startupTimeoutMs:5000});t.after(()=>preparation.close());
 await preparation.start('ocr');let listening=false;for(let index=0;index<100;index++){try{await fetch(f.media.ocrEndpoint);listening=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
 assert.equal(listening,true);assert.equal((await preparation.status('ocr')).state,'starting');const result=await preparation.cancel('ocr');assert.equal(result.state,'cancelled');assert.equal(result.runtimeReady,false);await assert.rejects(fetch(f.media.ocrEndpoint));
});
test('custom native endpoints remain explicit and are never installed over or claimed managed',async t=>{
 const f=await fixture(t),preparation=new MediaPreparation({runtime:'native',...f,media:{...f.media,ocrEndpoint:'https://example.invalid/ocr'}});t.after(()=>preparation.close());
 assert.equal((await preparation.status('ocr')).error,'external_worker');assert.throws(()=>preparation.start('ocr'),/external_worker/);assert.equal(f.assets.installs,0);
});


test('configuration invalidation aborts an in-flight worker health request',async t=>{
 const f=await fixture(t);f.assets.installed.add('ocr');let signal:AbortSignal|undefined;
 const preparation=new MediaPreparation({runtime:'docker',...f,fetch:async(_input,init)=>{signal=init?.signal as AbortSignal;await new Promise<void>((_resolve,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return Response.json({ocr:true});}});t.after(()=>preparation.close());
 const reading=preparation.status('ocr');for(let index=0;index<100&&!signal;index++)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(signal);preparation.invalidate();assert.equal(signal.aborted,true);assert.equal((await reading).runtimeReady,false);await preparation.close();
});
