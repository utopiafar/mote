import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryResult} from '@mote/shared';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

function members(input:MemoryPipelineQuery){return (input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;}
function output(input:MemoryPipelineQuery,runId:string,withCandidate=false,coverage=members(input),saturated=false):QueryResult{
 const first=members(input)[0],memories=withCandidate?[{title:'Generated preference',statement:`The owner prefers a blue bowl [${first.id}]`,uncertainty:'One synthetic statement',admission:{layer:'memory',reason:'An explicit generated preference',scope:'Fixture only',attribution:'user'},evidenceIds:[first.id],evidence:[{id:first.id,quote:'I prefer a blue bowl.'}]}]:[];
 return {runId,trace:[],citations:withCandidate?[{id:first.id,capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:''}]:[],answer:JSON.stringify({memories,coverage:coverage.map(member=>({key:member.key,state:withCandidate&&member.key===first.key?'checked':'no_candidates',candidateIndexes:withCandidate&&member.key===first.key?[0]:[]})),capacity:{saturated}})};
}
async function fixture(t:TestContext,count=4){
 const dir=mkdtempSync(join(tmpdir(),'mote-memory-package-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const ids:string[]=[];for(let i=0;i<count;i++)ids.push((await sources.upsert('generated',{externalId:String(i),revision:'1',text:'I prefer a blue bowl.',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'})).id);
 const seen:MemoryPipelineQuery[]=[],reviews:MemoryPipelineQuery[]=[];let generate=(input:MemoryPipelineQuery)=>output(input,'extract',false),review=(input:MemoryPipelineQuery,draft:QueryResult)=>Promise.resolve({...draft,runId:'review'});
 const pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'generated-model',requireAdmission:true,query:async input=>{seen.push(input);return generate(input);},review:(input,draft)=>reviewMemory(input,draft,async reviewed=>{reviews.push(reviewed as MemoryPipelineQuery);return review(reviewed as MemoryPipelineQuery,draft);})});
 t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,sources,memories,pipeline,ids,seen,reviews,setGenerate(fn:typeof generate){generate=fn;},setReview(fn:typeof review){review=fn;},create(){return pipeline.create({evidenceIds:ids,workPackage:{id:'synthetic-package',goal:'Inspect the authorized originals',instruction:'Preserve independent provenance'}});}};
}

test('a work package independently reviews every zero-candidate input and checkpoints exact ranges',async t=>{
 const f=await fixture(t),job=f.create(),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,1,'zero candidates require a fresh reviewer');
 assert.deepEqual(f.reviews[0].evidenceRanges,f.seen[0].evidenceRanges);
 assert.equal(done.batches[0].coverage!.length,4);assert.ok(done.batches[0].coverage!.every(member=>member.state==='no_candidates'&&member.memoryIds.length===0));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);assert.equal(f.memories.list().length,0);
 await f.pipeline.run(job.id);assert.equal(f.reviews.length,1,'completed work never repeats reviewer or commit');
});

test('checked member links only its independently reviewed memories while other members have explicit zero results',async t=>{
 const f=await fixture(t);f.setGenerate(input=>output(input,'extract-candidate',true));const done=await f.pipeline.run(f.create().id);
 assert.equal(done.status,'completed');assert.equal(f.memories.list().length,1);assert.equal(f.memories.get(done.memoryIds[0]).reviewReceipt?.decision,'independent');
 assert.deepEqual(done.batches[0].coverage!.find(member=>member.state==='checked')!.memoryIds,done.memoryIds);assert.equal(done.batches[0].coverage!.filter(member=>member.state==='no_candidates').length,3);
});

for(const mode of ['missing','saturated'] as const)test(`${mode} coverage subdivides only the incomplete package and never checkpoints its parent`,async t=>{
 const f=await fixture(t);f.setGenerate(input=>members(input).length===4?output(input,'large',false,mode==='missing'?members(input).slice(0,2):members(input),mode==='saturated'):output(input,'small'));
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.equal(done.batches.length,3);
 const parent=done.batches.find(batch=>batch.supersededBy);assert.equal(parent?.supersededBy?.length,2);
 const leaves=done.batches.filter(batch=>!batch.supersededBy);assert.equal(leaves.flatMap(batch=>batch.coverage!).length,4);assert.ok(leaves.every(batch=>batch.coverage!.every(member=>member.state==='no_candidates')));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);assert.equal(f.seen.length,3);assert.equal(f.reviews.length,3);
});

test('review timeout preserves the private package draft and retries only fresh independent review',async t=>{
 const f=await fixture(t);f.setReview(async()=>{throw new ProviderFailure({category:'transient',code:'provider_timeout',retryAfterMs:0});});const job=f.create(),failed=await f.pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,1);
 f.setReview(async(_input,draft)=>({...draft,runId:'new-review'}));const done=await f.pipeline.retry(job.id);assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,2);
});

test('unresolved context stays visible without granting another original or publishing a candidate',async t=>{
 const f=await fixture(t,1);f.setGenerate(input=>{const result=output(input,'needs-context');const parsed=JSON.parse(result.answer);parsed.coverage[0]={key:members(input)[0].key,state:'needs_context',candidateIndexes:[],reason:'Requires explicitly authorized earlier context',contextRefs:['material:unread']};return {...result,answer:JSON.stringify(parsed)};});
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'waiting_for_input');assert.equal(done.errorCode,'memory_context_required');assert.equal(done.batches[0].coverage![0].state,'needs_context');assert.deepEqual(done.batches[0].coverage![0].contextRefs,['material:unread']);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.memories.list().length,0);assert.deepEqual(f.reviews[0].evidenceIds,f.ids);
});

test('candidate capacity scales with package members and a revised input fences the entire old package',async t=>{
 const f=await fixture(t);const job=f.create();assert.equal((f.pipeline.get(job.id).workPackage?.id),'synthetic-package');
 f.setGenerate(input=>{assert.equal((input.taskContext!.memoryWork as {maxCandidates:number}).maxCandidates,32);return output(input,'old',false);});
 f.setReview(async(_input,draft)=>{await f.sources.upsert('generated',{externalId:'1',revision:'2',text:'A corrected generated preference.',observedAt:'2026-09-02T00:00:00Z',kind:'file',layer:'original'});return {...draft,runId:'changed-review'};});
 const done=await f.pipeline.run(job.id);assert.equal(done.status,'failed');assert.ok(done.batches[0].coverage!.every(member=>member.state==='stale'));assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});
