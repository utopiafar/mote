import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryResult} from '@mote/shared';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline,type MemoryPipelineQuery,type ConversationPreparation} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import {createAgent} from '@mote/agent';
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
 const seen:MemoryPipelineQuery[]=[],reviews:MemoryPipelineQuery[]=[];let generate:(input:MemoryPipelineQuery)=>QueryResult|Promise<QueryResult>=input=>output(input,'extract',false),review=(input:MemoryPipelineQuery,draft:QueryResult)=>Promise.resolve({...draft,runId:'review'});
 let understand:((input:ConversationPreparation)=>Promise<{id:string;revision:string}[]|undefined>)|undefined;
 const pipeline=new MemoryPipeline({store,memories,understand:input=>understand?.(input)??Promise.resolve(undefined),configured:()=>true,model:()=> 'generated-model',requireAdmission:true,query:async input=>{seen.push(input);return generate(input);},review:(input,draft)=>reviewMemory(input,draft,async reviewed=>{reviews.push(reviewed as MemoryPipelineQuery);return review(reviewed as MemoryPipelineQuery,draft);})});
 t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {directory:dir,store,sources,memories,pipeline,ids,seen,reviews,setUnderstand(fn:NonNullable<typeof understand>){understand=fn;},setGenerate(fn:typeof generate){generate=fn;},setReview(fn:typeof review){review=fn;},create(){return pipeline.create({evidenceIds:ids,workPackage:{id:'synthetic-package',goal:'Inspect the authorized originals',instruction:'Preserve independent provenance'}});}};
}

test('wide packages reach the real Codex adapter for extraction and independent review without dropping members',async t=>{
 const f=await fixture(t,20),executable=join(f.directory,'generated-codex.mjs'),delivered=join(f.directory,'delivered.ndjson');
 const summary='Generated derived context. '.repeat(500).slice(0,12000),artifact=f.store.archive.save('3'.repeat(64),'generated-group','1'.repeat(64),{kind:'semantic',text:summary,metadata:{evidenceRanges:f.ids.map(id=>({id,offset:0,length:20}))}},f.ids.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'generated-only','1','2'.repeat(64));
 writeFileSync(join(f.directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-unused-key'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread'},approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const context=JSON.parse(m.params.input[0].text),work=context.untrustedTaskContext.memoryWork;
  appendFileSync(${JSON.stringify(delivered)},JSON.stringify({request:context.request,work,interpretations:context.untrustedTaskContext.untrustedInterpretations,evidenceIds:context.untrustedEvidence.map(r=>r.id),review:Boolean(context.untrustedTaskContext.untrustedMemoryDraft)})+'\\n');
  const value={memories:[],coverage:work.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),capacity:{saturated:false}};
  send({id:m.id,result:{turn:{id:'generated-turn'}}});
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-answer',type:'agentMessage',text:JSON.stringify({answer:JSON.stringify(value),citationIds:[]})}}});
  send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});chmodSync(executable,0o700);
 const agent=createAgent({reader:{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async({ids})=>f.memories.readEvidence(ids),devices:async()=>[],activity:async()=>({})},protocol:'codex-app-server',model:'generated-only',codex:{executable,home:f.directory},agentTimeoutMs:10000});t.after(()=>agent.close());
 f.setGenerate(input=>agent.query(input));f.setReview(async input=>agent.query(input));
 const job=f.pipeline.create({evidenceIds:f.ids,artifactRefs:[{id:artifact.id,revision:artifact.revision}],workPackage:{id:'synthetic-package',goal:'Inspect the authorized originals',instruction:'Preserve generated provenance and original scope. '.repeat(70)}}),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'completed',`the real adapter must accept both calls (extract=${f.seen[0]?.question.length}, review=${f.reviews[0]?.question.length}, error=${done.errorCode})`);
 const calls=readFileSync(delivered,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,2);
 assert.deepEqual(calls.map(call=>call.review),[false,true]);
 for(const call of calls){assert.equal(call.work.members.length,20);assert.deepEqual(new Set(call.evidenceIds),new Set(f.ids));assert.ok(call.request.length<=20000);assert.ok(call.interpretations.includes(summary.slice(0,11000)));assert.equal(call.work.package.instruction,job.workPackage!.instruction);}
 assert.equal(calls[0].interpretations,calls[1].interpretations);
 assert.ok(calls[0].request.length+calls[0].work.instruction.length+calls[0].work.package.instruction.length+calls[0].interpretations.length>20000,'putting the complete task in question reproduces the former adapter limit');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,20);
 assert.ok(done.batches[0].coverage!.every(member=>member.state==='no_candidates'));
});

test('a work package independently reviews every zero-candidate input and checkpoints exact ranges',async t=>{
 const f=await fixture(t),job=f.create(),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,1,'zero candidates require a fresh reviewer');
 assert.deepEqual(f.reviews[0].evidenceRanges,f.seen[0].evidenceRanges);
 assert.equal(done.batches[0].coverage!.length,4);assert.ok(done.batches[0].coverage!.every(member=>member.state==='no_candidates'&&member.memoryIds.length===0));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);assert.equal(f.memories.list().length,0);
 await f.pipeline.run(job.id);assert.equal(f.reviews.length,1,'completed work never repeats reviewer or commit');
});

for(const phase of ['extract','review'] as const)test(`${phase} reports an inexact quote before coverage ownership and repairs only that phase`,async t=>{
 const f=await fixture(t,1);
 const generate=async(input:MemoryPipelineQuery)=>{
  const result=output(input,'generated-'+phase,true),invalid=JSON.parse(result.answer);
  invalid.memories[0].evidence[0].quote='I prefer the blue bowl.';
  const issue=await input.validateOutput!({...result,answer:JSON.stringify(invalid)});
  assert.equal(issue?.code,'quote_not_found');assert.match(issue!.feedback,/exact substring/);
  assert.match(issue!.feedback,/Candidate index: 0/);
  assert.equal(f.memories.list().length,0,'the rejected generation never publishes a memory');
  return result;
 };
 if(phase==='extract')f.setGenerate(generate);
 else {f.setGenerate(input=>output(input,'extract',true));f.setReview(async input=>generate(input));}
 const done=await f.pipeline.run(f.create().id);
 assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,1);
 assert.deepEqual(done.batches[0].validationFailures?.map(failure=>({code:failure.code,phase:failure.phase})),[{code:'quote_not_found',phase}]);
 assert.equal(f.memories.list().length,1);
});

test('a missing package coverage envelope still receives coverage repair feedback',async t=>{
 const f=await fixture(t,1);
 f.setGenerate(async input=>{
  const result=output(input,'generated-coverage'),invalid=JSON.parse(result.answer);delete invalid.coverage;
  const issue=await input.validateOutput!({...result,answer:JSON.stringify(invalid)});
  assert.equal(issue?.code,'coverage');assert.match(issue!.feedback,/every host member key/);
  return result;
 });
 const done=await f.pipeline.run(f.create().id);
 assert.equal(done.status,'completed');assert.equal(done.batches[0].validationFailures![0].code,'coverage');
});

test('the real Codex package path repairs quote feedback on its existing thread before independent review',async t=>{
 const f=await fixture(t,1),executable=join(f.directory,'generated-quote-codex.mjs'),delivered=join(f.directory,'quote-turns.ndjson');
 writeFileSync(join(f.directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-unused-key'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const threadId='generated-'+process.pid,send=value=>process.stdout.write(JSON.stringify(value)+'\\n');let original;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId},approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const context=JSON.parse(m.params.input[0].text),repair=Boolean(context.validationError);original??=context;
  const work=original.untrustedTaskContext.memoryWork,member=work.members[0],review=Boolean(original.untrustedTaskContext.untrustedMemoryDraft);
  appendFileSync(${JSON.stringify(delivered)},JSON.stringify({threadId,repair,review,feedback:context.validationError})+'\\n');
  const value={memories:[{title:'Generated preference',statement:'The owner prefers a blue bowl ['+member.id+']',uncertainty:'One synthetic statement',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Fixture only',attribution:'user'},evidenceIds:[member.id],evidence:[{id:member.id,quote:review||repair?'I prefer a blue bowl.':'I prefer the blue bowl.'}]}],coverage:[{key:member.key,state:'checked',candidateIndexes:[0]}],capacity:{saturated:false}};
  send({id:m.id,result:{turn:{id:'generated-turn'}}});
  send({method:'item/completed',params:{threadId,item:{id:'generated-answer',type:'agentMessage',text:JSON.stringify({answer:JSON.stringify(value),citationIds:[member.id]})}}});
  send({method:'turn/completed',params:{threadId,turn:{status:'completed'}}});
 }
});
`,{mode:0o700});
 const agent=createAgent({reader:{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async({ids})=>f.memories.readEvidence(ids),devices:async()=>[],activity:async()=>({})},protocol:'codex-app-server',model:'generated-only',codex:{executable,home:f.directory},agentTimeoutMs:10000});t.after(()=>agent.close());
 f.setGenerate(input=>agent.query(input));f.setReview(async input=>agent.query(input));
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');
 const calls=readFileSync(delivered,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(calls.length,3);assert.equal(calls[0].threadId,calls[1].threadId);assert.notEqual(calls[1].threadId,calls[2].threadId);
 assert.deepEqual(calls.map(call=>[call.repair,call.review]),[[false,false],[true,false],[false,true]]);
 assert.match(calls[1].feedback,/quote_not_found/);assert.match(calls[1].feedback,/Candidate index: 0/);
 assert.equal(f.seen.length,1);assert.equal(f.reviews.length,1);assert.equal(f.memories.list().length,1);
 assert.deepEqual(done.batches[0].validationFailures?.map(failure=>failure.code),['quote_not_found']);
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
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);assert.equal(f.seen.length,mode==='missing'?4:3);assert.equal(f.reviews.length,mode==='missing'?2:3);
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

for(const broken of ['json','coverage','quote'] as const)test(`invalid ${broken} reviewer output repairs only review and preserves the validated draft`,async t=>{
 const f=await fixture(t);let attempts=0;
 f.setReview(async(input,draft)=>{attempts++;if(attempts>1)return {...draft,runId:'repaired-review'};
  if(broken==='json')return {...draft,answer:'invalid json',runId:'invalid-review'};
  if(broken==='coverage'){const value=JSON.parse(draft.answer);value.coverage=[];return {...draft,answer:JSON.stringify(value),runId:'invalid-review'};}
  const invalid=output(input,'invalid-review',true),value=JSON.parse(invalid.answer);value.memories[0].evidence[0].quote='Invented quote';return {...invalid,answer:JSON.stringify(value)};
 });
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,2);assert.equal(done.batches[0].reviewReceipt?.draftRunId,'extract');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,4);
 assert.deepEqual(done.batches[0].validationFailures?.map(failure=>({phase:failure.phase,runId:failure.runId})),[{phase:'review',runId:'invalid-review'}],'one invalid reviewer response records one reviewer failure, never a failure on the valid draft');
});

for(const variant of ['valid','legacy','missing','saturated','contract','range'] as const)test(`Coding candidate reuse consumes only an exact complete unsaturated artifact: ${variant}`,async t=>{
 const f=await fixture(t,1);
 f.setUnderstand(async preparation=>{
  const member=preparation.memoryWork!.members[0],coverage=variant==='missing'?[]:[{key:member.key,state:'no_candidates',candidateIndexes:[]}];
  const artifact=f.store.archive.save('3'.repeat(64),'generated-coding-'+variant,'1'.repeat(64),{kind:'semantic',text:'Generated interpretation',metadata:{productsVersion:variant==='legacy'?1:2,generationContract:variant==='contract'?'different':preparation.generationContract,complete:true,runId:'authentic-understanding-run',memoryCandidates:[],memoryCoverage:coverage,memoryCapacity:{saturated:variant==='saturated'},evidenceRanges:variant==='range'?[]:preparation.ranges}},f.ids.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'generated-only','1','2'.repeat(64));
  return [{id:artifact.id,revision:artifact.revision}];
 });
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.equal(f.seen.length,variant==='valid'?0:1);assert.equal(f.reviews.length,1);assert.equal(done.batches[0].reviewReceipt?.draftRunId,variant==='valid'?'authentic-understanding-run':'extract');
});

test('compatible reviewers reuse a complete draft when transport target ordering changes',async t=>{
 const f=await fixture(t,2),common={contextTime:'2026-10-01T00:00:00Z',workPackage:{id:'generated-order',goal:'Inspect each selected original independently',instruction:'Preserve each original context and attribution'}};
 const first=f.pipeline.create({...common,evidenceIds:f.ids,recipes:[{id:'mote.personal-memory',version:'2'}]});assert.equal((await f.pipeline.run(first.id)).status,'completed');
 const second=f.pipeline.create({...common,evidenceIds:[...f.ids].reverse(),recipes:[{id:'mote.coding-memory',version:'2'}]});assert.equal((await f.pipeline.run(second.id)).status,'completed');
 assert.equal(f.seen.length,1,'transport order does not change an otherwise exact generation contract');assert.equal(f.reviews.length,2,'each reviewer remains independent');
});
