import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {estimateSerializedTokens,type QueryInput} from '@mote/agent';
import type {QueryResult,QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {TaskRecords} from '../src/task-records.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {semanticProcessor} from '../src/semantic-extraction.js';
import {UsageLedger} from '../src/usage.js';
import {agentModelConnection} from '../src/model-authorization-host.js';
import {StoreError,sha256} from '../src/store.js';
import {materialId} from '../src/materials.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const all:QueryScope={kind:'all'};
const at='2026-10-01T10:00:00.000Z';
const headers={authorization:'Bearer generated-followup-owner'};
type Context={materials:{ref:string;products:{summary:string;events:unknown[]}[];body?:{text:string;complete:boolean}}[];originals:{id:string;offset:number;quote:string}[];
 cards:{id:string;revision:number;title:string;body:string;feedback:{action:string;note?:string}[]}[];memories:{id:string;statement:string}[];commitments:{id:string;status:string}[];mode:{kind:string}};
type Program=(context:Context)=>unknown|Promise<unknown>;
const evidence=(context:Context,needle:string)=>{
 const source=context.originals.find(original=>original.quote.includes(needle));assert.ok(source,`Original not supplied: ${needle}; context=${JSON.stringify(context.materials)}; originals=${JSON.stringify(context.originals)}`);
 return {id:source.id,offset:source.offset+source.quote.indexOf(needle),quote:needle};
};
const card=(proof:ReturnType<typeof evidence>,changes:Record<string,unknown>={})=>({action:'new',cardId:null,relatedCardIds:[],title:'Generated missing item',body:'The generated plan needs an owner.',reason:'The requirement asks for an owner.',evidence:[proof],matterId:null,...changes});
const answer=(cards:unknown[]=[],commitments:unknown[]=[],reason='Generated result')=>({reason,cards,commitments});
async function until(check:()=>boolean){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for the generated batch');}

async function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-assistant-followup-'));
 const config:Config={dataDir,dataKey:'43'.repeat(32),contentEncryptionEnabled:true,token:'generated-followup-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const programs:Program[]=[],seen:Context[]=[];let providerFailure:unknown;
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query:async(input:QueryInput):Promise<QueryResult>=>{
  // Component-only provider double. The HTTP journeys exercise the actual
  // complete-request gate; this estimate only bounds this generated input.
  const tokens=estimateSerializedTokens({question:input.question,evidenceIds:input.evidenceIds,contextTime:input.contextTime}).tokens;
  assert.ok(tokens+4000<=32000,'generated request must fit the declared small fixture window');
  const marker='\nUntrusted context: ',offset=input.question.indexOf(marker);assert.notEqual(offset,-1);
  const context=JSON.parse(input.question.slice(offset+marker.length)) as Context;seen.push(context);
  const program=programs.shift();assert.ok(program,'A generated model response must be explicitly supplied');
  try{return {answer:JSON.stringify(await program(context)),citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}};}
  catch(error){providerFailure=error;throw error;}
 },close:async()=>{}}});
 const reader=node.featureServices.evidenceReader;
 const assertCurrent=(ids:readonly string[])=>{if(!reader.contextDependenciesAllowed(ids))throw new StoreError('Generated evidence changed',409);};
 const batch=node.batchProcessing,service=node.featureServices.assistantFollowup;
 const tasks=new TaskRecords(node.store);
 await node.app.ready();
 const runtime=new ProcessingRuntime(node.store,[],{},Date.now,undefined,node.materials);
 t.after(async()=>{await runtime.close();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const add=async(text:string,deviceId='generated-device')=>{
  const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId,deviceName:'Generated',platform:'import',capturedAt:at,text}});
  assert.equal(response.statusCode,201,response.body);await node.materialOrganizer.tick(100);
  const material=node.materials.list({kind:'mote.note',limit:100}).items.find(value=>value.origin.externalId===id);assert.ok(material);return {id,text,material};
 };
 const produce=async(note:Awaited<ReturnType<typeof add>>)=>{
  node.store.archive.aggregate();const segment=node.store.archive.page({kind:'segment'}).items.find(item=>item.members.includes(note.id));assert.ok(segment);
  const model={owner:'models' as const,fingerprint:'a'.repeat(64),revision:1,profileId:'fixture',provider:'openai',model:'generated',configured:true};
  runtime.registry.register(semanticProcessor({store:node.store,memories:node.memories,records:ids=>node.store.evidence(ids),selection:()=>model,usage:new UsageLedger(node.store),query:async()=>({
   answer:JSON.stringify({summary:'Generated requirement product',evidence:[{id:note.id,quote:note.text}],events:[{statement:'Owner asks for a named owner',uncertainty:'Generated requirement',evidence:[{id:note.id,quote:note.text}]}],memoryCandidates:[],actionCues:[]}),
   citations:[{id:note.id,capturedAt:at,appName:'Generated',excerpt:note.text}],trace:[],runId:randomUUID(),
  })}));
  const job=runtime.enqueue([{name:'semantic',processor:'mote.segment-understanding',artifactInputs:[{id:segment.id,revision:segment.revision}],config:{artifactId:segment.id,modelFingerprint:model.fingerprint}}]).semantic;
  await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');
  return (JSON.parse(String(node.store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(job)!.json)).outputs as string[])[0];
 };
 const profile=node.modelSettings.select('chat'),admission={identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]};
 const start=async(refs:string[],mode:{kind:'change'}|{kind:'briefing';after:string;before:string}={kind:'change'},scope:QueryScope=all)=>service.start({operationId:'generated:'+randomUUID(),requestId:randomUUID(),scope,materialRefs:refs,mode},admission);
 const wait=async(task:{id:string;revision:number})=>{
  const batchId=service.progress(task.id).batch!.task.id;
  await until(()=>['succeeded','failed','stale','cancelled'].includes(batch.progress(batchId).task.state)||batch.progress(batchId).items.some(item=>['failed','stale','blocked'].includes(item.state)));
  if(providerFailure)throw providerFailure;
  const progress=batch.progress(batchId);assert.equal(progress.task.state,'succeeded',JSON.stringify(progress));
 };
 const run=async(refs:string[],program:Program,mode?:Parameters<typeof start>[1],scope?:QueryScope)=>{programs.push(program);const task=await start(refs,mode,scope);await wait(task);return service.finish(task.id);};
 return {node,reader,batch,service,tasks,assertCurrent,programs,seen,add,produce,start,wait,run,admission};
}

test('real stored Material and semantic product feed the batch consumer; the later original resolves the same suggestion and updates a commitment',async t=>{
 const f=await fixture(t),requirement=await f.add('Generated requirement: name an owner.'),draft=await f.add('Generated draft: the owner is missing.'),artifact=await f.produce(requirement);
 const first=await f.run([requirement.material.ref,draft.material.ref],context=>{
  assert.ok(context.materials.some(material=>material.products.some(product=>product.summary==='Generated requirement product')));
  const requirementProof=evidence(context,requirement.text),draftProof=evidence(context,draft.text);
  return answer([{...card(requirementProof),evidence:[requirementProof,draftProof]}],[{commitmentId:null,kind:'commitment',occurredAt:null,summary:'Generated owner assignment is pending.',changes:{title:'Assign an owner',status:'pending_confirmation'},evidence:[requirementProof]}]);
 });
 assert.equal(first.cardIds.length,1);assert.equal(first.commitmentIds.length,1);
 const original=f.node.featureServices.assistantCards.get(first.cardIds[0],all);assert.equal(original.state,'open');
 const update=await f.add('Generated update: Alex is the owner.');
 const second=await f.run([requirement.material.ref,draft.material.ref,update.material.ref],context=>{
  const proof=evidence(context,update.text),existing=context.cards.find(value=>value.id===original.id)!;
  assert.equal(existing.revision,original.revision);
  return answer([card(proof,{action:'resolve',cardId:existing.id,relatedCardIds:[existing.id],title:'Owner assigned',body:'Alex is the owner.',reason:'The later original names Alex.'})],
   [{commitmentId:first.commitmentIds[0],kind:'progress',occurredAt:null,summary:'The owner was assigned.',changes:{status:'completed'},evidence:[proof]}]);
 });
 assert.deepEqual(second.cardIds,[original.id]);assert.deepEqual(second.commitmentIds,first.commitmentIds);
 const resolved=f.node.featureServices.assistantCards.get(original.id,all);assert.equal(resolved.state,'resolved');assert.equal(resolved.revision,2);
 assert.equal(f.node.featureServices.assistantCommitments.get(first.commitmentIds[0],all).status,'completed');
 assert.equal(f.node.featureServices.assistantCards.history(original.id,{scope:all}).items.length,2);
 assert.ok(resolved.evidence.some(item=>item.quote===update.text));
 f.node.store.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(artifact);
 assert.throws(()=>f.node.featureServices.assistantCards.get(original.id,all),{statusCode:404});
 assert.throws(()=>f.node.featureServices.assistantCommitments.get(first.commitmentIds[0],all),{statusCode:404});
 assert.equal(f.node.store.evidence([requirement.id]).length,1,'retiring a derived product does not delete its original');
});

test('no new help is a valid serialized result and empty selection never reaches the model',async t=>{
 const f=await fixture(t),note=await f.add('Generated independent note.');
 const result=await f.run([note.material.ref],()=>answer([],[],'No supported new help.'));
 assert.deepEqual(result,{reason:'No supported new help.',cardIds:[],commitmentIds:[]});
 const before=f.seen.length;await assert.rejects(f.start([note.material.ref],undefined,{kind:'selection',evidenceIds:[]}),{statusCode:409});assert.equal(f.seen.length,before);
});

test('owner correction fences a completed older analysis and is read by the next interpretation',async t=>{
 const f=await fixture(t),note=await f.add('Generated requirement: deliver the plan.'),refs=[note.material.ref];
 const created=await f.run(refs,context=>answer([card(evidence(context,note.text))]));const id=created.cardIds[0];
 f.programs.push(context=>answer([card(evidence(context,note.text),{action:'update',cardId:id,relatedCardIds:[id],body:'Outdated interpretation.'})]));
 const pending=await f.start(refs);await f.wait(pending);
 const snapshot=f.tasks.input<{batchId:string}>(pending.id,pending.revision,f.assertCurrent),itemId=(f.batch.progress(snapshot.batchId).items[0].input as {itemId:string}).itemId;
 const current=f.node.featureServices.assistantCards.get(id,all);
 const feedback=await f.node.app.inject({method:'POST',url:`/api/assistant-cards/${id}/feedback?scope=${encodeURIComponent(JSON.stringify(all))}`,headers,payload:{expectedRevision:current.revision,action:'correct',note:'The owner says the plan is already delivered.'}});
 assert.equal(feedback.statusCode,200,feedback.body);await assert.rejects(f.service.finish(pending.id),{statusCode:409});
 for(const workId of [pending.id,snapshot.batchId,itemId]){const row=f.node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE id=?').get(workId)!;
  assert.equal(row.state,'stale');assert.equal(row.input_json,null);assert.equal(row.result_json,null);
 }
 const next=await f.run(refs,context=>{
  const original=context.cards.find(value=>value.id===id)!;assert.ok(original.feedback.some(value=>value.note==='The owner says the plan is already delivered.'));
  return answer([card(evidence(context,note.text),{action:'resolve',cardId:id,relatedCardIds:[id],body:'The owner corrected the previous assessment.',reason:'The owner confirmed delivery.'})]);
 });
 assert.deepEqual(next.cardIds,[id]);const saved=f.node.featureServices.assistantCards.get(id,all);assert.equal(saved.state,'resolved');assert.doesNotMatch(saved.body,/Outdated interpretation/);
});

test('two analyses based on one card revision cannot overwrite each other and a fresh interpretation preserves both inputs',async t=>{
 const f=await fixture(t),initial=await f.add('Generated requirement: record both details.'),a=await f.add('Generated first detail: budget approved.'),b=await f.add('Generated second detail: date confirmed.');
 const created=await f.run([initial.material.ref],context=>answer([card(evidence(context,initial.text))]));const id=created.cardIds[0];
 f.programs.push(context=>answer([card(evidence(context,a.text),{action:'update',cardId:id,relatedCardIds:[id],body:'Budget approved.'})]));
 const one=await f.start([initial.material.ref,a.material.ref]);
 f.programs.push(context=>answer([card(evidence(context,b.text),{action:'update',cardId:id,relatedCardIds:[id],body:'Date confirmed.'})]));
 const two=await f.start([initial.material.ref,b.material.ref]);await Promise.all([f.wait(one),f.wait(two)]);
 await f.service.finish(one.id);await assert.rejects(f.service.finish(two.id),{statusCode:409});
 const retry=await f.run([initial.material.ref,a.material.ref,b.material.ref],context=>{
  assert.match(context.cards.find(value=>value.id===id)!.body,/Budget approved/);
  return answer([card(evidence(context,a.text),{action:'update',cardId:id,relatedCardIds:[id],body:'Budget approved; date confirmed.',evidence:[evidence(context,a.text),evidence(context,b.text)]})]);
 });
 assert.deepEqual(retry.cardIds,[id]);const saved=f.node.featureServices.assistantCards.get(id,all);assert.match(saved.body,/Budget approved; date confirmed/);
 assert.deepEqual(new Set(saved.evidence.map(item=>item.quote)),new Set([a.text,b.text]));
});

test('never-remind feedback suppresses the same issue even under a different title, while a separate issue remains possible',async t=>{
 const f=await fixture(t),note=await f.add('Generated plan has an open owner question.'),later=await f.add('Generated new source mentions the same owner question.');
 const first=await f.run([note.material.ref],context=>answer([card(evidence(context,note.text))]));const id=first.cardIds[0];
 const current=f.node.featureServices.assistantCards.get(id,all),response=await f.node.app.inject({method:'POST',url:`/api/assistant-cards/${id}/feedback?scope=${encodeURIComponent(JSON.stringify(all))}`,headers,payload:{expectedRevision:current.revision,action:'never_remind'}});
 assert.equal(response.statusCode,200,response.body);
 const result=await f.run([note.material.ref,later.material.ref],context=>{
  assert.ok(context.cards.find(value=>value.id===id)!.feedback.some(item=>item.action==='never_remind'));
  return answer([card(evidence(context,later.text),{title:'Completely renamed suggestion',relatedCardIds:[id]})],[],'Owner opted out of this issue.');
 });
 assert.deepEqual(result.cardIds,[]);assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.length,1);
 const other=await f.run([note.material.ref,later.material.ref],context=>answer([card(evidence(context,later.text),{title:'Different independent issue',body:'An independent issue.'})]));
 assert.equal(other.cardIds.length,1);assert.notEqual(other.cardIds[0],id);
});

test('briefing reads corrected current Memory and keeps cancellation distinct from completed progress',async t=>{
 const f=await fixture(t),work=await f.add('Generated project progress: draft delivered.'),life=await f.add('Generated appointment is Monday.');
 const record=f.node.store.evidence([life.id])[0]!;
 const result:QueryResult={answer:JSON.stringify({memories:[{title:'Generated appointment',statement:`${life.text} [${life.id}]`,uncertainty:'Generated fixture',evidenceIds:[life.id]}]}),citations:[{id:life.id,capturedAt:at,appName:'Generated',excerpt:life.text}],trace:[],runId:randomUUID()};
 const draft=f.node.memories.extract(fixtureMemoryResult(f.node.memories,result),'generated').items[0]!,old=f.node.memories.publish(draft.id,draft.version);
 const correction=await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated corrected appointment',statement:'The appointment was cancelled.'}});
 assert.equal(correction.statusCode,200,correction.body);
 const current=correction.json();
 const briefing=await f.run([work.material.ref,life.material.ref],context=>{
  assert.ok(context.memories.some(memory=>memory.id===current.id&&memory.statement.includes('cancelled')));
  assert.ok(!context.memories.some(memory=>memory.id===old.id));
  return answer([card(evidence(context,work.text),{title:'Generated daily briefing',body:'The draft was delivered. The appointment was cancelled.',reason:'Current Memory contains the owner correction.'})]);
 },{kind:'briefing',after:'2026-10-01T00:00:00Z',before:'2026-10-02T00:00:00Z'});
 const saved=f.node.featureServices.assistantCards.get(briefing.cardIds[0],all);assert.equal(saved.kind,'briefing');assert.match(saved.body,/cancelled/);assert.doesNotMatch(saved.body,/Monday/);
 assert.ok(saved.evidenceDependencies.ids.includes(current.id));
});

test('scope filters mixed cards before model disclosure and deletion prevents a late publication',async t=>{
 const f=await fixture(t),privateNote=await f.add('GENERATED_PRIVATE_WORK', 'private-device'),selected=await f.add('Generated selected public note.', 'selected-device');
 await f.run([privateNote.material.ref,selected.material.ref],context=>answer([card(evidence(context,selected.text),{body:'GENERATED_PRIVATE_WORK is mixed into this card.'})]));
 const scope:QueryScope={kind:'selection',evidenceIds:[selected.id]};
 const scoped=await f.run([selected.material.ref],context=>{assert.doesNotMatch(JSON.stringify(context),/GENERATED_PRIVATE_WORK/);assert.equal(context.cards.length,0);return answer();},undefined,scope);
 assert.deepEqual(scoped.cardIds,[]);
 f.programs.push(context=>answer([card(evidence(context,selected.text))]));const pending=await f.start([selected.material.ref]);await f.wait(pending);
 const removed=await f.node.app.inject({method:'DELETE',url:`/api/notes/${selected.id}`,headers});assert.equal(removed.statusCode,200,removed.body);
 await assert.rejects(f.service.finish(pending.id),{statusCode:409});assert.equal(f.tasks.get(pending.id).state,'stale');
});

test('forged quotes fail without a partial card or commitment publication',async t=>{
 const f=await fixture(t),note=await f.add('Generated proof is available.'),refs=[note.material.ref];
 f.programs.push(context=>answer([card(evidence(context,note.text))],[{commitmentId:null,kind:'commitment',occurredAt:null,summary:'Unsupported assertion',changes:{title:'Generated invalid commitment'},evidence:[{id:context.originals[0].id,offset:0,quote:'fabricated'}]}]));
 const task=await f.start(refs);await f.wait(task);await assert.rejects(f.service.finish(task.id),{statusCode:409});
 assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.length,0);assert.equal(f.node.featureServices.assistantCommitments.page({scope:all}).items.length,0);
});

test('replaying an owner request returns its original task and does not call the provider twice',async t=>{
 const f=await fixture(t),note=await f.add('Generated idempotent request.');
 const request={operationId:'generated-idempotent',requestId:randomUUID(),scope:all,materialRefs:[note.material.ref],mode:{kind:'change' as const}};
 f.programs.push(context=>answer([card(evidence(context,note.text))]));
 const [one,two]=await Promise.all([f.service.start(request,f.admission),f.service.start(request,f.admission)]);assert.equal(one.id,two.id);
 await f.wait(one);const result=await f.service.finish(one.id);assert.deepEqual(await f.service.finish(two.id),result);
 const replay=await f.service.start(request,f.admission);assert.equal(replay.id,one.id);assert.equal(f.seen.length,1);
 await assert.rejects(f.service.start({...request,operationId:'generated-different'},f.admission),{statusCode:409});
});

test('superseded card context fails closed instead of reviving a suppressed issue',async t=>{
 const f=await fixture(t),sourceId='generated-revision-source',externalId='generated-document';
 f.node.sources.register({id:sourceId,name:'Generated',kind:'custom',deviceId:'generated-device',platform:'import'});
 const put=async(revision:string,text:string)=>{
  const capture=await f.node.sources.upsert(sourceId,{externalId,revision,observedAt:at,kind:'message',layer:'original',text});
  const {materialId}=await import('../src/materials.js'),id=materialId(sourceId,externalId),previous=f.node.materials.get(id);
  const material=f.node.materials.publish({id,kind:'mote.message',schemaVersion:1,title:'Generated document',origin:{sourceId,externalId,deviceId:'generated-device',firstAt:at,lastAt:at},
   blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],members:[{id:'original',kind:'capture',ref:'capture:'+capture.id}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}},previous?{expectedRevision:previous.revision}:undefined);
  return {capture,material};
 };
 const first=await put('1','Generated first version has an open issue.');
 const made=await f.run([first.material.ref],context=>answer([card(evidence(context,'Generated first version has an open issue.'))]));
 const cards=f.node.featureServices.assistantCards,prior=cards.get(made.cardIds[0],all);cards.feedback(prior.id,{expectedRevision:prior.revision,action:'never_remind'},all);
 const newer=await put('2','Generated newer version addresses the issue.');const calls=f.seen.length;
 assert.equal(cards.get(prior.id,all).state,'stale');
 await assert.rejects(f.start([newer.material.ref]),/Historical assistant context requires a current-evidence review/);
 assert.equal(f.seen.length,calls,'historical text is not sent to a current-evidence-only batch');
 assert.equal(cards.history(prior.id,{scope:all}).items.length,1);
});

test('a Memory correction clears both K4 frozen inputs and the follow-up snapshot before a late result can publish',async t=>{
 const f=await fixture(t),note=await f.add('Generated original appointment is Monday.');
 const result:QueryResult={answer:JSON.stringify({memories:[{title:'Generated appointment',statement:`${note.text} [${note.id}]`,uncertainty:'Generated fixture',evidenceIds:[note.id]}]}),
  citations:[{id:note.id,capturedAt:at,appName:'Generated',excerpt:note.text}],trace:[],runId:randomUUID()};
 const draft=f.node.memories.extract(fixtureMemoryResult(f.node.memories,result),'generated').items[0]!,old=f.node.memories.publish(draft.id,draft.version);
 f.programs.push(context=>{assert.ok(context.memories.some(memory=>memory.id===old.id));return answer([card(evidence(context,note.text))]);});
 const task=await f.start([note.material.ref]),snapshot=f.tasks.input<{batchId:string}>(task.id,task.revision,f.assertCurrent),progress=f.batch.progress(snapshot.batchId);
 const itemId=(progress.items[0].input as {itemId:string}).itemId;await f.wait(task);
 const correction=await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated correction',statement:'The appointment is cancelled.'}});
 assert.equal(correction.statusCode,200,correction.body);
 for(const id of [task.id,snapshot.batchId,itemId]){const row=f.node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE id=?').get(id)!;
  assert.equal(row.state,'stale');assert.equal(row.input_json,null);assert.equal(row.result_json,null);
 }
 await assert.rejects(f.service.finish(task.id),{statusCode:409});assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.length,0);
});

test('a matter linked to readable evidence and its owner correction enter the interpretation',async t=>{
 const f=await fixture(t),note=await f.add('Generated evidence for the owner matter.');
 const matters=f.node.featureServices.assistantMatters;
 const matter=matters.command({type:'create',requestId:randomUUID(),goal:'Generated tracked goal',scope:all,evidenceIds:[note.id],correction:'Owner says the goal is urgent.'},{
  currentEvidence:ids=>ids.filter(id=>id===note.id).map(id=>({id,title:'Generated note',deviceId:'generated-device',at})),currentTask:()=>undefined,
 });
 const result=await f.run([note.material.ref],context=>{
  const selected=(context as Context&{matters:{id:string;goal:string;correction:string}[]}).matters.find(item=>item.id===matter.id);
  assert.equal(selected?.goal,'Generated tracked goal');assert.equal(selected?.correction,'Owner says the goal is urgent.');
  return answer([card(evidence(context,note.text),{matterId:matter.id})]);
 });
 assert.equal(f.node.featureServices.assistantCards.get(result.cardIds[0],all).matterId,matter.id);
});

test('feedback depending on earlier card versions carries all of its original lineage into K4',async t=>{
 const f=await fixture(t),earlier=await f.add('Generated earlier card evidence.'),current=await f.add('Generated current card evidence.'),fresh=await f.add('Generated new evidence.');
 const cards=f.node.featureServices.assistantCards,id=randomUUID(),publication=(version:string,note:typeof earlier)=>({id,kind:'suggestion' as const,matterId:null,version,state:'open' as const,
  title:'Generated issue',body:'Generated interpretation',evidence:[{id:note.id,quote:note.text}],evidenceDependencies:{version:1 as const,complete:true as const,ids:[note.id]}});
 const first=cards.publish(publication('first',earlier),undefined,all,f.assertCurrent),second=cards.publish(publication('second',current),first.revision,all,f.assertCurrent);
 cards.feedback(id,{expectedRevision:second.revision,action:'correct',note:'Generated correction after reading both versions.'},all);
 f.programs.push(context=>{assert.ok(context.cards[0].feedback.some(item=>item.action==='correct'));return answer();});
 const task=await f.start([current.material.ref,fresh.material.ref]),snapshot=f.tasks.input<{batchId:string}>(task.id,task.revision,f.assertCurrent);
 assert.ok(f.tasks.evidenceDependencies(task.id,task.revision,f.assertCurrent).ids.includes(earlier.id));
 const itemId=(f.batch.progress(snapshot.batchId).items[0].input as {itemId:string}).itemId;
 assert.ok(f.tasks.evidenceDependencies(itemId,f.tasks.get(itemId).revision,f.assertCurrent).ids.includes(earlier.id));
 await f.wait(task);f.node.store.delete(earlier.id);
 for(const id of [task.id,snapshot.batchId,itemId]){const row=f.node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE id=?').get(id)!;
  assert.equal(row.state,'stale');assert.equal(row.input_json,null);assert.equal(row.result_json,null);
 }
 await assert.rejects(f.service.finish(task.id),{statusCode:409});
});

test('a newly completed understanding product forces a fresh analysis before publication',async t=>{
 const f=await fixture(t),note=await f.add('Generated requirement: name an owner.');
 f.programs.push(context=>{assert.deepEqual(context.materials[0].products,[]);return answer([card(evidence(context,note.text))]);});
 const task=await f.start([note.material.ref]);await f.wait(task);await f.produce(note);
 await assert.rejects(f.service.finish(task.id),/Understanding changed; analyze again/);
 assert.equal(f.node.featureServices.assistantCards.page({scope:all}).items.length,0);
 const retry=await f.run([note.material.ref],context=>{assert.equal(context.materials[0].products[0].summary,'Generated requirement product');return answer();});
 assert.deepEqual(retry.cardIds,[]);
});

test('the assembled batch passes the configured product budget to its query consumer',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-followup-budget-'));let calls=0;
 const config:Config={dataDir,token:'generated-followup-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelMaxTokens:512,modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query:async(input:QueryInput)=>{
  calls++;assert.deepEqual(input.modelBudget,{contextWindow:32000,maxTokens:512,historyRatio:0.5,lowWatermarkRatio:0.5,tokenCounting:'estimated',contextWindowSource:'configured'});
  return {answer:JSON.stringify(answer()),citations:[],trace:[],runId:randomUUID(),evidenceDependencies:input.contextEvidenceDependencies};
 },close:async()=>{}}});
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const view=await node.app.inject({method:'GET',url:'/api/configuration',headers});
 const configured=await node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:view.json().revision,value:{context:{contextWindow:32000,contextWindowSource:'configured'}}}});
 assert.equal(configured.statusCode,200,configured.body);
 const id=randomUUID(),created=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text:'Generated budget-block note.'}});
 assert.equal(created.statusCode,201,created.body);await node.materialOrganizer.tick(100);
 const material=node.materials.list({kind:'mote.note',limit:100}).items.find(item=>item.origin.externalId===id)!;assert.ok(material);
 const profile=node.modelSettings.select('chat'),task=await node.featureServices.assistantFollowup.start({operationId:'generated-production-budget',requestId:randomUUID(),scope:all,materialRefs:[material.ref],mode:{kind:'change'}},
  {identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]});
 const tasks=new TaskRecords(node.store),snapshot=tasks.input<{batchId:string}>(task.id,task.revision,()=>{});
 await until(()=>node.batchProcessing.progress(snapshot.batchId).items.some(item=>['succeeded','failed','blocked'].includes(item.state)));
 assert.equal(node.batchProcessing.progress(snapshot.batchId).items[0].state,'succeeded');assert.equal(calls,1);
 assert.deepEqual((await node.featureServices.assistantFollowup.finish(task.id)).cardIds,[]);
});


test('a new file version lets A14 resolve the existing suggestion instead of losing its identity',async t=>{
 const f=await fixture(t),requirement=await f.add('Generated requirement: name an owner.');
 const source=await f.node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'generated-followup-files',name:'Generated files',kind:'local-files',deviceId:'generated-followup',platform:'macos',retention:'archive'}});assert.equal(source.statusCode,200,source.body);
 const settings={...f.node.processing.view().settings,enabled:true,summarize:false};
 await f.node.processing.save({revision:f.node.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.node.processing.runtime.registry)});
 const upload=async(revision:string,previousRevision:string|null,text:string)=>{
  const bytes=Buffer.from(text),payload={sourceId:'generated-followup-files',relativePath:'draft.txt',previousRevision,item:{externalId:'draft.txt',revision,observedAt:new Date().toISOString(),title:'Generated draft',kind:'file',layer:'original',text:'',mimeType:'text/plain',deleted:false},sizeBytes:bytes.length,sha256:sha256(bytes)};
  const begin=await f.node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers,payload});assert.equal(begin.statusCode,200,begin.body);const id=begin.json().uploadId;
  const part=await f.node.app.inject({method:'PUT',url:`/api/file-sync/v1/uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(part.statusCode,200,part.body);
  const done=await f.node.app.inject({method:'POST',url:`/api/file-sync/v1/uploads/${id}/commit`,headers,payload:{}});assert.equal(done.statusCode,200,done.body);
  await f.node.processing.tick();await f.node.materialOrganizer.tick(100);
  const material=f.node.materials.get(materialId('generated-followup-files','draft.txt'));assert.ok(material);return {...material,captureId:done.json().id as string};
 };
 const missing='Generated draft: the owner is missing.',complete='Generated draft: Alex is the owner.';
 const before=await upload('1',null,missing);
 const first=await f.run([requirement.material.ref,before.ref],context=>answer([card(evidence(context,requirement.text),{evidence:[evidence(context,requirement.text),evidence(context,missing)]})]));
 const cardId=first.cardIds[0];assert.equal(f.node.featureServices.assistantCards.get(cardId,all).state,'open');
 const after=await upload('2','1',complete);
 const second=await f.run([requirement.material.ref,after.ref],context=>{
  const prior=context.cards.find(value=>value.id===cardId);assert.ok(prior,'the interpreter can identify the earlier suggestion');
  return answer([card(evidence(context,complete),{action:'resolve',cardId,relatedCardIds:[cardId]})],
   [{commitmentId:null,kind:'commitment',occurredAt:null,summary:'Generated next owner review.',changes:{title:'Review the assigned plan'},evidence:[evidence(context,complete)]}]);
 });
 assert.deepEqual(second.cardIds,[cardId]);assert.equal(f.node.featureServices.assistantCards.get(cardId,all).state,'resolved');
 const commitment=f.node.featureServices.assistantCommitments.get(second.commitmentIds[0],all);
 assert.equal(commitment.title,'Review the assigned plan');assert.ok(commitment.evidenceDependencies.ids.includes(before.captureId));
 assert.ok(!JSON.stringify(commitment).includes('historicalEvidenceIds'),'private dependency roles do not extend the public contract');
 assert.deepEqual(f.node.featureServices.assistantCommitments.page({scope:{kind:'selection',evidenceIds:[after.captureId]}}).items,[]);
 const correctionId=randomUUID(),corrected=f.node.featureServices.assistantCommitments.correct({commitmentId:commitment.id,eventId:correctionId,
  targetEventId:commitment.timeline[0].eventId,occurredAt:null,summary:'Generated owner cancels the next review.',changes:{status:'cancelled'},
  evidence:[{id:requirement.id,offset:0,quote:requirement.text}],evidenceDependencies:commitment.evidenceDependencies},commitment.revision,all,f.assertCurrent);
 assert.equal(corrected.status,'cancelled','owner corrections retain their precedence with historical file context');
 const cards=f.node.featureServices.assistantCards,resolved=cards.get(cardId,all);
 assert.ok(resolved.evidenceDependencies.ids.includes(before.captureId),'the revised interpretation retains the historical disclosure lineage');
 assert.deepEqual(cards.page({scope:{kind:'selection',evidenceIds:[after.captureId]}}).items,[],'a narrow current-file scope cannot expose mixed requirement or historical card context');
 cards.feedback(cardId,{expectedRevision:resolved.revision,action:'never_remind'},all);
 const later=await upload('3','2','Generated draft: Alex remains the owner.');
 const suppressed=await f.run([requirement.material.ref,later.ref],context=>{
  assert.ok(context.cards.find(value=>value.id===cardId)!.feedback.some(value=>value.action==='never_remind'));
  return answer([card(evidence(context,'Alex remains the owner.'),{relatedCardIds:[cardId],title:'A renamed version of the same issue'})]);
 });
 assert.deepEqual(suppressed.cardIds,[],'another file version and title cannot revive a suppressed suggestion');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_cards').get()!.n,1);
 f.node.store.delete(before.captureId);
 assert.throws(()=>cards.get(cardId,all),{statusCode:404},'deleting a historical dependency clears the revised derived body too');
 for(const eventId of [commitment.timeline[0].eventId,correctionId])assert.equal(f.node.store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(eventId)!.private_json,null);
 assert.equal(f.node.sources.getItem('generated-followup-files','draft.txt')?.captureId,later.captureId,'the independently retained current file survives');
});
