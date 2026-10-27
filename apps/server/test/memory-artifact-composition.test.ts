import {authorizeFixtureModels,withFixtureOwnerModelWork,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {fixtureMemoryPlan,fixtureMemoryWorkResult} from './fixtures/memory-planning.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseAnswer,type QueryInput} from '@mote/agent';
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
  const boundaryChecks:{phase:string|undefined;targetCount:number;seedCount:number;siblingSeeded:boolean;ungrantedIds:string[]}[]=[];
  const calls:QueryInput[]=[],control:{failASR:boolean;failCoding:boolean;transcript:string;segments?:string[];probeReadBoundaries?:boolean;review?:(input:QueryInput)=>Promise<void>}={failASR:false,failCoding:false,transcript};
  const start=async()=>{
    node=await buildApp(config,{backgroundWorker:false,
      transcriptionProvider:{transcribe:async input=>{for await(const _ of input.body){}asrCalls++;if(control.failASR)throw Error('Generated ASR failure');const texts=control.segments??[control.transcript];return {durationMs:1000,segments:texts.map((text,i)=>({startMs:Math.floor(i*1000/texts.length),endMs:Math.floor((i+1)*1000/texts.length),text}))};}},
      createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
        const plan=await fixtureMemoryPlan(input);if(plan)return plan;
        const topic=fixtureTopicResult(input);if(topic)return topic;calls.push(input);
        // The reader can serve explicitly authorized context originals. The
        // model-facing bridge separately restricts ordinary evidence to seeds.
        const visible=await reader.evidence({ids:input.evidenceIds!});assert.equal(visible.length,input.evidenceIds!.length,'named ready inputs reach the model-facing reader');
        const readable=new Set([...(input.evidenceIds??[]),...(input.evidenceReadRanges??[]).map(range=>range.id)]);
        for(const pin of input.processingMaterialInputs??[]){
          const all=node.materials.evidenceIds(pin.materialId),bounded=await reader.evidence({ids:all});
          assert.deepEqual(bounded.map(r=>r.id).sort(),pin.evidenceIds.filter(id=>readable.has(id)).sort(),'unselected outputs remain outside target and context authority');
        }
        const bridge=control.probeReadBoundaries?await (await import('../../../packages/agent/dist/bridge.js')).startBridge(reader,input,24):undefined;
        try{
        if(bridge){
          const members=(input.taskContext!.memoryWork as {members:{id:string}[]}).members,targets=new Set(members.map(member=>member.id)),seeds=new Set(input.evidenceIds!);
          const sibling=input.evidenceReadRanges!.find(range=>!targets.has(range.id));assert.ok(sibling,'the selected original catalog contains another batch target');
          const ungrantedIds=[...new Set((input.processingMaterialInputs??[]).flatMap(pin=>node.materials.evidenceIds(pin.materialId)).filter(id=>!readable.has(id)))];
          assert.ok(ungrantedIds.length,'source-record metadata is not selected by the transcript recipe');
          assert.deepEqual(await reader.evidence({ids:ungrantedIds}),[],'the internal reader must also deny unselected material outputs');
          const tool=async(name:string,args:Record<string,unknown>)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});return {status:response.status,body:await response.json()};};
          const ordinary=await tool('evidence',{ids:input.evidenceIds});assert.equal(ordinary.status,200);
          assert.deepEqual(ordinary.body.data.map((record:{id:string})=>record.id).sort(),[...seeds].sort());
          const siblingSeeded=seeds.has(sibling.id),before=await tool('evidence',{ids:[sibling.id]});
          assert.equal(before.status,siblingSeeded?200:400,'ordinary evidence can only reread this phase\'s actual seeds');
          if(!siblingSeeded){assert.equal(before.body.toolError.code,'evidence_scope_denied');assert.equal(bridge.records.has(sibling.id),false);assert.throws(()=>parseAnswer(JSON.stringify({answer:`Unread sibling [${sibling.id}]`,citationIds:[sibling.id]}),bridge.records),/not retrieved/);}
          const context=await tool('context_evidence',{id:sibling.id,offset:sibling.offset,length:sibling.length});assert.equal(context.status,200,JSON.stringify(context.body));
          const original=node.memories.readEvidence([sibling.id])[0];assert.equal(context.body.data[0].ocrText,original.ocrText.slice(sibling.offset,sibling.offset+sibling.length));
          assert.doesNotThrow(()=>parseAnswer(JSON.stringify({answer:`Read selected sibling [${sibling.id}]`,citationIds:[sibling.id]}),bridge.records));
          assert.equal((await tool('evidence',{ids:[sibling.id]})).status,siblingSeeded?200:400,'a context read does not widen the ordinary evidence tool');
          assert.equal((await tool('context_evidence',{id:ungrantedIds[0],offset:0,length:1})).status,400);
          assert.equal((await tool('evidence',{ids:[ungrantedIds[0]]})).status,400);
          assert.equal(bridge.records.has(ungrantedIds[0]),false,'rejected outputs gain no quote authority');
          boundaryChecks.push({phase:input.traceContext?.phase,targetCount:targets.size,seedCount:seeds.size,siblingSeeded,ungrantedIds});
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
        const result=fixtureMemoryWorkResult(input,{answer:JSON.stringify({memories}),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()});
        return {...result,...(bridge?{trace:bridge.trace,evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies}:{})};
        }finally{await bridge?.close();}
      }})});
    const extract={id:'mote.context-extraction',version:'3.4.0'};
    node.memoryStrategies.registerReview({id:'fixture.record-review',version:'1',input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'Generated index policy: keep only an observation supported by the supplied record.'});
    for(const [recipe,requires,review] of [[bodyRecipe,['source-record'],{id:'fixture.record-review',version:'1'}],[extractedPersonal,['extracted-text'],{id:'mote.personal-review',version:'2'}],[extractedCoding,['extracted-text'],{id:'mote.coding-review',version:'2'}]] as const)
      node.memoryStrategies.registerRecipe({...recipe,extract,review,requires});
    await node.app.ready();
  };
  await start();
  const settings=node.processing.view();await node.processing.save({revision:settings.revision,settings:{...settings.settings,enabled:true,audioProcessor:'audio.http',endpoint:'http://127.0.0.1:1234/transcribe',summarize:false},policy:fixtureFilePolicy({...settings.settings,enabled:true,audioProcessor:'audio.http',endpoint:'http://127.0.0.1:1234/transcribe',summarize:false},node.processing.runtime.registry)});
  const selected=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers:{authorization:'Bearer '+config.token},payload:{recipes:[bodyRecipe,extractedPersonal,extractedCoding]}});assert.equal(selected.statusCode,200,selected.body);
  await authorizeFixtureModels(node);
  const upload=async(mime='audio/wav',sourceId='generated-audio')=>{
    node.sources.register({id:sourceId,name:'Generated '+sourceId,kind:mime==='audio/wav'?'local-files':'upload',deviceId:'fixture',platform:'import',retention:'archive'});
    const bytes=mime==='audio/wav'?wave:Buffer.from(transcript),item={externalId:'sample',revision:'1',observedAt:'2026-05-07T07:00:00Z',kind:'file',layer:'original',title:'Generated file',text:'',mimeType:mime,document:{contentRole:'authored',recordedAt:'2026-05-07T07:00:00Z'}};
    const begun=node.files.begin({sourceId,item,sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});node.files.part(begun.uploadId,0,bytes,()=>{});
    return {id:(await node.files.commit(begun.uploadId,()=>{})).id,materialId:materialId(sourceId,'sample')};
  };
  const organize=async()=>{for(let i=0;i<10;i++)if(await node.materialOrganizer.tick(100)===0)return;throw Error('Organizer did not drain');};
  const queue=async()=>{const p=node.memoryPipeline;await node.sourcePipelines.drainMemory({create:i=>p.create(i),get:id=>p.get(id),cancel:id=>p.cancel(id),run:async()=>{}},true,100);await new Promise(resolve=>setImmediate(resolve));};
  const run=async()=>{await queue();await Promise.all(node.memoryPipeline.list().filter(j=>['queued','running'].includes(j.status)).map(j=>node.memoryPipeline.run(j.id)));};
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  return {get node(){return node;},control,calls,boundaryChecks,upload,organize,queue,run,request:(payload:Record<string,unknown>)=>node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+config.token},payload}),count:(phase:string)=>calls.filter(c=>c.traceContext?.phase===phase).length,asrCalls:()=>asrCalls,async restart(){await node.app.close();await start();}};
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
  await f.restart();assert.equal(f.node.processing.cancellation(file.id).wait,'unknown');assert.throws(()=>f.node.processing.retry(file.id),{statusCode:409});f.control.failASR=false;await withFixtureOwnerModelWork(f.node,async()=>f.node.processing.retry(file.id,'transcribe',false,true),{identities:['capture:'+file.id]});await f.node.processing.tick();await f.organize();
  assert.equal(f.asrCalls(),2);assert.equal(f.node.files.detail(file.id).job.state,'succeeded');
  f.control.failCoding=true;await f.run();jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,3);
  const failed=jobs.find(j=>j.recipes![0].id===extractedCoding.id)!;assert.equal(failed.status,'failed');
  assert.equal(jobs.find(j=>j.recipes![0].id===extractedPersonal.id)!.status,'completed');assert.deepEqual(f.node.memories.get(saved),product);
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),3);
  const artifacts=f.node.files.detail(file.id).artifacts.map((a:{id:string})=>a.id);
  await f.restart();f.control.failCoding=false;assert.equal((await withFixtureOwnerModelWork(f.node,()=>f.node.memoryPipeline.retry(failed.id))).status,'completed');
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),4);assert.equal(f.asrCalls(),2);assert.deepEqual(f.node.files.detail(file.id).artifacts.map((a:{id:string})=>a.id),artifacts);
  assert.deepEqual(f.node.memories.get(saved),product);
  f.control.transcript='A corrected generated account of testing a different retry mechanism.';await withFixtureOwnerModelWork(f.node,async()=>f.node.processing.retry(file.id),{identities:['capture:'+file.id]});await f.node.processing.tick();
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

for(const revoke of [false,true])test(`dialogue intermediate transcript preserves the unused Memory receipt${revoke?' until recipe withdrawal':''}`,async t=>{
  const f=await fixture(t);
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
  f.node.processing.runtime.registry.register({id:'fixture.held-diarizer',name:'Generated held diarizer',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(){
    enter();await held;
    return {durationMs:1000,engine:'generated',expectedSpeakers:1,observedSpeakers:1,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'}],samples:[]};
  }});
  const settings={...f.node.processing.view().settings,localEndpoint:'http://127.0.0.1:1234/transcribe',audioProcessor:'audio.local-dialogue',diarizationProcessor:'fixture.held-diarizer',speakerCount:1};
  await f.node.processing.save({revision:f.node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.node.processing.runtime.registry)});
  await authorizeFixtureModels(f.node);
  const file=await f.upload();await f.organize();await f.queue();
  const processing=f.node.processing.tick();
  await Promise.race([entered,processing.then(()=>{throw Error('Generated pipeline ended before diarization: '+JSON.stringify(f.node.files.detail(file.id).job));})]);
  try{
    await f.organize();
    assert.equal(f.node.files.detail(file.id).job.state,'running');
    assert.ok(f.node.files.detail(file.id).artifacts.some((artifact:{kind:string})=>artifact.kind==='transcript'),'the real extractor has committed its complete raw transcript');
    const intermediate=f.node.materials.input(file.materialId,['extracted-text'])!;
    assert.equal(intermediate.ready,false,'raw ASR is provisional while the selected dialogue recipe can replace its chunks');
    await f.queue();
    assert.equal(f.node.memoryPipeline.list().length,1,'only the independent source-record recipe may claim a job');
    assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,1);
    if(revoke)f.node.memoryRecipeSettings.configure({recipes:[bodyRecipe]});
  }finally{release();await processing;}
  await f.organize();
  const final=f.node.materials.input(file.materialId,['extracted-text'])!;
  assert.equal(final.ready,true);
  await f.run();
  const jobs=f.node.memoryPipeline.list().map(job=>f.node.memoryPipeline.get(job.id));
  assert.equal(jobs.length,revoke?1:3);assert.ok(jobs.every(job=>job.status==='completed'));
  assert.equal(f.asrCalls(),1);
  for(const job of jobs.filter(job=>job.recipes![0].id!==bodyRecipe.id)){
    assert.equal(job.workPackage!.inputs[0].fingerprint,final.fingerprint);
    assert.deepEqual(job.automaticGrants?.map(grant=>grant.inputKey),[file.id]);
  }
  const count=f.calls.length;await f.organize();await f.run();assert.equal(f.calls.length,count,'republication cannot renew a consumed or withdrawn receipt');
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
    f.control.transcript='A revised generated transcript with a different outcome.';await withFixtureOwnerModelWork(f.node,async()=>f.node.processing.retry(file.id),{identities:['capture:'+file.id]});await f.node.processing.tick();await f.organize();await f.queue();
    assert.deepEqual(f.node.memories.get(saved),record);assert.equal(f.node.materialMemoryWork.authorized(target),false);
  }finally{release();}
  const done=await running;assert.notEqual(done.status,'completed');assert.equal(done.memoryIds.length,0);
  assert.deepEqual(f.node.memories.get(saved),record);assert.equal(f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id)).length,3);
});

test('named ready outputs recheck original deletion before result commit',async t=>{
  const f=await fixture(t,true),file=await f.upload();await f.organize();
  const ids=f.node.materials.input(file.materialId,['source-record'])!.evidenceIds;
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  f.control.review=async()=>{enter();await held;};
  const job=f.node.memoryPipeline.create({evidenceIds:ids,recipes:[bodyRecipe]}),running=withFixtureOwnerModelWork(f.node,()=>f.node.memoryPipeline.run(job.id));await entered;
  f.node.store.delete(file.id);release();
  const result=await running;assert.notEqual(result.status,'completed');assert.equal(result.memoryIds.length,0);
  assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('manual recipes persist independent waiting inputs and resume only the original selection',async t=>{
  const f=await fixture(t),file=await f.upload();await f.organize();
  const scope={deviceId:'fixture',contextTime:'2026-05-07T08:00:00Z'};
  assert.equal((await f.request(scope)).statusCode,409,'legacy unspecified-recipe request keeps its conservative contract');
  const allPending=await f.request({...scope,recipes:[extractedPersonal]});assert.equal(allPending.statusCode,202,allPending.body);
  assert.equal((await f.node.memoryPipeline.run(allPending.json().id)).status,'waiting_for_input');
  assert.equal(f.calls.length,0);f.node.memoryPipeline.cancel(allPending.json().id);
  const response=await f.request({...scope,recipes:[bodyRecipe,extractedPersonal]});assert.equal(response.statusCode,202,response.body);
  const jobId=response.json().id,first=await f.node.memoryPipeline.run(jobId);
  assert.equal(first.status,'waiting_for_input');assert.equal(first.completedBatches,1);assert.equal(first.inputPlans?.waiting,1);
  assert.notEqual(first.execution?.status,'succeeded');assert.equal(first.memoryIds.length,1);
  const body=f.node.memories.get(first.memoryIds[0]),bodyBatch=first.batches.find(b=>b.strategy?.recipe.id===bodyRecipe.id)!;
  f.control.failASR=true;await f.node.processing.tick();await f.organize();
  assert.equal(f.node.materials.input(file.materialId,['extracted-text'])!.dependencies[0].state,'failed');
  f.node.memoryPipeline.wakeInputs([file.materialId]);await f.node.memoryPipeline.tickInputs();const failed=await f.node.memoryPipeline.run(jobId);
  assert.equal(failed.status,'failed');assert.equal(failed.inputPlans?.blocked,1);assert.equal(failed.completedBatches,1);
  assert.deepEqual(f.node.memories.get(body.id),body);
  const later=await f.upload('text/plain','generated-later');await f.organize();
  await f.restart();assert.equal(f.node.processing.cancellation(file.id).wait,'unknown');assert.throws(()=>f.node.processing.retry(file.id),{statusCode:409});f.control.failASR=false;await withFixtureOwnerModelWork(f.node,async()=>f.node.processing.retry(file.id,'transcribe',false,true),{identities:['capture:'+file.id]});await f.node.processing.tick();await f.organize();
  const result=await withFixtureOwnerModelWork(f.node,()=>f.node.memoryPipeline.retry(jobId));assert.equal(result.status,'completed');assert.equal(result.memoryIds.length,2);
  assert.equal(result.inputPlans?.total,2);assert.equal(result.inputPlans?.completed,2);
  assert.equal(result.batches.find(b=>b.id===bodyBatch.id)!.attempts,bodyBatch.attempts);
  assert.deepEqual(f.node.memories.get(body.id),body);assert.equal(result.batches.some(b=>b.strategy?.recipe.id===extractedCoding.id),false);
  const laterIds=f.node.materials.evidenceIds(later.materialId);assert.equal(result.evidenceIds.some(id=>laterIds.includes(id)),false);
  assert.equal(f.count('extract'),2);assert.equal(f.count('review'),2);assert.equal(f.asrCalls(),2);
});

test('a multi-batch consumer keeps ordinary evidence seed-bound while explicit context grants permit selected siblings only',async t=>{
  const f=await fixture(t);f.node.memoryRecipeSettings.configure({recipes:[extractedPersonal]});
  f.control.probeReadBoundaries=true;
  f.control.segments=Array.from({length:21},(_,i)=>`Generated prototype verification in segment ${i}.`);
  await f.upload();await f.node.processing.tick();await f.organize();await f.run();
  const jobs=f.node.memoryPipeline.list().map(j=>f.node.memoryPipeline.get(j.id));assert.equal(jobs.length,1);
  assert.equal(jobs[0].status,'completed');assert.equal(jobs[0].totalBatches,2);assert.equal(jobs[0].materialInputs![0].evidenceIds.length,21);
  assert.equal(f.calls.length,4);assert.ok(f.calls.filter(call=>call.traceContext?.phase==='extract').every(call=>call.evidenceIds!.length<21));
  assert.equal(f.boundaryChecks.length,4);assert.ok(f.boundaryChecks.filter(check=>check.phase==='extract').every(check=>!check.siblingSeeded));
  assert.ok(f.boundaryChecks.filter(check=>check.phase==='review').every(check=>check.siblingSeeded),'independent review receives the exact sibling original actually read by extraction');
  assert.ok(f.boundaryChecks.every(check=>check.ungrantedIds.length>0));
  assert.deepEqual(jobs[0].batches.map(batch=>batch.evidenceRanges.length).sort((a,b)=>a-b),[1,20],'context reads never add targets or coverage');
  assert.equal(f.asrCalls(),1);
});
