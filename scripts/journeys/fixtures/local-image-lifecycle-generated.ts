/** IMG-08 row 8 through the default Central assembly. Only package installation,
 * generated model bytes and recognition are boundary fixtures. Real preparation,
 * process groups, authenticated health, plugin control and shutdown stay live. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../../../apps/server/src/app.js';
import type {ConfigurationPlatformOptions} from '../../../apps/server/src/config.js';
import {sha256} from '../../../apps/server/src/evidence-store.js';
import {MEDIA_CATALOG} from '../../../apps/server/src/media-assets.js';
import {LOCAL_IMAGE_MODEL,LOCAL_IMAGE_PROMPT_VERSION} from '../../../apps/server/src/local-image-contract.js';
import {localImageProcessingSelection} from '../../../apps/server/src/plugins/local-image-processing.js';
import {prepareNativeMediaRuntime,MEDIA_UV_VERSION,nativeMediaPlatform,mediaRoleSupported} from '../../../apps/server/src/media-native-runtime.mjs';

const roles=['ocr','dialogue','local-image'] as const;
const gone=(pid:number)=>{try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}};

test('IMG08 matrix 8: the default Central isolates three role environments, ports and owned groups while only the image plugin stops VLM',{timeout:120000},async t=>{
 assert.ok(roles.every(role=>mediaRoleSupported(role)),'this generated native lifecycle requires the existing supported host');
 const directory=await mkdtemp(join(tmpdir(),'mote-img08-three-roles-')),models=join(directory,'models'),runtime=join(directory,'data','media-runtime');
 const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
 const identity=JSON.parse(execFileSync(python,[fileURLToPath(new URL('../../test_mote_asr_contract.py',import.meta.url)),'--emit'],{encoding:'utf8'})).request.identity;
 const previous=Object.fromEntries(roles.map(role=>[role,MEDIA_CATALOG[role]])),bytes=Buffer.from('Generated IMG08 lifecycle model boundary'),calls:{role:string;kind:string;args:string[]}[]=[],downloads:string[]=[];
 const worker=join(directory,'generated-roles.py');
 await writeFile(join(directory,'identity.json'),JSON.stringify(identity));
 await writeFile(join(directory,'image-model.json'),JSON.stringify({...LOCAL_IMAGE_MODEL,revision:'generated-img08-lifecycle',engine:'mlx',engineVersion:'generated-no-model-import',promptVersion:LOCAL_IMAGE_PROMPT_VERSION}));
 await writeFile(worker,`import json,os,sys,subprocess\nfrom pathlib import Path\nfrom http.server import ThreadingHTTPServer,BaseHTTPRequestHandler\nroot=Path(__file__).parent\nrole=os.environ['MOTE_GENERATED_ROLE']\n(root/(role+'.pid')).write_text(str(os.getpid()))\n(root/(role+'.environment.json')).write_text(json.dumps({name:os.environ.get(name) for name in ['HOME','OPENAI_API_KEY','MOTE_TOKEN','MOTE_CONFIG_FILE','PYTHONPATH','HF_TOKEN','AWS_SECRET_ACCESS_KEY','MOTE_MEDIA_WORKER_TOKEN']}))\nif role=='local-image':\n    code='import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('+repr(str(root/'local-image.child-pid'))+').write_text(str(os.getpid()));time.sleep(120)'\n    subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nclass Handler(BaseHTTPRequestHandler):\n    def log_message(self,*args): pass\n    def do_GET(self):\n        if self.path!='/health' or self.headers.get('Authorization')!='Bearer '+os.environ['MOTE_MEDIA_WORKER_TOKEN']:\n            self.send_response(401);self.end_headers();return\n        if role=='ocr': value={'version':1,'execution':'local','ocr':True}\n        elif role=='dialogue': value={'protocol':'mote.funasr/1','execution':'local','asr':True,'diarization':True,'identity':json.loads((root/'identity.json').read_text())}\n        else: value={'version':1,'execution':'local','localImage':True,'model':json.loads((root/'image-model.json').read_text())}\n        raw=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)\nThreadingHTTPServer(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])),Handler).serve_forever()\n`);
 const download=createServer((request,response)=>{downloads.push(request.url!);response.writeHead(200,{'content-length':bytes.length}).end(bytes);});
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 const oldKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='generated-must-not-inherit';
 t.after(async()=>{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;try{await node?.app.close();}finally{download.closeAllConnections();await new Promise<void>(resolve=>download.close(()=>resolve()));for(const role of roles)MEDIA_CATALOG[role]=previous[role];await rm(directory,{recursive:true,force:true});}});
 download.listen(0,'127.0.0.1');await once(download,'listening');const downloadUrl=`http://127.0.0.1:${(download.address() as {port:number}).port}`;
 const originalFetch=fetch;t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).startsWith('https://generated-img08-roles.invalid/')?originalFetch(downloadUrl+new URL(String(input)).pathname,init):originalFetch(input,init));
 const platform=nativeMediaPlatform(),bootstrapBytes=Buffer.from('Generated verified role installer');
 for(const role of roles){
  MEDIA_CATALOG[role]={version:'generated-img08-lifecycle-'+role,files:[{name:'component/model.bin',size:bytes.length,sha256:sha256(bytes),official:`https://generated-img08-roles.invalid/${role}/model.bin`}]};
  const bootstrap=join(runtime,role,'bootstrap',MEDIA_UV_VERSION,platform.target);await mkdir(bootstrap,{recursive:true});await writeFile(join(bootstrap,'uv'),bootstrapBytes);await writeFile(join(bootstrap,'receipt.json'),JSON.stringify({archiveSha256:platform.sha256,binarySha256:sha256(bootstrapBytes)}));
 }
 const reservations=await Promise.all(roles.map(async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');return server;})),ports=reservations.map(server=>(server.address() as {port:number}).port);
 await Promise.all(reservations.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));assert.equal(new Set(ports).size,3);
 const prepare:NonNullable<Parameters<typeof buildApp>[1]>['prepareMediaRuntime']=options=>prepareNativeMediaRuntime({...options,sourcePython:python,run:async(command,args)=>{
  calls.push({role:options.role,kind:args[0],args});options.signal?.throwIfAborted();
  if(args[0]==='venv'){
   const target=args.at(-1)!;await mkdir(join(target,'bin'),{recursive:true});await mkdir(join(target,'lib'));await writeFile(join(target,'lib/ffmpeg'),'generated ffmpeg');
   await writeFile(join(target,'bin/python'),`#!${python}\nimport os,sys,runpy\nos.environ['MOTE_GENERATED_ROLE']=${JSON.stringify(options.role)}\nsys.argv.pop(1)\nrunpy.run_path(${JSON.stringify(worker)},run_name='__main__')\n`,{mode:0o700});
  }
  if(args[0]==='-c')return Buffer.from(JSON.stringify({python:'3.11.generated',ffmpeg:join(command.replace(/\/bin\/python$/,''),'lib/ffmpeg')}));
  return Buffer.alloc(0);
 }});
 const media={modelDirectory:models,python:'python3',workerToken:'generated-img08-roles-worker',ocrPort:ports[0],asrPort:ports[1],localImagePort:ports[2],ocrEndpoint:`http://127.0.0.1:${ports[0]}/ocr`,asrEndpoint:`http://127.0.0.1:${ports[1]}/transcribe`,localImageEndpoint:`http://127.0.0.1:${ports[2]}/v1/interpret`};
 const config:ConfigurationPlatformOptions={path:join(directory,'data','mote.yaml'),privateCredential:{token:'generated-img08-roles-owner',tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[],runtime:'native'},execution:{insightIntervalHours:0},models:{deployment:{model:'',baseUrl:'',apiKey:'',allowUnauthenticatedLocal:false},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},media}};
 const options={backgroundWorker:true,prepareMediaRuntime:prepare,createModelAgent:async()=>({configured:false,close:async()=>{},query:async()=>assert.fail('No configured model belongs to a lifecycle check')})};
 const boot=async()=>{node=await buildApp(config,options);await node.app.listen({host:'127.0.0.1',port:0});t.diagnostic('generated lifecycle: actual Central booted');};
 await boot();
 const api=async(method:string,path:string,body?:unknown)=>{const response=await fetch(`http://127.0.0.1:${(node!.app.server.address() as {port:number}).port}`+path,{method,headers:{authorization:'Bearer '+config.privateCredential!.token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.ok(response.status<400,JSON.stringify(value));return value;};
 const until=async(check:()=>Promise<boolean>,label:string)=>{let last='';for(;;){assert.equal(t.signal.aborted,false,label);if(await check()){t.diagnostic('generated lifecycle reached: '+label);return;}const state=JSON.stringify(await api('GET','/api/media-preparation'));if(state!==last){t.diagnostic('generated lifecycle waiting '+label+': '+state);last=state;}await new Promise(resolve=>setTimeout(resolve,10));}};
 const ready=async(role:typeof roles[number])=>(await api('GET','/api/media-preparation'))[role].runtimeReady;
 const toggle=async(enabled:boolean)=>{const build=await api('GET','/api/plugin-builds/local-image');return api('PATCH','/api/plugin-builds/local-image',{expectedRevision:build.revision,operationId:randomUUID(),selection:enabled?localImageProcessingSelection:null});};
 const authority=node!.modelAuthorization.view(),selection=node!.modelSettings.view();
 await Promise.all(roles.map(role=>api('POST','/api/media-preparation/'+role,{})));
 await until(async()=>{const state=await api('GET','/api/media-preparation');return state.ocr.runtimeReady&&state.dialogue.runtimeReady&&state['local-image'].state==='prepared';},'all generated role preparations');
 assert.equal(await ready('local-image'),false);await toggle(true);await until(()=>ready('local-image'),'the selected image worker');
 await until(async()=>{try{return Number(await readFile(join(directory,'local-image.child-pid'),'utf8'))>0;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}},'the actual model descendant');
 const pids=Object.fromEntries(await Promise.all(roles.map(async role=>[role,Number(await readFile(join(directory,role+'.pid'),'utf8'))]))),child=Number(await readFile(join(directory,'local-image.child-pid'),'utf8'));
 const environments=Object.fromEntries(await Promise.all(roles.map(async role=>[role,JSON.parse(await readFile(join(directory,role+'.environment.json'),'utf8'))]))),markers=Object.fromEntries(await Promise.all(roles.map(async role=>[role,JSON.parse(await readFile(join(runtime,role,'current.json'),'utf8'))])));
 assert.equal(new Set(Object.values(pids)).size,3);assert.equal(new Set(Object.values(environments).map(value=>value.HOME)).size,3);
 for(const role of roles){assert.equal(Number(execFileSync('ps',['-p',String(pids[role]),'-o','pgid='],{encoding:'utf8'}).trim()),pids[role]);for(const name of ['OPENAI_API_KEY','MOTE_TOKEN','MOTE_CONFIG_FILE','PYTHONPATH','HF_TOKEN','AWS_SECRET_ACCESS_KEY'])assert.equal(environments[role][name],null,role+':'+name);assert.equal(environments[role].MOTE_MEDIA_WORKER_TOKEN,media.workerToken);assert.ok(environments[role].HOME.startsWith(join(runtime,role,'worker')));assert.equal(markers[role].role,role);}
 t.diagnostic('generated lifecycle: stopping the image plugin');await toggle(false);t.diagnostic('generated lifecycle: image plugin stopped');assert.equal(gone(pids['local-image']),true);assert.equal(gone(child),true);
 for(const role of ['ocr','dialogue'] as const){assert.equal(gone(pids[role]),false);assert.equal(await ready(role),true);}
 assert.deepEqual(node!.modelAuthorization.view(),authority);assert.deepEqual(node!.modelSettings.view(),selection);
 const before={pip:calls.filter(call=>call.kind==='pip').length,downloads:downloads.length};assert.equal(before.pip,3);assert.equal(before.downloads,3);
 t.diagnostic('generated lifecycle: closing the first Central');await node!.app.close();t.diagnostic('generated lifecycle: first Central closed');for(const pid of Object.values(pids))assert.equal(gone(pid),true);
 await boot();await until(async()=>await ready('ocr')&&await ready('dialogue'),'only prepared OCR and ASR resume');assert.equal(await ready('local-image'),false);
 assert.deepEqual({pip:calls.filter(call=>call.kind==='pip').length,downloads:downloads.length},before,'restart reuses the three existing role receipts');
 const resumedPids=Object.fromEntries(await Promise.all((['ocr','dialogue'] as const).map(async role=>[role,Number(await readFile(join(directory,role+'.pid'),'utf8'))])));for(const role of ['ocr','dialogue'] as const)assert.notEqual(resumedPids[role],pids[role]);
 await node!.app.close();for(const pid of Object.values(resumedPids))assert.equal(gone(pid),true);for(const port of ports)await assert.rejects(fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)}));
 t.diagnostic(JSON.stringify({stage:'generated-img08-default-three-roles',ports,pids,resumedPids,modelChildPid:child,environments,markers,counts:before,allOwnedProcessesReaped:true,allPortsReleased:true,recognitionBoundary:'generated; no real model import or quality claim'}));
});
