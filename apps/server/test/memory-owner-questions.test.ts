import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readMemoryWorkCoverage,memoryWorkInstruction,type MemoryWorkMember,type MemoryOwnerQuestion} from '../src/memory-work-contract.js';
import {reviewMemory} from '../src/memory-review.js';
import type {QueryResult} from '@mote/shared';

const original='Speaker A: I felt pressured at work. Speaker A: Could you describe what happened? Participant: My name is Rowan.';
const member:MemoryWorkMember={key:'a'.repeat(64),id:'generated-evidence',offset:0,length:original.length,fingerprint:'b'.repeat(64),state:'pending',memoryIds:[]};
const question:MemoryOwnerQuestion={prompt:'Are you the person describing pressure at work, the person responding, or neither?',choices:[{id:'describing',label:'Describing the pressure',answer:'I am the person describing the pressure.'},{id:'responding',label:'Responding',answer:'I am the person responding.'},{id:'neither',label:'Neither',answer:'I did not participate.'}],evidence:[{id:member.id,quote:'I felt pressured at work.'}],reason:'The transcript mixes both roles under one label and does not establish owner correspondence.'};
const output=(coverage:unknown,memories:unknown[]=[]):QueryResult=>({runId:'generated-run',answer:JSON.stringify({memories,coverage,capacity:{saturated:false}}),citations:[],trace:[]});
const ownerRow=(changes:Record<string,unknown>={})=>({key:member.key,state:'needs_owner_input',candidateIndexes:[],question,...changes});
const read=(result:QueryResult,members=[member])=>readMemoryWorkCoverage(result,members,8,id=>id===member.id?original:undefined);

test('a reviewed owner question accounts for its inspected range without claiming completion',()=>{
 const parsed=read(output([ownerRow()]));assert.equal(parsed.incomplete,true);assert.deepEqual(parsed.missing,[]);assert.deepEqual(parsed.needsOwnerInput[0].question,question);assert.equal(parsed.saturated,false);
});

test('independent observed context may survive an owner question in the same range',()=>{
 const candidate={title:'Generated conversation',statement:`A participant described work pressure [${member.id}]`,uncertainty:'The speaker is not identified as the owner.',admission:{layer:'observation',reason:'Conversation context for later recall',scope:'This generated conversation',attribution:'observed'},evidenceIds:[member.id],evidence:[{id:member.id,quote:'I felt pressured at work.'}]};
 const parsed=read(output([ownerRow({candidateIndexes:[0]})],[candidate]));assert.deepEqual(parsed.coverage[0].candidateIndexes,[0]);assert.equal(parsed.incomplete,true);
});

for(const invalid of ['missing-question','question-on-completed','duplicate-choice','invalid-choice-id','outside-member','invented-quote','outside-range','wrong-offset'] as const)test(`owner question rejects ${invalid} without trusting generated prose`,()=>{
 let row=ownerRow(),members=[member];
 if(invalid==='missing-question')delete row.question;
 if(invalid==='question-on-completed')row.state='no_candidates';
 if(invalid==='duplicate-choice')row.question={...question,choices:[question.choices[0],question.choices[0]]};
 if(invalid==='invalid-choice-id')row.question={...question,choices:[{...question.choices[0],id:'choice with spaces'}]};
 if(invalid==='outside-member')row.question={...question,evidence:[{id:'ungranted-evidence',quote:'I felt pressured at work.'}]};
 if(invalid==='invented-quote')row.question={...question,evidence:[{id:member.id,quote:'I am the owner.'}]};
 if(invalid==='outside-range')members=[{...member,offset:original.indexOf('Participant:'),length:'Participant: My name is Rowan.'.length}];
 if(invalid==='wrong-offset')row.question={...question,evidence:[{id:member.id,quote:'I felt pressured at work.',offset:0}]};
 assert.throws(()=>read(output([row]),members));
});

test('a named participant without owner correspondence asks about the relationship, not another name search',()=>{
 const named={...question,prompt:'Are you the participant who introduced themself as Rowan?',choices:[],evidence:[{id:member.id,quote:'My name is Rowan.'}],reason:'The participant name is stated, but the archive does not establish that Rowan is the owner.'};
 assert.equal(read(output([ownerRow({question:named})])).needsOwnerInput[0].question?.prompt,named.prompt);
 const instruction=memoryWorkInstruction([member],8);assert.match(instruction,/participant's name or role does not establish/);assert.match(instruction,/both sides of a conversation/);assert.match(instruction,/previously examined exact target\/context vectors/);
});

test('useful additional evidence remains separate from owner-only information and completed uncertainty',()=>{
 const contextual=read(output([{key:member.key,state:'needs_context',candidateIndexes:[],reason:'A separately authorized participant roster identifies this utterance.',contextRefs:['generated-roster-range']}]))
 assert.equal(contextual.incomplete,true);assert.deepEqual(contextual.needsOwnerInput,[]);
 const completed=read(output([{key:member.key,state:'no_candidates',candidateIndexes:[],reason:'Fully inspected; uncertain attribution has no meaningful selected memory.'}]));assert.equal(completed.incomplete,false);assert.deepEqual(completed.needsOwnerInput,[]);
});

test('the independent review inspects a direct owner question even with zero memory candidates',async()=>{
 const draft=output([ownerRow()]);let calls=0;
 const reviewed=await reviewMemory({question:'Inspect this generated conversation.',taskContext:{turns:[],memoryWork:{members:[member]}},evidenceIds:[member.id],evidenceRanges:[{id:member.id,offset:0,length:original.length}]},draft,async input=>{calls++;assert.equal(input.traceContext?.phase,'review');assert.match(input.question,/Verify owner questions/);assert.match(input.question,/without guessing|does not establish owner identity/);return {...draft,runId:'generated-independent-review'};});
 assert.equal(calls,1);assert.equal(reviewed.runId,'generated-independent-review');assert.deepEqual(read(reviewed).needsOwnerInput[0].question,question);
});

import {type TestContext} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import {fixtureMemoryPlan} from './fixtures/memory-planning.js';
import type {MemoryFeedbackRequest} from '../src/memory-feedback.js';

async function httpFixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-owner-questions-'));
 const config:Config={dataDir:directory,token:'generated-owner-question-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,memoryConcurrency:1,logLevel:'silent'};
 const calls:QueryInput[]=[],anchors=new Map<string,string[]>(),control={replyDisposition:'resolved' as 'resolved'|'followup'|'unknown',ownerObservation:false,contextUnresolved:false};
 const generate=async(input:QueryInput):Promise<QueryResult>=>{
  calls.push(input);if(input.taskContext?.ownerClarificationReply)return {runId:'generated-answer-interpretation',answer:JSON.stringify({disposition:control.replyDisposition,...(control.replyDisposition==='followup'?{prompt:'Which utterance in this generated conversation belongs to you?'}:{})}),citations:[],trace:[]};if(input.traceContext?.phase==='feedback-planning'){const request=(input.taskContext!.memoryWork as {feedback:MemoryFeedbackRequest}).feedback,background=request.authorized.find(target=>node.memories.readEvidence([target.id])[0].ocrText.includes('Wholly generated independent record'))!;assert.ok(background);await input.hostControlChannel!.execute('delegation_submit',{units:[{id:'generated-context-only',capabilityId:'memory.feedback-group',title:'Inspect the generated missing background',goal:'Resolve only the actual evidence gap',input:{memberKeys:request.targets.map(target=>target.key),contextKeys:[background.key],instruction:'Use the specifically authorized background for this generated dependent range.'}}]});return {runId:'generated-context-plan',answer:'Generated scoped context plan submitted.',citations:[],trace:[]};}const plan=await fixtureMemoryPlan(input);if(plan)return plan;
  const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}|undefined)?.members;assert.ok(members,'production Memory must apply reviewed coverage to ordinary recipe jobs');
  const memories:any[]=[],coverage:any[]=[];
  for(const target of members){
   const text=node.memories.readEvidence([target.id])[0].ocrText.slice(target.offset,target.offset+target.length);
   const declared=Boolean(target.attributionContext?.ownerStatements?.length);
   if(text.includes('Wholly generated requires background')){const contextual=(input.taskContext!.memoryWork as {contextMembers?:MemoryWorkMember[]}).contextMembers?.length;if(contextual&&!control.contextUnresolved)coverage.push({key:target.key,state:'no_candidates',candidateIndexes:[],reason:'The specifically authorized generated background completes interpretation.'});else {const background=((input.taskContext!.memoryWork as {authorizedMembers?:MemoryWorkMember[]}).authorizedMembers??members).find(value=>node.memories.readEvidence([value.id])[0].ocrText.includes('Wholly generated independent record'));coverage.push({key:target.key,state:'needs_context',candidateIndexes:[],reason:'The separately authorized generated background supplies the missing referent.',contextRefs:background?[background.key]:[]});}continue;}
   if(!text.includes('I felt pressured at work.')&&!text.includes('I felt proud of my prototype.')&&!text.includes('Wholly generated requires background')){coverage.push({key:target.key,state:'no_candidates',candidateIndexes:[],reason:'Fully inspected generated neutral context.'});continue;}
   if(text.includes('I felt proud of my prototype.')||declared){
    const index=memories.length;memories.push({domain:'personal',title:text.includes('I felt proud of my prototype.')?'Generated prototype pride':'Generated work pressure',statement:`${text.includes('I felt proud of my prototype.')?'The owner felt proud of the prototype':'The owner felt pressured at work'} [${target.id}]`,uncertainty:'This generated record only.',admission:{layer:'memory',reason:'An expressed personally meaningful experience',scope:'Generated prototype',attribution:'user'},evidenceIds:[target.id],evidence:[{id:target.id,quote:text.includes('I felt proud of my prototype.')?'I felt proud of my prototype.':'I felt pressured at work.'}]});coverage.push({key:target.key,state:'checked',candidateIndexes:[index]});
   }else {const candidateIndexes:number[]=[];if(control.ownerObservation){candidateIndexes.push(memories.length);memories.push({domain:'personal',title:'Generated conversation context',statement:`A participant described work pressure [${target.id}]`,uncertainty:'The participant is not identified as the owner.',admission:{layer:'observation',reason:'A useful generated conversational context',scope:'This conversation only',attribution:'observed'},evidenceIds:[target.id],evidence:[{id:target.id,quote:'I felt pressured at work.'}]});}coverage.push({key:target.key,state:'needs_owner_input',candidateIndexes,question:{...question,evidence:[{id:target.id,quote:'I felt pressured at work.'}]}});}
  }
  return {runId:'generated-http-'+calls.length,answer:JSON.stringify({memories,coverage,capacity:{saturated:false}}),citations:memories.flatMap(memory=>memory.evidenceIds.map((id:string)=>({id,capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:''}))),trace:[]};
 };
 const dependencies={backgroundWorker:false,agent:{configured:true,close:async()=>{},query:generate},createModelAgent:async()=>({configured:true,close:async()=>{},query:generate})};
 let node=await buildApp(config,dependencies);await node.app.ready();
 const disable=()=>{const settings=node.lifecycle.settings();for(const id of ['working','consolidation','insights'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);};disable();
 const api=(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const add=async(externalId:string,text=original)=>{
  if(!node.sources.listSources().some(source=>source.id==='generated-dialogues')){const response=await api('POST','/api/sources',{id:'generated-dialogues',name:'Generated conversations',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});assert.equal(response.statusCode,200,response.body);}
  const response=await api('PUT','/api/sources/generated-dialogues/items',{externalId,revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text,document:{contentRole:'transcript',recordedAt:'2026-09-01T00:00:00Z',timeBasis:'recorded'}});assert.equal(response.statusCode,200,response.body);await node.materialOrganizer.tick();await node.sourcePipelines.tick();const id=response.json().id as string,material=node.materials.list({sourceId:'generated-dialogues'}).items.find(value=>value.origin.externalId===externalId)!;assert.ok(material);anchors.set(id,node.materials.evidenceIds(material.ref));return id;
 };
 const start=async(ids:string[],recipe={id:'mote.personal-memory',version:'2'})=>{const response=await api('POST','/api/memory-jobs',{evidenceIds:ids.flatMap(id=>anchors.get(id)??[id]),recipes:[recipe]});assert.equal(response.statusCode,202,response.body);return node.memoryPipeline.run(response.json().id);};
 return {get node(){return node;},api,add,start,calls,control,async questions(workId?:string){const response=await api('GET','/api/owner-questions'+(workId?'?operationId='+encodeURIComponent('memory:'+workId):''));assert.equal(response.statusCode,200,response.body);return response.json().items as any[];},async restart(){await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();disable();}};
}

test('ordinary recipe work asks the owner directly and remains dormant across retry and restart',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]);
 assert.equal(job.status,'waiting_for_input');assert.equal(job.errorCode,'memory_owner_input_required');
 const questions=await f.questions(job.id);assert.equal(questions.length,1);assert.equal(questions[0].messages[0].role,'assistant');assert.equal(questions[0].prompt,question.prompt);
 assert.equal(f.calls.filter(input=>input.traceContext?.phase==='feedback-planning').length,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_feedback_plans').get()!.n,0);assert.equal(f.node.memories.list().length,0);
 const before=f.calls.length;await f.node.memoryPipeline.retry(job.id);assert.equal(f.calls.length,before);await f.restart();await f.node.memoryPipeline.run(job.id);assert.equal(f.calls.length,before);assert.equal((await f.questions(job.id))[0].id,questions[0].id);
 const independent=await f.add('subsequent-independent','Wholly generated independent record: I felt proud of my prototype.'),next=await f.start([independent]);assert.equal(next.status,'completed');assert.equal(next.memoryIds.length,1,'a dormant question releases execution capacity for another job');assert.equal((await f.questions(job.id))[0].id,questions[0].id);
});

test('an unanswered identity does not withhold an independently reviewed sibling result',{timeout:30000},async t=>{
 const f=await httpFixture(t),unknown=await f.add('anonymous'),independent=await f.add('independent','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([unknown,independent]);
 assert.equal(job.status,'waiting_for_input');assert.equal(job.memoryIds.length,1);assert.equal(f.node.memories.get(job.memoryIds[0]).reviewReceipt?.decision,'independent');assert.equal((await f.questions(job.id)).length,1);
 const checkpointIds=f.node.store.db.prepare('SELECT evidence_id FROM memory_checkpoints').all().map(row=>row.evidence_id);assert.equal(checkpointIds.length,1);
 const ownerTargets=job.batches.flatMap(batch=>batch.coverage??[]).filter(target=>target.state==='needs_owner_input');assert.ok(ownerTargets.length);assert.ok(ownerTargets.every(target=>!checkpointIds.includes(target.id)));
 const before=f.calls.length,memory=JSON.stringify(f.node.memories.get(job.memoryIds[0]));await f.node.memoryPipeline.retry(job.id);assert.equal(f.calls.length,before);assert.equal(JSON.stringify(f.node.memories.get(job.memoryIds[0])),memory);
});

for(const mutation of ['delete','correction','cancel'] as const)test(`${mutation} makes the old Memory question unable to resume processing`,{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]),[pending]=await f.questions(job.id);assert.ok(pending);
 if(mutation==='delete')f.node.store.delete(id);
 if(mutation==='correction'){const response=await f.api('PUT','/api/sources/generated-dialogues/items',{externalId:'anonymous',revision:'2',observedAt:'2026-09-02T00:00:00Z',kind:'message',layer:'original',text:'Generated corrected dialogue: no participant correspondence is supplied.'});assert.equal(response.statusCode,200,response.body);await f.node.materialOrganizer.tick();}
 if(mutation==='cancel'){const response=await f.api('POST','/api/memory-jobs/'+job.id+'/cancel');assert.equal(response.statusCode,200,response.body);}
 const before=f.calls.length,response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',choiceId:'describing'});assert.equal(response.statusCode,409,response.body);assert.equal(f.calls.length,before);assert.equal(f.node.memories.list().length,0);
});

test('an explicit choice creates one current scoped continuation and receives a fresh independent review',{timeout:30000},async t=>{
 const f=await httpFixture(t),unknown=await f.add('anonymous'),independent=await f.add('independent','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([unknown,independent]),[pending]=await f.questions(job.id);
 const original=f.node.store.evidence([unknown])[0].ocrText,before=f.calls.length,reply={requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',choiceId:'describing'};
 const response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',reply);assert.equal(response.statusCode,200,response.body);const answered=response.json();assert.equal(answered.state,'answered');assert.ok(answered.continuationId);assert.equal(answered.messages.at(-1).role,'user');assert.equal(answered.messages.at(-1).text,question.choices[0].answer);
 const continuation=await f.node.memoryPipeline.run(answered.continuationId.replace(/^memory:/,''));assert.equal(continuation.status,'completed');assert.equal(continuation.memoryIds.length,1);
 const addedCalls=f.calls.slice(before);assert.equal(addedCalls.length,2,'an explicit authored choice needs extraction and independent review, without reply interpretation');assert.deepEqual(addedCalls.map(input=>input.traceContext?.phase),['extract','review']);
 for(const input of addedCalls){const targets=(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;assert.equal(targets.length,1,'the already completed sibling is not processed again');assert.equal(targets[0].attributionContext?.ownerStatements?.at(-1)?.answer,question.choices[0].answer);}
 assert.equal(f.node.memories.get(continuation.memoryIds[0]).reviewReceipt?.decision,'independent');assert.equal(f.node.store.evidence([unknown])[0].ocrText,original,'owner declarations never rewrite original content');
 const count=f.calls.length,jobs=f.node.memoryPipeline.list().length;const duplicate=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',reply);assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.json().continuationId,answered.continuationId);assert.equal(f.calls.length,count);assert.equal(f.node.memoryPipeline.list().length,jobs);
 await f.restart();const restarted=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',reply);assert.equal(restarted.statusCode,200,restarted.body);assert.equal(restarted.json().continuationId,answered.continuationId);assert.equal(f.calls.length,count);
});

test('an unknown answer ends the current evaluation without inventing an identity or replaying work',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]),[pending]=await f.questions(job.id),before=f.calls.length;
 const response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'unknown'});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().state,'closed');assert.equal(response.json().continuationId,undefined);
 const completed=await f.node.memoryPipeline.run(job.id);assert.equal(completed.status,'completed');assert.equal(f.calls.length,before);assert.equal(f.node.memories.list().length,0);
 await f.node.memoryPipeline.retry(job.id);await f.restart();await f.node.memoryPipeline.run(job.id);assert.equal(f.calls.length,before);assert.equal((await f.questions(job.id))[0].state,'closed');
});

test('a tentative free-text answer receives a followup instead of becoming an owner declaration',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]),[pending]=await f.questions(job.id),before=f.calls.length;f.control.replyDisposition='followup';
 const response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',answer:'I might have been the person describing it, but I am not certain.'});assert.equal(response.statusCode,200,response.body);const followup=response.json();assert.equal(followup.state,'open');assert.equal(followup.continuationId,undefined);assert.equal(followup.messages.at(-1).role,'assistant');assert.equal(f.calls.length,before+1,'only answer sufficiency is interpreted; extraction does not resume');assert.equal(f.node.memories.list().length,0);assert.equal(f.node.memoryPipeline.list().length,1);
 await f.node.memoryPipeline.run(job.id);assert.equal(f.calls.length,before+1);
});

import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';

test('exact owner replies remain encrypted, scoped to one material and recoverable after reopen',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-generated-owner-declarations-')),options={dataKey:'ac'.repeat(32),contentEncryptionEnabled:true};let store=new Store(directory,options),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const sources=new SourceStore(store);sources.register({id:'generated',name:'Generated conversations',kind:'custom',deviceId:'generated',platform:'import'});
 const publish=async(externalId:string)=>{const source=await sources.upsert('generated',{externalId,revision:'1',kind:'message',layer:'original',observedAt:'2026-09-01T00:00:00Z',text:original});return materials.publish({id:materialId('generated',externalId),kind:'mote.message',schemaVersion:1,title:'Generated anonymous conversation',origin:{sourceId:'generated',externalId},blocks:[{id:'body',kind:'text',format:'plain',text:original,memberIds:[source.id]}],members:[{id:source.id,kind:'capture',ref:'capture:'+source.id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});};
 const target=await publish('target'),other=await publish('other'),marker='GENERATED_OWNER_DECLARATION_EXACT_REPLY',declaration={id:randomUUID(),question:question.prompt,answer:marker+' I am the person describing pressure, but not the respondent.'};
 const revised=materials.declareContext(target.id,target.revision,declaration);assert.notEqual(revised.revision,target.revision);assert.deepEqual(revised.attributionContext?.ownerStatements,[declaration]);assert.equal(materials.get(other.id)?.attributionContext?.ownerStatements,undefined,'a speaker label never establishes correspondence in another material');
 const duplicate=materials.declareContext(target.id,revised.revision,declaration);assert.equal(duplicate.revision,revised.revision);
 const declarationRows=store.db.prepare('SELECT json FROM material_owner_declarations').all();assert.equal(declarationRows.length,1);assert.match(String(declarationRows[0].json),/aes:/);assert.ok(!String(declarationRows[0].json).includes(marker));
 for(const row of store.db.prepare('SELECT manifest FROM material_revisions').all())assert.ok(!String(row.manifest).includes(marker),'public material manifests contain declaration fingerprints, not owner prose');
 const proof=materials.evidence(materials.evidenceIds(revised.ref))[0];assert.deepEqual(proof.attributionContext?.ownerStatements,[declaration]);
 store.close();store=new Store(directory,options);materials=new MaterialStore(store);assert.deepEqual(materials.get(target.id)?.attributionContext?.ownerStatements,[declaration]);assert.equal(materials.get(other.id)?.attributionContext?.ownerStatements,undefined);
});

test('supported context in the questioned range commits without a full-range checkpoint',{timeout:30000},async t=>{
 const f=await httpFixture(t);f.control.ownerObservation=true;const id=await f.add('anonymous'),job=await f.start([id]);assert.equal(job.status,'waiting_for_input');assert.equal(job.memoryIds.length,1);
 const saved=f.node.memories.get(job.memoryIds[0]);assert.equal(saved.admission?.layer,'observation');assert.equal(saved.admission?.attribution,'observed');assert.equal(saved.reviewReceipt?.decision,'independent');assert.equal((await f.questions(job.id)).length,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
 const target=job.batches.flatMap(batch=>batch.coverage??[]).find(value=>value.state==='needs_owner_input')!;assert.deepEqual(target.memoryIds,job.memoryIds);const before=f.calls.length;await f.node.memoryPipeline.retry(job.id);assert.equal(f.calls.length,before);assert.equal(f.node.memories.list().length,1);
});

test('removing the selected recipe prevents an old owner question from creating a continuation',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),base=f.node.memoryStrategies.resolve({id:'mote.personal-memory',version:'2'}),review={id:'generated.owner-review',version:'1'},recipe={id:'generated.owner-recipe',version:'1'};
 const removeReview=f.node.memoryStrategies.registerReview({...review,input:'memory-candidates@1',output:'memory-candidates@1',permissions:['evidence.read'],policy:'Independently review this wholly generated conversation and its owner question.'});
 const removeRecipe=f.node.memoryStrategies.registerRecipe({...recipe,extract:{id:base.extract.id,version:base.extract.version},review});t.after(()=>{removeRecipe();removeReview();});
 const job=await f.start([id],recipe),[pending]=await f.questions(job.id);assert.ok(pending);removeRecipe();const before=f.calls.length;
 const response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',choiceId:'describing'});assert.equal(response.statusCode,409,response.body);assert.equal(f.calls.length,before);assert.equal(f.node.memoryPipeline.list().length,1);
});

import {ContentStorageService} from '../src/content-storage.js';
import {OwnerQuestions} from '../src/owner-questions.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';

test('managed decryption converts owner questions and declarations before retiring the encryption key',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-owner-declarations-decryption-')),store=new Store(directory,{dataKey:'ac'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),materials=new MaterialStore(store),files=new FileStore(store,sources),archived=new ArchivedFileStore(store),service=new ContentStorageService(store,files,archived);
 t.after(async()=>{await service.close();store.close();rmSync(directory,{recursive:true,force:true});});sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const originalRecord=await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-09-01T00:00:00Z',text:original,kind:'message',layer:'original'}),material=materials.publish({id:materialId('generated','one'),kind:'mote.message',schemaVersion:1,title:'Generated declaration migration',origin:{sourceId:'generated',externalId:'one'},blocks:[{id:'body',kind:'text',format:'plain',text:original,memberIds:[originalRecord.id]}],members:[{id:originalRecord.id,kind:'capture',ref:'capture:'+originalRecord.id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}}),declaration={id:randomUUID(),question:question.prompt,answer:'I am the person describing the pressure in this generated dialogue.'};
 materials.declareContext(material.id,material.revision,declaration);assert.match(String(store.db.prepare('SELECT json FROM material_owner_declarations').get()!.json),/aes:/);
 const questions=new OwnerQuestions(store),provider={id:'generated.decryption',version:'1'};questions.register({...provider,installationEpoch:'generated-decryption@1',validate:()=>true,answer:async()=>({kind:'closed',outcome:'Generated test only.'})});const pending=questions.create(provider,{key:'generated',operationId:'generated-decryption',workId:'generated-decryption',title:'Generated encryption question',prompt:question.prompt,choices:question.choices,evidence:[{id:originalRecord.id,quote:'I felt pressured at work.'}],dependencyIds:[originalRecord.id]});assert.match(String(store.db.prepare('SELECT json FROM owner_questions').get()!.json),/aes:/);
 service.configure(false);service.start();for(let attempt=0;attempt<1000&&service.snapshot().job.state==='running';attempt++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(service.snapshot().job.state,'completed');assert.equal(service.snapshot().job.failed,0);assert.match(String(store.db.prepare('SELECT json FROM material_owner_declarations').get()!.json),/json:/);assert.deepEqual(materials.get(material.id)?.attributionContext?.ownerStatements,[declaration]);
 const reopened=new Store(directory);try{assert.deepEqual(new MaterialStore(reopened).get(material.id)?.attributionContext?.ownerStatements,[declaration]);assert.equal(new OwnerQuestions(reopened).get(pending.id).prompt,question.prompt);assert.match(String(reopened.db.prepare('SELECT json FROM owner_questions').get()!.json),/json:/);}finally{reopened.close();}
});

test('mixed owner questions and actual context gaps preserve independent results and plan only the evidence gap',{timeout:30000},async t=>{
 const f=await httpFixture(t),settings=f.node.lifecycle.settings();settings.batchCharacters=600;f.node.lifecycle.configure(settings);const owner=await f.add('anonymous'),context=await f.add('dependent','Wholly generated requires background: that earlier trial supplies the referent.'),background=await f.add('background','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([owner,context,background]);assert.equal(job.status,'waiting_for_input');assert.equal((await f.questions(job.id)).length,1);assert.equal(job.memoryIds.length,1);
 const planning=f.calls.filter(input=>input.traceContext?.phase==='feedback-planning');assert.equal(planning.length,1);const request=(planning[0].taskContext!.memoryWork as {feedback:MemoryFeedbackRequest}).feedback;assert.equal(request.targets.length,1);assert.ok(f.node.memories.readEvidence([request.targets[0].id])[0].ocrText.includes('Wholly generated requires background'));
 const extracts=f.calls.filter(input=>input.traceContext?.phase==='extract');assert.equal(extracts.length,4,'three independent batches plus the scoped followup, without an intermediate extraction');assert.ok((planning[0].taskContext!.memoryWork as {feedback:MemoryFeedbackRequest}).feedback.history?.some(inspection=>inspection.targets.some(target=>target.state==='needs_context')));assert.ok((extracts.at(-1)!.taskContext!.memoryWork as {history?:unknown[]}).history?.length);const followup=extracts.find(input=>Boolean((input.taskContext!.memoryWork as {contextMembers?:MemoryWorkMember[]}).contextMembers?.length))!,targets=(followup.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members;assert.equal(targets.length,1);assert.equal(targets[0].id,request.targets[0].id);
 const unresolved=job.batches.flatMap(batch=>batch.coverage??[]).filter(target=>target.state==='needs_owner_input');assert.ok(unresolved.length);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2,'only independently completed and resolved-context ranges receive checkpoints');
 const before=f.calls.length;await f.node.memoryPipeline.retry(job.id);assert.equal(f.calls.length,before);assert.equal(f.node.memories.list().length,1);
});

test('a clarified material reevaluates its authorized sibling ranges while other materials stay completed',{timeout:30000},async t=>{
 const f=await httpFixture(t),settings=f.node.lifecycle.settings();settings.batchCharacters=256;f.node.lifecycle.configure(settings);
 const compound=await f.add('compound',original+' '+'Generated neutral context. '.repeat(15)+'Wholly generated independent record: I felt proud of my prototype.'),other=await f.add('other','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([compound,other]),[pending]=await f.questions(job.id);assert.ok(pending);assert.equal((await f.questions(job.id)).length,1);assert.equal(job.memoryIds.length,2);
 const material=f.node.materials.list({sourceId:'generated-dialogues'}).items.find(value=>value.origin.externalId==='compound')!,current=f.node.materials.evidenceIds(material.ref),authorized=job.batches.flatMap(batch=>batch.evidenceRanges).filter(range=>current.includes(range.id));assert.ok(authorized.length>1);assert.ok(job.batches.flatMap(batch=>batch.coverage??[]).some(member=>member.materialRef===material.ref&&member.state==='checked'));
 const before=f.calls.length,response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',choiceId:'describing'});assert.equal(response.statusCode,200,response.body);const continuation=await f.node.memoryPipeline.run(response.json().continuationId.replace(/^memory:/,''));assert.equal(continuation.status,'completed');assert.equal(continuation.memoryIds.length,2,'a contextual revision must replace both affected results from this material');
 const calls=f.calls.slice(before),targets=calls.filter(input=>input.traceContext?.phase==='extract').flatMap(input=>(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members);assert.deepEqual(targets.map(({offset,length})=>({offset,length})).sort((a,b)=>a.offset-b.offset),authorized.map(({offset,length})=>({offset,length})).sort((a,b)=>a.offset-b.offset));assert.ok(targets.every(target=>target.materialRef?.includes(material.id)));assert.equal(f.node.memories.list().length,3,'the independent result from the other material is retained once');
});

test('an unknown answer can later receive new explicit information without retrying the closed evaluation',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]),[pending]=await f.questions(job.id),before=f.calls.length;
 const closed=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'unknown'});assert.equal(closed.statusCode,200,closed.body);assert.equal(f.calls.length,before);
 const resolved=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:closed.json().revision,action:'answer',choiceId:'describing'});assert.equal(resolved.statusCode,200,resolved.body);const continuation=await f.node.memoryPipeline.run(resolved.json().continuationId.replace(/^memory:/,''));assert.equal(continuation.status,'completed');assert.equal(continuation.memoryIds.length,1);assert.equal(f.calls.length,before+2);assert.equal(f.node.memoryPipeline.list().length,2);
});

test('already jointly inspected context never creates an adjustment task',{timeout:30000},async t=>{
 const f=await httpFixture(t),owner=await f.add('anonymous'),context=await f.add('dependent','Wholly generated requires background: that earlier trial supplies the referent.'),background=await f.add('background','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([owner,context,background]);assert.equal(job.status,'waiting_for_input');assert.equal(job.memoryIds.length,1);assert.equal((await f.questions(job.id)).length,1);
 assert.equal(f.calls.filter(input=>input.traceContext?.phase==='feedback-planning').length,0);assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM delegation_works WHERE json_extract(json,'$.profileId')='memory.feedback'").get()!.n,0);
 const before=f.calls.length;await f.node.memoryPipeline.retry(job.id);await f.restart();await f.node.memoryPipeline.run(job.id);assert.equal(f.calls.length,before);
});

test('unchanged target and background pairs cannot create a second adjustment task',{timeout:30000},async t=>{
 const f=await httpFixture(t),settings=f.node.lifecycle.settings();settings.batchCharacters=600;f.node.lifecycle.configure(settings);f.control.contextUnresolved=true;
 const context=await f.add('dependent','Wholly generated requires background: that earlier trial supplies the referent.'),background=await f.add('background','Wholly generated independent record: I felt proud of my prototype.'),job=await f.start([context,background]);assert.equal(job.status,'waiting_for_input');assert.equal(job.memoryIds.length,1);
 const plans=f.calls.filter(input=>input.traceContext?.phase==='feedback-planning');assert.equal(plans.length,1);const originalExtract=f.calls.find(input=>input.traceContext?.phase==='extract'&&(input.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members.some(member=>f.node.memories.readEvidence([member.id])[0].ocrText.includes('Wholly generated requires background')))!,followup=f.calls.filter(input=>input.traceContext?.phase==='extract'&&Boolean((input.taskContext!.memoryWork as {contextMembers:MemoryWorkMember[]}).contextMembers.length));assert.equal(followup.length,1);
 const history=(followup[0].taskContext!.memoryWork as {history:import('../src/memory-work-contract.js').MemoryWorkInspection[]}).history;assert.ok(history.some(inspection=>inspection.targets.some(target=>target.state==='needs_context'&&target.key===(originalExtract.taskContext!.memoryWork as {members:MemoryWorkMember[]}).members[0].key)));assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM delegation_works WHERE json_extract(json,'$.profileId')='memory.feedback'").get()!.n,1);
 const before=f.calls.length;await f.node.memoryPipeline.retry(job.id);await f.restart();await f.node.memoryPipeline.run(job.id);assert.equal(f.calls.length,before);
});

test('a resolved free-text declaration preserves the exact owner reply including whitespace',{timeout:30000},async t=>{
 const f=await httpFixture(t),id=await f.add('anonymous'),job=await f.start([id]),[pending]=await f.questions(job.id),answer='  I am the person describing the pressure.\n  ';
 const response=await f.api('POST','/api/owner-questions/'+pending.id+'/reply',{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',answer});assert.equal(response.statusCode,200,response.body);const continuation=await f.node.memoryPipeline.run(response.json().continuationId.replace(/^memory:/,''));assert.equal(continuation.status,'completed');assert.equal(response.json().messages.at(-1).text,answer);
 const records=f.node.memories.readEvidence(continuation.evidenceIds);assert.ok(records.every(record=>record.attributionContext?.ownerStatements?.at(-1)?.answer===answer));assert.equal(f.calls.filter(input=>Boolean(input.taskContext?.ownerClarificationReply)).length,1);
});
