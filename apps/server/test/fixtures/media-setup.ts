import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../src/app.js';
import type {ConfigurationPlatformOptions} from '../../src/config.js';
import {MEDIA_CATALOG} from '../../src/media-assets.js';
import {LOCAL_IMAGE_MODEL,LOCAL_IMAGE_PROMPT_VERSION} from '../../src/local-image-contract.js';
import {prepareNativeMediaRuntime,mediaRoleSupported} from '../../src/media-native-runtime.mjs';

const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
/** Real Web/HTTP setup producer and consumer, with only unavailable package
 * installation/imports and inference replaced by a generated Python boundary.
 * MediaPreparation, native receipts, model download/verification, owned process,
 * health, persisted plugin selection and stop remain production code. */
export async function generatedLocalImageSetup(t:TestContext,runtime:'native'|'docker'='native',workerFixture?:{script:string;token:string},createModelAgent?:NonNullable<Parameters<typeof buildApp>[1]>['createModelAgent']){
 const directory=await mkdtemp(join(tmpdir(),'mote-generated-image-setup-')),prior=MEDIA_CATALOG['local-image'],bytes=Buffer.from('Generated optional image model bytes');
 const modelDirectory=join(directory,'models'),modelName='component/model.bin',digest=createHash('sha256').update(bytes).digest('hex');
 MEDIA_CATALOG['local-image']={version:'generated-image-setup',files:[{name:modelName,size:bytes.length,sha256:digest,official:'https://generated-image-setup.invalid/model'}],
  ...(workerFixture?{models:{image:{id:LOCAL_IMAGE_MODEL.id,repository:'generated-img08',revision:'generated-img08-boundary',license:'generated-fixture',directory:'.'}}}:{})};
 const download=createServer((_request,response)=>response.writeHead(200,{'content-length':bytes.length}).end(bytes));
 let node:Awaited<ReturnType<typeof buildApp>>|undefined;
 const holds:ReturnType<typeof gate>[]=[];
 t.after(async()=>{for(const hold of holds)hold.release();try{await node?.app.close();}finally{download.closeAllConnections();await new Promise<void>(resolve=>download.close(()=>resolve()));MEDIA_CATALOG['local-image']=prior;await rm(directory,{recursive:true,force:true});}});
 download.listen(0,'127.0.0.1');await once(download,'listening');
 const downloadEndpoint=`http://127.0.0.1:${(download.address() as {port:number}).port}`,originalFetch=fetch;
 t.mock.method(globalThis,'fetch',(input:Parameters<typeof fetch>[0],init?:RequestInit)=>String(input).startsWith('https://generated-image-setup.invalid/')?originalFetch(downloadEndpoint,init):originalFetch(input,init));
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim(),worker=workerFixture?.script??join(directory,'generated-vlm.py'),pidPath=join(directory,'worker.pid');
 const scripts=fileURLToPath(new URL('../../../../scripts/',import.meta.url));
 if(!workerFixture)await writeFile(worker,`import json,os,sys
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
sys.path.insert(0,${JSON.stringify(scripts)})
from mote_vlm import verify_assets
verify_assets(sys.argv[sys.argv.index('--model-root')+1],${JSON.stringify([[modelName,bytes.length,digest]])})
Path(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.headers.get('Authorization')!='Bearer '+os.environ['MOTE_MEDIA_WORKER_TOKEN']:
            self.send_response(401);self.end_headers();return
        payload={'version':1,'execution':'local','localImage':True,'model':${JSON.stringify({...LOCAL_IMAGE_MODEL,revision:'generated-image-revision',engine:'mlx',engineVersion:'generated-engine',promptVersion:LOCAL_IMAGE_PROMPT_VERSION})}}
        raw=json.dumps(payload).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
ThreadingHTTPServer(('127.0.0.1',int(sys.argv[sys.argv.index('--port')+1])),Handler).serve_forever()
`);
 const counts={prepare:0,pip:0,probe:0},entered=gate();let held:ReturnType<typeof gate>|undefined;
 // The bootstrap download is an external boundary too. Seed only its verified
 // executable receipt, never current.json or an installed environment/model.
 const {MEDIA_UV_VERSION,nativeMediaPlatform}=await import('../../src/media-native-runtime.mjs') as any,platform=nativeMediaPlatform(),bootstrap=join(modelDirectory,'runtime/local-image/bootstrap',MEDIA_UV_VERSION,platform.target),bootstrapBytes=Buffer.from('Generated package installer');
 await mkdir(bootstrap,{recursive:true});await writeFile(join(bootstrap,'uv'),bootstrapBytes);await writeFile(join(bootstrap,'receipt.json'),JSON.stringify({archiveSha256:platform.sha256,binarySha256:createHash('sha256').update(bootstrapBytes).digest('hex')}));
 const prepare:NonNullable<Parameters<typeof buildApp>[1]>['prepareMediaRuntime']=async options=>{
  counts.prepare++;
  return (prepareNativeMediaRuntime as any)({...options,run:async(command:string,args:string[],runtime:{signal?:AbortSignal})=>{
   runtime.signal?.throwIfAborted();
   if(args[0]==='venv'){
    const target=args.at(-1)!;await mkdir(join(target,'bin'),{recursive:true});
    await writeFile(join(target,'bin/python'),`#!${python}\nimport sys,runpy\nsys.argv.pop(1)\nrunpy.run_path(${JSON.stringify(worker)},run_name='__main__')\n`,{mode:0o700});
   }
   if(args[0]==='pip'){counts.pip++;entered.release();await held?.promise;runtime.signal?.throwIfAborted();}
   if(args[0]==='-c'){
    counts.probe++;assert.match(args[1],/import mlx.core,mlx_vlm,transformers,PIL/);
    // The unavailable dependency imports are controlled; do execute a small
    // Python producer for the native environment receipt consumed below.
    return execFileSync(python,['-c','import json;print(json.dumps({"python":"3.11.generated"}))'],{env:{PATH:dirname(python)}});
   }
   return Buffer.alloc(0);
  }});
 };
 const token='generated-image-setup-owner',workerToken=workerFixture?.token??'generated-image-setup-worker';
 const config:ConfigurationPlatformOptions={path:(join(directory,'data'))+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:join(directory,'data'),maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[],runtime:runtime},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'},media:{modelDirectory,python:'python3',workerToken,ocrPort:9010,asrPort:9009,ocrEndpoint:'http://127.0.0.1:9010/ocr',asrEndpoint:'http://127.0.0.1:9009/transcribe',localImagePort:port,localImageEndpoint:`http://127.0.0.1:${port}/v1/interpret`}}};
 node=await buildApp(config,{backgroundWorker:false,prepareMediaRuntime:prepare,...(createModelAgent?{createModelAgent}:{})});
 return {directory,bytes,counts,token,workerToken,config,pidPath,endpoint:config.initialDocument!.media!.localImageEndpoint!,supported:runtime==='native'&&mediaRoleSupported('local-image'),get node(){return node!;},installed:join(modelDirectory,'local-image',modelName),
  holdDependencies(){held=gate();holds.push(held);return {entered:entered.promise,release:held.release};},
  async restart(){await node!.app.close();node=await buildApp(config,{backgroundWorker:false,prepareMediaRuntime:prepare,...(createModelAgent?{createModelAgent}:{})});},
  async until(check:()=>boolean|Promise<boolean>,label:string){const deadline=Date.now()+10000;while(!await check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5));}},
  async request(path:string,init?:RequestInit){
   const response=await node!.app.inject({url:path,method:(init?.method??'GET') as 'GET'|'POST'|'PATCH',headers:{authorization:'Bearer '+token},...(init?.body?{payload:JSON.parse(String(init.body))}:{})});
   assert.ok(response.statusCode<400,response.body);return response.json();
  },
  async pid(){return Number(await readFile(pidPath,'utf8'));},
 };
}
