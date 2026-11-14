import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {createServer,request as httpRequest,type Server} from 'node:http';
import {transcriptSchema,fileEvidenceSchema,ProviderFailure} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {configFromDocument} from '../src/config.js';
import {MEDIA_CATALOG,mediaModelIdentities} from '../src/media-assets.js';
import {materialId} from '../src/materials.js';
import {sha256} from '../src/store.js';
import {processorSettingsFingerprint} from '../src/file-configuration.js';
import {effectiveFileSettings,selectFilePolicy} from '../src/file-policy.js';
import {mediaModelHealth} from '../src/media-configuration.js';
import {FUNASR_PINS,parseFunasrArchive,parseFunasrRequest,type FunasrRequest} from '../src/funasr-contract.js';
import {runFunasr} from '../src/funasr-client.js';
import type {ProcessorInput} from '../src/file-processors.js';
import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

type Central=Awaited<ReturnType<typeof buildApp>>;
const scripts=fileURLToPath(new URL('../../../scripts/',import.meta.url));
const driver=fileURLToPath(new URL('./fixtures/funasr-journey.py',import.meta.url));
const sourceId='generated-asr07',ownerToken='generated-asr07-owner',workerToken='generated-asr07-private-worker-token';
const headers={authorization:'Bearer '+ownerToken};
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await pause();}
 throw Error('Generated journey did not reach '+label);
}

/** No replacement recipes, processors, Store, routes or output publishers.
 * Only model assets/inference and the later language-model response are
 * generated. The production Python worker owns HTTP, child processes, FFmpeg
 * and execution facts. Central uses its actual startup and default registry.
 * Some tests explicitly disable cleanup through the owner API to isolate the
 * remaining path; the default-on assembly gate below must pass independently.
 */
async function fixture(t:TestContext,options:{cleanup?:boolean;authorize?:boolean;healthTransform?:(health:any)=>void}={}){
 const directory=mkdtempSync(join(tmpdir(),'mote-asr07-')),runtime=join(directory,'worker');
 const generated=JSON.parse(execFileSync('python3',[driver,'--prepare',runtime],{encoding:'utf8',timeout:30000}));
 const prior=MEDIA_CATALOG.dialogue;MEDIA_CATALOG.dialogue=generated.catalog;
 let node:Central|undefined,child:ChildProcess|undefined,stderr='',stopped:Promise<void>|undefined,healthProxy:Server|undefined;
 const modelCalls:{model:string;question:string}[]=[];
 const stop=()=>stopped??=(async()=>{
  if(!child||child.exitCode!==null)return;
  const owned=child;
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{owned.kill('SIGKILL');reject(Error('Owned generated worker did not terminate'));},10000);
   owned.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Owned worker exit '+code+': '+stderr));});
   owned.kill('SIGTERM');
  });
 })();
 t.after(async()=>{try{await node?.app.close();}finally{try{
  if(healthProxy)await new Promise<void>(resolve=>{healthProxy!.close(()=>resolve());healthProxy!.closeAllConnections();});
  await stop();
 }finally{MEDIA_CATALOG.dialogue=prior;rmSync(directory,{recursive:true,force:true});}}});
 assert.deepEqual(mediaModelIdentities('dialogue'),generated.models,'the generated asset producer is consumed by the real catalog identity code');
 child=spawn('python3',[join(runtime,'transcription-server.py'),'--model-root',join(directory,'models/dialogue'),
  '--backend','cpu','--threads','1','--timeout','20','--load-timeout','10','--port','0','--temporary-root',runtime],{
  env:{PATH:process.env.PATH,HOME:runtime,TMPDIR:runtime,PYTHONNOUSERSITE:'1',MOTE_MEDIA_WORKER_TOKEN:workerToken},stdio:['ignore','pipe','pipe'],
 });
 child.stderr!.on('data',part=>{stderr+=part;});
 const lines=createInterface({input:child.stdout!});
 const port=await new Promise<number>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Generated worker listener timed out: '+stderr)),10000);
  lines.once('line',line=>{clearTimeout(timer);try{resolve(JSON.parse(line).port);}catch(error){reject(error);}});
  child!.once('error',reject);child!.once('exit',()=>{clearTimeout(timer);reject(Error('Worker exited before listening: '+stderr));});
 });
 lines.close();
 let centralPort=port;
 if(options.healthTransform){
  // Only negative cases alter health in transit. Successful journeys consume
  // the production response directly, including every identity field.
  healthProxy=createServer((request,response)=>{
   const forwarded=httpRequest({hostname:'127.0.0.1',port,path:request.url,method:request.method,headers:request.headers},upstream=>{
    if(request.url==='/health'){
     const parts:Buffer[]=[];upstream.on('data',part=>parts.push(part));upstream.on('end',()=>{
      const health=JSON.parse(Buffer.concat(parts).toString());
      options.healthTransform!(health);
      response.writeHead(upstream.statusCode!,{'content-type':'application/json','x-mote-execution':'local'});response.end(JSON.stringify(health));
     });
    }else{response.writeHead(upstream.statusCode!,upstream.headers);upstream.pipe(response);}
   });
   forwarded.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});
   response.on('close',()=>{if(!response.writableFinished)forwarded.destroy();});request.pipe(forwarded);
  });
  await new Promise<void>(resolve=>healthProxy!.listen(0,'127.0.0.1',resolve));centralPort=(healthProxy.address() as {port:number}).port;
 }
 const config=configFromDocument({version:1,revision:0,storage:{dataDir:join(directory,'data')},
  media:{modelDirectory:join(directory,'models'),asrEndpoint:`http://127.0.0.1:${centralPort}/transcribe`,asrPort:centralPort,workerToken}},
  join(directory,'mote.yaml'),{token:ownerToken,tokenPath:join(directory,'owner-token')});
 config.diagnosticsEnabled=false;config.logLevel='silent';
 const start=async()=>{
  node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
   modelCalls.push({model:settings.model,question:input.question});
   assert.equal(settings.model,'generated-selected-ask','intake does not replace the selected Ask model');
   assert.ok(input.anchorMaterialRef);assert.ok(reader.materialRead);assert.ok(reader.fileChunks);
   const page=await reader.materialRead({ref:input.anchorMaterialRef,length:12000});
   assert.ok(page.text.includes('完整尾段保留。'));
   const chunks=await reader.fileChunks({id:node!.materials.members(input.anchorMaterialRef,{limit:100}).items[0].ref.replace('capture:',''),offset:0});
   const tail=chunks.find(row=>row.ocrText.includes('完整尾段保留。'));assert.ok(tail);
   fileEvidenceSchema.parse(tail.fileEvidence);
   return {answer:'Generated answer grounded in the saved tail.',runId:randomUUID(),trace:[],
    citations:[{id:tail.id,capturedAt:tail.capturedAt,appName:tail.appName,excerpt:tail.ocrText}],
    evidenceDependencies:{version:1,complete:true,ids:[tail.id]}};
  }})});
  return node;
 };
 await start();
 const policy=structuredClone(node!.processing.view().policy);
 for(const service of policy.services)if(service.id==='asr-local')service.apiKey=workerToken;
 const applied=selectFilePolicy(policy,sourceId,'audio/wav',node!.processing.view().revision);
 const settings=effectiveFileSettings(applied,policy,node!.processing.currentSettings(),node!.processing.runtime.registry);
 const fingerprint=processorSettingsFingerprint(node!.processing.runtime.registry.get('audio.local-dialogue'),settings,applied.profile.parameters);
 await node!.featureServices.mediaAssets.importBundle('dialogue',join(runtime,'bundle'));
 const health=await until(async()=>{const response=await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:'Bearer '+workerToken}});const health=await response.json() as any;return health.asr&&health;},'real worker four-component health');
 const models=node!.modelSettings.view();
 await node!.modelSettings.updateDefaults({revision:models.revision,defaults:models.defaults,defaultModels:{file:'generated-selected-file',memory:'generated-selected-memory',chat:'generated-selected-ask'}});
 const request=async(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:any)=>{
  const response=await node!.app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
  assert.equal(response.statusCode,200,response.body);return response;
 };
 const saveCleanup=async(enabled:boolean)=>{
  const view=node!.processing.view(),policy=structuredClone(view.policy);
  policy.profiles.find(profile=>profile.processorId==='audio.local-dialogue')!.parameters.deduplicate=enabled;
  await request('PUT','/api/file-processing',{revision:view.revision,settings:view.settings,policy});
 };
 if(options.cleanup===false)await saveCleanup(false);
 if(options.authorize!==false)await authorizeFixtureModels(node!);
 node!.sources.register({id:sourceId,name:'Generated journey',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const audio=readFileSync(join(runtime,'generated.wav'));
 const calls=():FunasrRequest[]=>existsSync(join(runtime,'calls.jsonl'))?readFileSync(join(runtime,'calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(parseFunasrRequest):[];
 let serial=0;
 const upload=async()=>{
  const first=await request('POST','/api/file-sync/v1/uploads',{sourceId,sizeBytes:audio.length,sha256:sha256(audio),item:{externalId:`generated-${++serial}.wav`,revision:'1',observedAt:'2026-11-14T00:00:00Z',title:'Generated journey.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav'}});
  const session=first.json();if(session.ack)return String(session.ack.id);
  const part=await node!.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${session.uploadId}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:audio});assert.equal(part.statusCode,200,part.body);
  return String((await request('POST',`/api/file-sync/v1/uploads/${session.uploadId}/commit`,{})).json().id);
 };
 const settle=async(id:string)=>{
  await until(async()=>{await node!.processing.tick();const job=node!.files.detail(id).job;return (!['running','waiting'].includes(job.state)||job.state==='waiting'&&job.error)&&job;},'file receipt');
 };
 const flag=(name:string,value=true)=>value?writeFileSync(join(runtime,name),'generated'):rmSync(join(runtime,name),{force:true});
 return {get node(){return node!;},directory,runtime,audio,generated,health,fingerprint,settings,modelCalls,calls,request,saveCleanup,upload,settle,flag,
  async restart(){await node!.app.close();await start();},
  hold(operation:'recognize'|'diarize'){flag('entered-'+operation,false);flag('hold-'+operation);return {entered:()=>until(()=>existsSync(join(runtime,'entered-'+operation)),operation),release:()=>flag('hold-'+operation,false)};},
  detail:async(id:string)=>(await request('GET','/api/files/'+id)).json(),
  chunks:async(id:string)=>(await request('GET','/api/files/'+id+'/chunks')).json().items as any[],
  artifact:(id:string)=>node!.processing.artifact(id),
 };
}

function tar(bytes:Buffer){
 const raw=gunzipSync(bytes),entries=new Map<string,Buffer>();
 for(let offset=0;offset+512<=raw.length;){const name=raw.subarray(offset,offset+100).toString().replace(/\0.*$/s,'');if(!name)break;
  const size=parseInt(raw.subarray(offset+124,offset+136).toString().replace(/\0.*$/s,'').trim(),8);entries.set(name,raw.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;}
 return entries;
}

test('the installer and actual engine export the same four pinned model identities',()=>{
 const manifest=JSON.parse(execFileSync('python3',[join(scripts,'mote_funasr.py'),'--manifest'],{encoding:'utf8',timeout:30000}));
 const engine=Object.fromEntries(Object.entries(manifest).map(([role,value])=>{const model=value as any;return [role,{id:model.id,revision:model.revision,manifestSha256:model.manifestSha256}];}));
 assert.deepEqual(mediaModelIdentities('dialogue'),engine,'CORE-01 / ASR-01 must agree on actual bytes and manifest digest before any clean install can infer');
});

test('the unmodified production worker health is accepted by Central recognition without a test projection',async t=>{
 const f=await fixture(t,{cleanup:false});
 assert.equal(mediaModelHealth('dialogue',JSON.parse(JSON.stringify(f.health))).ready,true);
 const id=await f.upload();await f.settle(id);const detail=await f.detail(id);
 assert.ok(detail.artifacts.some((artifact:any)=>artifact.kind==='transcript'),
  'ASR-02 health must be accepted by the actual ASR-03 client: '+JSON.stringify(detail.job));
 assert.equal(detail.job.state,'succeeded',JSON.stringify(detail.job));
 assert.notEqual(f.health.identity.settingsFingerprint,f.fingerprint,'loaded inference settings are independent of host connection settings');
 assert.deepEqual(f.calls().map(call=>call.operation),['recognize','diarize']);
 for(const call of f.calls())assert.deepEqual(call.identity,f.health.identity,'both requests retain the complete loaded worker identity');
 const raw=detail.artifacts.find((artifact:any)=>artifact.kind==='transcript');
 assert.deepEqual(parseFunasrArchive(f.artifact(raw.id).output.payload.checkpoint).identity,f.health.identity);
});

function clientInput(f:Awaited<ReturnType<typeof fixture>>,overrides:Partial<ProcessorInput>={}):ProcessorInput{
 return {file:{id:'generated-client',title:'Generated.wav',mimeType:'audio/wav',sizeBytes:f.audio.length,sha256:sha256(f.audio)},
  settings:f.settings,settingsFingerprint:f.fingerprint,maxAudioMs:4000,signal:new AbortController().signal,
  readOriginal:async function*(){yield f.audio;},...overrides};
}

function unstartedIdentityRejection(error:unknown){
 assert.ok(error instanceof ProviderFailure);
 // Admission rejects over HTTP 400. The real local transport retains the
 // explicit unstarted fact and HTTP diagnostics, rather than parsing its body.
 assert.deepEqual(error.details,{category:'permanent',code:'provider_request_invalid',executionStarted:false});
 assert.deepEqual(error.diagnostic,{source:'http',httpStatus:400});
 return true;
}

test('invalid complete health identities cannot read original audio or start recognition',async t=>{
 let alter=(health:any)=>{};
 const f=await fixture(t,{cleanup:false,healthTransform:health=>alter(health)});
 let reads=0;
 const input=clientInput(f,{readOriginal:async function*(){reads++;yield f.audio;}});
 const mutations:Record<string,(h:any)=>void>={
  'extra identity field':h=>h.identity.unrecognized='generated',
  'missing loaded field':h=>delete h.identity.dependencies,
  'missing inference fingerprint':h=>delete h.identity.settingsFingerprint,
  'malformed inference fingerprint':h=>h.identity.settingsFingerprint='generated',
  'old SDK':h=>h.identity.sdkVersion='1.4.24',
  'wrong SDK wheel':h=>h.identity.sdkWheelSha256='0'.repeat(64),
  ...Object.fromEntries(Object.keys(FUNASR_PINS).map(pin=>['old '+pin,(h:any)=>h.identity[pin].version='0'])),
  'wrong model id':h=>h.identity.models.asr.id='generated/other',
  'wrong immutable model revision':h=>h.identity.models.vad.revision='0'.repeat(40),
  'wrong model manifest hash':h=>h.identity.models.speaker.manifestSha256='0'.repeat(64),
  'extra model field':h=>h.identity.models.punctuation.extra=true,
  'invalid backend':h=>h.identity.backend='generated',
  'invalid thread count':h=>h.identity.threads=0,
  'unready recognizer':h=>h.asr=false,
  'remote execution':h=>h.execution='remote',
  'old protocol':h=>h.protocol='mote.funasr/0',
 };
 for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{
  alter=mutate;await assert.rejects(runFunasr(input,'recognize'));
  assert.equal(reads,0,'rejected health must not expose original bytes');assert.deepEqual(f.calls(),[]);
 });
 alter=()=>{};
 const response=await runFunasr(input,'recognize');
 assert.equal(reads,1);assert.deepEqual(parseFunasrArchive(response.checkpoint).identity,f.health.identity);
});

test('the worker rejects changed inference settings, dependencies and execution settings before model entry',async t=>{
 let alter=(health:any)=>{};
 const f=await fixture(t,{cleanup:false,healthTransform:health=>alter(health)});
 const mutations:Record<string,(h:any)=>void>={
  settings:h=>h.identity.settingsFingerprint=sha256('different generated inference settings'),
  dependencies:h=>h.identity.dependencies.torch='9.0.0',
  backend:h=>h.identity.backend='mps',threads:h=>h.identity.threads=2,
 };
 for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{
  alter=mutate;
  await assert.rejects(runFunasr(clientInput(f),'recognize'),unstartedIdentityRejection);
  assert.deepEqual(f.calls(),[],'health/request disagreement cannot enter the engine');
 });
 alter=()=>{};
 const response=await runFunasr(clientInput(f),'recognize'),saved=JSON.stringify(response.checkpoint);
 for(const [name,mutate] of Object.entries(mutations))await t.test('persisted checkpoint '+name,async()=>{
  const cp=parseFunasrArchive(response.checkpoint);mutate({identity:cp.identity});
  const json=JSON.stringify(cp),recognition={json,sha256:sha256(json)};
  await assert.rejects(runFunasr(clientInput(f,{recognition}),'diarize'),unstartedIdentityRejection);
  assert.deepEqual(f.calls().map(call=>call.operation),['recognize'],'invalid retry cannot run CAM or rerun ASR');
  assert.equal(JSON.stringify(response.checkpoint),saved,'historical checkpoint bytes stay intact');
 });
});

test('owner denial before health or during health prevents original audio from reaching the worker',async t=>{
 let healthReads=0,authorized=true;
 const f=await fixture(t,{cleanup:false,healthTransform:()=>{healthReads++;authorized=false;}});
 let reads=0;
 const denied=Error('Generated owner denial'),input=clientInput(f,{
  authorizeModel:()=>{if(!authorized)throw denied;},readOriginal:async function*(){reads++;yield f.audio;},
 });
 authorized=false;const before=healthReads;
 await assert.rejects(runFunasr(input,'recognize'),denied);assert.equal(healthReads,before);
 authorized=true;
 await assert.rejects(runFunasr(input,'recognize'),denied);assert.equal(healthReads,before+1);
 assert.equal(reads,0);assert.deepEqual(f.calls(),[]);
 const response=await runFunasr(clientInput(f),'recognize'),saved=JSON.stringify(response.checkpoint);
 await assert.rejects(runFunasr({...input,recognition:response.checkpoint},'diarize'),denied);
 assert.equal(reads,0);assert.deepEqual(f.calls().map(call=>call.operation),['recognize']);
 assert.equal(JSON.stringify(response.checkpoint),saved,'denied retry leaves the persisted input intact');
});

test('default-on cleanup is wired by actual Central startup and completes a generated upload',async t=>{
 const f=await fixture(t),id=await f.upload();await f.settle(id);const detail=await f.detail(id);
 assert.equal(f.node.processing.view().policy.profiles.find(profile=>profile.processorId==='audio.local-dialogue')!.parameters.deduplicate,true);
 assert.equal(detail.job.state,'succeeded',JSON.stringify({job:detail.job,steps:detail.steps}));
 const current=f.artifact((await f.chunks(id))[0].fileEvidence.artifactId);
 assert.equal(current.output.type.id,'mote.cleaned-dialogue');assert.equal(current.transcript.uncorrected,true);
 assert.deepEqual(current.output.payload.cleanup.sourceToDerived,[0,0,1,2,3,4]);
});

test('explicit cleanup-off upload preserves raw bytes before CAM, complete tail, playback, review, export, Material, Memory and Ask evidence',async t=>{
 const f=await fixture(t,{cleanup:false}),held=f.hold('diarize'),id=await f.upload(),running=f.node.processing.tick();
 t.after(held.release);
 await held.entered();
 const before=await f.detail(id),raw=before.artifacts.find((a:any)=>a.kind==='transcript');assert.ok(raw);
 const saved=JSON.stringify(f.artifact(raw.id)),checkpoint=f.artifact(raw.id).output.payload.checkpoint;
 assert.deepEqual((f.calls().at(-1) as any).checkpoint,checkpoint,'real multipart carries exactly the committed checkpoint');
 held.release();await running;await f.settle(id);
 assert.equal((await f.detail(id)).job.state,'succeeded');assert.deepEqual(f.calls().map(r=>r.operation),['recognize','diarize']);
 let chunks=await f.chunks(id);assert.equal(chunks.length,6);assert.equal(new Set(chunks.map(row=>row.id)).size,6);
 assert.deepEqual(chunks.map(row=>[row.fileEvidence.startMs,row.fileEvidence.endMs]),f.generated.rows.map((row:any[])=>row.slice(0,2)));
 assert.equal(chunks[2].fileEvidence.speaker,'SPEAKER_UNKNOWN');assert.equal(chunks[2].fileEvidence.uncertain,true);
 const cp=parseFunasrArchive(checkpoint);assert.equal(cp.source.durationMs,4000);assert.ok(cp.text.startsWith('  '));assert.ok(cp.text.endsWith('\n  '));
 assert.ok(cp.sentences.every(row=>!Object.hasOwn(row,'words')));assert.equal(cp.sentences.at(-1)!.endMs,4000);
 assert.ok(chunks.every(row=>!row.fileEvidence.speakerAttribution));
 const current=chunks[0].fileEvidence.artifactId;
 await f.request('POST',`/api/files/${id}/speakers`,{artifactId:current,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
 const selected=chunks[3];
 await f.request('POST',`/api/files/${id}/corrections`,{artifactId:current,chunkId:selected.id,originalText:'使用扣迪士记录。',correctedText:'使用扣迪斯记录。'});
 chunks=await f.chunks(id);assert.equal(chunks.at(-1)!.fileEvidence.speakerAttribution.name,'Generated 乙');
 assert.equal(JSON.stringify(f.artifact(raw.id)),saved,'manual correction never rewrites recognition');
 const playback=await f.request('POST',`/api/files/${id}/playback`,{}),cookie=String(playback.headers['set-cookie']).split(';')[0];
 const content=await f.node.app.inject({url:playback.json().url,headers:{cookie,range:'bytes=44-363'}});assert.equal(content.statusCode,206);assert.deepEqual(content.rawPayload,f.audio.subarray(44,364));
 const diarization=(await f.detail(id)).artifacts.find((a:any)=>a.kind==='diarization');assert.equal(diarization.engine,'CAM++ / FunASR 1.4.25');assert.equal(diarization.estimate,undefined);
 const sample=diarization.samples[0];assert.ok(sample);
 const clip=await f.request('GET',`/api/files/${id}/assets?artifactId=${diarization.id}&name=${encodeURIComponent('speaker_samples/'+sample.speaker+'.wav')}`);assert.equal(clip.rawPayload.toString('ascii',0,4),'RIFF');
 const entries=tar((await f.request('GET',`/api/files/${id}/export`)).rawPayload),manifest=JSON.parse(entries.get('manifest.json')!.toString());
 assert.equal(manifest.selectedTranscript.kind,'corrected-dialogue');assert.equal(JSON.parse(entries.get(`artifacts/${raw.id}.json`)!.toString()).data.output.payload.checkpoint.json,checkpoint.json);
 await until(async()=>{await f.node.materialOrganizer.tick(100);return f.node.materials.get(materialId(sourceId,'generated-1.wav'));},'actual default Material publication');
 const material=f.node.materials.get(materialId(sourceId,'generated-1.wav'))!;assert.ok(f.node.materials.read(material.ref).text.includes('使用扣迪斯记录。'));
 const tail=chunks.at(-1)!,result={answer:JSON.stringify({memories:[{title:'Generated tail',statement:'A generated recording retains its tail.',uncertainty:'Fixture only',evidenceIds:[tail.id]}]}),citations:[{id:tail.id,capturedAt:tail.capturedAt,appName:tail.appName,excerpt:tail.ocrText}],trace:[],runId:randomUUID()};
 const memory=f.node.memories.extract(fixtureMemoryResult(f.node.memories,result),'generated-selected-memory').items[0];f.node.memories.publish(memory.id);
 assert.equal(f.node.memories.get(memory.id).evidence![0].fileEvidence!.endMs,4000);
 const queryId=randomUUID(),accepted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:queryId,input:{question:'What supports the final recorded point?',anchorMaterialRef:material.ref}}});assert.equal(accepted.statusCode,202,accepted.body);
 const asked=await until(async()=>{const view=(await f.request('GET','/api/query-runs/'+queryId)).json();return view.status!=='running'&&view;},'Ask publication');
 assert.equal(asked.status,'completed',JSON.stringify(asked));assert.equal(f.modelCalls.at(-1)!.model,'generated-selected-ask');
 const cited=f.node.conversations.get(asked.conversationId).turns[0].result!.citations[0];assert.equal(cited.id,tail.id);
 const evidence=(await f.request('GET','/api/captures/'+cited.id)).json();assert.equal(evidence.fileEvidence.captureId,id);assert.equal(evidence.fileEvidence.endMs,4000);
 if(process.env.MOTE_ASR07_EXAMPLE_PATH){
  const path=resolve(process.env.MOTE_ASR07_EXAMPLE_PATH),workspace=fileURLToPath(new URL('../../../',import.meta.url));assert.ok(!path.startsWith(workspace.endsWith(sep)?workspace:workspace+sep));
  const example={kind:'generated-model-boundary',limits:{healthProjection:false,cleanup:false,realModels:false},pins:FUNASR_PINS,
   health:f.health,requests:f.calls(),raw:f.artifact(raw.id),diarization:f.artifact(diarization.id),selected:f.artifact(chunks[0].fileEvidence.artifactId),
   tail:evidence.fileEvidence,memoryEvidence:f.node.memories.get(memory.id).evidence,queryCitation:cited,exportSelection:manifest.selectedTranscript};
  const json=JSON.stringify(example,null,2)+'\n';for(const privateValue of [ownerToken,workerToken,f.directory])assert.ok(!json.includes(privateValue));writeFileSync(path,json);
 }
 const original=f.node.modelSettings.view();assert.equal(f.node.modelSettings.select('file').settings.model,'generated-selected-file');assert.equal(f.node.modelSettings.select('memory').settings.model,'generated-selected-memory');
 await f.restart();assert.deepEqual(f.node.modelSettings.view(),original);assert.equal(JSON.stringify(f.artifact(raw.id)),saved);assert.equal(f.calls().filter(r=>r.operation==='recognize').length,1);
 t.diagnostic(JSON.stringify({kind:'generated-model-boundary',checkpointSha256:checkpoint.sha256,tail:evidence.fileEvidence,selectedTranscript:manifest.selectedTranscript,workerOperations:f.calls().map(r=>r.operation)}));
});

test('a real worker CAM failure retains recognition and restart plus scoped range retry never invokes ASR again',async t=>{
 const f=await fixture(t,{cleanup:false});f.flag('fail-diarize');const id=await f.upload();await f.settle(id);
 const detail=await f.detail(id),raw=detail.artifacts.find((a:any)=>a.kind==='transcript');assert.ok(raw);assert.equal(detail.job.state,'failed');assert.equal((await f.chunks(id)).length,6);
 const saved=JSON.stringify(f.artifact(raw.id));await f.restart();f.flag('fail-diarize',false);f.flag('flip');
 await f.request('POST',`/api/files/${id}/retry`,{stage:'diarize',diarization:{artifactId:raw.id,options:{processor:'audio.diarize',speakerCount:null,range:{min:2,max:4}}}});await f.settle(id);
 assert.equal((await f.detail(id)).job.state,'succeeded');assert.deepEqual(f.calls().map(r=>r.operation),['recognize','diarize','diarize']);assert.equal(JSON.stringify(f.artifact(raw.id)),saved);
 assert.deepEqual((f.calls().at(-1) as any).speakers,{mode:'range',min:2,max:4});assert.equal((await f.chunks(id))[0].fileEvidence.speaker,'SPEAKER_1');
});

test('HTTP correction, rename and CAM-only rerun invalidate the affected Memory and withdraw old speaker confirmations',async t=>{
 const f=await fixture(t,{cleanup:false}),id=await f.upload();await f.settle(id);
 const raw=(await f.detail(id)).artifacts.find((artifact:any)=>artifact.kind==='transcript'),original=JSON.stringify(f.artifact(raw.id));
 let chunks=await f.chunks(id),artifactId=chunks[0].fileEvidence.artifactId;
 await f.request('POST',`/api/files/${id}/speakers`,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 乙'}});
 chunks=await f.chunks(id);
 const remember=(chunk:any,label:string)=>{
  const result={answer:JSON.stringify({memories:[{title:label,statement:label+' observed in generated speech.',uncertainty:'Fixture only',evidenceIds:[chunk.id]}]}),
   citations:[{id:chunk.id,capturedAt:chunk.capturedAt,appName:chunk.appName,excerpt:chunk.ocrText}],trace:[],runId:randomUUID()};
  const memory=f.node.memories.extract(fixtureMemoryResult(f.node.memories,result),'generated-selected-memory').items[0];f.node.memories.publish(memory.id);return memory;
 };
 const edited=chunks[3],tail=chunks.at(-1)!,changed=remember(edited,'Generated correction target'),kept=remember(tail,'Generated unchanged tail');
 await f.request('POST',`/api/files/${id}/corrections`,{artifactId,chunkId:edited.id,originalText:'使用扣迪士记录。',correctedText:'使用扣迪斯记录。'});
 assert.equal(f.node.memories.get(changed.id).status,'stale');assert.equal(f.node.memories.get(kept.id).status,'published');
 chunks=await f.chunks(id);assert.equal(chunks.at(-1)!.id,tail.id);assert.notEqual(chunks[3].id,edited.id);artifactId=chunks[0].fileEvidence.artifactId;
 const afterCorrection=remember(chunks[3],'Generated corrected memory');
 await f.request('POST',`/api/files/${id}/speakers`,{artifactId,names:{SPEAKER_0:'Generated 甲',SPEAKER_1:'Generated 丙'}});
 assert.equal(f.node.memories.get(kept.id).status,'stale');assert.equal(f.node.memories.get(afterCorrection.id).status,'published');
 assert.equal((await f.chunks(id)).at(-1)!.fileEvidence.speakerAttribution.name,'Generated 丙');
 f.flag('flip');await f.request('POST',`/api/files/${id}/retry`,{stage:'diarize',diarization:{artifactId:raw.id,options:{processor:'audio.diarize',speakerCount:2,range:null}}});await f.settle(id);
 assert.equal((await f.detail(id)).job.state,'succeeded');assert.equal(f.node.memories.get(afterCorrection.id).status,'stale');
 assert.ok((await f.chunks(id)).every(chunk=>!chunk.fileEvidence.speakerAttribution));
 assert.deepEqual(f.calls().map(request=>request.operation),['recognize','diarize','diarize']);assert.equal(JSON.stringify(f.artifact(raw.id)),original);
});

for(const action of ['cancel','delete'] as const)test(`real in-flight CAM ${action} cannot publish a late result or lose retained raw input`,async t=>{
 const f=await fixture(t,{cleanup:false}),held=f.hold('diarize'),id=await f.upload(),running=f.node.processing.tick();t.after(held.release);await held.entered();
 const raw=(await f.detail(id)).artifacts.find((a:any)=>a.kind==='transcript');assert.ok(raw);
 if(action==='cancel')await f.request('POST',`/api/files/${id}/cancel`,{});else await f.request('DELETE','/api/files/'+id);
 held.release();await running;
 if(action==='cancel'){assert.equal((await f.detail(id)).job.state,'cancelled');assert.ok(f.node.files.detail(id).hasOriginal);assert.equal(f.artifact(raw.id).transcript.segments.at(-1).endMs,4000);}
 else assert.equal((await f.node.app.inject({url:'/api/files/'+id,headers})).statusCode,404);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM file_artifacts WHERE capture_id=? AND kind='diarization'").get(id)!.n,0);
});

test('background authorization off prevents even a ready generated worker from receiving recognition',async t=>{
 const f=await fixture(t,{cleanup:false,authorize:false}),id=await f.upload();await f.node.processing.tick();
 assert.deepEqual(f.calls(),[]);assert.ok(f.node.files.detail(id).hasOriginal);assert.deepEqual((await f.detail(id)).artifacts,[]);
});

test('complete silence retains its full recording duration and publishes empty standard products',async t=>{
 const f=await fixture(t,{cleanup:false});f.flag('silence');const id=await f.upload();await f.settle(id);
 const detail=await f.detail(id);assert.equal(detail.job.state,'succeeded');assert.deepEqual(await f.chunks(id),[]);
 for(const artifact of detail.artifacts.filter((a:any)=>a.kind==='transcript'||a.kind==='dialogue')){const transcript=transcriptSchema.parse(f.artifact(artifact.id).transcript);assert.equal(transcript.durationMs,4000);assert.equal(transcript.coverage,'full');assert.deepEqual(transcript.segments,[]);}
});
