import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';

const caption='I felt proud of completing the generated prototype.';
const transcript='I verified that an idempotency key prevents duplicate prototype writes.';
const bodyRecipe={id:'fixture.record-index',version:'1'};
const extractedPersonal={id:'fixture.transcript-personal',version:'1'};
const extractedCoding={id:'fixture.transcript-coding',version:'1'};
const wave=Buffer.alloc(32044);wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(32000,40);

async function fixture(t:import('node:test').TestContext,remote=false){
  const directory=mkdtempSync(join(tmpdir(),'mote-artifact-recipes-'));
  const config:Config={dataDir:directory,token:'generated-artifact-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  if(remote)Object.assign(config,{modelBaseUrl:'https://generated.invalid',apiKey:'fixture',allowUnauthenticatedLocal:false});
  let node:Awaited<ReturnType<typeof buildApp>>,asrCalls=0;
  const calls:QueryInput[]=[],control:{failASR:boolean;failCoding:boolean;transcript:string;segments?:string[];review?:(input:QueryInput)=>Promise<void>}={failASR:false,failCoding:false,transcript};
  const start=async()=>{
    node=await buildApp(config,{backgroundWorker:false,
      transcriptionProvider:{transcribe:async input=>{for await(const _ of input.body){}asrCalls++;if(control.failASR)throw Error('Generated ASR failure');const texts=control.segments??[control.transcript];return {durationMs:1000,segments:texts.map((text,i)=>({startMs:Math.floor(i*1000/texts.length),endMs:Math.floor((i+1)*1000/texts.length),text}))};}},
      createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
        calls.push(input);
        // Exercise the actual model-facing reader, not only MemoryStore reads.
        const visible=await reader.evidence({ids:input.evidenceIds!});assert.equal(visible.length,input.evidenceIds!.length,'named ready inputs reach the model-facing reader');
        for(const pin of input.processingMaterialInputs??[]){
          const all=node.materials.evidenceIds(pin.materialId),bounded=await reader.evidence({ids:all});
          assert.deepEqual(bounded.map(r=>r.id).sort(),pin.evidenceIds.filter(id=>input.evidenceIds!.includes(id)).sort(),'other outputs are outside this bounded read');
        }
        const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
        const recipe=node.memoryPipeline.get(input.traceContext!.jobId!).batches.find(b=>b.id===input.traceContext!.batchId)!.strategy!.recipe.id;
        const index=recipe===bodyRecipe.id;
        const common={uncertainty:'Generated example only.',admission:{layer:index?'observation':'memory',reason:'Generated supported experience',scope:'Generated prototype',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]};
        const candidates=[{...common,domain:'personal',title:'Generated experience',statement:`Recorded a prototype experience [${id}]`},{...common,domain:'coding',title:'Generated retry experience',statement:`Verified idempotent prototype writes [${id}]`,coding:{kind:'decision',scope:'session',applicability:'Generated prototype',validation:'tested'}}];
        let memories=candidates;
        if(input.traceContext?.phase==='review'){
          await control.review?.(input);
          const coding=recipe===extractedCoding.id;
          if(coding&&control.failCoding)throw Error('Generated review failure');
          memories=[candidates[coding?1:0]];
        }
        return {answer:JSON.stringify({memories}),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()};
      }})});
    const extract={id:'mote.context-extraction',version:'3.4.0'};
    node.memoryStrategies.registerReview({id:'fixture.record-review',version:'1',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'Generated index policy: keep only an observation supported by the supplied record.'});
    for(const [recipe,requires,review] of [[bodyRecipe,['source-record'],{id:'fixture.record-review',version:'1'}],[extractedPersonal,['extracted-text'],{id:'mote.personal-review',version:'2'}],[extractedCoding,['extracted-text'],{id:'mote.coding-review',version:'1'}]] as const)
      node.memoryStrategies.registerRecipe({...recipe,extract,review,requires});
    await node.app.ready();
  };
  await start();
  const settings=node.processing.view();node.processing.update({revision:settings.revision,settings:{...settings.settings,enabled:true,audioProcessor:'audio.http',endpoint:'http://127.0.0.1:1234/transcribe',summarize:false}});
  const selected=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers:{authorization:'Bearer '+config.token},payload:{recipes:[bodyRecipe,extractedPersonal,extractedCoding]}});assert.equal(selected.statusCode,200,selected.body);
  const upload=async(mime='audio/wav',sourceId='generated-audio')=>{
    node.sources.register({id:sourceId,name:'Generated '+sourceId,kind:mime==='audio/wav'?'local-files':'upload',deviceId:'fixture',platform:'import',retention:'archive'});
    const bytes=mime==='audio/wav'?wave:Buffer.from(transcript),item={externalId:'sample',revision:'1',observedAt:'2026-05-07T07:00:00Z',kind:'file',layer:'original',title:'Generated file',text:'',mimeType:mime,document:{contentRole:'authored',recordedAt:'2026-05-07T07:00:00Z'}};
    const begun=node.files.begin({sourceId,item,sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});node.files.part(begun.uploadId,0,bytes,()=>{});
    return {id:(await node.files.commit(begun.uploadId,()=>{})).id,materialId:materialId(sourceId,'sample')};
  };
  const organize=async()=>{for(let i=0;i<10;i++)if(await node.materialOrganizer.tick(100)===0)return;throw Error('Organizer did not drain');};
  const queue=async()=>{const p=node.memoryPipeline;node.sourcePipelines.drainMemory({create:i=>p.create(i),get:id=>p.get(id),cancel:id=>p.cancel(id),run:async()=>{}},true,100);await new Promise(resolve=>setImmediate(resolve));};
  const run=async()=>{await queue();await Promise.all(node.memoryPipeline.list().filter(j=>['queued','running'].includes(j.status)).map(j=>node.memoryPipeline.run(j.id)));};
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  return {get node(){return node;},control,calls,upload,organize,queue,run,request:(payload:Record<string,unknown>)=>node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+config.token},payload}),count:(phase:string)=>calls.filter(c=>c.traceContext?.phase===phase).length,asrCalls:()=>asrCalls,async restart(){await node.app.close();await start();}};
}

test('ready record index survives failed media, restart and recovery; two waiting recipes share one extraction',async t=>{
  const f=await fixture(t),file=await f.upload();await f.organize();await f.queue();
  let jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,1);assert.equal(jobs[0].recipes![0].id,bodyRecipe.id);
  const bodyJob=jobs[0],before=f.node.materials.input(file.materialId,['source-record'])!;
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.control.review=async()=>{enter();await held;};const running=f.node.memoryPipeline.run(bodyJob.id);await entered;
  try{
    f.control.failASR=true;await f.node.processing.tick();assert.equal(f.node.files.detail(file.id).job.state,'failed');await f.organize();
    const after=f.node.materials.input(file.materialId,['source-record'])!;assert.equal(after.fingerprint,before.fingerprint);assert.deepEqual(after.evidenceIds,before.evidenceIds);
    assert.equal(f.node.materialMemoryWork.authorized(bodyJob),true);assert.equal(f.node.memoryPipeline.get(bodyJob.id).status,'running');
  }finally{release();}
  assert.equal((await running).status,'completed');f.control.review=undefined;
  const saved=f.node.memoryPipeline.get(bodyJob.id).memoryIds[0];f.node.memories.publish(saved);const product=f.node.memories.get(saved);
  await f.restart();f.control.failASR=false;f.node.processing.retry(file.id);await f.node.processing.tick();await f.organize();
  assert.equal(f.asrCalls(),2);assert.equal(f.node.files.detail(file.id).job.state,'succeeded');
  f.control.failCoding=true;await f.run();jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,3);
  const failed=jobs.find(j=>j.recipes![0].id===extractedCoding.id)!;assert.equal(failed.status,'failed');
  assert.equal(jobs.find(j=>j.recipes![0].id===extractedPersonal.id)!.status,'completed');assert.deepEqual(f.node.memories.get(saved),product);
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  const artifacts=f.node.files.detail(file.id).artifacts.map((a:{id:string})=>a.id);
  await f.restart();f.control.failCoding=false;assert.equal((await f.node.memoryPipeline.retry(failed.id)).status,'completed');
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),4);assert.equal(f.asrCalls(),2);assert.deepEqual(f.node.files.detail(file.id).artifacts.map((a:{id:string})=>a.id),artifacts);
  assert.deepEqual(f.node.memories.get(saved),product);
  f.control.transcript='A corrected generated account of testing a different retry mechanism.';f.node.processing.retry(file.id);await f.node.processing.tick();
  assert.deepEqual(f.node.memories.get(saved),product,'retired transcript dependencies do not invalidate the source record');
  await f.organize();await f.run();assert.equal(f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id)).length,3,'explicit ASR retry does not authorize historical Memory replay');
  assert.deepEqual(f.node.memories.get(saved),product);assert.equal(f.count('extract'),2);
  for(const job of f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id)).filter(j=>j.id!==bodyJob.id))for(const id of job.memoryIds)assert.equal(f.node.memories.get(id).status,'stale');
  f.node.store.delete(file.id);assert.equal(f.node.memories.list({includeStale:true}).length,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
});

test('the same named-output recipes reuse a different source and deterministic text processor',async t=>{
  const f=await fixture(t),file=await f.upload('text/plain','generated-text');await f.organize();await f.run();assert.equal(f.count('extract'),1);
  await f.node.processing.tick();await f.organize();await f.run();assert.equal(f.asrCalls(),0);
  const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,3);assert.ok(jobs.every(j=>j.status==='completed'));
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  const extracted=f.node.materials.input(file.materialId,['extracted-text'])!;assert.equal(extracted.ready,true);assert.equal(f.node.memories.readEvidence(extracted.evidenceIds)[0].ocrText,transcript);
  await f.restart();await f.organize();await f.run();assert.equal(f.calls.length,5);assert.equal(f.asrCalls(),0);
});

test('authored body and record-index recipes share generation despite different names for the same blocks',async t=>{
  const f=await fixture(t),personal={id:'fixture.authored-memory',version:'1'};
  f.node.memoryStrategies.registerRecipe({...personal,requires:['source-body'],extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'}});
  f.node.memoryRecipeSettings.configure({recipes:[personal,bodyRecipe]});
  f.node.sources.register({id:'generated-authored',name:'Generated authored source',kind:'custom',deviceId:'fixture',platform:'import'});
  await f.node.sources.upsert('generated-authored',{externalId:'note',revision:'1',observedAt:'2026-05-07T07:00:00Z',kind:'message',layer:'original',text:caption,document:{contentRole:'authored'}});
  await f.organize();await f.run();
  const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.status==='completed'));
  assert.equal(f.count('extract'),1);assert.equal(f.count('review'),2);
  const products=jobs.flatMap(j=>j.memoryIds.map(id=>f.node.memories.get(id)));
  assert.equal(products.filter(m=>m.admission?.layer==='memory').length,1);assert.equal(products.filter(m=>m.admission?.layer==='observation').length,1);
  assert.equal(new Set(products.map(m=>m.reviewReceipt!.draftRunId)).size,1);
});

test('changing a required transcript fences its in-flight result while unrelated record input remains valid',async t=>{
  const f=await fixture(t),file=await f.upload();await f.node.processing.tick();await f.organize();await f.queue();
  const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id)),index=jobs.find(j=>j.recipes![0].id===bodyRecipe.id)!,target=jobs.find(j=>j.recipes![0].id===extractedPersonal.id)!;
  assert.equal((await f.node.memoryPipeline.run(index.id)).status,'completed');const saved=f.node.memoryPipeline.get(index.id).memoryIds[0],record=f.node.memories.get(saved);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.control.review=async input=>{if(input.traceContext!.jobId===target.id){enter();await held;}};
  const running=f.node.memoryPipeline.run(target.id);await entered;
  try{
    f.control.transcript='A revised generated transcript with a different outcome.';f.node.processing.retry(file.id);await f.node.processing.tick();await f.organize();await f.queue();
    assert.deepEqual(f.node.memories.get(saved),record);assert.equal(f.node.materialMemoryWork.authorized(target),false);
  }finally{release();}
  const done=await running;assert.notEqual(done.status,'completed');assert.equal(done.memoryIds.length,0);
  assert.deepEqual(f.node.memories.get(saved),record);assert.equal(f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id)).length,3);
});

test('named ready outputs cannot bypass local-only policy at creation or late result commit',async t=>{
  const f=await fixture(t,true),file=await f.upload();await f.organize();
  const ids=f.node.materials.input(file.materialId,['source-record'])!.evidenceIds;
  f.node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(file.id);
  assert.throws(()=>f.node.memoryPipeline.create({evidenceIds:ids,recipes:[bodyRecipe]}),/not allowed|not ready/);assert.equal(f.calls.length,0);
  f.node.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(file.id);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.control.review=async()=>{enter();await held;};
  const job=f.node.memoryPipeline.create({evidenceIds:ids,recipes:[bodyRecipe]}),running=f.node.memoryPipeline.run(job.id);await entered;
  f.node.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(file.id);release();
  const result=await running;assert.notEqual(result.status,'completed');assert.equal(result.memoryIds.length,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('manual range selection honors named inputs and never drops a requested recipe to start a job',async t=>{
  const f=await fixture(t),file=await f.upload();await f.organize();
  const scope={deviceId:'fixture',contextTime:'2026-05-07T08:00:00Z'};
  for(const recipes of [undefined,[extractedPersonal],[bodyRecipe,extractedPersonal]]){
    const response=await f.request({...scope,...(recipes?{recipes}:{})});assert.equal(response.statusCode,409,response.body);
  }
  assert.equal(f.node.memoryPipeline.list().length,0);assert.equal(f.calls.length,0);
  const index=await f.request({...scope,recipes:[bodyRecipe]});assert.equal(index.statusCode,202,index.body);
  assert.equal((await f.node.memoryPipeline.run(index.json().id)).status,'completed');
  assert.deepEqual(f.node.memoryPipeline.get(index.json().id).evidenceIds,f.node.materials.input(file.materialId,['source-record'])!.evidenceIds);
  f.control.failASR=true;await f.node.processing.tick();await f.organize();
  const failed=await f.request({...scope,recipes:[extractedPersonal]});assert.equal(failed.statusCode,409,failed.body);
  assert.equal(f.node.memoryPipeline.list().length,1);
  f.control.failASR=false;f.node.processing.retry(file.id);await f.node.processing.tick();await f.organize();
  const ready=await f.request({...scope,recipes:[extractedPersonal,extractedCoding]});assert.equal(ready.statusCode,202,ready.body);
  const result=await f.node.memoryPipeline.run(ready.json().id);assert.equal(result.status,'completed');assert.equal(result.memoryIds.length,2);
  assert.deepEqual(result.evidenceIds,f.node.materials.input(file.materialId,['extracted-text'])!.evidenceIds);
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);assert.equal(f.asrCalls(),2);
});

test('a multi-batch consumer cannot read other batches through its shared material input pin',async t=>{
  const f=await fixture(t);f.node.memoryRecipeSettings.configure({recipes:[extractedPersonal]});
  f.control.segments=Array.from({length:21},(_,i)=>`Generated prototype verification in segment ${i}.`);
  await f.upload();await f.node.processing.tick();await f.organize();await f.run();
  const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,1);
  assert.equal(jobs[0].status,'completed');assert.equal(jobs[0].totalBatches,2);assert.equal(jobs[0].materialInputs![0].evidenceIds.length,21);
  assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>call.evidenceIds!.length<21));
  assert.equal(f.asrCalls(),1);
});
