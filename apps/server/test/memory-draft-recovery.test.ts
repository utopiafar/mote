import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineOptions} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import {MemoryExtractionDrafts} from '../src/memory-extraction-drafts.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-draft-recovery-'));let store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const originals=[];
 for(const externalId of ['one','two'])originals.push(await sources.upsert('generated',{externalId,revision:'1',text:'I enjoyed making a bowl.',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'}));
 const ids=originals.map(r=>r.id),draft:QueryResult={runId:'original-extraction',answer:JSON.stringify({memories:[{title:'Making a bowl',statement:`The owner enjoyed making a bowl [${ids[0]}]`,uncertainty:'A single experience',admission:{layer:'memory',attribution:'user',reason:'An expressed personal experience',scope:'This occasion'},evidenceIds:[ids[0]],evidence:[{id:ids[0],quote:'I enjoyed making a bowl.'}]}]}),citations:[{id:ids[0],capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:'I enjoyed making a bowl.'}],trace:[]};
 let extracts=0,reviews=0,failReview=true,config='one',skillVersion='generated-v1',reviewHook:(()=>Promise<void>)|undefined;
 const options=():MemoryPipelineOptions=>({store,memories,skillVersion,configured:()=>true,model:()=> 'fixture',requireAdmission:true,configuration:()=>({owner:'models',fingerprint:config,revision:1,profileId:'generated',provider:'fixture',model:'fixture'}),query:async()=>{extracts++;return {...draft,runId:'extraction-'+extracts};},review:(input,result)=>reviewMemory(input,result,async()=>{reviews++;await reviewHook?.();if(failReview)throw new ProviderFailure({category:'transient',code:'provider_timeout',retryAfterMs:0});return {...result,runId:'review-'+reviews};})});
 let pipeline=new MemoryPipeline(options());
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {ids,draft,get store(){return store;},get sources(){return sources;},get memories(){return memories;},get pipeline(){return pipeline;},counts:()=>({extracts,reviews}),succeed(){failReview=false;reviewHook=undefined;},holdReview(){let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);reviewHook=()=>{enter();return held;};return {entered,release};},configuration(value:string){config=value;},policy(value:string){skillVersion=value;},async restart(){await pipeline.close();store.close();store=new Store(directory);sources=new SourceStore(store);memories=new MemoryStore(store);pipeline=new MemoryPipeline(options());}};
}

test('review timeout resumes a validated draft across a vault restart without splitting or re-extracting',async t=>{
 const f=await fixture(t),job=f.pipeline.create({evidenceIds:f.ids}),failed=await f.pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(failed.batches[0].phase,'review');assert.equal(f.memories.list().length,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 assert.ok(!JSON.stringify(f.pipeline.get(job.id)).includes('making a bowl'),'Unreviewed text is not public job state');
 await f.restart();f.succeed();const done=await f.pipeline.retry(job.id);
 assert.equal(done.status,'completed');assert.equal(done.totalBatches,1);assert.deepEqual(f.counts(),{extracts:1,reviews:2});
 const memory=f.memories.get(done.memoryIds[0]);assert.equal(memory.status,'proposed');assert.equal(memory.reviewReceipt?.draftRunId,'extraction-1');assert.equal(memory.reviewReceipt?.decision,'independent');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
});

test('changed model configuration discards the saved draft before explicit retry',async t=>{
 const f=await fixture(t),job=f.pipeline.create({evidenceIds:f.ids});await f.pipeline.run(job.id);
 f.configuration('two');f.succeed();assert.equal((await f.pipeline.retry(job.id)).status,'completed');assert.deepEqual(f.counts(),{extracts:2,reviews:2});
});

test('a changed extraction policy regenerates after restart instead of admitting the old draft',async t=>{
 const f=await fixture(t),job=f.pipeline.create({evidenceIds:f.ids});await f.pipeline.run(job.id);
 f.policy('generated-v2');await f.restart();f.succeed();assert.equal((await f.pipeline.retry(job.id)).status,'completed');assert.deepEqual(f.counts(),{extracts:2,reviews:2});
});

test('shutdown during review resumes only review; a late old response cannot write after restart',async t=>{
 const f=await fixture(t),held=f.holdReview(),job=f.pipeline.create({evidenceIds:f.ids}),running=f.pipeline.run(job.id);
 await held.entered;assert.equal(f.memories.list().length,0);f.succeed();await f.restart();await running;
 const done=await f.pipeline.run(job.id);assert.equal(done.status,'completed');assert.deepEqual(f.counts(),{extracts:1,reviews:2});
 held.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.memories.list().length,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);
});

test('draft storage is bounded, included in vault accounting, and never duplicates usage receipts',async t=>{
 const f=await fixture(t),drafts=new MemoryExtractionDrafts(f.store,8192,2),ids=[0,1,2].map(()=>f.pipeline.create({evidenceIds:f.ids}).batches[0].id);
 const before=f.store.logicalBytes(),json=JSON.stringify({answer:f.draft.answer,citations:f.draft.citations,runId:f.draft.runId,trace:[]});
 drafts.put(ids[0],'a',f.draft);assert.equal(f.store.logicalBytes()-before,Buffer.byteLength(json));
 drafts.put(ids[1],'b',f.draft);drafts.put(ids[2],'c',f.draft);assert.equal(drafts.get(ids[0],'a'),undefined);assert.ok(drafts.get(ids[2],'c'));
 assert.equal(drafts.get(ids[1],'changed-policy'),undefined);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,1);
 drafts.put(ids[2],'c',{...f.draft,answer:'x'.repeat(8193)});assert.equal(drafts.get(ids[2],'c'),undefined);assert.equal(f.store.logicalBytes(),before);
});

for(const mutation of ['delete','revise','cancel'] as const)test(`${mutation} purges private draft text and cannot publish it`,async t=>{
 const f=await fixture(t),job=f.pipeline.create({evidenceIds:f.ids});await f.pipeline.run(job.id);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,1);
 if(mutation==='delete')f.store.delete(f.ids[1]);
 else if(mutation==='revise')await f.sources.upsert('generated',{externalId:'two',revision:'2',text:'A corrected generated record.',observedAt:'2026-09-02T00:00:00Z',kind:'file',layer:'original'});
 else f.pipeline.cancel(job.id);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,0);assert.equal(f.memories.list().length,0);
});
