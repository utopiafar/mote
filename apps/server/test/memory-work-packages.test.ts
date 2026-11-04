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
import {buildContextEnvelope,createAgent,prepareTaskContext} from '@mote/agent';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

function members(input:MemoryPipelineQuery){return (input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;}
function output(input:MemoryPipelineQuery,runId:string,withCandidate=false,coverage=members(input)):QueryResult{
 const first=members(input)[0],memories=withCandidate?[{title:'Generated preference',statement:`The owner prefers a blue bowl [${first.id}]`,uncertainty:'One synthetic statement',admission:{layer:'memory',reason:'An explicit generated preference',scope:'Fixture only',attribution:'user'},evidenceIds:[first.id],evidence:[{id:first.id,quote:'I prefer a blue bowl.'}]}]:[];
 return {runId,trace:[],citations:withCandidate?[{id:first.id,capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:''}]:[],answer:JSON.stringify({memories,coverage:coverage.map(member=>({key:member.key,state:withCandidate&&member.key===first.key?'checked':'no_candidates',candidateIndexes:withCandidate&&member.key===first.key?[0]:[]}))})};
}
async function fixture(t:TestContext,count=4){
 const dir=mkdtempSync(join(tmpdir(),'mote-memory-package-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const ids:string[]=[];for(let i=0;i<count;i++)ids.push((await sources.upsert('generated',{externalId:String(i),revision:'1',text:'I prefer a blue bowl.',observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'})).id);
 const seen:MemoryPipelineQuery[]=[],reviews:MemoryPipelineQuery[]=[];let generate:(input:MemoryPipelineQuery)=>QueryResult|Promise<QueryResult>=input=>output(input,'extract',false),review=(input:MemoryPipelineQuery,draft:QueryResult)=>Promise.resolve({...draft,runId:'review'});
 let understand:((input:ConversationPreparation)=>Promise<{id:string;revision:string}[]|undefined>)|undefined;
 const pipeline=new MemoryPipeline({store,memories,requireAdmission:true,models:{configured:()=>true,model:()=> 'generated-model'},phases:{understand:input=>understand?.(input)??Promise.resolve(undefined),query:async input=>{seen.push(input);return generate(input);},review:(input,draft)=>reviewMemory(input,draft,async reviewed=>{reviews.push(reviewed as MemoryPipelineQuery);return review(reviewed as MemoryPipelineQuery,draft);})}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 // These retained scenarios characterize the old contract under its immutable
 // recipe. New range-evaluation journeys live in memory-range-evaluation.test.ts.
 return {directory:dir,store,sources,memories,pipeline,ids,seen,reviews,setUnderstand(fn:NonNullable<typeof understand>){understand=fn;},setGenerate(fn:typeof generate){generate=fn;},setReview(fn:typeof review){review=fn;},create(){return pipeline.create({evidenceIds:ids,recipes:[{id:'mote.personal-memory',version:'5'}],workPackage:{id:'synthetic-package',goal:'Inspect the authorized originals',instruction:'Preserve independent provenance'}});}};
}

test('wide packages use short exact coverage identities through Codex extraction, repair and independent review',async t=>{
 const f=await fixture(t,20),executable=join(f.directory,'generated-codex.mjs'),delivered=join(f.directory,'delivered.ndjson');
 const summary='Generated derived context. '.repeat(500).slice(0,12000),artifact=f.store.archive.save('3'.repeat(64),'generated-group','1'.repeat(64),{kind:'semantic',text:summary,metadata:{evidenceRanges:f.ids.map(id=>({id,offset:0,length:20}))}},f.ids.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'generated-only','1','2'.repeat(64));
 writeFileSync(join(f.directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-unused-key'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let context,turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-thread',model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const incoming=JSON.parse(m.params.input[0].text);if(incoming.untrustedTaskContext)context=incoming;const work=context.untrustedTaskContext.memoryWork;turns++;
  appendFileSync(${JSON.stringify(delivered)},JSON.stringify({request:context.request,work,repair:Boolean(incoming.validationError),interpretations:context.untrustedTaskContext.untrustedInterpretations,evidenceIds:context.untrustedEvidence.map(r=>r.id),review:Boolean(context.untrustedTaskContext.untrustedMemoryDraft)})+'\\n');
  const value={memories:[],coverage:work.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]})),...(work.workContract==='range-evaluation@1'?{}:{capacity:{saturated:false}})};
  if(turns===1&&!context.untrustedTaskContext.untrustedMemoryDraft)value.coverage[18].key='member_999';
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
 const calls=readFileSync(delivered,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,3);
 assert.deepEqual(calls.map(call=>call.review),[false,false,true]);assert.deepEqual(calls.map(call=>call.repair),[false,true,false]);
 for(const call of calls){assert.equal(call.work.members.length,20);assert.ok(call.work.members.every((m:{key:string},i:number)=>m.key==='member_'+i));assert.deepEqual(new Set(call.evidenceIds),new Set(f.ids));assert.ok(call.request.length<=20000);assert.ok(call.interpretations.includes(summary.slice(0,11000)));assert.equal(call.work.package.instruction,job.workPackage!.instruction);}
 assert.equal(done.batches[0].validationFailures?.length,1,'a foreign alias must be rejected and repaired, never inferred');
 assert.ok(done.batches[0].coverage!.every(m=>/^[a-f0-9]{64}$/.test(m.key)),'publication preserves canonical range identities');
 assert.equal(done.batches[0].reviewReceipt?.decision,'independent');assert.notEqual(done.batches[0].reviewReceipt?.draftRunId,done.batches[0].reviewReceipt?.reviewRunId);
 assert.equal(calls[0].interpretations,calls[1].interpretations);
 assert.ok(calls[0].request.length+calls[0].work.instruction.length+calls[0].work.package.instruction.length+calls[0].interpretations.length>20000,'putting the complete task in question reproduces the former adapter limit');
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,20);
 assert.ok(done.batches[0].coverage!.every(member=>member.state==='no_candidates'));
});

test('a real Central Memory input enters the Memory pack and the runtime keeps its exact host coverage contract',async t=>{
 const f=await fixture(t,2),executable=join(f.directory,'generated-memory-pack-codex.mjs'),delivered=join(f.directory,'memory-pack-context.ndjson');
 writeFileSync(join(f.directory,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-unused-key'}),{mode:0o600});
 writeFileSync(executable,`#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let context;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'generated-memory-pack',model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const incoming=JSON.parse(m.params.input[0].text);context??=incoming;
  const work=context.untrustedTaskContext.memoryWork;
  appendFileSync(${JSON.stringify(delivered)},JSON.stringify({request:context.request,taskId:context.taskId,taskProfile:context.taskProfile,requiredSkill:context.requiredSkill,procedure:context.procedure,work,evidenceIds:context.untrustedEvidence.map(record=>record.id),authorizedContextRanges:context.authorizedContextRanges})+'\\n');
  const value={memories:[],coverage:work.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))};
  send({id:m.id,result:{turn:{id:'generated-turn'}}});
  send({method:'item/completed',params:{threadId:'generated-memory-pack',item:{id:'generated-answer',type:'agentMessage',text:JSON.stringify({answer:JSON.stringify(value),citationIds:[]})}}});
  send({method:'turn/completed',params:{threadId:'generated-memory-pack',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});chmodSync(executable,0o700);
 const agent=createAgent({reader:{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async({ids})=>f.memories.readEvidence(ids),devices:async()=>[],activity:async()=>({})},protocol:'codex-app-server',model:'generated-only',codex:{executable,home:f.directory},agentTimeoutMs:10000});t.after(()=>agent.close());
 let seen:MemoryPipelineQuery|undefined;f.setGenerate(input=>{seen=input;return agent.query(input);});
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.ok(seen);
 const prepared=prepareTaskContext(seen),envelope=buildContextEnvelope(seen,f.memories.readEvidence(seen.evidenceIds));
 assert.equal(prepared.id,'extraction');assert.equal(prepared.version,'1');assert.deepEqual(prepared.profile,{output:'memory-extraction',retrieval:'evidence'});
 assert.equal(prepared.responseMode,'memory-extraction');assert.equal(prepared.skill?.id,'memory-strategy');assert.equal(prepared.skill?.version,'1.0.0');
 assert.equal(envelope.untrustedEvidence.length,seen.evidenceIds.length,'the pack adds no original target');
 const call=JSON.parse(readFileSync(delivered,'utf8').trim());
 assert.equal(call.request,seen.question);assert.equal(call.taskId,'extraction');assert.deepEqual(call.taskProfile,{output:'memory-extraction',retrieval:'evidence'});
 assert.equal(call.requiredSkill,'memory-strategy');assert.equal(call.procedure,prepared.skill.content);
 assert.equal(call.work.members.length,members(seen).length);assert.deepEqual(call.work.members.map((member:{key:string})=>member.key),['member_0','member_1']);
 assert.deepEqual(new Set(call.evidenceIds),new Set(seen.evidenceIds));assert.deepEqual(call.authorizedContextRanges.ranges.map((range:{memberRef?:string})=>range.memberRef),['member_0','member_1'],'the read catalog reuses exact target identities without adding targets');
 assert.deepEqual(done.batches[0].coverage!.map(member=>member.key),members(seen).map(member=>member.key),'the host validator restores and consumes the exact canonical target keys');
 assert.ok(done.batches[0].coverage!.every(member=>member.state==='no_candidates'&&member.memoryIds.length===0));
 assert.equal(f.reviews.length,1,'the pack cannot bypass independent review');assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
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
  assert.equal(issue?.code,'coverage');assert.match(issue!.feedback,/coverage/);
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
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId,model:null},model:m.params.model,serviceTier:m.params.serviceTier,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const context=JSON.parse(m.params.input[0].text),repair=Boolean(context.validationError);original??=context;
  const work=original.untrustedTaskContext.memoryWork,member=work.members[0],review=Boolean(original.untrustedTaskContext.untrustedMemoryDraft);
  appendFileSync(${JSON.stringify(delivered)},JSON.stringify({threadId,repair,review,feedback:context.validationError})+'\\n');
  const value={memories:[{title:'Generated preference',statement:'The owner prefers a blue bowl ['+member.id+']',uncertainty:'One synthetic statement',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Fixture only',attribution:'user'},evidenceIds:[member.id],evidence:[{id:member.id,quote:review||repair?'I prefer a blue bowl.':'I prefer the blue bowl.'}]}],coverage:[{key:member.key,state:'checked',candidateIndexes:[0]}],...(work.workContract==='range-evaluation@1'?{}:{capacity:{saturated:false}})};
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

test('missing coverage remains unfinished without creating recursive packages',async t=>{
 const f=await fixture(t);f.setGenerate(input=>output(input,'large',false,members(input).slice(0,2)));
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'failed');assert.equal(done.batches.length,1);assert.ok(!done.batches[0].supersededBy);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.memories.list().length,0);
});

test('review timeout preserves the private package draft and retries only fresh independent review',async t=>{
 const f=await fixture(t);f.setReview(async()=>{throw new ProviderFailure({category:'permanent',code:'provider_timeout',retryAfterMs:0});});const job=f.create(),failed=await f.pipeline.run(job.id);
 assert.equal(failed.status,'failed');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_extraction_drafts').get()!.n,1);
 f.setReview(async(_input,draft)=>({...draft,runId:'new-review'}));const done=await f.pipeline.retry(job.id);assert.equal(done.status,'completed');assert.equal(f.seen.length,1);assert.equal(f.reviews.length,2);
});

test('unresolved context stays visible without granting another original or publishing a candidate',async t=>{
 const f=await fixture(t,1);f.setGenerate(input=>{const result=output(input,'needs-context');const parsed=JSON.parse(result.answer);parsed.coverage[0]={key:members(input)[0].key,state:'needs_context',candidateIndexes:[],reason:'Requires explicitly authorized earlier context',contextRefs:['material:unread']};return {...result,answer:JSON.stringify(parsed)};});
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'waiting_for_input');assert.equal(done.errorCode,'memory_context_required');assert.equal(done.batches[0].coverage![0].state,'needs_context');assert.deepEqual(done.batches[0].coverage![0].contextRefs,['material:unread']);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.memories.list().length,0);assert.deepEqual(f.reviews[0].evidenceIds,f.ids);
});

test('a revised input fences the entire old package without a candidate capacity',async t=>{
 const f=await fixture(t);const job=f.create();assert.equal((f.pipeline.get(job.id).workPackage?.id),'synthetic-package');
 f.setGenerate(input=>{assert.equal((input.taskContext!.memoryWork as {maxCandidates?:number}).maxCandidates,undefined);return output(input,'old',false);});
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

for(const variant of ['valid','missing'] as const)test(`Coding candidate reuse consumes only an exact complete artifact: ${variant}`,async t=>{
 const f=await fixture(t,1);
 f.setUnderstand(async preparation=>{
  const member=preparation.memoryWork!.members[0],coverage=variant==='missing'?[]:[{key:member.key,state:'no_candidates',candidateIndexes:[]}];
  const artifact=f.store.archive.save('3'.repeat(64),'generated-coding-'+variant,'1'.repeat(64),{kind:'semantic',text:'Generated interpretation',metadata:{productsVersion:3,workContract:'range-evaluation@1',generationContract:preparation.generationContract,complete:true,runId:'authentic-understanding-run',memoryCandidates:[],memoryCoverage:coverage,evidenceRanges:preparation.ranges}},f.ids.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'generated-only','1','2'.repeat(64));
  return [{id:artifact.id,revision:artifact.revision}];
 });
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.equal(f.seen.length,variant==='valid'?0:1);assert.equal(f.reviews.length,1);assert.equal(done.batches[0].reviewReceipt?.draftRunId,variant==='valid'?'authentic-understanding-run':'extract');
});

for(const variant of ['selected','legacy-products','legacy-contract','incomplete'] as const)test(`range evaluation reuses only a product carrying its frozen assessment contract: ${variant}`,async t=>{
 const f=await fixture(t,1);
 f.setUnderstand(async preparation=>{
  assert.equal(preparation.memoryWork!.workContract,'range-evaluation@1');const member=preparation.memoryWork!.members[0],coverage=[{key:member.key,state:variant==='incomplete'?'incomplete':'no_candidates',candidateIndexes:[],...(variant==='incomplete'?{reason:'Generated producer did not assess all supplied input'}:{})}];
  const metadata={productsVersion:variant==='legacy-products'?2:3,...(variant==='legacy-contract'?{}:{workContract:'range-evaluation@1'}),generationContract:preparation.generationContract,complete:true,runId:'generated-selected-understanding',memoryCandidates:[],memoryCoverage:coverage,evidenceRanges:preparation.ranges};
  const artifact=f.store.archive.save('3'.repeat(64),'generated-selected-'+variant,'1'.repeat(64),{kind:'semantic',text:'Generated navigation',metadata},f.ids.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'generated-only','1','2'.repeat(64));return [{id:artifact.id,revision:artifact.revision}];
 });
 const job=f.pipeline.create({evidenceIds:f.ids,workPackage:{id:'generated-selected-reuse',goal:'Assess the generated target',instruction:'Select useful context after complete range assessment'}}),done=await f.pipeline.run(job.id);
 assert.equal(done.status,'completed');assert.equal(f.seen.length,variant==='selected'?0:1);assert.equal(f.reviews.length,1);assert.equal(done.batches[0].reviewReceipt?.draftRunId,variant==='selected'?'generated-selected-understanding':'extract');
});

test('compatible reviewers reuse a complete draft when transport target ordering changes',async t=>{
 const f=await fixture(t,2),common={contextTime:'2026-10-01T00:00:00Z',workPackage:{id:'generated-order',goal:'Inspect each selected original independently',instruction:'Preserve each original context and attribution'}},current=f.pipeline.strategies.resolve({id:'mote.personal-memory',version:'5'}).binding,review={id:'generated.order-review',version:'1'};
 f.pipeline.strategies.registerReview({...review,input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'Generated independent ordering reviewer'});
 const sibling={id:'generated.order-memory',version:'1'};
 f.pipeline.strategies.registerRecipe({...sibling,workContract:'range-evaluation@1',extract:{id:current.extract.id,version:current.extract.version},review:{id:review.id,version:review.version}});
 const first=f.pipeline.create({...common,evidenceIds:f.ids,recipes:[{id:'mote.personal-memory',version:'5'}]});assert.equal((await f.pipeline.run(first.id)).status,'completed');
 const second=f.pipeline.create({...common,evidenceIds:[...f.ids].reverse(),recipes:[sibling]});assert.equal((await f.pipeline.run(second.id)).status,'completed');
 assert.equal(f.seen.length,1,'transport order does not change an otherwise exact generation contract');assert.equal(f.reviews.length,2,'each reviewer remains independent');
});

for(const count of [1,4])test(`actual provider context rejection for ${count} target members stays terminal without splitting`,async t=>{
 const f=await fixture(t,count);f.setGenerate(()=>{throw new ProviderFailure({category:'permanent',code:'processing_limit'});});
 const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'failed');assert.equal(done.batches.length,1);assert.equal(done.batches[0].errorCode,'processing_limit');assert.equal(done.batches[0].attempts,1);assert.equal(f.reviews.length,0);assert.equal(f.memories.list().length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});

test('schema and coverage repair identify exact host fields without leaking rejected values',async t=>{
 const f=await fixture(t,2);f.setGenerate(async input=>{
  const valid=output(input,'generated-contract',true),draft=JSON.parse(valid.answer);draft.memories[0].evidence[0].id='generated-invalid-id-do-not-echo';
  let issue=await input.validateOutput!({...valid,answer:JSON.stringify(draft)});assert.equal(issue?.code,'schema');assert.match(issue!.feedback,/memories\[0\]\.evidence\[0\]\.id/);assert.match(issue!.feedback,/coverage/i);assert.ok(!issue!.feedback.includes('generated-invalid-id-do-not-echo'));
  draft.memories[0].evidence[0].id=members(input)[0].id;delete draft.coverage;issue=await input.validateOutput!({...valid,answer:JSON.stringify(draft)});assert.equal(issue?.code,'coverage');assert.match(issue!.feedback,/Host field: coverage/);assert.match(issue!.feedback,/needs_owner_input/);
  const bad=JSON.parse(valid.answer);bad.coverage[1].key+='a';issue=await input.validateOutput!({...valid,answer:JSON.stringify(bad)});assert.match(issue!.feedback,/coverage\[1\]\.key/);return valid;
 });const done=await f.pipeline.run(f.create().id);assert.equal(done.status,'completed');assert.equal(f.reviews.length,1);
});
