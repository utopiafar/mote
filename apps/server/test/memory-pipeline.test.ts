import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {MemoryStore,MemoryOutputValidationError,memoryEvidenceFingerprint} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-generated-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
  sources.register({id:'generated',name:'Generated archive',kind:'custom',deviceId:'generated-device',platform:'import'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,sources,memories};
}
const item=(externalId='a',text='合成原文：我计划学习 TypeScript，尚未开始。',revision='1',observedAt='2026-09-15T01:00:00Z')=>({externalId,text,revision,observedAt,title:'Generated record',kind:'file',layer:'original'});
const result=(id:string,quote?:{offset:number;quote:string})=>({answer:JSON.stringify({memories:[{title:'合成候选',statement:`尚未开始的计划 [${id}]`,uncertainty:'没有完成证据',evidenceIds:[id],...(quote?{evidence:[{id,...quote}]}:{})}]}),citations:[{id,capturedAt:'2026-09-15T01:00:00Z',appName:'Generated',excerpt:'合成'}],trace:[],runId:'generated-run'});
const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-empty'});

test('memory references preserve source versions, authored time and exact UTF-16 quotes',async t=>{
  const {store,sources,memories}=fixture(t),text='开头🌱\n合成原文：我计划学习 TypeScript，尚未开始。';
  const document={fileId:'generated-file',path:'diary/day.md',recordedAt:'2021-01-02T08:00:00+08:00',timeBasis:'recorded',contentRole:'authored',originalMetadata:{tags:['generated'],author:'fixture'}};
  const ack=await sources.upsert('generated',{...item('a',text),document}),offset=text.indexOf('我计划'),quote=text.slice(offset);
  const saved=memories.extract(result(ack.id,{offset,quote}),'fixture-model',{skillVersion:'test-v1'}).items[0];
  assert.equal(saved.skillVersion,'test-v1');assert.equal(saved.evidence![0].sourceId,'generated');assert.equal(saved.evidence![0].externalId,'a');assert.equal(saved.evidence![0].revision,'1');
  assert.equal(saved.evidence![0].recordedAt,document.recordedAt);assert.equal(saved.evidence![0].capturedAt,'2026-09-15T01:00:00.000Z');assert.equal(saved.evidence![0].fileId,'generated-file');
  assert.equal(saved.evidence![0].offset,offset);assert.equal(saved.evidence![0].quote,quote);
  assert.throws(()=>memories.extract(result(ack.id,{offset:offset+1,quote}),'fixture-model'),/quote does not match/);
  assert.throws(()=>memories.extract(result(ack.id,{offset,quote}),'fixture-model',{evidenceRanges:[{id:ack.id,offset:0,length:2}]}),/outside the supplied segment/);
  assert.equal(store.list({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).totalCount,1);
  assert.equal(store.list({after:'2026-09-01T00:00:00Z'}).totalCount,0);
  assert.equal(sources.listItems({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).items.length,1);
  assert.equal(memories.list({after:'2021-01-01T00:00:00Z',before:'2021-01-03T00:00:00Z'}).length,1);
  assert.deepEqual(sources.getItem('generated','a')?.document,document);
});

test('source revisions and privacy deletion affect only dependent memory cards',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('a')),b=await sources.upsert('generated',item('b'));
  const ma=memories.extract(result(a.id),'fixture').items[0],mb=memories.extract(result(b.id),'fixture').items[0];memories.publish(mb.id);
  await sources.upsert('generated',item('a','更正后的合成原文','2','2026-09-15T02:00:00Z'));
  assert.equal(memories.get(ma.id).status,'stale');assert.equal(memories.get(mb.id).status,'published');
  store.delete(a.id);assert.throws(()=>memories.get(ma.id),{statusCode:404});assert.equal(memories.get(mb.id).status,'published');
  assert.throws(()=>memories.extract(result(a.id),'fixture'),{statusCode:409});
});

test('pipeline covers all long-text segments within a character budget, checkpoints zero results and replays imports idempotently',async t=>{
  const {store,sources,memories}=fixture(t),text='🌱'.repeat(430),a=await sources.upsert('generated',item('long',text)),b=await sources.upsert('generated',item('short','合成短文'));
  const calls:MemoryPipelineQuery[]=[];const pipeline=new MemoryPipeline({store,memories,batchCharacters:257,model:()=> 'fixture',configured:()=>true,query:async input=>{calls.push(input);return empty();}});
  t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id,b.id],importJobId:'generated-import'});
  assert.equal(pipeline.create({evidenceIds:[a.id,b.id],importJobId:'generated-import'}).id,job.id);
  const completed=await pipeline.run(job.id);assert.equal(completed.status,'completed');assert.equal(completed.completedBatches,completed.totalBatches);assert.deepEqual(completed.memoryIds,[]);
  const ranges=calls.flatMap(c=>c.evidenceRanges).filter(r=>r.id===a.id).sort((x,y)=>x.offset-y.offset);let end=0;
  for(const range of ranges){assert.equal(range.offset,end);end+=range.length;assert.equal(range.length%2,0);}
  assert.equal(end,text.length);assert.ok(calls.every(c=>c.skill==='memory-extraction'&&c.evidenceRanges.reduce((sum,r)=>sum+r.length,0)<=257));
  assert.ok(calls.some(c=>c.evidenceIds.includes(b.id)));
  const repeated=pipeline.create({evidenceIds:[a.id,b.id]});assert.equal(repeated.totalBatches,0);assert.equal(repeated.status,'completed');assert.equal(repeated.skippedChunks,ranges.length+1);
});

test('unconfigured models stay retryable, and retry reruns only failed batches',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('long','文'.repeat(600)));
  let configured=false,failed=false;const calls:number[]=[];
  const pipeline=new MemoryPipeline({store,memories,batchCharacters:256,model:()=> 'fixture',configured:()=>configured,query:async input=>{const offset=input.evidenceRanges[0].offset;calls.push(offset);if(offset===256&&!failed){failed=true;throw new Error('generated transport failure');}return empty();}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]});assert.equal((await pipeline.run(job.id)).status,'waiting_for_model');assert.deepEqual(calls,[]);
  configured=true;const partial=await pipeline.retry(job.id);assert.equal(partial.status,'failed');assert.equal(partial.completedBatches,2);assert.equal(partial.failedBatches,1);
  const done=await pipeline.retry(job.id);assert.equal(done.status,'completed');assert.deepEqual(calls,[0,256,512,256]);
});

test('memory batches retain the selected profile through recovery and wait if it disappears',async t=>{
  const {store,sources,memories}=fixture(t),record=await sources.upsert('generated',item('long','文'.repeat(600)));
  let available=true;const calls:string[]=[];
  const options={store,memories,batchCharacters:256,model:(id?:string)=>{assert.equal(id,'selected');if(!available)throw Error('deleted profile');return 'fixture';},configured:(id?:string)=>id==='selected'&&available,query:async(input:MemoryPipelineQuery)=>{calls.push(input.modelProfileId!);available=false;return empty();}};
  let pipeline=new MemoryPipeline(options);
  const job=pipeline.create({evidenceIds:[record.id],modelProfileId:'selected'});
  const paused=await pipeline.run(job.id);assert.equal(paused.status,'waiting_for_model');assert.equal(paused.completedBatches,1);assert.equal(paused.batches[1].status,'pending');
  await pipeline.close();pipeline=new MemoryPipeline({...options,query:async(input)=>{calls.push(input.modelProfileId!);return empty();}});t.after(()=>pipeline.close());
  assert.equal(pipeline.get(job.id).modelProfileId,'selected');assert.equal((await pipeline.retry(job.id)).status,'waiting_for_model');
  available=true;assert.equal((await pipeline.retry(job.id)).status,'completed');assert.deepEqual(calls,['selected','selected','selected']);
});

test('privacy deletion during a model run cannot resurrect memory or create a completed checkpoint',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  let enter!:()=>void,finish!:(value:ReturnType<typeof result>)=>void;const entered=new Promise<void>(resolve=>enter=resolve);
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{enter();return new Promise(resolve=>finish=resolve);}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);await entered;store.delete(a.id);finish(result(a.id));
  const done=await running;assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(memories.list({includeStale:true}).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
});

test('recovery retries interrupted batches and commits memory with its checkpoint atomically',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  let pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>result(a.id)});
  assert.throws(()=>pipeline.create({evidenceIds:[a.id],timeZone:'generated/invalid-zone'}));
  const job=pipeline.create({evidenceIds:[a.id],timeZone:'Asia/Shanghai'});await pipeline.close();
  store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.status','running') WHERE id=?").run(job.id);
  store.db.prepare("UPDATE memory_batches SET json=json_set(json,'$.status','running') WHERE job_id=?").run(job.id);
  pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async input=>{assert.equal(input.timeZone,'Asia/Shanghai');return result(a.id);}});t.after(()=>pipeline.close());
  assert.equal(pipeline.get(job.id).timeZone,'Asia/Shanghai');
  assert.equal(pipeline.get(job.id).status,'queued');assert.equal(pipeline.get(job.id).batches[0].status,'pending');
  const completed=await pipeline.run(job.id);assert.equal(completed.status,'completed');assert.equal(completed.memoryIds.length,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,1);
  assert.throws(()=>memories.extract({...result(a.id),answer:JSON.stringify({memories:[{title:'另一候选',statement:`另一条陈述 [${a.id}]`,uncertainty:'生成测试',evidenceIds:[a.id]}]})},'fixture',{onSaved:()=>{throw new Error('checkpoint transaction failed');}}),/checkpoint transaction failed/);
  assert.equal(memories.list().length,1);
});

test('new revisions are queued and completed old batches become visibly invalidated',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>empty()});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id]});await pipeline.run(job.id);
  const b=await sources.upsert('generated',item('a','新的合成版本','2','2026-09-15T02:00:00Z'));
  assert.equal(pipeline.get(job.id).status,'failed');assert.equal(pipeline.create({evidenceIds:[b.id]}).totalBatches,1);
  assert.throws(()=>memories.extract(result(a.id),'fixture',{expectedFingerprints:{[a.id]:memoryEvidenceFingerprint(store.evidence([a.id])[0])}}),{statusCode:409});
});

test('document metadata and source receipts survive roundtrip; throwing receipt callbacks roll back',async t=>{
  const {store,sources}=fixture(t),files=new ArchivedFileStore(store),attachment=files.put({name:'diagram.png',bytes:Buffer.from('generated attachment fixture'),mimeType:'application/x-fixture'}),document={recordedAt:'2019-02-01T10:00:00Z',timeBasis:'recorded',contentRole:'authored',attachments:[{id:attachment.id,name:'diagram.png'}],originalMetadata:{nested:{flags:[true,null,3]}}};
  let callbackId='';const a=await sources.upsert('generated',{...item(),document},undefined,ack=>{callbackId=ack.id;});assert.equal(callbackId,a.id);
  await assert.rejects(sources.upsert('generated',item('rollback'),undefined,()=>{throw new Error('generated receipt failure');}));assert.equal(sources.getItem('generated','rollback'),undefined);
  const restored=fixture(t);await restored.store.importArchive(store.exportArchive(1_000_000));assert.deepEqual(restored.sources.getItem('generated','a')?.document,document);
  await assert.rejects(sources.upsert('generated',{...item('invalid'),document:{originalMetadata:{text:'x'.repeat(32001)}}}));
});

test('invalid inner memory schema regenerates once with trusted feedback and unchanged evidence scope',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());const calls:MemoryPipelineQuery[]=[];
  const untrusted='UNTRUSTED_BAD_OUTPUT_DO_NOT_REPLAY_AS_INSTRUCTIONS';
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async input=>{
    calls.push(input);assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
    if(calls.length===1)return {...result(a.id),answer:JSON.stringify({memories:[{title:'合成',statement:untrusted,evidenceIds:[a.id]}]})};
    assert.match(input.question,/Host validation rejected/);assert.match(input.question,/string uncertainty/);assert.ok(!input.question.includes(untrusted));return result(a.id);
  }});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[a.id],timeZone:'Asia/Shanghai'}),done=await pipeline.run(job.id);
  assert.equal(done.status,'completed');assert.equal(done.batches[0].attempts,2);assert.equal(calls.length,2);assert.equal(done.memoryIds.length,1);
  for(const key of ['evidenceIds','evidenceRanges','skill','timeZone'] as const)assert.deepEqual(calls[1][key],calls[0][key]);
});

test('quote offset errors are model validation failures and repair keeps exact UTF-16 evidence bounds',async t=>{
  const {store,sources,memories}=fixture(t),text='🌱开头\n合成原文：我计划学习。',a=await sources.upsert('generated',item('quote',text));
  const offset=text.indexOf('我计划'),quote=text.slice(offset),calls:MemoryPipelineQuery[]=[];
  assert.throws(()=>memories.extract(result(a.id,{offset:offset+1,quote}),'fixture'),error=>error instanceof MemoryOutputValidationError&&error.code==='quote_offset_mismatch'&&error.statusCode===502);
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async input=>{
    calls.push(input);if(calls.length===1)return result(a.id,{offset:offset+1,quote});assert.equal(memories.list().length,0);assert.match(input.question,/absolute UTF-16 offset/);return result(a.id,{offset,quote});
  }});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'completed');assert.equal(done.batches[0].attempts,2);assert.deepEqual(calls[1].evidenceRanges,calls[0].evidenceRanges);
  assert.equal(done.batches[0].validationFailures?.[0].code,'quote_offset_mismatch');assert.equal(done.batches[0].validationFailures?.[0].details?.spanIndex,0);
  const saved=memories.get(done.memoryIds[0]);assert.equal(saved.evidence![0].offset,offset);assert.equal(saved.evidence![0].quote,quote);
});

test('schema repair is bounded and final invalid output remains visible without partial memories',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());let calls=0;
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{calls++;return {...empty(),answer:'not valid inner JSON'};}});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'failed');assert.equal(done.errorCode,'invalid_model_output');assert.equal(done.batches[0].attempts,2);assert.equal(calls,2);assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_checkpoints').get()!.n,0);
});

test('source changes prevent a second model call even when the first inner output is malformed',async t=>{
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item());let calls=0;
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{
    calls++;await sources.upsert('generated',item('a','已变更的合成资料','2','2026-09-15T02:00:00Z'));return {...empty(),answer:'malformed output'};
  }});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(done.batches[0].errorCode,'evidence_changed');assert.equal(done.batches[0].attempts,1);assert.equal(calls,1);assert.equal(memories.list().length,0);
});

test('quote diagnostics distinguish exact failure modes without retaining source or model text',async t=>{
  const {sources,memories}=fixture(t),text='🌱prefix\nrepeat repeat\nunique-secret-fixture',a=await sources.upsert('generated',item('quote-codes',text));
  const base=result(a.id),candidate=JSON.parse(base.answer).memories[0];
  const check=(span:Record<string,unknown>,code:string,ranges?:{id:string;offset:number;length:number}[])=>{
    assert.throws(()=>memories.extract({...base,answer:JSON.stringify({memories:[{...candidate,evidence:[{id:a.id,...span}]}]})},'fixture',{evidenceRanges:ranges}),error=>{
      assert.ok(error instanceof MemoryOutputValidationError);assert.equal(error.code,code);assert.equal(error.details.candidateIndex,0);assert.equal(error.details.spanIndex,0);
      assert.ok(!JSON.stringify(error.details).includes('unique-secret-fixture'));return true;
    });
    assert.equal(memories.list().length,0);
  };
  check({quote:'repeat',offset:0},'quote_offset_mismatch');
  check({quote:'repeat',length:2},'quote_length_mismatch');
  check({quote:'not-present'},'quote_not_found');
  check({quote:'not-present',offset:0},'quote_not_found');
  check({quote:'repeat'},'quote_ambiguous');
  check({quote:'unique-secret-fixture'},'quote_range',[{id:a.id,offset:0,length:8}]);
  check({quote:'repeat',id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},'quote_evidence_undeclared');
  const saved=memories.extract({...base,answer:JSON.stringify({memories:[{...candidate,evidence:[{id:a.id,quote:'repeat'}]}]})},'fixture',{evidenceRanges:[{id:a.id,offset:text.indexOf('repeat'),length:6}]}).items[0];
  assert.equal(saved.evidence![0].offset,text.indexOf('repeat'));
});

test('review quote failure persists run and attempt locations and emits an ordinary safe diagnostic',async t=>{
  const {directory,store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('review-diagnostic','synthetic exact source'));
  const {ServerDiagnostics}=await import('../src/diagnostics.js');
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),traceEnabled:false});await diagnostics.init();t.after(()=>diagnostics.close());
  const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,
    query:async()=>{const draft=result(a.id,{offset:0,quote:'synthetic exact source'}),value=JSON.parse(draft.answer);value.memories[0].admission={layer:'memory',reason:'Explicit fixture instruction',scope:'Fixture only',attribution:'user'};return {...draft,answer:JSON.stringify(value)};},
    review:async()=>({...result(a.id,{offset:1,quote:'synthetic exact source'}),runId}),
    onValidationFailure:event=>diagnostics.record('agent.memory_validation_failed',{jobId:event.jobId,batchId:event.batchId,batchIndex:event.batchIndex,runId:event.runId,attempt:event.attempt,validationCode:event.code,validationPhase:event.phase,...event.details},'warn'),
  });t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);
  assert.equal(done.status,'failed');assert.equal(done.errorCode,'invalid_model_output');
  assert.deepEqual(done.batches[0].validationFailures?.map(f=>[f.phase,f.code,f.attempt,f.runId]),[['review','quote_offset_mismatch',1,runId],['review','quote_offset_mismatch',2,runId]]);
  const persisted=JSON.parse(String(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(done.batches[0].id)!.json));
  assert.equal(persisted.validationFailures[1].details.declaredOffset,1);
  await diagnostics.flush();const events=diagnostics.events().items;
  assert.equal(events.length,2);assert.equal(events[1].jobId,done.id);assert.equal(events[1].batchId,done.batches[0].id);assert.equal(events[1].validationCode,'quote_offset_mismatch');assert.equal(events[1].validationPhase,'review');assert.equal(events[1].candidateIndex,0);assert.equal(events[1].quoteLength,22);
  assert.ok(!JSON.stringify(events).includes('synthetic exact source'));assert.equal(memories.list().length,0);
});

test('independent memory batches overlap; same evidence is serialized and pause finishes only in-flight work',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('parallel-a','a'.repeat(600))),b=await sources.upsert('generated',item('parallel-b','b'.repeat(300)));
 const running=new Set<string>(),releases:(()=>void)[]=[];let peak=0;
 const pipeline=new MemoryPipeline({store,memories,batchCharacters:256,concurrency:()=>3,model:()=> 'fixture',configured:()=>true,query:async input=>{const id=input.evidenceIds[0];assert.ok(!running.has(id));running.add(id);peak=Math.max(peak,running.size);await new Promise<void>(r=>releases.push(r));running.delete(id);return empty();}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[a.id,b.id]}),done=pipeline.run(job.id);await new Promise(r=>setImmediate(r));assert.equal(peak,2);assert.equal(pipeline.get(job.id).runningBatches,2);
 assert.equal(pipeline.pause(job.id).status,'pausing');for(const release of releases.splice(0))release();const paused=await done;assert.equal(paused.status,'paused');assert.equal(paused.completedBatches,2);assert.ok(paused.pendingBatches!>0);
 pipeline.resume(job.id);await new Promise(r=>setImmediate(r));pipeline.cancel(job.id);for(const release of releases.splice(0))release();await pipeline.run(job.id);assert.equal(pipeline.get(job.id).status,'cancelled');
});

test('host quote feedback is delivered before query session closes and successful repair does not restart extraction',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item()),failures:unknown[]=[];let calls=0;
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,onValidationFailure:e=>failures.push(e),query:async input=>{
   calls++;const bad=result(a.id,{offset:0,quote:'不存在的合成引文'}),issue=await input.validateOutput!(bad);assert.equal(issue?.code,'quote_not_found');assert.match(issue!.feedback,/quote/);assert.equal(memories.list({}).length,0);
   const fixed=empty();assert.equal(await input.validateOutput!(fixed),undefined);return fixed;
 }});t.after(()=>pipeline.close());const job=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(calls,1);assert.equal(job.status,'completed');assert.equal(job.batches[0].attempts,1);assert.equal(failures.length,1);
});

test('cancelling extraction or review fences late models and saves no memory or checkpoint',async t=>{
 for(const phase of ['extract','review'] as const){
  const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('cancel-'+phase));
  let enter!:()=>void,release!:(value:ReturnType<typeof result>)=>void,signal:AbortSignal|undefined;
  const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<ReturnType<typeof result>>(r=>{release=r;});
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,
   query:async input=>{signal=input.signal;if(phase==='extract'){enter();return held;}const draft=result(a.id,{offset:0,quote:item().text}),value=JSON.parse(draft.answer);value.memories[0].admission={layer:'memory',reason:'Explicit fixture instruction',scope:'Fixture only',attribution:'user'};return {...draft,answer:JSON.stringify(value)};},
   ...(phase==='review'?{review:async()=>{enter();return held;}}:{})});
  const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);await entered;
  pipeline.cancel(job.id);release(result(a.id));const done=await running;
  assert.equal(done.status,'cancelled');assert.equal(memories.list().length,0,phase+' saved a late candidate');
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(signal?.aborted,true);await pipeline.close();
 }
});

test('closing a memory pipeline releases an uncooperative model and restart can recover the batch',async t=>{
 const {store,sources,memories}=fixture(t),a=await sources.upsert('generated',item('uncooperative'));
 let enter!:()=>void,release!:(value:ReturnType<typeof result>)=>void;
 const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<ReturnType<typeof result>>(r=>{release=r;});
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{enter();return held;}});
 const job=pipeline.create({evidenceIds:[a.id]}),running=pipeline.run(job.id);await entered;
 try{await Promise.race([pipeline.close(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Shutdown waited on an uncooperative model')),1000);timer.unref();})]);}
 finally{release(result(a.id));}
 await running;await new Promise(r=>setImmediate(r));assert.equal(memories.list().length,0);
 const restarted=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>result(a.id)});t.after(()=>restarted.close());
 assert.equal((await restarted.run(job.id)).status,'completed');assert.equal(memories.list().length,1);
});


test('400 generated days imported individually and in batches share one durable memory executor',async t=>{
 const {store,sources,memories}=fixture(t),ids:string[]=[];
 const inputs=Array.from({length:400},(_,i)=>item('engine-day-'+i,'Synthetic bounded source '+i+' '+'.'.repeat(256),'1',new Date(Date.UTC(2024,0,1+i)).toISOString()));
 for(const input of inputs.slice(0,200))ids.push((await sources.upsert('generated',input)).id);
 for(let offset=200;offset<400;offset+=100){await sources.upsertBatch('generated',inputs.slice(offset,offset+100));for(const input of inputs.slice(offset,offset+100))ids.push(sources.getItem('generated',input.externalId)!.captureId);}
 const engine=new ExecutionEngine(store),calls:string[]=[];let peak=0,active=0;
 const pipeline=new MemoryPipeline({executor:engine,store,memories,batchCharacters:256,concurrency:()=>3,model:()=> 'fixture',configured:()=>true,query:async input=>{calls.push(input.traceContext!.jobId!);active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return empty();}});
 const a=pipeline.create({evidenceIds:ids.slice(0,200)}),b=pipeline.create({evidenceIds:ids.slice(200)});
 const completed=await Promise.all([pipeline.run(a.id),pipeline.run(b.id)]);assert.ok(completed.every(job=>job.status==='completed'));
 assert.equal(calls.length,800);assert.equal(peak,3);assert.ok(calls.slice(0,6).includes(a.id)&&calls.slice(0,6).includes(b.id));
 assert.equal(store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.batch' AND state='succeeded'").get()!.n,800);
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,800);
 assert.equal(pipeline.create({evidenceIds:ids}).totalBatches,0);
 await engine.close();await pipeline.close();
});

test('memory, checkpoint and engine success commit roll back together when the host commit fails',async t=>{
 const {store,sources,memories}=fixture(t),ack=await sources.upsert('generated',item('commit-rollback'));
 const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>result(ack.id)});t.after(()=>pipeline.close());
 store.db.exec("CREATE TRIGGER generated_checkpoint_failure BEFORE INSERT ON memory_checkpoints BEGIN SELECT RAISE(ABORT,'generated checkpoint failure'); END");
 const job=pipeline.create({evidenceIds:[ack.id]}),failed=await pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(memories.list().length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.equal(pipeline.engine.get(job.batches[0].id)!.state,'failed');assert.equal(failed.batches[0].memoryIds.length,0);
 store.db.exec('DROP TRIGGER generated_checkpoint_failure');assert.equal((await pipeline.retry(job.id)).status,'completed');assert.equal(memories.list().length,1);
});


test('shared engine cannot bypass explicit lifecycle activation after recovery',async t=>{
 const {store,sources,memories}=fixture(t),ack=await sources.upsert('generated',item('activation'));
 const options={store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>empty()};
 const initial=new MemoryPipeline(options),job=initial.create({evidenceIds:[ack.id]});await initial.close();
 const engine=new ExecutionEngine(store),pipeline=new MemoryPipeline({...options,executor:engine});
 const batchId=job.batches[0].id;
 engine.enqueue('memory:'+job.id,'memory.batch',{jobId:job.id,batchId,evidenceIds:[ack.id]},{id:batchId});
 await engine.tick();assert.equal(engine.get(batchId)!.error,'awaiting_activation');assert.equal(engine.get(batchId)!.attempts,0);assert.equal(pipeline.get(job.id).completedBatches,0);
 assert.equal((await pipeline.run(job.id)).status,'completed');await engine.close();await pipeline.close();
});
