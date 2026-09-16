import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {MemoryStore,MemoryOutputValidationError,memoryEvidenceFingerprint} from '../src/memory.js';
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
  assert.throws(()=>memories.extract(result(a.id,{offset:offset+1,quote}),'fixture'),error=>error instanceof MemoryOutputValidationError&&error.code==='quote'&&error.statusCode===502);
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async input=>{
    calls.push(input);if(calls.length===1)return result(a.id,{offset:offset+1,quote});assert.equal(memories.list().length,0);assert.match(input.question,/absolute UTF-16 offset/);return result(a.id,{offset,quote});
  }});t.after(()=>pipeline.close());
  const done=await pipeline.run(pipeline.create({evidenceIds:[a.id]}).id);assert.equal(done.status,'completed');assert.equal(done.batches[0].attempts,2);assert.deepEqual(calls[1].evidenceRanges,calls[0].evidenceRanges);
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
