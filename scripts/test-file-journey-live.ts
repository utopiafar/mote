/** Opt-in local media journey. Inputs are only the files explicitly listed in a manifest. */
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,relative,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {FILE_PART_BYTES} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';

const {values}=parseArgs({options:{manifest:{type:'string'},output:{type:'string'},python:{type:'string'},'ocr-model-root':{type:'string'},'asr-model-root':{type:'string'},'processor-module':{type:'string'},'audio-processor':{type:'string'},'allow-generated-central-analysis':{type:'boolean',default:false}}});
const audioProcessor=values['audio-processor']??'audio.local-dialogue';
assert.ok(values.manifest&&values.output&&values.python,'Required: --manifest --output --python; plus model roots for the selected types');
const manifest=z.object({personalDataUsed:z.boolean(),files:z.array(z.object({id:z.string().regex(/^[a-z0-9-]+$/),path:z.string(),mimeType:z.string(),observedAt:z.string().datetime({offset:true}),expectedLines:z.array(z.string()).optional()})).min(1).max(10)}).parse(JSON.parse(await readFile(values.manifest,'utf8')));
const centralAnalysisAllowed=values['allow-generated-central-analysis'];
assert.ok(!centralAnalysisAllowed||!manifest.personalDataUsed,'Central-analysis control must use generated inputs');
assert.equal(new Set(manifest.files.map(file=>file.id)).size,manifest.files.length);
const directory=resolve(values.output),outside=relative(repositoryRoot,directory);
assert.ok(outside==='..'||outside.startsWith('../'),'Reports and originals must stay outside the repository');
let previous:any,priorSettings:any;
if(process.env.MOTE_FILE_JOURNEY_RESUME==='1'){
  previous=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
  assert.ok(previous.status==='failed'&&previous.personalDataUsed===manifest.personalDataUsed&&manifest.files.length===1,'Resume one failed file in its isolated vault');
  assert.equal(previous.files[0].id,manifest.files[0].id);assert.ok(previous.files[0].detail?.artifacts.some((a:{kind:string})=>a.kind==='transcript'),'Resume requires a saved transcript');
  priorSettings=JSON.parse(await readFile(join(directory,'vault','file-processing.json'),'utf8')).settings;
  assert.equal(priorSettings.audioProcessor,audioProcessor);
  await writeFile(join(directory,`report.previous-${randomUUID()}.json`),JSON.stringify(previous,null,2)+'\n',{mode:0o600,flag:'wx'});
}else await mkdir(directory,{mode:0o700});
const token=randomBytes(32).toString('hex'),workerToken=priorSettings?.localWorkerApiKey??randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:join(directory,'vault'),token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,
  maxStorageBytes:2_000_000_000,maxExportBytes:200_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',
  diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,
  ...(values['processor-module']?{fileProcessorModules:[resolve(values['processor-module'])]}:{})};
const report:Record<string,unknown>={startedAt:new Date().toISOString(),status:'running',personalDataUsed:manifest.personalDataUsed,
  browserTested:false,physicalDeviceTested:false,liveLlmUsed:false,localInference:true,semanticQualityVerified:false,centralAnalysisAllowed,
  runtime:{python:resolve(values.python),asrModelRoot:values['asr-model-root']?resolve(values['asr-model-root']):undefined,ocrModelRoot:values['ocr-model-root']?resolve(values['ocr-model-root']):undefined},
  ...(previous?{resumedFrom:previous.startedAt}:{}),files:[]};
const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const children:{child:ChildProcess;closed:Promise<unknown>}[]=[];
async function worker(script:string,args:string[],capability:'ocr'|'asr'){
  const resumePort=capability==='asr'&&priorSettings?Number(new URL(priorSettings.localEndpoint).port):0;
  const socket=createServer();await new Promise<void>((done,reject)=>{socket.once('error',reject);socket.listen(resumePort,'127.0.0.1',done);});
  const address=socket.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(done=>socket.close(()=>done()));
  const child=spawn(values.python!,[join(repositoryRoot,'scripts',script),...args,'--port',String(port)],{
    env:{PATH:process.env.PATH,HOME:directory,MOTE_MEDIA_WORKER_TOKEN:workerToken},stdio:'ignore'});
  let startupError:Error|undefined;child.on('error',error=>{startupError=error;});
  children.push({child,closed:new Promise(done=>child.once('close',done))});
  const endpoint=`http://127.0.0.1:${port}`,deadline=Date.now()+60000;
  for(;;){
    if(startupError)throw startupError;
    assert.ok(child.exitCode===null&&child.signalCode===null,'Local media worker exited');
    let health:{ocr?:boolean;asr?:boolean;diarization?:boolean}|undefined;
    try{const response=await fetch(endpoint+'/health',{headers:{authorization:'Bearer '+workerToken},signal:AbortSignal.timeout(10000)});if(response.ok)health=await response.json();}catch{}
    if(health?.[capability]&&(capability!=='asr'||health.diarization))return endpoint;
    assert.ok(Date.now()<deadline,'Local media model did not become ready');await new Promise(done=>setTimeout(done,250));
  }
}
async function request(method:'POST'|'PUT'|'GET',url:string,payload?:Record<string,unknown>|Buffer){
  const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})},...(payload?{payload}:{})});
  assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body.slice(0,1000)}`);return response;
}
try{
  await save();
  report.processorModule=values['processor-module']?{path:resolve(values['processor-module']),sha256:sha256(await readFile(resolve(values['processor-module'])))}:null;
  report.processingCodeHashes=Object.fromEntries(await Promise.all(['apps/server/src/file-processors.ts','apps/server/src/file-processing.ts','apps/server/src/file-policy.ts','apps/server/src/file-configuration.ts'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
  report.workerCodeHashes=Object.fromEntries(await Promise.all(['scripts/mote_audio.py','scripts/transcription-server.py','scripts/requirements-audio.txt','scripts/test-file-journey-live.ts'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
  const hasImage=manifest.files.some(file=>file.mimeType.startsWith('image/')),hasAudio=manifest.files.some(file=>file.mimeType.startsWith('audio/'));
  assert.ok(manifest.files.every(file=>file.mimeType.startsWith('image/')||file.mimeType.startsWith('audio/')),'Choose image/audio files');
  if(hasImage)assert.ok(values['ocr-model-root'],'OCR model root required');if(hasAudio)assert.ok(values['asr-model-root'],'ASR model root required');
  if(hasAudio){
    const names=new Set(await readdir(values['asr-model-root']!));
    report.audioModelFiles=await Promise.all(['config.json','preprocessor_config.json','model.bin','tokenizer.json','vocabulary.txt','vocabulary.json','segmentation.onnx','speaker.onnx'].filter(name=>names.has(name)).map(async name=>{
      const path=join(values['asr-model-root']!,name),before=await stat(path),hash=createHash('sha256');
      for await(const part of createReadStream(path))hash.update(part);const after=await stat(path);assert.equal(before.size,after.size);assert.equal(before.mtimeMs,after.mtimeMs);
      return {name,sizeBytes:after.size,sha256:hash.digest('hex')};
    }));await save();
  }
  const ocr=hasImage?await worker('ocr-server.py',['--model-root',values['ocr-model-root']!],'ocr'):undefined;
  const asr=hasAudio?await worker('transcription-server.py',['--model',values['asr-model-root']!,'--segmentation-model',join(values['asr-model-root']!,'segmentation.onnx'),'--speaker-model',join(values['asr-model-root']!,'speaker.onnx')],'asr'):undefined;
  node=await buildApp(config);const lifecycle=node.lifecycle.settings();
  for(const key of ['extraction','consolidation','insights','working'] as const)lifecycle[key].enabled=false;
  node.lifecycle.configure(lifecycle);await node.app.ready();
  if(hasAudio){const selected=node.processing.runtime.registry.get(audioProcessor);assert.ok(selected.localOnly&&selected.dialogue&&(centralAnalysisAllowed?selected.contentPolicy!=='local-only':selected.contentPolicy==='local-only'&&selected.allowSummary===false),'Select an offline dialogue processor matching the explicit disclosure mode');report.audioProcessor=node.processing.runtime.registry.list().find(processor=>processor.id===audioProcessor);}
  const view=(await request('GET','/api/file-processing')).json();
  if(priorSettings)assert.equal(asr+'/transcribe',priorSettings.localEndpoint,'Keep worker identity to reuse the saved extraction');
  else await request('PUT','/api/file-processing',{revision:view.revision,settings:{...view.settings,
    enabled:true,summarize:false,semanticTurns:false,timeoutMs:600000,
    ...(ocr?{imageProcessor:'image.http',imageEndpoint:ocr+'/ocr',apiKey:workerToken}:{}),
    ...(asr?{audioProcessor,localEndpoint:asr+'/transcribe',localWorkerApiKey:workerToken}:{}),
  }});
  for(const file of manifest.files){
    const result:Record<string,unknown>={id:file.id,mimeType:file.mimeType,observedAt:file.observedAt,status:'running'};
    (report.files as unknown[]).push(result);await save();const started=Date.now();
    try{
      const bytes=await readFile(resolve(file.path));result.sizeBytes=bytes.length;result.sha256=sha256(bytes);
      const sourceId='media-'+file.id;
      let ack:any,priorTranscriptId:string|undefined;
      if(previous){
        assert.equal(previous.files[0].sha256,sha256(bytes),'Resume original changed');
        ack={id:previous.files[0].captureId};result.captureId=ack.id;
        const before=(await request('GET','/api/files/'+ack.id)).json();priorTranscriptId=before.artifacts.find((a:{kind:string})=>a.kind==='transcript')?.id;assert.ok(priorTranscriptId);
        await request('POST',`/api/files/${ack.id}/retry`,{stage:'diarize'});result.resumedStage='diarize';result.originalUploadReused=true;
      }else{
      await request('POST','/api/sources',{id:sourceId,name:'Local media validation',kind:'local-files',deviceId:sourceId,platform:'import',retention:'archive'});
      const upload=(await request('POST','/api/file-sync/v1/uploads',{sourceId,sizeBytes:bytes.length,sha256:sha256(bytes),item:{externalId:file.id,revision:'1',observedAt:file.observedAt,title:file.id,kind:'file',layer:'original',text:'',mimeType:file.mimeType,deleted:false}})).json();
      for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)await request('PUT',`/api/file-sync/v1/uploads/${upload.uploadId}/parts/${part}`,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES));
      ack=(await request('POST',`/api/file-sync/v1/uploads/${upload.uploadId}/commit`,{})).json();result.captureId=ack.id;assert.equal(ack.receipt.state,'received');
      }
      result.receivedMs=Date.now()-started;await save();console.log(JSON.stringify({stage:previous?'resume-diarization':'received',id:file.id,bytes:bytes.length}));
      await node.processing.tick();
      const detail=(await request('GET','/api/files/'+ack.id)).json();result.detail=detail;await save();assert.equal(detail.job.state,'succeeded',JSON.stringify(detail.job));
      if(priorTranscriptId){assert.equal(detail.artifacts.find((a:{kind:string})=>a.kind==='transcript')?.id,priorTranscriptId,'Retry repeated extraction');result.transcriptArtifactReused=priorTranscriptId;}
      const chunks:unknown[]=[];
      for(let offset=0;;){const page=(await request('GET',`/api/files/${ack.id}/chunks?offset=${offset}`)).json();chunks.push(...page.items);if(page.nextOffset===null)break;offset=page.nextOffset;}
      result.chunks=chunks;assert.ok(chunks.length,'Processed media has no readable evidence');
      const rawArtifact=detail.artifacts.find((a:{kind:string})=>a.kind==='transcript'),dialogue=detail.artifacts.find((a:{kind:string})=>a.kind==='dialogue');
      if(rawArtifact&&dialogue){
        const text=(artifactId:string)=>node!.store.db.prepare('SELECT text FROM file_chunks WHERE artifact_id=? ORDER BY start_ms,rowid').all(artifactId).map(row=>String(row.text)).join('');
        const rawText=text(rawArtifact.id),alignedText=text(dialogue.id);
        assert.equal(rawText.replace(/\s/gu,''),alignedText.replace(/\s/gu,''),'Alignment changed recognized non-whitespace characters');
        result.alignmentIntegrity={rawCharacters:rawText.length,alignedCharacters:alignedText.length,sameNonWhitespace:true,acousticAccuracyVerified:false};
      }
      const original=await request('GET','/api/files/'+ack.id+'/content');assert.equal(sha256(original.rawPayload),sha256(bytes),'Original changed during processing');
      if(file.expectedLines)assert.deepEqual(chunks.map(chunk=>(chunk as {ocrText:string}).ocrText),file.expectedLines,'Every generated line must be readable through the file evidence API');
      result.status='passed';
    }catch(error){result.status='failed';result.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
    finally{result.durationMs=Date.now()-started;await save();console.log(JSON.stringify({stage:'processed',id:file.id,status:result.status,durationMs:result.durationMs}));}
  }
  report.modelUsage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200).total;
  assert.equal((report.modelUsage as {runs:number}).runs,0,'Acoustic processing unexpectedly invoked an LLM');
  report.status=(report.files as {status:string}[]).every(file=>file.status==='passed')?'passed':'failed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  report.finishedAt=new Date().toISOString();await save();await node?.app.close();
  for(const {child,closed} of children){child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),5000);await closed;clearTimeout(force);}
  console.log(JSON.stringify({status:report.status,report:join(directory,'report.json')}));
}
